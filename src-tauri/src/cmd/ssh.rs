use std::collections::{HashMap, HashSet};

use tauri::ipc::{Channel as IpcChannel, InvokeResponseBody};
use tauri::{AppHandle, State};
use tokio::sync::mpsc;

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::ssh::session::{run_session, SessionCmd};
use crate::ssh::{connect, SessionInfo, SessionManager};

/// Profundidade da fila de comandos por sessão. Só carrega input de teclado e
/// resize, então algumas dezenas bastam; se encher, o servidor já parou de ler.
const CMD_QUEUE: usize = 64;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub connection_id: String,
    pub cols: u32,
    pub rows: u32,
    /// Passphrase da chave ou senha do usuário, quando o frontend já perguntou.
    pub secret: Option<String>,
    /// Segredo do jump host (bastion), coletado num prompt separado.
    pub jump_secret: Option<String>,
}

/// Abre uma sessão SSH com PTY e começa a transmitir a saída pelo `on_output`.
///
/// Pode retornar `host_key_unknown` ou `auth_required`: são passos do fluxo, não
/// falhas — o frontend mostra o diálogo correspondente e chama de novo.
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ConnectArgs,
    on_output: IpcChannel<InvokeResponseBody>,
) -> AppResult<SessionInfo> {
    let conn = state.db.get_connection(&args.connection_id)?;

    let identity = match &conn.identity_id {
        Some(id) => state.db.get_identity(id)?,
        None => None,
    };

    let jump_conn = match &conn.jump_host_id {
        Some(id) => Some(state.db.get_connection(id)?),
        None => None,
    };
    let jump_identity = match jump_conn.as_ref().and_then(|c| c.identity_id.clone()) {
        Some(id) => state.db.get_identity(&id)?,
        None => None,
    };

    let connected = match connect::connect(
        state.db.clone(),
        &conn,
        jump_conn.as_ref(),
        identity.as_ref(),
        jump_identity.as_ref(),
        args.secret.as_deref(),
        args.jump_secret.as_deref(),
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            // Pedido de senha/host key é passo do fluxo, não falha — não polui
            // o log com um "erro" a cada diálogo.
            let routine = matches!(
                e,
                AppError::AuthRequired { .. }
                    | AppError::HostKeyUnknown { .. }
                    | AppError::HostKeyChanged { .. }
            );
            if !routine {
                state.db.log_event(
                    "error",
                    "connect",
                    Some(&conn.id),
                    &conn.name,
                    &format!("falha ao conectar em {}@{}: {e}", conn.username, conn.host),
                );
            }
            return Err(e);
        }
    };

    let channel = connected.handle.channel_open_session().await?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            args.cols.max(1),
            args.rows.max(1),
            0,
            0,
            &[],
        )
        .await?;
    channel.request_shell(true).await?;

    let session_id = SessionManager::new_id();
    let info = SessionInfo {
        session_id: session_id.clone(),
        connection_id: conn.id.clone(),
        host: conn.host.clone(),
        username: conn.username.clone(),
        fingerprint: connected.host_fingerprint.clone(),
        banner: connected.server_banner.clone(),
        read_only: conn.read_only,
    };

    let (tx, rx) = mpsc::channel(CMD_QUEUE);
    state
        .sessions
        .insert(info.clone(), tx, connected.remote_targets.clone())
        .await;
    state.db.touch_connection(&conn.id)?;
    state.db.log_event(
        "info",
        "connect",
        Some(&conn.id),
        &conn.name,
        &format!(
            "sessão aberta com {}@{}:{} ({})",
            conn.username, conn.host, conn.port, connected.host_fingerprint
        ),
    );

    let sessions = state.sessions.clone();
    let sid = session_id.clone();
    let db = state.db.clone();
    let log_conn = (conn.id.clone(), conn.name.clone());
    tauri::async_runtime::spawn(async move {
        run_session(
            connected.handle,
            connected.jump,
            channel,
            rx,
            on_output,
            app,
            sid.clone(),
        )
        .await;
        // Sem isso, os listeners de túnel local ficariam escutando portas de
        // uma sessão morta.
        if let Some(h) = sessions.remove(&sid).await {
            h.abort_all_forwards().await;
        }
        db.log_event(
            "info",
            "disconnect",
            Some(&log_conn.0),
            &log_conn.1,
            "sessão encerrada",
        );
    });

    Ok(info)
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> AppResult<()> {
    state.sessions.get(&session_id).await?.write(data).await
}

/// Liga/desliga o modo somente leitura da sessão em curso.
#[tauri::command]
pub async fn ssh_set_read_only(
    state: State<'_, AppState>,
    session_id: String,
    value: bool,
) -> AppResult<()> {
    let handle = state.sessions.get(&session_id).await?;
    handle.set_read_only(value);

    let name = state
        .db
        .get_connection(&handle.info.connection_id)
        .map(|c| c.name)
        .unwrap_or_else(|_| handle.info.host.clone());
    state.db.log_event(
        "info",
        "readonly",
        Some(&handle.info.connection_id),
        &name,
        if value {
            "sessão travada em somente leitura"
        } else {
            "sessão destravada para escrita"
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    state
        .sessions
        .get(&session_id)
        .await?
        .send(SessionCmd::Resize {
            cols: cols.max(1),
            rows: rows.max(1),
        })
        .await
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let handle = state.sessions.get(&session_id).await?;
    handle.send(SessionCmd::Close).await
}

#[tauri::command]
pub async fn ssh_sessions(state: State<'_, AppState>) -> AppResult<Vec<SessionInfo>> {
    Ok(state.sessions.list().await)
}

/// Envia o mesmo texto para várias sessões (broadcast / cluster mode).
///
/// Sessões que já morreram são reportadas em vez de abortar o envio — em um
/// fleet de 20 máquinas, uma caída não deve impedir as outras 19.
#[tauri::command]
pub async fn ssh_broadcast(
    state: State<'_, AppState>,
    session_ids: Vec<String>,
    data: Vec<u8>,
) -> AppResult<Vec<String>> {
    let mut failed = Vec::new();
    for id in session_ids {
        match state.sessions.get(&id).await {
            // Sessão travada não recebe broadcast: o modo somente leitura existe
            // justamente para o painel de produção não ser atingido por engano.
            Ok(h) => {
                if h.write(data.clone()).await.is_err() {
                    failed.push(id);
                }
            }
            Err(_) => failed.push(id),
        }
    }
    Ok(failed)
}

/// Abre um shell local (ou uma distro WSL no Windows) com PTY. Do frontend em
/// diante é uma sessão como qualquer outra — mesmo canal de saída, mesmos
/// write/resize/gravação.
#[tauri::command]
pub async fn local_open(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    connection_id: Option<String>,
    wsl_distro: Option<String>,
    on_output: IpcChannel<InvokeResponseBody>,
) -> AppResult<SessionInfo> {
    let clean_distro = wsl_distro
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let session_id = SessionManager::new_id();
    let (tx, shell_path) = crate::local::spawn(
        app,
        session_id.clone(),
        shell.as_deref(),
        clean_distro,
        cols,
        rows,
        on_output,
    )?;

    let (conn_id, host, log_label) = match clean_distro {
        Some(d) => (
            format!("{}{d}", crate::local::WSL_CONNECTION_PREFIX),
            format!("wsl:{d}"),
            format!("WSL ({d})"),
        ),
        None if connection_id.as_deref() == Some(crate::local::WSL_CONNECTION_ID) => (
            crate::local::WSL_CONNECTION_ID.to_string(),
            "wsl".into(),
            "WSL (Linux)".to_string(),
        ),
        None => (
            crate::local::LOCAL_CONNECTION_ID.to_string(),
            "localhost".into(),
            "Terminal local".to_string(),
        ),
    };

    let username = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "local".into());

    let info = SessionInfo {
        session_id: session_id.clone(),
        connection_id: conn_id,
        host,
        username,
        fingerprint: String::new(),
        banner: None,
        read_only: false,
    };

    state
        .sessions
        .insert(info.clone(), tx, Default::default())
        .await;
    state.db.log_event(
        "info",
        "local",
        None,
        &log_label,
        &format!("shell local aberto ({shell_path})"),
    );

    let sessions = state.sessions.clone();
    let db = state.db.clone();
    let sid = session_id.clone();
    // A task da sessão emite `session-closed` sozinha; aqui só limpamos o
    // registro quando o shell morre.
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            ticker.tick().await;
            match sessions.get(&sid).await {
                Ok(h) if h.is_alive() => continue,
                _ => break,
            }
        }
        sessions.remove(&sid).await;
        db.log_event("info", "local", None, &log_label, "shell encerrado");
    });

    Ok(info)
}

/// Lista as distribuições WSL instaladas no Windows (retorna vazio fora do Windows).
#[tauri::command]
pub async fn wsl_list() -> AppResult<Vec<crate::local::WslDistro>> {
    tokio::task::spawn_blocking(crate::local::list_wsl_distros)
        .await
        .map_err(|e| AppError::msg(e.to_string()))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: u32,
    pub output: String,
}

/// Executa um comando não interativo na sessão (canal exec separado — não
/// interfere no terminal do usuário).
#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> AppResult<ExecResult> {
    let (exit_code, out) = state.sessions.get(&session_id).await?.exec(command).await?;
    Ok(ExecResult {
        exit_code,
        output: String::from_utf8_lossy(&out).into_owned(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRuntime {
    pub kind: String,
    pub label: String,
    pub cli: String,
    pub active: bool,
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
    pub running: bool,
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created: String,
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubePod {
    pub namespace: String,
    pub name: String,
    pub ready: String,
    pub status: String,
    pub restarts: String,
    pub age: String,
    pub image: String,
    pub node: String,
    pub running: bool,
}

const UNIX_CONTAINER_PATH_PREFIX: &str =
    r#"PATH="$PATH:/usr/local/bin:/snap/bin:/sbin:/usr/sbin"; export PATH"#;

fn is_win_local_session(connection_id: &str) -> bool {
    cfg!(target_os = "windows") && connection_id == crate::local::LOCAL_CONNECTION_ID
}

fn log_container_event(
    state: &State<'_, AppState>,
    handle: &crate::ssh::SessionHandle,
    kind: &str,
    message: &str,
) {
    let name = state
        .db
        .get_connection(&handle.info.connection_id)
        .map(|c| c.name)
        .unwrap_or_else(|_| "Terminal local".into());
    state.db.log_event(
        "info",
        kind,
        Some(&handle.info.connection_id),
        &name,
        message,
    );
}

fn validate_image_ref(image: &str) -> AppResult<()> {
    if image.is_empty()
        || image.starts_with('-')
        || !image
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | ':' | '@'))
    {
        return Err(AppError::msg("identificador de imagem inválido"));
    }
    Ok(())
}

fn validate_kube_name(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty()
        || value.starts_with('-')
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(AppError::msg(format!("{label} inválido")));
    }
    Ok(())
}

fn friendly_kube_error(raw: &str, fallback: &str) -> String {
    let msg = raw.trim();
    if msg.is_empty() {
        return fallback.to_string();
    }
    let lower = msg.to_ascii_lowercase();
    if lower.contains("k3s.yaml") && lower.contains("permission denied") {
        return format!(
            "{msg} — no k3s, libere leitura em /etc/rancher/k3s/k3s.yaml, copie para ~/.kube/config ou habilite sudo sem senha"
        );
    }
    msg.to_string()
}

/// Detecta de forma leve (sem conectar em daemons) os runtimes de container e
/// Kubernetes presentes no host: Docker, Podman, k3s, MicroK8s e kubectl.
#[tauri::command]
pub async fn container_runtimes(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<ContainerRuntime>> {
    let handle = state.sessions.get(&session_id).await?;
    let is_win = is_win_local_session(&handle.info.connection_id);

    let cmd = if is_win {
        r#"if (Get-Command docker -ErrorAction SilentlyContinue) { Write-Output 'docker|Docker|docker|1' }
if (Get-Command podman -ErrorAction SilentlyContinue) { Write-Output 'podman|Podman|podman|1' }
if (Get-Command kubectl -ErrorAction SilentlyContinue) {
  $kc = if ($env:KUBECONFIG) { $env:KUBECONFIG } else { Join-Path $HOME '.kube\config' }
  $act = if (Test-Path $kc) { '1' } else { '0' }
  Write-Output "kubectl|Kubernetes|kubectl|$act"
}"#
        .to_string()
    } else {
        format!(
            r#"{UNIX_CONTAINER_PATH_PREFIX}
if command -v docker >/dev/null 2>&1; then
  case "$(docker --version 2>/dev/null)" in
    *podman*) ;;
    *)
      if [ -S /var/run/docker.sock ] || [ -S "$HOME/.docker/run/docker.sock" ] || [ -S "$HOME/.orbstack/run/docker.sock" ] || [ -n "${{DOCKER_HOST:-}}" ] || [ -S "${{XDG_RUNTIME_DIR:-/run}}/docker.sock" ]; then
        echo "docker|Docker|docker|1"
      else
        echo "docker|Docker|docker|0"
      fi
      ;;
  esac
fi
if command -v podman >/dev/null 2>&1; then
  if [ -S /run/podman/podman.sock ] || [ -S "${{XDG_RUNTIME_DIR:-/run/user/$(id -u)}}/podman/podman.sock" ] || [ -d "$HOME/.local/share/containers" ] || [ -d /var/lib/containers ]; then
    echo "podman|Podman|podman|1"
  else
    echo "podman|Podman|podman|0"
  fi
fi
if command -v k3s >/dev/null 2>&1; then
  if [ -r /etc/rancher/k3s/k3s.yaml ] || [ "$(id -u)" = "0" ]; then
    echo "k3s|k3s|k3s kubectl|1"
  elif [ -r "${{KUBECONFIG:-$HOME/.kube/config}}" ] && command -v kubectl >/dev/null 2>&1; then
    echo "k3s|k3s|kubectl|1"
  elif [ -e /etc/rancher/k3s/k3s.yaml ] && sudo -n true >/dev/null 2>&1; then
    echo "k3s|k3s|sudo k3s kubectl|1"
  else
    echo "k3s|k3s|k3s kubectl|0"
  fi
elif command -v microk8s >/dev/null 2>&1; then
  if microk8s status >/dev/null 2>&1; then
    echo "microk8s|MicroK8s|microk8s kubectl|1"
  elif sudo -n true >/dev/null 2>&1; then
    echo "microk8s|MicroK8s|sudo microk8s kubectl|1"
  else
    echo "microk8s|MicroK8s|microk8s kubectl|0"
  fi
elif command -v kubectl >/dev/null 2>&1; then
  if [ -r "${{KUBECONFIG:-$HOME/.kube/config}}" ] || [ -r /etc/kubernetes/admin.conf ]; then
    echo "kubectl|Kubernetes|kubectl|1"
  elif [ -e /etc/kubernetes/admin.conf ] && sudo -n true >/dev/null 2>&1; then
    echo "kubectl|Kubernetes|sudo kubectl --kubeconfig=/etc/kubernetes/admin.conf|1"
  else
    echo "kubectl|Kubernetes|kubectl|0"
  fi
fi
exit 0"#
        )
    };

    let (_code, out) = handle.exec(cmd).await?;
    let text = String::from_utf8_lossy(&out);
    Ok(parse_container_runtimes(&text))
}

fn parse_container_runtimes(text: &str) -> Vec<ContainerRuntime> {
    let mut runtimes = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(4, '|');
        let (Some(kind), Some(label), Some(cli), Some(active)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if !matches!(
            kind,
            "docker" | "podman" | "k3s" | "microk8s" | "kubectl"
        ) {
            continue;
        }
        runtimes.push(ContainerRuntime {
            kind: kind.to_string(),
            label: label.to_string(),
            cli: cli.to_string(),
            active: active.trim() == "1",
        });
    }
    runtimes.sort_by_key(|r| !r.active);
    runtimes
}

/// Monta o comando OCI respeitando a engine selecionada (`docker` ou `podman`)
/// para que um runtime não interfira no outro, mantendo fallback quando `None`.
fn oci_engine_cmd(is_win_local: bool, engine: Option<&str>, args: &str) -> AppResult<String> {
    match engine {
        Some("docker") => Ok(if is_win_local {
            format!(
                "if (Get-Command docker -ErrorAction SilentlyContinue) {{ docker {args} }} else {{ Write-Error 'docker não encontrado'; exit 1 }}"
            )
        } else {
            format!("{UNIX_CONTAINER_PATH_PREFIX}; docker {args}")
        }),
        Some("podman") => Ok(if is_win_local {
            format!(
                "if (Get-Command podman -ErrorAction SilentlyContinue) {{ podman {args} }} else {{ Write-Error 'podman não encontrado'; exit 1 }}"
            )
        } else {
            format!("{UNIX_CONTAINER_PATH_PREFIX}; podman {args}")
        }),
        None => Ok(if is_win_local {
            format!(
                "if (Get-Command docker -ErrorAction SilentlyContinue) {{ docker {args} }} \
                 elseif (Get-Command podman -ErrorAction SilentlyContinue) {{ podman {args} }} \
                 else {{ exit 1 }}"
            )
        } else {
            format!(
                "{UNIX_CONTAINER_PATH_PREFIX}; \
                 if command -v docker >/dev/null 2>&1; then docker {args}; \
                 elif command -v podman >/dev/null 2>&1; then podman {args}; \
                 else exit 1; fi"
            )
        }),
        Some(_) => Err(AppError::msg("engine de container inválida")),
    }
}

/// Lista os containers do host via `docker ps` ou `podman ps` conforme a engine.
#[tauri::command]
pub async fn docker_ps(
    state: State<'_, AppState>,
    session_id: String,
    engine: Option<String>,
) -> AppResult<Vec<DockerContainer>> {
    const FMT: &str = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}";
    let handle = state.sessions.get(&session_id).await?;
    let cmd = oci_engine_cmd(
        is_win_local_session(&handle.info.connection_id),
        engine.as_deref(),
        &format!("ps -a --format '{FMT}'"),
    )?;

    let (exit_code, out) = handle.exec(cmd).await?;
    let text = String::from_utf8_lossy(&out);

    if exit_code != 0 {
        let msg = text.trim();
        return Err(AppError::msg(if msg.is_empty() {
            "docker/podman não encontrado neste host".to_string()
        } else {
            msg.to_string()
        }));
    }

    Ok(parse_docker_ps(&text))
}

fn parse_docker_ps(text: &str) -> Vec<DockerContainer> {
    let mut containers = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let mut parts = line.splitn(5, '\t');
        let (Some(id), Some(name)) = (parts.next(), parts.next()) else {
            continue;
        };
        let image = parts.next().unwrap_or_default();
        let status = parts.next().unwrap_or_default();
        let ports = parts.next().unwrap_or_default();
        let status_lower = status.to_ascii_lowercase();
        let running = status_lower.starts_with("up") || status_lower.starts_with("running");
        containers.push(DockerContainer {
            id: id.to_string(),
            name: name.to_string(),
            image: image.to_string(),
            status: status.to_string(),
            ports: ports.to_string(),
            running,
        });
    }
    containers
}

/// Lista as imagens presentes no host via `docker images` ou `podman images`.
#[tauri::command]
pub async fn docker_images(
    state: State<'_, AppState>,
    session_id: String,
    engine: Option<String>,
) -> AppResult<Vec<DockerImage>> {
    const FMT: &str = "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}";
    let handle = state.sessions.get(&session_id).await?;
    let cmd = oci_engine_cmd(
        is_win_local_session(&handle.info.connection_id),
        engine.as_deref(),
        &format!("images --format '{FMT}'"),
    )?;

    let (exit_code, out) = handle.exec(cmd).await?;
    let text = String::from_utf8_lossy(&out);

    if exit_code != 0 {
        let msg = text.trim();
        return Err(AppError::msg(if msg.is_empty() {
            "docker/podman não encontrado neste host".to_string()
        } else {
            msg.to_string()
        }));
    }

    Ok(parse_docker_images(&text))
}

fn parse_docker_images(text: &str) -> Vec<DockerImage> {
    let mut images = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.splitn(5, '\t');
        let (Some(id), Some(repository)) = (parts.next(), parts.next()) else {
            continue;
        };
        let tag = parts.next().unwrap_or_default();
        let size = parts.next().unwrap_or_default();
        let created = parts.next().unwrap_or_default();
        images.push(DockerImage {
            id: id.to_string(),
            repository: repository.to_string(),
            tag: tag.to_string(),
            size: size.to_string(),
            created: created.to_string(),
        });
    }
    images
}

/// Remove uma imagem do host via `docker rmi` (ou `podman rmi`).
#[tauri::command]
pub async fn docker_image_rm(
    state: State<'_, AppState>,
    session_id: String,
    image: String,
    force: Option<bool>,
    engine: Option<String>,
) -> AppResult<()> {
    validate_image_ref(&image)?;

    let args = if force.unwrap_or(false) {
        format!("rmi -f {image}")
    } else {
        format!("rmi {image}")
    };
    let handle = state.sessions.get(&session_id).await?;
    let cmd = oci_engine_cmd(
        is_win_local_session(&handle.info.connection_id),
        engine.as_deref(),
        &args,
    )?;

    let (exit_code, out) = handle.exec(cmd).await?;
    if exit_code != 0 {
        let msg = String::from_utf8_lossy(&out).trim().to_string();
        return Err(AppError::msg(if msg.is_empty() {
            format!("falha ao remover imagem {image}")
        } else {
            msg
        }));
    }

    log_container_event(
        &state,
        &handle,
        engine.as_deref().unwrap_or("docker"),
        &format!("imagem removida: {image}"),
    );
    Ok(())
}

/// Ciclo de vida de um container: `start`, `stop`, `restart` ou `rm`.
///
/// Roda pelo canal exec (não pelo PTY do usuário) e devolve a saída do runtime
/// quando falha — "permission denied" ou "no such container" precisam chegar
/// à UI, não sumir.
#[tauri::command]
pub async fn docker_action(
    state: State<'_, AppState>,
    session_id: String,
    action: String,
    container: String,
    engine: Option<String>,
) -> AppResult<()> {
    if !matches!(action.as_str(), "start" | "stop" | "restart" | "rm") {
        return Err(AppError::msg(format!("ação inválida: {action}")));
    }
    // Id/nome vem da listagem do próprio runtime; ainda assim é validado antes
    // de entrar numa linha de comando.
    if container.is_empty()
        || !container
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(AppError::msg("identificador de container inválido"));
    }

    // `rm -f` para o container antes de remover: sem isso, apagar um container
    // rodando falharia com uma mensagem que não ajuda em nada na UI. Volumes
    // não são tocados (sem `-v`).
    let args = if action == "rm" {
        format!("rm -f {container}")
    } else {
        format!("{action} {container}")
    };
    let handle = state.sessions.get(&session_id).await?;
    let cmd = oci_engine_cmd(
        is_win_local_session(&handle.info.connection_id),
        engine.as_deref(),
        &args,
    )?;

    let (exit_code, out) = handle.exec(cmd).await?;
    if exit_code != 0 {
        let msg = String::from_utf8_lossy(&out).trim().to_string();
        return Err(AppError::msg(if msg.is_empty() {
            format!("falha ao executar {action} em {container}")
        } else {
            msg
        }));
    }

    log_container_event(
        &state,
        &handle,
        engine.as_deref().unwrap_or("docker"),
        &format!("container {container}: {action}"),
    );
    Ok(())
}

fn validate_kube_engine(engine: Option<&str>) -> AppResult<&str> {
    match engine {
        None => Ok("auto"),
        Some(e @ ("k3s" | "microk8s" | "kubectl")) => Ok(e),
        Some(_) => Err(AppError::msg("engine Kubernetes inválida")),
    }
}

fn unix_run_k8s_fn(engine: &str) -> String {
    match engine {
        "k3s" => r#"run_k8s() {
  if [ -r /etc/rancher/k3s/k3s.yaml ] || [ "$(id -u)" = "0" ]; then
    k3s kubectl "$@"
  elif [ -r "${KUBECONFIG:-$HOME/.kube/config}" ] && command -v kubectl >/dev/null 2>&1; then
    kubectl "$@"
  elif [ -e /etc/rancher/k3s/k3s.yaml ] && sudo -n true >/dev/null 2>&1; then
    sudo -n k3s kubectl "$@"
  else
    k3s kubectl "$@"
  fi
}"#
        .to_string(),
        "microk8s" => r#"run_k8s() {
  if microk8s status >/dev/null 2>&1; then
    microk8s kubectl "$@"
  elif sudo -n true >/dev/null 2>&1; then
    sudo -n microk8s kubectl "$@"
  else
    microk8s kubectl "$@"
  fi
}"#
        .to_string(),
        "kubectl" => r#"run_k8s() {
  if [ ! -r "${KUBECONFIG:-$HOME/.kube/config}" ] && [ -e /etc/kubernetes/admin.conf ] && [ ! -r /etc/kubernetes/admin.conf ] && sudo -n true >/dev/null 2>&1; then
    sudo -n kubectl --kubeconfig=/etc/kubernetes/admin.conf "$@"
  else
    kubectl "$@"
  fi
}"#
        .to_string(),
        _ => r#"run_k8s() {
  if command -v k3s >/dev/null 2>&1; then
    if [ -r /etc/rancher/k3s/k3s.yaml ] || [ "$(id -u)" = "0" ]; then
      k3s kubectl "$@"
    elif [ -r "${KUBECONFIG:-$HOME/.kube/config}" ] && command -v kubectl >/dev/null 2>&1; then
      kubectl "$@"
    elif [ -e /etc/rancher/k3s/k3s.yaml ] && sudo -n true >/dev/null 2>&1; then
      sudo -n k3s kubectl "$@"
    else
      k3s kubectl "$@"
    fi
  elif command -v microk8s >/dev/null 2>&1; then
    if microk8s status >/dev/null 2>&1; then
      microk8s kubectl "$@"
    elif sudo -n true >/dev/null 2>&1; then
      sudo -n microk8s kubectl "$@"
    else
      microk8s kubectl "$@"
    fi
  else
    kubectl "$@"
  fi
}"#
        .to_string(),
    }
}

/// Monta o script que resolve `run_k8s` e executa `body` (no Unix) ou `win_body` (no Windows local).
fn kube_cmd_script(
    is_win_local: bool,
    engine: Option<&str>,
    unix_body: &str,
    win_body: &str,
) -> AppResult<String> {
    let eng = validate_kube_engine(engine)?;
    if is_win_local {
        Ok(format!(
            "if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {{ Write-Error 'kubectl não encontrado'; exit 1 }}\n{win_body}"
        ))
    } else {
        let helper = unix_run_k8s_fn(eng);
        Ok(format!("{UNIX_CONTAINER_PATH_PREFIX}\n{helper}\n{unix_body}"))
    }
}

/// Lista os Pods de todos os namespaces do cluster (`k3s`, `microk8s` ou `kubectl`).
#[tauri::command]
pub async fn kube_pods(
    state: State<'_, AppState>,
    session_id: String,
    engine: Option<String>,
) -> AppResult<Vec<KubePod>> {
    let handle = state.sessions.get(&session_id).await?;
    let is_win = is_win_local_session(&handle.info.connection_id);

    let unix_body = r#"echo '##PODS'
run_k8s get pods -A -o wide --no-headers 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  echo '##IMAGES'
  run_k8s get pods -A --no-headers -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,IMAGES:.spec.containers[*].image' 2>/dev/null
fi
exit $rc"#;

    let win_body = r#"Write-Output '##PODS'
kubectl get pods -A -o wide --no-headers 2>&1
$rc = $LASTEXITCODE
if ($rc -eq 0) {
  Write-Output '##IMAGES'
  kubectl get pods -A --no-headers -o 'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,IMAGES:.spec.containers[*].image' 2>$null
}
exit $rc"#;

    let cmd = kube_cmd_script(is_win, engine.as_deref(), unix_body, win_body)?;
    let (exit_code, out) = handle.exec(cmd).await?;
    let text = String::from_utf8_lossy(&out);

    if exit_code != 0 {
        let sections = super::net::sections(&text);
        let raw_err = sections
            .get("PODS")
            .map(String::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&text);
        return Err(AppError::msg(friendly_kube_error(
            raw_err,
            "não foi possível listar os pods do Kubernetes",
        )));
    }

    Ok(parse_kube_pods(&text))
}

fn parse_kube_pods(text: &str) -> Vec<KubePod> {
    let s = super::net::sections(text);
    let get = |k: &str| s.get(k).map(String::as_str).unwrap_or_default();

    let mut images_map: HashMap<(String, String), String> = HashMap::new();
    for line in get("IMAGES").lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() >= 3 {
            images_map.insert((t[0].to_string(), t[1].to_string()), t[2].to_string());
        }
    }

    let mut pods = Vec::new();
    for line in get("PODS").lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("No resources found") {
            continue;
        }
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 6 {
            continue;
        }
        let namespace = t[0].to_string();
        let name = t[1].to_string();
        let ready = t[2].to_string();
        let status = t[3].to_string();

        let has_restart_age = t
            .get(5)
            .is_some_and(|v| v.starts_with('('))
            && t.get(6).is_some_and(|v| v.ends_with(')'));

        let (restarts, age, node) = if has_restart_age {
            (
                format!("{} {} {}", t[4], t[5], t[6]),
                t.get(7).copied().unwrap_or_default().to_string(),
                t.get(9).copied().unwrap_or_default(),
            )
        } else {
            (
                t[4].to_string(),
                t.get(5).copied().unwrap_or_default().to_string(),
                t.get(7).copied().unwrap_or_default(),
            )
        };

        let node = if node == "<none>" {
            String::new()
        } else {
            node.to_string()
        };

        let ready_ok = ready
            .split_once('/')
            .and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)))
            .is_some_and(|(a, b)| b > 0 && a == b);
        let running = status == "Running" && ready_ok;
        let image = images_map
            .get(&(namespace.clone(), name.clone()))
            .cloned()
            .unwrap_or_default();

        pods.push(KubePod {
            namespace,
            name,
            ready,
            status,
            restarts,
            age,
            image,
            node,
            running,
        });
    }
    pods
}

/// Remove/reinicia um Pod no cluster (`kubectl delete pod -n <ns> <pod> --wait=false`).
#[tauri::command]
pub async fn kube_pod_delete(
    state: State<'_, AppState>,
    session_id: String,
    namespace: String,
    pod: String,
    engine: Option<String>,
) -> AppResult<()> {
    validate_kube_name(&namespace, "namespace")?;
    validate_kube_name(&pod, "nome do pod")?;

    let handle = state.sessions.get(&session_id).await?;
    let is_win = is_win_local_session(&handle.info.connection_id);
    let unix_body = format!("run_k8s delete pod -n {namespace} {pod} --wait=false 2>&1");
    let win_body = format!("kubectl delete pod -n {namespace} {pod} --wait=false 2>&1");

    let cmd = kube_cmd_script(is_win, engine.as_deref(), &unix_body, &win_body)?;
    let (exit_code, out) = handle.exec(cmd).await?;
    if exit_code != 0 {
        let text = String::from_utf8_lossy(&out);
        return Err(AppError::msg(friendly_kube_error(
            &text,
            &format!("falha ao excluir pod {namespace}/{pod}"),
        )));
    }

    log_container_event(
        &state,
        &handle,
        "k8s",
        &format!("pod removido/reiniciado: {namespace}/{pod}"),
    );
    Ok(())
}

/// Lista imagens do nó (`crictl images` / `k3s crictl images`) ou, em fallback,
/// as imagens declaradas nos pods do cluster.
#[tauri::command]
pub async fn kube_images(
    state: State<'_, AppState>,
    session_id: String,
    engine: Option<String>,
) -> AppResult<Vec<DockerImage>> {
    let handle = state.sessions.get(&session_id).await?;
    let is_win = is_win_local_session(&handle.info.connection_id);
    let eng_label = engine.as_deref().unwrap_or("auto");

    let unix_body = format!(
        r#"run_crictl() {{
  if command -v k3s >/dev/null 2>&1 && [ "{eng_label}" != "kubectl" ] && [ "{eng_label}" != "microk8s" ]; then
    if k3s crictl "$@" 2>/dev/null; then return 0; fi
    if sudo -n k3s crictl "$@" 2>/dev/null; then return 0; fi
  fi
  if command -v crictl >/dev/null 2>&1; then
    if crictl "$@" 2>/dev/null; then return 0; fi
    if sudo -n crictl "$@" 2>/dev/null; then return 0; fi
  fi
  return 1
}}
if out="$(run_crictl images)"; then
  echo '##CRICTL'
  printf '%s\n' "$out"
  exit 0
fi
echo '##KUBECTL_IMAGES'
run_k8s get pods -A --no-headers -o 'custom-columns=IMAGES:.spec.containers[*].image' 2>&1"#
    );

    let win_body = r#"Write-Output '##KUBECTL_IMAGES'
kubectl get pods -A --no-headers -o 'custom-columns=IMAGES:.spec.containers[*].image' 2>&1"#;

    let cmd = kube_cmd_script(is_win, engine.as_deref(), &unix_body, win_body)?;
    let (exit_code, out) = handle.exec(cmd).await?;
    let text = String::from_utf8_lossy(&out);

    if exit_code != 0 {
        let sections = super::net::sections(&text);
        let raw_err = sections
            .get("KUBECTL_IMAGES")
            .map(String::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&text);
        return Err(AppError::msg(friendly_kube_error(
            raw_err,
            "não foi possível listar as imagens do Kubernetes",
        )));
    }

    Ok(parse_kube_images(&text))
}

fn split_image_repo_tag(image: &str) -> (String, String) {
    if image.contains('@') {
        return (image.to_string(), "<none>".to_string());
    }
    let after_slash = image.rsplit('/').next().unwrap_or(image);
    if after_slash.contains(':') {
        if let Some((repo, tag)) = image.rsplit_once(':') {
            return (repo.to_string(), tag.to_string());
        }
    }
    (image.to_string(), "<none>".to_string())
}

fn parse_kube_images(text: &str) -> Vec<DockerImage> {
    let s = super::net::sections(text);
    if let Some(crictl) = s.get("CRICTL") {
        let mut images = Vec::new();
        for line in crictl.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("IMAGE") {
                continue;
            }
            let t: Vec<&str> = line.split_whitespace().collect();
            if t.len() < 4 {
                continue;
            }
            images.push(DockerImage {
                id: t[2].to_string(),
                repository: t[0].to_string(),
                tag: t[1].to_string(),
                size: t[3].to_string(),
                created: String::new(),
            });
        }
        return images;
    }

    let mut seen = HashSet::new();
    let mut images = Vec::new();
    for line in s
        .get("KUBECTL_IMAGES")
        .map(String::as_str)
        .unwrap_or_default()
        .lines()
    {
        for item in line.split(|c: char| c == ',' || c.is_whitespace()) {
            let item = item.trim();
            if item.is_empty() || item == "<none>" || !seen.insert(item.to_string()) {
                continue;
            }
            let (repository, tag) = split_image_repo_tag(item);
            images.push(DockerImage {
                id: String::new(),
                repository,
                tag,
                size: "no cluster".to_string(),
                created: String::new(),
            });
        }
    }
    images
}

/// Remove uma imagem do nó Kubernetes via `k3s crictl rmi` ou `crictl rmi`.
#[tauri::command]
pub async fn kube_image_rm(
    state: State<'_, AppState>,
    session_id: String,
    image: String,
    engine: Option<String>,
) -> AppResult<()> {
    validate_image_ref(&image)?;
    let eng_label = validate_kube_engine(engine.as_deref())?;

    let handle = state.sessions.get(&session_id).await?;
    if is_win_local_session(&handle.info.connection_id) {
        return Err(AppError::msg(
            "remoção de imagem via crictl não é suportada no Windows local",
        ));
    }

    let cmd = format!(
        r#"{UNIX_CONTAINER_PATH_PREFIX}
if command -v k3s >/dev/null 2>&1 && [ "{eng_label}" != "kubectl" ] && [ "{eng_label}" != "microk8s" ]; then
  if k3s crictl rmi {image} 2>&1; then exit 0; fi
  if sudo -n true >/dev/null 2>&1; then
    sudo -n k3s crictl rmi {image} 2>&1
    exit $?
  fi
fi
if command -v crictl >/dev/null 2>&1; then
  if crictl rmi {image} 2>&1; then exit 0; fi
  if sudo -n true >/dev/null 2>&1; then
    sudo -n crictl rmi {image} 2>&1
    exit $?
  fi
fi
echo "crictl não disponível ou sem permissão neste nó para remover imagens" >&2
exit 1"#
    );

    let (exit_code, out) = handle.exec(cmd).await?;
    if exit_code != 0 {
        let msg = String::from_utf8_lossy(&out).trim().to_string();
        return Err(AppError::msg(if msg.is_empty() {
            format!("falha ao remover imagem {image}")
        } else {
            msg
        }));
    }

    log_container_event(
        &state,
        &handle,
        "k8s",
        &format!("imagem removida: {image}"),
    );
    Ok(())
}

#[tauri::command]
pub async fn ssh_ping(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state
        .sessions
        .get(&session_id)
        .await
        .map(|_| ())
        .map_err(|_| AppError::NoSession(session_id))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslInfo {
    pub available: bool,
    pub distros: Vec<String>,
    pub default_distro: Option<String>,
}

#[tauri::command]
pub fn wsl_info() -> WslInfo {
    #[cfg(target_os = "windows")]
    {
        let wsl_path = crate::local::resolve_wsl_executable();
        let exists = std::path::Path::new(&wsl_path).exists()
            || std::path::Path::new(r"C:\Windows\System32\wsl.exe").exists();
        if !exists {
            return WslInfo {
                available: false,
                distros: vec![],
                default_distro: None,
            };
        }
        let distros: Vec<String> = crate::local::list_wsl_distros()
            .into_iter()
            .map(|d| d.name)
            .collect();
        let default_distro = distros.first().cloned();
        WslInfo {
            available: true,
            distros,
            default_distro,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        WslInfo {
            available: false,
            distros: vec![],
            default_distro: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_docker_images_output_and_skips_blank_lines() {
        let out = "a1b2c3d4e5f6\tnginx\t1.27-alpine\t43.2MB\t2 weeks ago\r\n\n\
                   f6e5d4c3b2a1\t<none>\t<none>\t120MB\t3 days ago\n";
        let images = parse_docker_images(out);
        assert_eq!(images.len(), 2);
        assert_eq!(
            images[0],
            DockerImage {
                id: "a1b2c3d4e5f6".into(),
                repository: "nginx".into(),
                tag: "1.27-alpine".into(),
                size: "43.2MB".into(),
                created: "2 weeks ago".into(),
            }
        );
        assert_eq!(images[1].repository, "<none>");
        assert_eq!(images[1].tag, "<none>");
    }

    #[test]
    fn parses_container_runtimes_and_orders_active_first() {
        let out = "docker|Docker|docker|0\n\
                   podman|Podman|podman|1\n\
                   k3s|k3s|sudo k3s kubectl|1\n\
                   invalido\n";
        let list = parse_container_runtimes(out);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].kind, "podman");
        assert!(list[0].active);
        assert_eq!(list[1].kind, "k3s");
        assert_eq!(list[1].cli, "sudo k3s kubectl");
        assert!(list[1].active);
        assert_eq!(list[2].kind, "docker");
        assert!(!list[2].active);
    }

    #[test]
    fn parses_docker_and_podman_ps_statuses() {
        let out = "1111aaaa\tweb\tnginx:1.27\tUp 2 hours\t0.0.0.0:80->80/tcp\r\n\
                   2222bbbb\tcache\tredis:7\tRunning\t\n\
                   3333cccc\tjob\talpine:3\tExited (0) 5 minutes ago\t\n";
        let list = parse_docker_ps(out);
        assert_eq!(list.len(), 3);
        assert!(list[0].running);
        assert!(list[1].running);
        assert!(!list[2].running);
    }

    #[test]
    fn parses_kube_pods_with_simple_and_compound_restarts() {
        let out = "##PODS\n\
                   kube-system   coredns-7b98   1/1   Running            0             12d   10.42.0.5   node-a   <none>   <none>\n\
                   default       api-55c8     0/1   CrashLoopBackOff   5 (2m ago)    10m   10.42.0.9   node-b   <none>   <none>\n\
                   default       pending-1    0/1   Pending            0             30s   <none>      <none>   <none>   <none>\n\
                   ##IMAGES\n\
                   kube-system   coredns-7b98   rancher/mirrored-coredns:1.10.1\n\
                   default       api-55c8       ghcr.io/org/api:v2,busybox:1.36\n";
        let pods = parse_kube_pods(out);
        assert_eq!(pods.len(), 3);

        assert_eq!(pods[0].namespace, "kube-system");
        assert_eq!(pods[0].name, "coredns-7b98");
        assert_eq!(pods[0].restarts, "0");
        assert_eq!(pods[0].age, "12d");
        assert_eq!(pods[0].node, "node-a");
        assert_eq!(pods[0].image, "rancher/mirrored-coredns:1.10.1");
        assert!(pods[0].running);

        assert_eq!(pods[1].status, "CrashLoopBackOff");
        assert_eq!(pods[1].restarts, "5 (2m ago)");
        assert_eq!(pods[1].age, "10m");
        assert_eq!(pods[1].node, "node-b");
        assert_eq!(pods[1].image, "ghcr.io/org/api:v2,busybox:1.36");
        assert!(!pods[1].running);

        assert_eq!(pods[2].node, "");
        assert!(!pods[2].running);
    }

    #[test]
    fn parses_kube_images_from_crictl_and_kubectl_fallback() {
        let crictl = "##CRICTL\n\
                      IMAGE                              TAG      IMAGE ID       SIZE\n\
                      docker.io/library/nginx            1.27     a1b2c3d4e5f6   67.1MB\n\
                      docker.io/rancher/mirrored-pause   3.6      6270bb605e12   301kB\n";
        let list = parse_kube_images(crictl);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].repository, "docker.io/library/nginx");
        assert_eq!(list[0].tag, "1.27");
        assert_eq!(list[0].id, "a1b2c3d4e5f6");
        assert_eq!(list[0].size, "67.1MB");

        let fallback = "##KUBECTL_IMAGES\n\
                        nginx:1.27-alpine,localhost:5000/app:v1\n\
                        nginx:1.27-alpine\n\
                        busybox\n";
        let fb = parse_kube_images(fallback);
        assert_eq!(fb.len(), 3);
        assert_eq!(fb[0].repository, "nginx");
        assert_eq!(fb[0].tag, "1.27-alpine");
        assert_eq!(fb[0].size, "no cluster");
        assert_eq!(fb[1].repository, "localhost:5000/app");
        assert_eq!(fb[1].tag, "v1");
        assert_eq!(fb[2].repository, "busybox");
        assert_eq!(fb[2].tag, "<none>");
    }
}
