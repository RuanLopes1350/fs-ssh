use std::path::Path;
use std::time::Duration;

use tauri::ipc::Channel as IpcChannel;
use tauri::{AppHandle, Emitter, State};

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::ssh::sftp::{self, LocalEntry, Progress, RemoteEntry};

/// Teto para "abrir no editor local". Acima disso o caminho certo é download.
const MAX_INLINE_EDIT: u64 = 8 * 1024 * 1024;

/// Intervalo do watcher do "editar localmente": barato o bastante para rodar
/// sempre, rápido o bastante para o save-back parecer imediato.
const EDIT_POLL: Duration = Duration::from_secs(1);

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<Vec<RemoteEntry>> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    sftp::list(&s, &path).await
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, session_id: String) -> AppResult<String> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    sftp::canonicalize(&s, ".").await
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    session_id: String,
    remote: String,
    local: String,
    resume: bool,
    on_progress: IpcChannel<Progress>,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    sftp::download(s, remote, local, resume, on_progress).await
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    session_id: String,
    local: String,
    remote: String,
    resume: bool,
    on_progress: IpcChannel<Progress>,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    sftp::upload(s, local, remote, resume, on_progress).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    s.create_dir(path).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    s.rename(from, to).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    if is_dir {
        s.remove_dir(path).await?;
    } else {
        s.remove_file(path).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    mode: u32,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    let mut meta = s.metadata(path.clone()).await?;
    // Preserva os bits de tipo (dir/link) e troca só a permissão.
    let type_bits = meta.permissions.unwrap_or(0) & !0o7777;
    meta.permissions = Some(type_bits | (mode & 0o7777));
    s.set_metadata(path, meta).await?;
    Ok(())
}

/// Evento emitido pelo watcher do "editar localmente" a cada gravação enviada
/// (ou tentativa que falhou) de volta ao servidor.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSaved {
    pub session_id: String,
    pub remote: String,
    pub local: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Baixa o arquivo para um temporário local, devolve o caminho para o frontend
/// abrir no editor do sistema e fica vigiando o mtime: cada gravação local é
/// reenviada ao servidor pela mesma sessão SFTP (save-back).
///
/// O temporário pode conter segredo (`.env`, chaves), então o diretório nasce
/// 0700 e o arquivo 0600 — e sobras de execuções anteriores são removidas no
/// boot por `sweep_stale_temp_files`.
#[tauri::command]
pub async fn sftp_edit_local(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<String> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    let bytes = sftp::read_all(&s, &path, MAX_INLINE_EDIT).await?;

    let name = path.rsplit('/').next().unwrap_or("arquivo");
    let dir = std::env::temp_dir().join(format!("fs-ssh-edit-{}", uuid::Uuid::new_v4()));
    create_private_dir(&dir)?;
    let local = dir.join(name);
    write_private_file(&local, &bytes)?;

    let sessions = state.sessions.clone();
    let local_str = local.to_string_lossy().into_owned();
    tauri::async_runtime::spawn(watch_and_upload(
        app,
        sessions,
        session_id,
        path,
        local.clone(),
    ));

    Ok(local_str)
}

/// Cria o diretório já com 0700 — sem janela em que fique legível por outros.
fn create_private_dir(dir: &Path) -> AppResult<()> {
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)?;
    Ok(())
}

/// Grava o arquivo já com 0600 (create_new + mode), como o askpass.
fn write_private_file(path: &Path, bytes: &[u8]) -> AppResult<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}

/// Poll de mtime + reenvio. Termina quando a sessão morre ou o arquivo some;
/// ao terminar, apaga o temporário e o diretório.
async fn watch_and_upload(
    app: AppHandle,
    sessions: std::sync::Arc<crate::ssh::SessionManager>,
    session_id: String,
    remote: String,
    local: std::path::PathBuf,
) {
    let mut last_mtime = std::fs::metadata(&local).ok().and_then(|m| m.modified().ok());

    loop {
        tokio::time::sleep(EDIT_POLL).await;

        let Ok(meta) = tokio::fs::metadata(&local).await else {
            break; // arquivo apagado — nada mais a vigiar
        };
        let mtime = meta.modified().ok();
        if mtime == last_mtime {
            // Sessão morta encerra o watcher mesmo sem gravações novas.
            if sessions.get(&session_id).await.is_err() {
                break;
            }
            continue;
        }
        last_mtime = mtime;

        let result = upload_back(&sessions, &session_id, &remote, &local).await;
        let (ok, error) = match result {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        let fatal = !ok && sessions.get(&session_id).await.is_err();
        let _ = app.emit(
            "edit-saved",
            EditSaved {
                session_id: session_id.clone(),
                remote: remote.clone(),
                local: local.to_string_lossy().into_owned(),
                ok,
                error,
            },
        );
        if fatal {
            break;
        }
    }

    let _ = std::fs::remove_file(&local);
    if let Some(dir) = local.parent() {
        let _ = std::fs::remove_dir(dir);
    }
}

async fn upload_back(
    sessions: &crate::ssh::SessionManager,
    session_id: &str,
    remote: &str,
    local: &Path,
) -> AppResult<()> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    let bytes = tokio::fs::read(local).await?;
    let s = sessions.get(session_id).await?.sftp().await?;
    let mut f = s
        .open_with_flags(
            remote.to_string(),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await?;
    f.write_all(&bytes).await?;
    f.flush().await?;
    f.shutdown().await?;
    Ok(())
}

/// Remove sobras de `fs-ssh-edit-*` e `fs-ssh-askpass-*` de execuções
/// anteriores (crash, panic com `panic = "abort"`). Chamado no setup do app.
pub fn sweep_stale_temp_files() {
    let tmp = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&tmp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("fs-ssh-edit-") {
            let _ = std::fs::remove_dir_all(entry.path());
        } else if name.starts_with("fs-ssh-askpass-") || name.starts_with("fs-ssh-unit-") {
            let p = entry.path();
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(p);
            } else {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

#[tauri::command]
pub fn local_list(path: String) -> AppResult<Vec<LocalEntry>> {
    sftp::local_list(&path)
}

#[tauri::command]
pub fn local_home() -> String {
    sftp::home_dir()
}

#[tauri::command]
pub fn local_parent(path: String) -> String {
    std::path::Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path)
}

#[tauri::command]
pub fn local_read_text(path: String) -> AppResult<String> {
    let meta = std::fs::metadata(&path)?;
    if meta.len() > MAX_INLINE_EDIT {
        return Err(AppError::msg("arquivo grande demais para pré-visualizar"));
    }
    Ok(std::fs::read_to_string(path)?)
}
