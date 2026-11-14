//! Terminal local: um shell da própria máquina com PTY, exposto ao frontend
//! pela mesma interface das sessões SSH.
//!
//! Do lado da UI não há diferença — mesmo `SessionCmd`, mesmo canal de saída,
//! mesma gravação. O que muda é a origem dos bytes: em vez de um canal SSH,
//! um `portable_pty` falando com o shell do usuário.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel as IpcChannel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

use crate::error::{AppError, AppResult};
use crate::ssh::session::SessionCmd;

/// Mesma janela de coalescing do stream SSH: 8 ms fica abaixo do limiar
/// perceptível ao digitar e derruba a taxa de mensagens de IPC.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const FLUSH_BYTES: usize = 64 * 1024;

/// Flag `CREATE_NO_WINDOW` do Win32 para evitar flash de console em subprocessos
/// auxiliares (`wsl.exe --list`, exec em segundo plano, etc.).
#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Id reservado para a conexão sintética do terminal local.
pub const LOCAL_CONNECTION_ID: &str = "__local__";

/// Prefixo reservado para conexões sintéticas de distribuições WSL no Windows.
pub const WSL_CONNECTION_PREFIX: &str = "__wsl__:";

/// Informa se o identificador pertence a uma sessão local (shell nativo ou WSL).
#[allow(dead_code)]
pub fn is_local_connection_id(id: &str) -> bool {
    id == LOCAL_CONNECTION_ID || id.starts_with(WSL_CONNECTION_PREFIX)
}

/// Extrai o nome da distribuição WSL de um `connection_id` (`__wsl__:<distro>`).
#[allow(dead_code)]
pub fn wsl_distro_from_connection_id(id: &str) -> Option<&str> {
    id.strip_prefix(WSL_CONNECTION_PREFIX)
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub id: String,
    pub name: String,
    pub icon: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionClosed {
    session_id: String,
    exit_status: Option<u32>,
    reason: String,
}

/// Escolhe um identificador de ícone correspondente ao nome da distro WSL.
pub fn distro_icon(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.contains("ubuntu") {
        "ubuntu"
    } else if lower.contains("debian") {
        "debian"
    } else if lower.contains("arch") {
        "arch"
    } else if lower.contains("kali") {
        "kali"
    } else if lower.contains("fedora") {
        "fedora"
    } else if lower.contains("alpine") {
        "alpine"
    } else if lower.contains("opensuse") || lower.contains("suse") {
        "opensuse"
    } else if lower.contains("nixos") {
        "nixos"
    } else if lower.contains("redhat") || lower.contains("rhel") {
        "redhat"
    } else if lower.contains("rocky") {
        "rocky"
    } else if lower.contains("alma") {
        "alma"
    } else {
        "linux"
    }
}

/// Interpreta a saída de `wsl.exe --list --quiet` (UTF-16LE com ou sem BOM, ou UTF-8),
/// removendo entradas utilitárias como `docker-desktop`.
pub fn parse_wsl_list_output(bytes: &[u8]) -> Vec<WslDistro> {
    if bytes.is_empty() {
        return Vec::new();
    }

    let has_utf16le_bom = bytes.starts_with(&[0xFF, 0xFE]);
    let looks_utf16le = has_utf16le_bom
        || (bytes.len() >= 2
            && bytes.len() % 2 == 0
            && bytes.iter().skip(1).step_by(2).take(8).any(|&b| b == 0));

    let text = if looks_utf16le {
        let slice = if has_utf16le_bom { &bytes[2..] } else { bytes };
        let units: Vec<u16> = slice
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };

    let mut out = Vec::new();
    for raw in text.lines() {
        let cleaned: String = raw
            .chars()
            .filter(|&c| c != '\u{feff}' && c != '\0' && c != '\r')
            .collect();
        let name = cleaned.trim().to_string();
        if name.is_empty() {
            continue;
        }
        if name.eq_ignore_ascii_case("docker-desktop")
            || name.eq_ignore_ascii_case("docker-desktop-data")
        {
            continue;
        }
        let icon = distro_icon(&name).to_string();
        out.push(WslDistro {
            id: format!("{WSL_CONNECTION_PREFIX}{name}"),
            name,
            icon,
        });
    }
    out
}

/// Lista as distribuições WSL instaladas no Windows (vazio em macOS e Linux).
pub fn list_wsl_distros() -> Vec<WslDistro> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let Ok(out) = std::process::Command::new("wsl.exe")
            .args(["--list", "--quiet"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        else {
            return Vec::new();
        };
        if out.status.success() {
            parse_wsl_list_output(&out.stdout)
        } else {
            Vec::new()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

fn binary_stem(shell: &str) -> String {
    let base = shell.rsplit(['/', '\\']).next().unwrap_or(shell).trim();
    let lower = base.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

pub fn is_powershell_binary(shell: &str) -> bool {
    matches!(binary_stem(shell).as_str(), "pwsh" | "powershell")
}

pub fn is_cmd_binary(shell: &str) -> bool {
    binary_stem(shell) == "cmd"
}

pub fn shell_args_for_binary(shell: &str) -> Vec<String> {
    match binary_stem(shell).as_str() {
        "pwsh" | "powershell" => vec!["-NoLogo".into()],
        "cmd" => Vec::new(),
        "wsl" => vec!["--cd".into(), "~".into()],
        _ => vec!["-l".into()],
    }
}

#[cfg(target_os = "windows")]
fn find_in_path(exe: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Shell a usar: o preferido do usuário, com fallback nativo por sistema.
/// No Windows, usa PowerShell (`pwsh.exe` ou `powershell.exe`), nunca `cmd.exe`.
fn resolve_shell(requested: Option<&str>) -> (String, Vec<String>) {
    if let Some(s) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        return (s.to_string(), shell_args_for_binary(s));
    }

    #[cfg(target_os = "windows")]
    {
        let bin = find_in_path("pwsh.exe").unwrap_or_else(|| "powershell.exe".into());
        let args = shell_args_for_binary(&bin);
        (bin, args)
    }

    #[cfg(target_os = "linux")]
    {
        let bin = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                if std::path::Path::new("/bin/bash").exists() {
                    "/bin/bash".into()
                } else {
                    "/bin/sh".into()
                }
            });
        let args = shell_args_for_binary(&bin);
        (bin, args)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let bin = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/zsh".into());
        let args = shell_args_for_binary(&bin);
        (bin, args)
    }
}

/// Abre o shell local (ou uma distro WSL) num PTY e devolve o canal de comandos.
pub fn spawn(
    app: AppHandle,
    session_id: String,
    shell: Option<&str>,
    wsl_distro: Option<&str>,
    cols: u16,
    rows: u16,
    out: IpcChannel<InvokeResponseBody>,
) -> AppResult<(mpsc::Sender<SessionCmd>, String)> {
    let clean_distro = wsl_distro
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let (shell_prog, shell_args, label) = if let Some(ref distro) = clean_distro {
        (
            "wsl.exe".to_string(),
            vec!["-d".into(), distro.clone(), "--cd".into(), "~".into()],
            format!("wsl.exe -d {distro}"),
        )
    } else {
        let (prog, args) = resolve_shell(shell);
        let label = prog.clone();
        (prog, args, label)
    };

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::msg(format!("não foi possível abrir o PTY: {e}")))?;

    let mut cmd = CommandBuilder::new(&shell_prog);
    for arg in &shell_args {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "fs-ssh");
    if clean_distro.is_none() {
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::msg(format!("não foi possível iniciar {label}: {e}")))?;
    // O lado escravo precisa ser fechado aqui: enquanto ele existir, o EOF do
    // master nunca chega e a saída do shell não termina quando ele morre.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::msg(format!("PTY sem leitor: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::msg(format!("PTY sem escritor: {e}")))?;

    // O `portable_pty` é bloqueante; leitura e escrita ficam em threads e
    // conversam com a task da sessão por canais.
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut writer = writer;
        while let Ok(data) = in_rx.recv() {
            if writer.write_all(&data).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });

    // Espera o shell terminar sem bloquear a runtime.
    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<Option<u32>>();
    std::thread::spawn(move || {
        let status = child.wait().ok().map(|s| s.exit_code());
        let _ = exit_tx.send(status);
    });

    let (tx, rx) = mpsc::channel(64);
    let master = Arc::new(Mutex::new(pair.master));
    tauri::async_runtime::spawn(run_local_session(
        app,
        session_id,
        shell_prog,
        clean_distro,
        rx,
        out,
        out_rx,
        in_tx,
        master,
        exit_rx,
    ));

    Ok((tx, label))
}

#[allow(clippy::too_many_arguments)]
async fn run_local_session(
    app: AppHandle,
    session_id: String,
    shell_prog: String,
    wsl_distro: Option<String>,
    mut rx: mpsc::Receiver<SessionCmd>,
    out: IpcChannel<InvokeResponseBody>,
    mut out_rx: mpsc::Receiver<Vec<u8>>,
    in_tx: std::sync::mpsc::Sender<Vec<u8>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    mut exit_rx: tokio::sync::oneshot::Receiver<Option<u32>>,
) {
    let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut recorder = crate::ssh::session::Recorder::none();
    let mut exit_status: Option<u32> = None;
    let reason;

    loop {
        tokio::select! {
            biased;

            cmd = rx.recv() => match cmd {
                Some(SessionCmd::Write(data)) => {
                    if in_tx.send(data).is_err() {
                        reason = "shell encerrado".to_string();
                        break;
                    }
                }
                Some(SessionCmd::Resize { cols, rows }) => {
                    if let Ok(m) = master.lock() {
                        let _ = m.resize(PtySize {
                            rows: rows.max(1) as u16,
                            cols: cols.max(1) as u16,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                }
                Some(SessionCmd::Record { path, format, cols, rows, reply }) => {
                    let _ = reply.send(recorder.set(path, &format, cols, rows));
                }
                // Exec vale para a própria máquina: é o que faz o painel de
                // containers funcionar no terminal local. Roda fora do PTY,
                // como no SSH, para não sujar a tela do usuário.
                Some(SessionCmd::Exec { command, reply }) => {
                    let shell = shell_prog.clone();
                    let distro = wsl_distro.clone();
                    tokio::spawn(async move {
                        let _ = reply.send(run_local_command(shell, distro, command).await);
                    });
                }
                // Recursos que só existem sobre SSH. A mensagem é explícita
                // para o frontend poder mostrá-la sem adivinhar.
                Some(SessionCmd::OpenSftp(reply)) => {
                    let _ = reply.send(Err("o terminal local não tem SFTP".into()));
                }
                Some(SessionCmd::OpenDirectTcpip { reply, .. }) => {
                    let _ = reply.send(Err("túneis exigem uma sessão SSH".into()));
                }
                Some(SessionCmd::TcpipForward { reply, .. }) => {
                    let _ = reply.send(Err("túneis exigem uma sessão SSH".into()));
                }
                Some(SessionCmd::Close) => {
                    reason = "encerrada pelo usuário".to_string();
                    break;
                }
                None => {
                    reason = "handle descartado".to_string();
                    break;
                }
            },

            data = out_rx.recv() => match data {
                Some(data) => {
                    recorder.write(&data);
                    buf.extend_from_slice(&data);
                    if buf.len() >= FLUSH_BYTES {
                        flush(&out, &mut buf);
                    }
                }
                None => {
                    reason = "shell encerrado".to_string();
                    break;
                }
            },

            status = &mut exit_rx => {
                exit_status = status.ok().flatten();
                reason = "shell encerrado".to_string();
                break;
            }

            _ = ticker.tick() => {
                if !buf.is_empty() {
                    flush(&out, &mut buf);
                }
            }
        }
    }

    if !buf.is_empty() {
        flush(&out, &mut buf);
    }
    recorder.finish();

    let _ = app.emit(
        "session-closed",
        SessionClosed {
            session_id,
            exit_status,
            reason,
        },
    );
}

/// Tempo máximo de um exec local — mesmo teto do exec por SSH.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);

/// Executa um comando na máquina local (ou dentro da distro WSL) e devolve `(código, stdout+stderr)`.
///
/// No Unix usa o shell em modo de login (`-lc`) para preservar o `PATH`;
/// no Windows nativo usa PowerShell (`-NoLogo -NoProfile -NonInteractive -Command`)
/// e no WSL encaminha via `wsl.exe -d <distro> -- sh -lc <command>`.
async fn run_local_command(
    shell: String,
    wsl_distro: Option<String>,
    command: String,
) -> Result<(u32, Vec<u8>), String> {
    let mut cmd = if let Some(distro) = wsl_distro {
        let mut c = tokio::process::Command::new("wsl.exe");
        c.args(["-d", &distro, "--", "sh", "-lc", &command]);
        c
    } else if is_powershell_binary(&shell) {
        let mut c = tokio::process::Command::new(&shell);
        c.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &command]);
        c
    } else if is_cmd_binary(&shell) {
        let mut c = tokio::process::Command::new(&shell);
        c.args(["/C", &command]);
        c
    } else {
        let mut c = tokio::process::Command::new(&shell);
        c.args(["-lc", &command]);
        c
    };

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let run = cmd.output();

    match tokio::time::timeout(EXEC_TIMEOUT, run).await {
        Ok(Ok(out)) => {
            let mut buf = out.stdout;
            buf.extend_from_slice(&out.stderr);
            Ok((out.status.code().unwrap_or(0).max(0) as u32, buf))
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!(
            "comando não terminou em {}s",
            EXEC_TIMEOUT.as_secs()
        )),
    }
}

fn flush(out: &IpcChannel<InvokeResponseBody>, buf: &mut Vec<u8>) {
    let payload = std::mem::replace(buf, Vec::with_capacity(FLUSH_BYTES));
    if let Err(e) = out.send(InvokeResponseBody::Raw(payload)) {
        tracing::debug!("canal de saída local fechado: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wsl_utf16le_and_filters_docker_desktop() {
        let raw = "\u{feff}Ubuntu-24.04\r\ndocker-desktop\r\ndocker-desktop-data\r\nDebian\r\n";
        let mut bytes = Vec::new();
        for u in raw.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let parsed = parse_wsl_list_output(&bytes);
        assert_eq!(
            parsed,
            vec![
                WslDistro {
                    id: "__wsl__:Ubuntu-24.04".into(),
                    name: "Ubuntu-24.04".into(),
                    icon: "ubuntu".into(),
                },
                WslDistro {
                    id: "__wsl__:Debian".into(),
                    name: "Debian".into(),
                    icon: "debian".into(),
                },
            ]
        );
    }

    #[test]
    fn parses_wsl_utf8_output() {
        let parsed = parse_wsl_list_output(b"Arch\nkali-linux\n");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].icon, "arch");
        assert_eq!(parsed[1].icon, "kali");
    }

    #[test]
    fn maps_distro_icons() {
        assert_eq!(distro_icon("Ubuntu-24.04"), "ubuntu");
        assert_eq!(distro_icon("Debian"), "debian");
        assert_eq!(distro_icon("Arch"), "arch");
        assert_eq!(distro_icon("kali-linux"), "kali");
        assert_eq!(distro_icon("FedoraLinux-42"), "fedora");
        assert_eq!(distro_icon("openSUSE-Tumbleweed"), "opensuse");
        assert_eq!(distro_icon("custom-distro"), "linux");
    }

    #[test]
    fn selects_shell_args_by_binary() {
        assert_eq!(shell_args_for_binary("powershell.exe"), vec!["-NoLogo"]);
        assert_eq!(
            shell_args_for_binary(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            vec!["-NoLogo"]
        );
        assert!(shell_args_for_binary("cmd.exe").is_empty());
        assert_eq!(shell_args_for_binary("/bin/zsh"), vec!["-l"]);
        assert_eq!(shell_args_for_binary("/bin/bash"), vec!["-l"]);
    }

    #[test]
    fn identifies_local_and_wsl_connections() {
        assert!(is_local_connection_id(LOCAL_CONNECTION_ID));
        assert!(is_local_connection_id("__wsl__:Ubuntu"));
        assert!(!is_local_connection_id("conn-123"));
        assert_eq!(wsl_distro_from_connection_id("__wsl__:Ubuntu"), Some("Ubuntu"));
        assert_eq!(wsl_distro_from_connection_id("__wsl__:"), None);
        assert_eq!(wsl_distro_from_connection_id(LOCAL_CONNECTION_ID), None);
    }
}
