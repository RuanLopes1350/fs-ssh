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

/// Abre um shell local com PTY. Do frontend em diante é uma sessão como
/// qualquer outra — mesmo canal de saída, mesmos write/resize/gravação.
#[tauri::command]
pub async fn local_open(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    connection_id: Option<String>,
    on_output: IpcChannel<InvokeResponseBody>,
) -> AppResult<SessionInfo> {
    let session_id = SessionManager::new_id();
    let (tx, shell_path) = crate::local::spawn(
        app,
        session_id.clone(),
        shell.as_deref(),
        cols,
        rows,
        on_output,
    )?;

    let conn_id = connection_id.unwrap_or_else(|| crate::local::LOCAL_CONNECTION_ID.to_string());
    let host_name = if conn_id == crate::local::WSL_CONNECTION_ID {
        "wsl".to_string()
    } else {
        "localhost".to_string()
    };
    let log_title = if conn_id == crate::local::WSL_CONNECTION_ID {
        "WSL (Linux)"
    } else {
        "Terminal local"
    };

    let info = SessionInfo {
        session_id: session_id.clone(),
        connection_id: conn_id,
        host: host_name,
        username: std::env::var("USER").unwrap_or_else(|_| "local".into()),
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
        log_title,
        &format!("shell aberto ({shell_path})"),
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
        db.log_event("info", "local", None, "Terminal local", "shell encerrado");
    });

    Ok(info)
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

/// Ciclo de vida de um container: `start`, `stop`, `restart` ou `rm`.
///
/// Roda pelo canal exec (não pelo PTY do usuário) e devolve a saída do docker
/// quando falha — "permission denied" ou "no such container" precisam chegar
/// à UI, não sumir.
#[tauri::command]
pub async fn docker_action(
    state: State<'_, AppState>,
    session_id: String,
    action: String,
    container: String,
) -> AppResult<()> {
    if !matches!(action.as_str(), "start" | "stop" | "restart" | "rm") {
        return Err(AppError::msg(format!("ação inválida: {action}")));
    }
    // Id/nome vem da listagem do próprio docker; ainda assim é validado antes
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
    let cmd = format!(
        "command -v docker >/dev/null 2>&1 && docker {args} || \
         (command -v podman >/dev/null 2>&1 && podman {args})"
    );

    let handle = state.sessions.get(&session_id).await?;
    let (exit_code, out) = handle.exec(cmd).await?;
    if exit_code != 0 {
        let msg = String::from_utf8_lossy(&out).trim().to_string();
        return Err(AppError::msg(if msg.is_empty() {
            format!("falha ao executar {action} em {container}")
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
        "docker",
        Some(&handle.info.connection_id),
        &name,
        &format!("container {container}: {action}"),
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let wsl_path = std::path::Path::new(r"C:\Windows\System32\wsl.exe");
        if !wsl_path.exists() {
            return WslInfo {
                available: false,
                distros: vec![],
                default_distro: None,
            };
        }

        let output = Command::new(wsl_path)
            .args(["-l", "-q"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        let distros: Vec<String> = match output {
            Ok(out) if out.status.success() => {
                let text = if out.stdout.len() >= 2
                    && (out.stdout[1] == 0 || (out.stdout[0] == 0xff && out.stdout[1] == 0xfe))
                {
                    let u16_chars: Vec<u16> = out
                        .stdout
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .filter(|&c| c != 0xfeff && c != 0)
                        .collect();
                    String::from_utf16_lossy(&u16_chars)
                } else {
                    String::from_utf8_lossy(&out.stdout).to_string()
                };
                text.lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect()
            }
            _ => vec![],
        };

        let default_distro = distros.first().cloned();

        WslInfo {
            available: true,
            distros,
            default_distro,
        }
    }
    #[cfg(not(windows))]
    {
        WslInfo {
            available: false,
            distros: vec![],
            default_distro: None,
        }
    }
}
