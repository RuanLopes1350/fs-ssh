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

    let connected = connect::connect(
        state.db.clone(),
        &conn,
        jump_conn.as_ref(),
        identity.as_ref(),
        jump_identity.as_ref(),
        args.secret.as_deref(),
        args.jump_secret.as_deref(),
    )
    .await?;

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
    };

    let (tx, rx) = mpsc::channel(CMD_QUEUE);
    state
        .sessions
        .insert(info.clone(), tx, connected.remote_targets.clone())
        .await;
    state.db.touch_connection(&conn.id)?;

    let sessions = state.sessions.clone();
    let sid = session_id.clone();
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
    });

    Ok(info)
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> AppResult<()> {
    state
        .sessions
        .get(&session_id)
        .await?
        .send(SessionCmd::Write(data))
        .await
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
            Ok(h) => {
                if h.send(SessionCmd::Write(data.clone())).await.is_err() {
                    failed.push(id);
                }
            }
            Err(_) => failed.push(id),
        }
    }
    Ok(failed)
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

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
    pub running: bool,
}

/// Lista os containers do host remoto via `docker ps` (com fallback para
/// `podman`). Erros viram mensagens amigáveis: host sem Docker não é falha do
/// app, é informação.
#[tauri::command]
pub async fn docker_ps(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<DockerContainer>> {
    const FMT: &str = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}";
    let cmd = format!(
        "command -v docker >/dev/null 2>&1 && docker ps -a --format '{FMT}' || \
         (command -v podman >/dev/null 2>&1 && podman ps -a --format '{FMT}')"
    );

    let handle = state.sessions.get(&session_id).await?;
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

    let mut containers = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(5, '\t');
        let (Some(id), Some(name)) = (parts.next(), parts.next()) else {
            continue;
        };
        let image = parts.next().unwrap_or_default();
        let status = parts.next().unwrap_or_default();
        let ports = parts.next().unwrap_or_default();
        containers.push(DockerContainer {
            id: id.to_string(),
            name: name.to_string(),
            image: image.to_string(),
            status: status.to_string(),
            ports: ports.to_string(),
            running: status.starts_with("Up"),
        });
    }
    Ok(containers)
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
