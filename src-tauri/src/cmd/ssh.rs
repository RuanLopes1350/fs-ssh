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

    let (connection_id, host, log_label) = match clean_distro {
        Some(d) => (
            format!("{}{d}", crate::local::WSL_CONNECTION_PREFIX),
            format!("wsl:{d}"),
            format!("WSL ({d})"),
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
        connection_id,
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

/// Monta a chamada `docker` (com fallback para `podman`) conforme o shell do host.
fn docker_or_podman_cmd(is_win_local: bool, args: &str) -> String {
    if is_win_local {
        format!(
            "if (Get-Command docker -ErrorAction SilentlyContinue) {{ docker {args} }} \
             elseif (Get-Command podman -ErrorAction SilentlyContinue) {{ podman {args} }} \
             else {{ exit 1 }}"
        )
    } else {
        format!(
            "command -v docker >/dev/null 2>&1 && docker {args} || \
             (command -v podman >/dev/null 2>&1 && podman {args})"
        )
    }
}

fn is_win_local_session(connection_id: &str) -> bool {
    cfg!(target_os = "windows") && connection_id == crate::local::LOCAL_CONNECTION_ID
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
    let handle = state.sessions.get(&session_id).await?;
    let cmd = docker_or_podman_cmd(
        is_win_local_session(&handle.info.connection_id),
        &format!("ps -a --format '{FMT}'"),
    );

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
        containers.push(DockerContainer {
            id: id.to_string(),
            name: name.to_string(),
            image: image.to_string(),
            status: status.to_string(),
            ports: ports.to_string(),
            running: status.starts_with("Up"),
        });
    }
    containers
}

/// Lista as imagens presentes no host via `docker images` (com fallback para `podman`).
#[tauri::command]
pub async fn docker_images(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<DockerImage>> {
    const FMT: &str = "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}";
    let handle = state.sessions.get(&session_id).await?;
    let cmd = docker_or_podman_cmd(
        is_win_local_session(&handle.info.connection_id),
        &format!("images --format '{FMT}'"),
    );

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
) -> AppResult<()> {
    if image.is_empty()
        || image.starts_with('-')
        || !image
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | ':' | '@'))
    {
        return Err(AppError::msg("identificador de imagem inválido"));
    }

    let args = if force.unwrap_or(false) {
        format!("rmi -f {image}")
    } else {
        format!("rmi {image}")
    };
    let handle = state.sessions.get(&session_id).await?;
    let cmd = docker_or_podman_cmd(is_win_local_session(&handle.info.connection_id), &args);

    let (exit_code, out) = handle.exec(cmd).await?;
    if exit_code != 0 {
        let msg = String::from_utf8_lossy(&out).trim().to_string();
        return Err(AppError::msg(if msg.is_empty() {
            format!("falha ao remover imagem {image}")
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
        &format!("imagem removida: {image}"),
    );
    Ok(())
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
    let handle = state.sessions.get(&session_id).await?;
    let cmd = docker_or_podman_cmd(is_win_local_session(&handle.info.connection_id), &args);

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
}
