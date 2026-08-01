pub mod conn;
pub mod forward;
pub mod keys;
pub mod record;
pub mod sftp;
pub mod ssh;

use std::path::PathBuf;
use std::sync::Arc;

use crate::ssh::SessionManager;
use crate::store::Db;

/// Estado compartilhado da aplicação, injetado nos comandos por `tauri::State`.
pub struct AppState {
    pub db: Arc<Db>,
    pub sessions: Arc<SessionManager>,
    /// Diretório de dados do app — banco, gravações e logs vivem aqui.
    pub data_dir: PathBuf,
}
