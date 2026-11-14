//! Observabilidade do host da sessão: carga, memória, disco, serviços,
//! processos, portas escutando, atualizações pendentes e cauda de arquivo.
//!
//! Mesma regra do painel de rede: um `exec` por consulta, nada instalado no
//! servidor, nada digitado no terminal do usuário. Os comandos coletam em
//! seções (`##NOME`) e a normalização é aqui, em Rust, testável sem host.

use tauri::State;

use super::AppState;
use crate::error::{AppError, AppResult};

/// PATH ampliado: em Debian/Ubuntu `ss`, `ip` e afins moram em `/usr/sbin`, que
/// não entra no PATH de um shell não interativo de usuário comum.
const PATH_PREFIX: &str = r#"PATH="$PATH:/sbin:/usr/sbin"; export PATH
"#;

// ---------------------------------------------------------------- visão geral

#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysDisk {
    pub filesystem: String,
    pub mount: String,
    /// Bytes.
    pub total: u64,
    pub used: u64,
    pub percent: f32,
}

#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysOverview {
    pub os: String,
    pub kernel: String,
    pub uptime_secs: u64,
    /// Carga de 1, 5 e 15 minutos.
    pub load: Vec<f32>,
    pub cpu_count: u32,
    /// Uso de CPU em %, `None` quando o host não deu como medir.
    pub cpu_percent: Option<f32>,
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disks: Vec<SysDisk>,
}

/// Duas amostras de `/proc/stat` com 300 ms entre elas dão o uso de CPU do
/// intervalo — sem isso, o número seria a média desde o boot, que não diz nada
/// sobre agora. No BSD/macOS não há equivalente barato: a soma do `%cpu` do
/// `ps` entra no lugar.
const OVERVIEW_SCRIPT: &str = r#"echo '##OS'
uname -sr
(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || sw_vers -productName 2>/dev/null
if [ -r /proc/uptime ]; then
  echo '##UPTIME'
  cut -d' ' -f1 /proc/uptime
  echo '##LOAD'
  cat /proc/loadavg
  echo '##NCPU'
  grep -c '^processor' /proc/cpuinfo
  echo '##STAT1'
  head -1 /proc/stat
  sleep 0.3
  echo '##STAT2'
  head -1 /proc/stat
  echo '##MEM'
  cat /proc/meminfo
else
  echo '##BOOTTIME'
  sysctl -n kern.boottime 2>/dev/null
  echo '##LOAD'
  sysctl -n vm.loadavg 2>/dev/null
  echo '##NCPU'
  sysctl -n hw.ncpu 2>/dev/null
  echo '##PSCPU'
  ps -A -o %cpu= 2>/dev/null | awk '{s+=$1} END {print s}'
  echo '##MEMSIZE'
  sysctl -n hw.memsize 2>/dev/null
  echo '##VMSTAT'
  vm_stat 2>/dev/null
  echo '##SWAP'
  sysctl -n vm.swapusage 2>/dev/null
fi
echo '##DF'
df -Pk 2>/dev/null
exit 0"#;

/// Coletor PowerShell para o terminal local nativo do Windows (`__local__`),
/// emitindo as seções esperadas por `parse_overview`.
const WINDOWS_OVERVIEW_SCRIPT: &str = r#"$inv = [System.Globalization.CultureInfo]::InvariantCulture
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
Write-Output '##OS'
Write-Output ("Windows_NT " + $os.Version)
Write-Output $os.Caption
Write-Output '##UPTIME'
if ($os.LastBootUpTime) {
  Write-Output ([int]((Get-Date) - $os.LastBootUpTime).TotalSeconds)
} else {
  Write-Output '0'
}
$ncpu = [Environment]::ProcessorCount
Write-Output '##NCPU'
Write-Output $ncpu
$load = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average
if ($null -ne $load) {
  Write-Output '##PSCPU'
  Write-Output ([double]$load * $ncpu).ToString('0.##', $inv)
}
Write-Output '##MEM'
Write-Output ("MemTotal: " + [int64]$os.TotalVisibleMemorySize + " kB")
Write-Output ("MemAvailable: " + [int64]$os.FreePhysicalMemory + " kB")
$pf = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue
$swapTotKb = [int64](($pf | Measure-Object -Property AllocatedBaseSize -Sum).Sum * 1024)
$swapUsedKb = [int64](($pf | Measure-Object -Property CurrentUsage -Sum).Sum * 1024)
$swapFreeKb = [math]::Max(0, $swapTotKb - $swapUsedKb)
Write-Output ("SwapTotal: " + $swapTotKb + " kB")
Write-Output ("SwapFree: " + $swapFreeKb + " kB")
Write-Output '##DF'
Write-Output 'Filesystem 1024-blocks Used Available Capacity Mounted on'
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Size -gt 0) {
    $tot = [int64]($_.Size / 1024)
    $avail = [int64]($_.FreeSpace / 1024)
    $used = [math]::Max(0, $tot - $avail)
    $pct = [int](($used / [math]::Max(1, $tot)) * 100)
    $mount = ($_.DeviceID + '\')
    Write-Output "$($_.DeviceID) $tot $used $avail ${pct}% $mount"
  }
}"#;

fn is_win_local(handle: &crate::ssh::SessionHandle) -> bool {
    cfg!(target_os = "windows") && handle.info.connection_id == crate::local::LOCAL_CONNECTION_ID
}

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[tauri::command]
pub async fn sys_overview(state: State<'_, AppState>, session_id: String) -> AppResult<SysOverview> {
    let handle = state.sessions.get(&session_id).await?;
    let text = if is_win_local(&handle) {
        let (_code, out) = handle.exec(WINDOWS_OVERVIEW_SCRIPT.to_string()).await?;
        String::from_utf8_lossy(&out).into_owned()
    } else {
        run_handle(&handle, OVERVIEW_SCRIPT).await?
    };
    Ok(parse_overview(&text))
}

fn parse_overview(text: &str) -> SysOverview {
    let s = super::net::sections(text);
    let get = |k: &str| s.get(k).map(String::as_str).unwrap_or_default();
    let first = |k: &str| get(k).lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();

    let os_lines: Vec<&str> = get("OS").lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let kernel = os_lines.first().copied().unwrap_or_default().to_string();
    let os = os_lines.get(1).copied().unwrap_or(&kernel).to_string();

    let uptime_secs = if let Some(v) = first("UPTIME").split('.').next().and_then(|v| v.parse::<u64>().ok()) {
        v
    } else {
        // macOS: "{ sec = 1739812345, usec = 0 } Sat Feb ..."
        boot_secs_ago(&first("BOOTTIME"))
    };

    // Linux: "0.15 0.20 0.18 1/234 5678"; macOS: "{ 1.52 1.68 1.72 }".
    let load: Vec<f32> = get("LOAD")
        .split(|c: char| c.is_whitespace() || c == '{' || c == '}')
        .filter_map(|t| t.parse::<f32>().ok())
        .take(3)
        .collect();

    let cpu_count = first("NCPU").parse::<u32>().unwrap_or(0);
    let cpu_percent = cpu_from_stat(&first("STAT1"), &first("STAT2"))
        .or_else(|| cpu_from_ps(get("PSCPU"), cpu_count));

    let (mem_total, mem_used, swap_total, swap_used) = if s.contains_key("MEM") {
        meminfo(get("MEM"))
    } else {
        let total = first("MEMSIZE").parse::<u64>().unwrap_or(0);
        let (swap_total, swap_used) = swapusage(&first("SWAP"));
        (total, vm_stat_used(get("VMSTAT"), total), swap_total, swap_used)
    };

    SysOverview {
        os,
        kernel,
        uptime_secs,
        load,
        cpu_count,
        cpu_percent,
        mem_total,
        mem_used,
        swap_total,
        swap_used,
        disks: parse_df(get("DF")),
    }
}

/// `{ sec = 1739812345, usec = 0 } ...` → segundos desde o boot.
fn boot_secs_ago(line: &str) -> u64 {
    let Some(rest) = line.split("sec = ").nth(1) else {
        return 0;
    };
    let secs: i64 = rest
        .split(|c: char| !c.is_ascii_digit())
        .find(|t| !t.is_empty())
        .and_then(|t| t.parse().ok())
        .unwrap_or(0);
    (chrono::Utc::now().timestamp() - secs).max(0) as u64
}

/// Duas linhas `cpu  user nice system idle iowait ...` → % de uso no intervalo.
fn cpu_from_stat(a: &str, b: &str) -> Option<f32> {
    let parse = |l: &str| -> Option<(u64, u64)> {
        let v: Vec<u64> = l.split_whitespace().skip(1).filter_map(|t| t.parse().ok()).collect();
        if v.len() < 4 {
            return None;
        }
        // idle = idle + iowait; o resto é trabalho.
        let idle = v[3] + v.get(4).copied().unwrap_or(0);
        Some((v.iter().sum::<u64>(), idle))
    };
    let (t1, i1) = parse(a)?;
    let (t2, i2) = parse(b)?;
    let dt = t2.checked_sub(t1)?;
    let di = i2.saturating_sub(i1);
    if dt == 0 {
        return None;
    }
    Some(((dt - di.min(dt)) as f32 / dt as f32) * 100.0)
}

/// Soma do `%cpu` de todos os processos, normalizada pelo número de núcleos.
fn cpu_from_ps(text: &str, cpu_count: u32) -> Option<f32> {
    let sum: f32 = text.split_whitespace().filter_map(|t| t.parse::<f32>().ok()).sum();
    if sum == 0.0 {
        return None;
    }
    let cores = cpu_count.max(1) as f32;
    Some((sum / cores).min(100.0))
}

/// `/proc/meminfo` → (total, usado, swap total, swap usado) em bytes.
fn meminfo(text: &str) -> (u64, u64, u64, u64) {
    let kb = |key: &str| -> u64 {
        text.lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
            .map(|v| v * 1024)
            .unwrap_or(0)
    };
    let total = kb("MemTotal:");
    // MemAvailable é a métrica certa desde o kernel 3.14: cache reclamável não
    // é memória "usada" para quem está decidindo se o host aguenta mais carga.
    let available = kb("MemAvailable:");
    let swap_total = kb("SwapTotal:");
    let swap_free = kb("SwapFree:");
    (total, total.saturating_sub(available), swap_total, swap_total.saturating_sub(swap_free))
}

/// `vm_stat` do macOS → bytes em uso (total menos livre/inativa/especulativa).
fn vm_stat_used(text: &str, total: u64) -> u64 {
    let page = text
        .lines()
        .next()
        .and_then(|l| l.split("page size of ").nth(1))
        .and_then(|r| r.split_whitespace().next())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(4096);
    let pages = |key: &str| -> u64 {
        text.lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.rsplit(':').next())
            .map(|v| v.trim().trim_end_matches('.'))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let free = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * page;
    total.saturating_sub(free)
}

/// `total = 2048,00M  used = 1024,00M  free = ...` → (total, usado) em bytes.
fn swapusage(line: &str) -> (u64, u64) {
    let mb = |key: &str| -> u64 {
        line.split(key)
            .nth(1)
            .map(|r| r.trim_start_matches(" ="))
            .map(|r| r.trim())
            .and_then(|r| r.split_whitespace().next())
            .map(|v| v.replace(',', "."))
            .and_then(|v| v.trim_end_matches('M').parse::<f64>().ok())
            .map(|v| (v * 1024.0 * 1024.0) as u64)
            .unwrap_or(0)
    };
    (mb("total"), mb("used"))
}

/// `df -Pk` (formato POSIX, blocos de 1 KiB) — colunas fixas em qualquer Unix.
fn parse_df(text: &str) -> Vec<SysDisk> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 6 {
            continue;
        }
        let (Ok(total), Ok(used)) = (t[1].parse::<u64>(), t[2].parse::<u64>()) else {
            continue;
        };
        if total == 0 {
            continue; // devfs, map auto_home e afins não têm o que mostrar
        }
        let mount = t[5..].join(" ");
        if !real_mount(t[0], &mount) {
            continue;
        }
        out.push(SysDisk {
            filesystem: t[0].to_string(),
            mount,
            total: total * 1024,
            used: used * 1024,
            percent: (used as f32 / total as f32) * 100.0,
        });
    }
    // O mesmo dispositivo aparece montado várias vezes (firmlinks do macOS,
    // bind mounts no Linux); a primeira ocorrência é a que interessa.
    out.dedup_by(|a, b| a.filesystem == b.filesystem);
    out
}

/// Descarta o que não é armazenamento útil: pseudo-sistemas, montagens internas
/// do macOS, as centenas de squashfs de `snap` e as camadas do Docker.
fn real_mount(filesystem: &str, mount: &str) -> bool {
    const PSEUDO: [&str; 7] = ["/dev", "/sys", "/proc", "/run", "/snap", "/var/lib/docker", "/private/var/folders"];
    if PSEUDO.iter().any(|p| mount.starts_with(p)) {
        return false;
    }
    // No macOS, das montagens de sistema só a de dados diz algo a quem está de
    // fora — as outras são partições fixas de poucos MB ou cópias da raiz.
    if mount.starts_with("/System/Volumes/") && mount != "/System/Volumes/Data" {
        return false;
    }
    !matches!(filesystem, "devfs" | "map" | "tmpfs" | "overlay" | "none")
}

// -------------------------------------------------------------------- serviços

#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysService {
    pub unit: String,
    /// active | inactive | failed | activating…
    pub active: String,
    /// running | exited | dead | failed…
    pub sub: String,
    pub description: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn sys_services(state: State<'_, AppState>, session_id: String) -> AppResult<Vec<SysService>> {
    let handle = state.sessions.get(&session_id).await?;
    if is_win_local(&handle) {
        return Err(AppError::msg("este host não usa systemd"));
    }

    const SCRIPT: &str = r#"command -v systemctl >/dev/null 2>&1 || { echo '##NOSYSTEMD'; exit 0; }
echo '##UNITS'
systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null
echo '##ENABLED'
systemctl list-unit-files --type=service --state=enabled --no-legend --plain --no-pager 2>/dev/null
exit 0"#;

    let text = run_handle(&handle, SCRIPT).await?;
    if text.contains("##NOSYSTEMD") {
        return Err(AppError::msg("este host não usa systemd"));
    }
    Ok(parse_services(&text))
}

fn parse_services(text: &str) -> Vec<SysService> {
    let s = super::net::sections(text);
    let get = |k: &str| s.get(k).map(String::as_str).unwrap_or_default();

    let enabled: Vec<&str> = get("ENABLED")
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .collect();

    let mut out = Vec::new();
    for line in get("UNITS").lines() {
        // "nginx.service loaded active running A high performance web server"
        // Unidades com problema vêm com "●" na frente.
        let line = line.trim_start_matches(['●', '*', ' ']);
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 4 || !t[0].ends_with(".service") {
            continue;
        }
        out.push(SysService {
            unit: t[0].to_string(),
            active: t[2].to_string(),
            sub: t[3].to_string(),
            description: t[4..].join(" "),
            enabled: enabled.contains(&t[0]),
        });
    }

    // Falhas primeiro, depois ativos, depois o resto — a lista existe para
    // responder "o que quebrou?" antes de qualquer outra coisa.
    out.sort_by_key(|s| match s.active.as_str() {
        "failed" => 0,
        "activating" | "deactivating" => 1,
        "active" => 2,
        _ => 3,
    });
    out
}

/// `start`, `stop`, `restart` ou `reload` numa unidade do systemd.
#[tauri::command]
pub async fn sys_service_action(
    state: State<'_, AppState>,
    session_id: String,
    action: String,
    unit: String,
) -> AppResult<()> {
    if !matches!(action.as_str(), "start" | "stop" | "restart" | "reload") {
        return Err(AppError::msg(format!("ação inválida: {action}")));
    }
    if unit.is_empty()
        || !unit
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '@' | ':' | '\\'))
    {
        return Err(AppError::msg("nome de unidade inválido"));
    }

    let handle = state.sessions.get(&session_id).await?;
    let (code, out) = handle
        .exec(format!("{PATH_PREFIX}systemctl {action} {unit} 2>&1"))
        .await?;
    if code != 0 {
        let msg = String::from_utf8_lossy(&out).trim().to_string();
        return Err(AppError::msg(if msg.is_empty() {
            format!("falha ao executar {action} em {unit}")
        } else {
            msg
        }));
    }

    let name = state
        .db
        .get_connection(&handle.info.connection_id)
        .map(|c| c.name)
        .unwrap_or_else(|_| "Terminal local".into());
    state.db.log_event(
        "info",
        "service",
        Some(&handle.info.connection_id),
        &name,
        &format!("serviço {unit}: {action}"),
    );
    Ok(())
}

// ------------------------------------------------------------------ processos

#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysProcess {
    pub pid: u32,
    pub user: String,
    pub cpu: f32,
    pub mem: f32,
    /// Tempo desde o início, como o `ps` reporta ("01:23:45", "2-04:00:00").
    pub elapsed: String,
    pub command: String,
}

/// Teto de linhas trazidas: um host com 5 mil processos não precisa mandar
/// todos para desenhar uma lista que mostra os mais pesados.
const PROC_LIMIT: usize = 300;

#[tauri::command]
pub async fn sys_processes(state: State<'_, AppState>, session_id: String) -> AppResult<Vec<SysProcess>> {
    let handle = state.sessions.get(&session_id).await?;
    let text = if is_win_local(&handle) {
        let script = format!(
            r#"$inv = [System.Globalization.CultureInfo]::InvariantCulture
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$totBytes = [math]::Max(1, ([double]$os.TotalVisibleMemorySize * 1024))
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First {PROC_LIMIT} | ForEach-Object {{
  $cpu = if ($null -ne $_.CPU) {{ [double]$_.CPU }} else {{ 0.0 }}
  $mem = ([double]$_.WorkingSet64 / $totBytes) * 100.0
  $el = '00:00:00'
  try {{
    if ($_.StartTime) {{
      $ts = (Get-Date) - $_.StartTime
      $el = [string]::Format($inv, '{{0:00}}:{{1:00}}:{{2:00}}', [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds)
    }}
  }} catch {{}}
  Write-Output "$($_.Id) local $($cpu.ToString('0.0', $inv)) $($mem.ToString('0.0', $inv)) $el $($_.ProcessName)"
}}"#
        );
        let (_code, out) = handle.exec(script).await?;
        String::from_utf8_lossy(&out).into_owned()
    } else {
        let script = format!(
            r#"if [ "$(uname)" = "Linux" ]; then
  ps -eo pid=,user:32=,pcpu=,pmem=,etime=,args= --sort=-pcpu 2>/dev/null | head -n {PROC_LIMIT}
else
  ps -Ao pid=,user=,pcpu=,pmem=,etime=,args= -r 2>/dev/null | head -n {PROC_LIMIT}
fi
exit 0"#
        );
        run_handle(&handle, &script).await?
    };
    let out = parse_processes(&text);
    if out.is_empty() {
        return Err(AppError::msg("não deu para listar os processos deste host"));
    }
    Ok(out)
}

fn parse_processes(text: &str) -> Vec<SysProcess> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(user), Some(cpu), Some(mem), Some(elapsed)) =
            (it.next(), it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(cpu), Ok(mem)) = (pid.parse::<u32>(), cpu.parse::<f32>(), mem.parse::<f32>())
        else {
            continue;
        };
        // O resto da linha é a linha de comando inteira, com espaços.
        let command = it.collect::<Vec<&str>>().join(" ");
        if command.is_empty() {
            continue;
        }
        out.push(SysProcess {
            pid,
            user: user.to_string(),
            cpu,
            mem,
            elapsed: elapsed.to_string(),
            command,
        });
    }
    out.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
    out
}

/// Manda um sinal a um processo. `term` pede saída limpa; `kill` não pede nada.
#[tauri::command]
pub async fn sys_kill(
    state: State<'_, AppState>,
    session_id: String,
    pid: u32,
    signal: String,
) -> AppResult<()> {
    let sig = match signal.as_str() {
        "term" => "TERM",
        "kill" => "KILL",
        "hup" => "HUP",
        other => return Err(AppError::msg(format!("sinal inválido: {other}"))),
    };
    if pid <= 1 {
        return Err(AppError::msg("pid inválido"));
    }

    let handle = state.sessions.get(&session_id).await?;
    let cmd = if is_win_local(&handle) {
        format!("Stop-Process -Id {pid} -Force -ErrorAction Stop")
    } else {
        format!("kill -{sig} {pid} 2>&1")
    };
    let (code, out) = handle.exec(cmd).await?;
    if code != 0 {
        let msg = String::from_utf8_lossy(&out).trim().to_string();
        return Err(AppError::msg(if msg.is_empty() {
            format!("não deu para enviar {sig} ao processo {pid}")
        } else {
            msg
        }));
    }

    let name = state
        .db
        .get_connection(&handle.info.connection_id)
        .map(|c| c.name)
        .unwrap_or_else(|_| "Terminal local".into());
    state.db.log_event(
        "warn",
        "process",
        Some(&handle.info.connection_id),
        &name,
        &format!("sinal {sig} enviado ao pid {pid}"),
    );
    Ok(())
}

// --------------------------------------------------------------------- portas

#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysPort {
    /// tcp | udp
    pub proto: String,
    /// Endereço de escuta ("0.0.0.0", "::", "127.0.0.1").
    pub address: String,
    pub port: u16,
    pub process: String,
    pub pid: Option<u32>,
}

#[tauri::command]
pub async fn sys_ports(state: State<'_, AppState>, session_id: String) -> AppResult<Vec<SysPort>> {
    const SCRIPT: &str = r#"if command -v ss >/dev/null 2>&1; then
  echo '##SS'
  ss -tulpnH 2>/dev/null || ss -tulpn 2>/dev/null
elif command -v netstat >/dev/null 2>&1 && [ "$(uname)" = "Linux" ]; then
  echo '##NETSTAT'
  netstat -tulpn 2>/dev/null
elif command -v lsof >/dev/null 2>&1; then
  echo '##LSOF'
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null
  lsof -nP -iUDP 2>/dev/null
fi
exit 0"#;

    const WINDOWS_PORTS_SCRIPT: &str = r#"$procs = @{}
Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $procs[[uint32]$_.Id] = $_.ProcessName }
Write-Output '##SS'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $addr = if ($_.LocalAddress -match ':') { "[$($_.LocalAddress)]" } else { $_.LocalAddress }
  $pname = $procs[[uint32]$_.OwningProcess]
  if (-not $pname) { $pname = 'system' }
  Write-Output "tcp LISTEN 0 0 ${addr}:$($_.LocalPort) *:* users:((""$pname"",pid=$($_.OwningProcess),fd=0))"
}
Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object {
  $addr = if ($_.LocalAddress -match ':') { "[$($_.LocalAddress)]" } else { $_.LocalAddress }
  $pname = $procs[[uint32]$_.OwningProcess]
  if (-not $pname) { $pname = 'system' }
  Write-Output "udp UNCONN 0 0 ${addr}:$($_.LocalPort) *:* users:((""$pname"",pid=$($_.OwningProcess),fd=0))"
}"#;

    let handle = state.sessions.get(&session_id).await?;
    let text = if is_win_local(&handle) {
        let (_code, out) = handle.exec(WINDOWS_PORTS_SCRIPT.to_string()).await?;
        String::from_utf8_lossy(&out).into_owned()
    } else {
        run_handle(&handle, SCRIPT).await?
    };
    let s = super::net::sections(&text);
    let get = |k: &str| s.get(k).map(String::as_str).unwrap_or_default();

    let mut out = if s.contains_key("SS") {
        parse_ss(get("SS"))
    } else if s.contains_key("NETSTAT") {
        parse_netstat_ports(get("NETSTAT"))
    } else if s.contains_key("LSOF") {
        parse_lsof(get("LSOF"))
    } else {
        return Err(AppError::msg(
            "não deu para listar as portas (sem `ss`, `netstat` ou `lsof`)",
        ));
    };

    out.sort_by_key(|p| (p.port, p.proto.clone()));
    out.dedup_by(|a, b| a.port == b.port && a.proto == b.proto && a.address == b.address);
    Ok(out)
}

/// `ss -tulpnH`: "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=800,fd=3))"
fn parse_ss(text: &str) -> Vec<SysPort> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 5 {
            continue;
        }
        let proto = match t[0] {
            "tcp" | "tcp6" => "tcp",
            "udp" | "udp6" => "udp",
            _ => continue,
        };
        // UDP não tem estado LISTEN; TCP sem LISTEN é conexão, não escuta.
        if proto == "tcp" && t[1] != "LISTEN" {
            continue;
        }
        let Some((address, port)) = split_host_port(t[4]) else {
            continue;
        };
        let (process, pid) = ss_users(line);
        out.push(SysPort { proto: proto.into(), address, port, process, pid });
    }
    out
}

/// `users:(("sshd",pid=800,fd=3))` → ("sshd", 800).
fn ss_users(line: &str) -> (String, Option<u32>) {
    let Some(rest) = line.split("users:((\"").nth(1) else {
        return (String::new(), None);
    };
    let name = rest.split('"').next().unwrap_or_default().to_string();
    let pid = rest
        .split("pid=")
        .nth(1)
        .and_then(|r| r.split(|c: char| !c.is_ascii_digit()).find(|t| !t.is_empty()))
        .and_then(|v| v.parse().ok());
    (name, pid)
}

/// `netstat -tulpn`: "tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 800/sshd"
fn parse_netstat_ports(text: &str) -> Vec<SysPort> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 5 {
            continue;
        }
        let proto = match t[0] {
            "tcp" | "tcp6" => "tcp",
            "udp" | "udp6" => "udp",
            _ => continue,
        };
        if proto == "tcp" && !t.contains(&"LISTEN") {
            continue;
        }
        let Some((address, port)) = split_host_port(t[3]) else {
            continue;
        };
        // Última coluna: "800/sshd" ou "-" quando falta permissão.
        let (pid, process) = match t.last().and_then(|v| v.split_once('/')) {
            Some((p, name)) => (p.parse().ok(), name.to_string()),
            None => (None, String::new()),
        };
        out.push(SysPort { proto: proto.into(), address, port, process, pid });
    }
    out
}

/// `lsof -nP -iTCP -sTCP:LISTEN`: "sshd 800 root 3u IPv4 0t0 TCP *:22 (LISTEN)"
fn parse_lsof(text: &str) -> Vec<SysPort> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 8 || t[0] == "COMMAND" {
            continue;
        }
        let proto = match t[7] {
            "TCP" => "tcp",
            "UDP" => "udp",
            _ => continue,
        };
        let Some((address, port)) = t.get(8).and_then(|v| split_host_port(v)) else {
            continue;
        };
        out.push(SysPort {
            proto: proto.into(),
            address: if address == "*" { "0.0.0.0".into() } else { address },
            port,
            process: t[0].to_string(),
            pid: t[1].parse().ok(),
        });
    }
    out
}

/// "0.0.0.0:22", "[::]:22", "*:22" → (endereço, porta).
fn split_host_port(value: &str) -> Option<(String, u16)> {
    let (host, port) = value.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    Some((host.to_string(), port))
}

// ------------------------------------------------------------- atualizações

#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysUpdates {
    /// apt | dnf | yum | apk | pacman | brew — vazio se nenhum foi reconhecido.
    pub manager: String,
    pub packages: Vec<String>,
    pub reboot_required: bool,
}

#[tauri::command]
pub async fn sys_updates(state: State<'_, AppState>, session_id: String) -> AppResult<SysUpdates> {
    let handle = state.sessions.get(&session_id).await?;
    if is_win_local(&handle) {
        return Err(AppError::msg(
            "gerenciador de pacotes não reconhecido neste host",
        ));
    }

    // Só consultas: nada aqui instala, atualiza índice ou pede root.
    const SCRIPT: &str = r#"if command -v apt >/dev/null 2>&1; then
  echo '##MANAGER'; echo apt
  echo '##PKGS'; apt list --upgradable 2>/dev/null | tail -n +2
elif command -v dnf >/dev/null 2>&1; then
  echo '##MANAGER'; echo dnf
  echo '##PKGS'; dnf -q check-update 2>/dev/null
elif command -v yum >/dev/null 2>&1; then
  echo '##MANAGER'; echo yum
  echo '##PKGS'; yum -q check-update 2>/dev/null
elif command -v apk >/dev/null 2>&1; then
  echo '##MANAGER'; echo apk
  echo '##PKGS'; apk -u list 2>/dev/null
elif command -v pacman >/dev/null 2>&1; then
  echo '##MANAGER'; echo pacman
  echo '##PKGS'; pacman -Qu 2>/dev/null
elif command -v brew >/dev/null 2>&1; then
  echo '##MANAGER'; echo brew
  # Sem auto-update: consultar não pode virar uma atualização de índice de 30s.
  echo '##PKGS'; HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --quiet 2>/dev/null
fi
echo '##REBOOT'
if [ -f /var/run/reboot-required ]; then echo sim; fi
exit 0"#;

    let text = run_handle(&handle, SCRIPT).await?;
    let s = super::net::sections(&text);
    let get = |k: &str| s.get(k).map(String::as_str).unwrap_or_default();

    let manager = get("MANAGER").trim().to_string();
    if manager.is_empty() {
        return Err(AppError::msg(
            "gerenciador de pacotes não reconhecido neste host",
        ));
    }

    let packages = get("PKGS")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("Listing") && !l.starts_with("Obsoleting"))
        .map(|l| l.to_string())
        .collect();

    Ok(SysUpdates {
        manager,
        packages,
        reboot_required: !get("REBOOT").trim().is_empty(),
    })
}

// ------------------------------------------------------------ cauda de arquivo

/// Teto de linhas por leitura — o painel mostra uma janela, não o arquivo todo.
const TAIL_MAX_LINES: u32 = 2000;

/// Últimas linhas de um arquivo do host, com filtro opcional.
///
/// É poll, não `tail -f`: cada chamada abre um exec, lê o fim e sai. Um `-f` de
/// verdade precisaria de um canal de streaming próprio, e prender um canal por
/// painel aberto custa mais do que reler 200 linhas a cada dois segundos.
#[tauri::command]
pub async fn sys_tail(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    lines: u32,
    filter: String,
) -> AppResult<String> {
    if path.trim().is_empty() {
        return Err(AppError::msg("informe o caminho do arquivo"));
    }
    let lines = lines.clamp(1, TAIL_MAX_LINES);

    let handle = state.sessions.get(&session_id).await?;
    let cmd = if is_win_local(&handle) {
        let mut c = format!("Get-Content -LiteralPath {} -Tail {lines}", ps_quote(&path));
        if !filter.is_empty() {
            c.push_str(&format!(
                " | Select-String -SimpleMatch {} | ForEach-Object {{ $_.Line }}",
                ps_quote(&filter)
            ));
        }
        c
    } else {
        let mut c = format!("tail -n {lines} -- {}", quote(&path));
        if !filter.is_empty() {
            c.push_str(&format!(" | grep -F -- {}", quote(&filter)));
        }
        c.push_str(" 2>&1");
        c
    };

    let (code, out) = handle.exec(cmd).await?;
    let text = String::from_utf8_lossy(&out).into_owned();
    // grep sem casar sai com 1 e sem texto: é resultado vazio, não erro.
    if code != 0 && !text.trim().is_empty() {
        return Err(AppError::msg(text.trim().to_string()));
    }
    Ok(text)
}

// -------------------------------------------------------------------- helpers

/// Roda um script na sessão já obtida e devolve a saída como texto.
async fn run_handle(handle: &crate::ssh::SessionHandle, script: &str) -> AppResult<String> {
    let (_code, out) = handle.exec(format!("{PATH_PREFIX}{script}")).await?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Aspas simples para a linha de comando — o caminho e o filtro vêm do usuário,
/// e validar caractere a caractere proibiria nomes de arquivo legítimos.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumo_do_linux() {
        let text = "##OS\nLinux 6.8.0-45-generic\nUbuntu 24.04.1 LTS\n##UPTIME\n123456.78\n##LOAD\n0.52 0.61 0.58 2/431 9876\n##NCPU\n4\n##STAT1\ncpu  100 0 50 800 50 0 0 0 0 0\n##STAT2\ncpu  150 0 70 900 60 0 0 0 0 0\n##MEM\nMemTotal:        8000000 kB\nMemFree:          500000 kB\nMemAvailable:    3000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n##DF\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 51475068 20590027 30885041 40% /\ntmpfs 4000000 0 4000000 0% /run\n";
        let o = parse_overview(text);
        assert_eq!(o.os, "Ubuntu 24.04.1 LTS");
        assert_eq!(o.kernel, "Linux 6.8.0-45-generic");
        assert_eq!(o.uptime_secs, 123456);
        assert_eq!(o.load, [0.52, 0.61, 0.58]);
        assert_eq!(o.cpu_count, 4);
        // 70 ticks de trabalho em 180 de intervalo (o resto foi idle+iowait).
        let cpu = o.cpu_percent.expect("uso de cpu");
        assert!((cpu - 38.889).abs() < 0.01, "cpu = {cpu}");
        assert_eq!(o.mem_total, 8_000_000 * 1024);
        assert_eq!(o.mem_used, 5_000_000 * 1024); // total - available
        assert_eq!(o.swap_used, 500_000 * 1024);
        // /run é pseudo-sistema e não entra na lista.
        assert_eq!(o.disks.len(), 1);
        assert_eq!(o.disks[0].mount, "/");
        assert_eq!(o.disks[0].total, 51_475_068 * 1024);
    }

    #[test]
    fn resumo_do_macos() {
        let text = "##OS\nDarwin 24.6.0\nmacOS\n##BOOTTIME\n{ sec = 1000, usec = 0 } Qui\n##LOAD\n{ 1.52 1.68 1.72 }\n##NCPU\n8\n##PSCPU\n16\n##MEMSIZE\n17179869184\n##VMSTAT\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                     100000.\nPages inactive:                  50000.\nPages speculative:               10000.\n##SWAP\ntotal = 2048,00M  used = 512,00M  free = 1536,00M\n##DF\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1s1 971350180 10000000 900000000 2% /\n";
        let o = parse_overview(text);
        assert_eq!(o.os, "macOS");
        assert!(o.uptime_secs > 1_700_000_000, "uptime = {}", o.uptime_secs);
        assert_eq!(o.load, [1.52, 1.68, 1.72]);
        // 16 de %cpu somado em 8 núcleos.
        assert_eq!(o.cpu_percent, Some(2.0));
        assert_eq!(o.mem_total, 17_179_869_184);
        assert_eq!(o.mem_used, 17_179_869_184 - 160_000 * 16384);
        assert_eq!(o.swap_total, 2048 * 1024 * 1024);
        assert_eq!(o.swap_used, 512 * 1024 * 1024);
    }

    #[test]
    fn df_deixa_de_fora_o_que_nao_e_armazenamento() {
        let text = "##DF\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1s1 971350180 17948180 113171660 14% /\ndevfs 212 212 0 100% /dev\n/dev/disk3s6 971350180 3146164 113171660 3% /System/Volumes/VM\n/dev/disk3s5 971350180 818252716 113171660 88% /System/Volumes/Data\n/dev/loop12 130000 130000 0 100% /snap/core22/1122\n/dev/disk5s1 1041768 950556 91212 92% /Volumes/VS Code Insiders\n";
        let disks = parse_df(&super::super::net::sections(text)["DF"]);
        let mounts: Vec<&str> = disks.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, ["/", "/System/Volumes/Data", "/Volumes/VS Code Insiders"]);
        // Nome com espaço não pode quebrar a coluna de montagem.
        assert_eq!(disks[2].percent.round(), 91.0);
    }

    #[test]
    fn servicos_com_falha_vem_primeiro() {
        let text = "##UNITS\n  ssh.service loaded active running OpenBSD Secure Shell server\n● nginx.service loaded failed failed A high performance web server\n  cron.service loaded active running Regular background program\n  dbus.socket loaded active running D-Bus\n##ENABLED\nssh.service enabled enabled\n";
        let list = parse_services(text);
        assert_eq!(list.len(), 3); // .socket não é serviço
        assert_eq!(list[0].unit, "nginx.service");
        assert_eq!(list[0].active, "failed");
        assert_eq!(list[0].description, "A high performance web server");
        assert!(list.iter().find(|s| s.unit == "ssh.service").unwrap().enabled);
        assert!(!list.iter().find(|s| s.unit == "cron.service").unwrap().enabled);
    }

    #[test]
    fn processos_ordenados_por_cpu() {
        let text = "  800 root      0.3  1.2 10-04:03:02 /usr/sbin/sshd -D\n 1234 www-data 55.0  8.4    01:02:03 nginx: worker process\ninválido\n";
        let list = parse_processes(text);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].pid, 1234);
        assert_eq!(list[0].user, "www-data");
        assert_eq!(list[0].command, "nginx: worker process");
        assert_eq!(list[1].elapsed, "10-04:03:02");
    }

    #[test]
    fn portas_do_ss() {
        let text = "tcp   LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*    users:((\"sshd\",pid=800,fd=3))\ntcp   ESTAB  0      0      10.0.0.1:22       10.0.0.9:51234\nudp   UNCONN 0      0      [::]:53           [::]:*       users:((\"systemd-resolve\",pid=700,fd=12))\n";
        let list = parse_ss(text);
        assert_eq!(list.len(), 2); // a conexão ESTAB não é escuta
        assert_eq!((list[0].port, list[0].proto.as_str()), (22, "tcp"));
        assert_eq!(list[0].process, "sshd");
        assert_eq!(list[0].pid, Some(800));
        assert_eq!(list[1].address, "::");
        assert_eq!(list[1].process, "systemd-resolve");
    }

    #[test]
    fn portas_do_netstat_e_do_lsof() {
        let n = parse_netstat_ports("tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN 900/nginx\ntcp 0 0 127.0.0.1:5432 0.0.0.0:* LISTEN -\n");
        assert_eq!(n.len(), 2);
        assert_eq!((n[0].port, n[0].process.as_str(), n[0].pid), (80, "nginx", Some(900)));
        assert_eq!(n[1].pid, None);

        let l = parse_lsof("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nsshd 800 root 3u IPv4 0xa1b2c3 0t0 TCP *:22 (LISTEN)\n");
        assert_eq!(l.len(), 1);
        assert_eq!((l[0].port, l[0].address.as_str(), l[0].pid), (22, "0.0.0.0", Some(800)));
    }

    #[test]
    fn aspas_protegem_caminho_com_espaco_e_apostrofo() {
        assert_eq!(quote("/var/log/app.log"), "'/var/log/app.log'");
        assert_eq!(quote("/tmp/o'brien; rm -rf /"), r"'/tmp/o'\''brien; rm -rf /'");
    }
}
