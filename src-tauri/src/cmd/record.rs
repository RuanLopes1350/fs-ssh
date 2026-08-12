use std::path::{Path, PathBuf};

use tauri::State;

use super::AppState;
use crate::error::{AppError, AppResult};

/// Teto ao ler uma gravação/log na UI. Arquivos maiores mostram só o fim.
const MAX_VIEW: u64 = 2 * 1024 * 1024;

pub fn recordings_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("recordings")
}

pub fn logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Epoch em segundos — o frontend formata.
    pub modified: u64,
    /// `text` ou `cast` (asciinema, com timing e replay).
    pub format: String,
}

/// Começa a gravar a saída da sessão em `recordings/<conexão>-<data>.<ext>`.
///
/// `format` escolhe entre texto legível (`text`) e asciicast (`cast`); as
/// dimensões só importam no `cast`, que as guarda no cabeçalho.
#[tauri::command]
pub async fn recording_start(
    state: State<'_, AppState>,
    session_id: String,
    format: Option<String>,
    cols: Option<u32>,
    rows: Option<u32>,
) -> AppResult<String> {
    let handle = state.sessions.get(&session_id).await?;
    if let Some(existing) = handle.recording_path().await {
        return Ok(existing); // já gravando: idempotente
    }

    let format = match format.as_deref() {
        Some("cast") => "cast",
        _ => "text",
    };
    let name = state
        .db
        .get_connection(&handle.info.connection_id)
        .map(|c| c.name)
        .unwrap_or_else(|_| handle.info.host.clone());
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    let ext = if format == "cast" { "cast" } else { "log" };
    let file = format!("{}-{stamp}.{ext}", slug(&name));

    let path = recordings_dir(&state.data_dir).join(file);
    let path = path.to_string_lossy().into_owned();
    handle
        .set_recording(
            Some(path.clone()),
            format,
            cols.unwrap_or(80),
            rows.unwrap_or(24),
        )
        .await?;
    state.db.log_event(
        "info",
        "recording",
        Some(&handle.info.connection_id),
        &name,
        &format!("gravação iniciada em {path}"),
    );
    Ok(path)
}

#[tauri::command]
pub async fn recording_stop(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state
        .sessions
        .get(&session_id)
        .await?
        .set_recording(None, "text", 0, 0)
        .await
}

/// Caminho da gravação em andamento da sessão, se houver.
#[tauri::command]
pub async fn recording_active(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Option<String>> {
    Ok(state.sessions.get(&session_id).await?.recording_path().await)
}

#[tauri::command]
pub fn recording_list(state: State<'_, AppState>) -> AppResult<Vec<Recording>> {
    let dir = recordings_dir(&state.data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default();
        if ext != "log" && ext != "cast" {
            continue;
        }
        let meta = entry.metadata()?;
        out.push(Recording {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            format: if ext == "cast" { "cast".into() } else { "text".into() },
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        });
    }
    // Mais recentes primeiro.
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub fn recording_read(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let file = ensure_inside(&recordings_dir(&state.data_dir), &path)?;
    read_tail(&file)
}

#[tauri::command]
pub fn recording_delete(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let file = ensure_inside(&recordings_dir(&state.data_dir), &path)?;
    std::fs::remove_file(file)?;
    Ok(())
}

#[tauri::command]
pub fn recordings_dir_path(state: State<'_, AppState>) -> String {
    recordings_dir(&state.data_dir).to_string_lossy().into_owned()
}

/// Grava um texto no caminho escolhido pelo usuário no diálogo do sistema —
/// exportação de sessão (HTML) e de histórico (JSON) passam por aqui.
///
/// O conteúdo é o que estava na tela ou no histórico: pode ter segredo, então o
/// arquivo nasce 0600, como as gravações. O caminho vem do diálogo nativo, não
/// do webview, e por isso não há o que sanitizar aqui além de exigir absoluto.
#[tauri::command]
pub fn export_text(path: String, contents: String) -> AppResult<()> {
    use std::io::Write;

    let target = Path::new(&path);
    if !target.is_absolute() {
        return Err(AppError::msg("caminho de exportação inválido"));
    }
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(target)?.write_all(contents.as_bytes())?;
    Ok(())
}

// ------------------------------------------------------- log de eventos (DB)

/// Eventos da aplicação, filtrados por data/conexão — alimenta a tela de logs.
#[tauri::command]
pub fn log_list(
    state: State<'_, AppState>,
    query: crate::store::models::LogQuery,
) -> AppResult<Vec<crate::store::models::LogEntry>> {
    state.db.list_logs(&query)
}

#[tauri::command]
pub fn log_clear(state: State<'_, AppState>) -> AppResult<()> {
    state.db.clear_logs()
}

// ------------------------------------------------------- log bruto (arquivo)

#[tauri::command]
pub fn logs_read(state: State<'_, AppState>) -> AppResult<String> {
    let file = logs_dir(&state.data_dir).join("fs-ssh.log");
    if !file.exists() {
        return Ok(String::new());
    }
    read_tail(&file)
}

#[tauri::command]
pub fn logs_path(state: State<'_, AppState>) -> String {
    logs_dir(&state.data_dir)
        .join("fs-ssh.log")
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
pub fn logs_clear(state: State<'_, AppState>) -> AppResult<()> {
    let file = logs_dir(&state.data_dir).join("fs-ssh.log");
    if file.exists() {
        std::fs::write(&file, b"")?;
    }
    Ok(())
}

// ------------------------------------------------------------------ helpers

/// Só abre arquivos dentro do diretório esperado — o caminho vem do webview.
fn ensure_inside(dir: &Path, path: &str) -> AppResult<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    let base = std::fs::canonicalize(dir)?;
    if !canonical.starts_with(&base) {
        return Err(AppError::msg("caminho fora do diretório de gravações"));
    }
    Ok(canonical)
}

/// Lê o fim do arquivo (últimos `MAX_VIEW` bytes) — logs e gravações longas não
/// precisam entrar inteiros na memória do webview.
fn read_tail(path: &Path) -> AppResult<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let mut truncated = false;
    if len > MAX_VIEW {
        f.seek(SeekFrom::Start(len - MAX_VIEW))?;
        truncated = true;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;

    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        text.insert_str(0, "…(início omitido: arquivo grande)…\n");
    }
    Ok(text)
}

/// Nome de arquivo seguro a partir do nome da conexão.
fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "sessao".into()
    } else {
        s
    }
}
