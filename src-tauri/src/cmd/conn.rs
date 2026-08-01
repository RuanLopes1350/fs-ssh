use tauri::State;

use super::AppState;
use crate::error::AppResult;
use crate::keys::sshconfig::{self, SshConfigHost};
use crate::store::models::*;
use crate::store::Connection_;

#[tauri::command]
pub fn conn_list(state: State<'_, AppState>) -> AppResult<Vec<Connection_>> {
    state.db.list_connections()
}

#[tauri::command]
pub fn conn_get(state: State<'_, AppState>, id: String) -> AppResult<Connection_> {
    state.db.get_connection(&id)
}

#[tauri::command]
pub fn conn_save(state: State<'_, AppState>, conn: Connection_) -> AppResult<Connection_> {
    state.db.save_connection(conn)
}

#[tauri::command]
pub fn conn_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.delete_connection(&id)
}

/// Backup do catálogo (conexões, pastas, tags, temas, snippets, known hosts).
/// Não há segredos no banco — senhas nunca são persistidas.
#[tauri::command]
pub fn db_backup(state: State<'_, AppState>, path: String) -> AppResult<()> {
    state.db.backup_to(&path)
}

#[tauri::command]
pub fn folder_list(state: State<'_, AppState>) -> AppResult<Vec<Folder>> {
    state.db.list_folders()
}

#[tauri::command]
pub fn folder_save(state: State<'_, AppState>, folder: Folder) -> AppResult<Folder> {
    state.db.save_folder(folder)
}

#[tauri::command]
pub fn folder_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.delete_folder(&id)
}

#[tauri::command]
pub fn tag_list(state: State<'_, AppState>) -> AppResult<Vec<Tag>> {
    state.db.list_tags()
}

#[tauri::command]
pub fn tag_save(state: State<'_, AppState>, tag: Tag) -> AppResult<Tag> {
    state.db.save_tag(tag)
}

#[tauri::command]
pub fn tag_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.delete_tag(&id)
}

#[tauri::command]
pub fn theme_list(state: State<'_, AppState>) -> AppResult<Vec<Theme>> {
    state.db.list_themes()
}

#[tauri::command]
pub fn theme_save(state: State<'_, AppState>, theme: Theme) -> AppResult<Theme> {
    state.db.save_theme(theme)
}

#[tauri::command]
pub fn theme_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.delete_theme(&id)
}

#[tauri::command]
pub fn snippet_list(state: State<'_, AppState>) -> AppResult<Vec<Snippet>> {
    state.db.list_snippets()
}

#[tauri::command]
pub fn snippet_save(state: State<'_, AppState>, snippet: Snippet) -> AppResult<Snippet> {
    state.db.save_snippet(snippet)
}

#[tauri::command]
pub fn snippet_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.delete_snippet(&id)
}

#[tauri::command]
pub fn known_hosts_list(state: State<'_, AppState>) -> AppResult<Vec<KnownHost>> {
    state.db.list_known_hosts()
}

#[tauri::command]
pub fn known_hosts_forget(state: State<'_, AppState>, host: String, port: u16) -> AppResult<()> {
    state.db.forget_host(&host, port)
}

/// Marca a host key como confiável. Chamado depois do diálogo TOFU — nunca
/// automaticamente.
#[tauri::command]
pub fn host_key_trust(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
) -> AppResult<()> {
    state
        .db
        .trust_host(&host, port, &key_type, &fingerprint, "")
}

#[tauri::command]
pub fn sshconfig_read() -> AppResult<Vec<SshConfigHost>> {
    sshconfig::load()
}

/// Importa entradas do `~/.ssh/config` como conexões. Não sobrescreve nada:
/// hosts que já existem (mesmo host+porta+usuário) são pulados e reportados.
#[tauri::command]
pub fn sshconfig_import(
    state: State<'_, AppState>,
    hosts: Vec<SshConfigHost>,
) -> AppResult<ImportResult> {
    let existing = state.db.list_connections()?;
    let identities = state.db.list_identities()?;
    let mut imported = 0usize;
    let mut skipped: Vec<String> = Vec::new();

    for h in hosts {
        let user = h.user.clone().unwrap_or_else(whoami_fallback);
        let port = h.port.unwrap_or(22);
        let dup = existing
            .iter()
            .any(|c| c.host == h.hostname && c.port == port && c.username == user);
        if dup {
            skipped.push(h.alias.clone());
            continue;
        }

        let identity_id = h.identity_file.as_ref().and_then(|f| {
            identities
                .iter()
                .find(|i| i.path.as_deref() == Some(f.as_str()))
                .map(|i| i.id.clone())
        });

        state.db.save_connection(Connection_ {
            id: String::new(),
            name: h.alias.clone(),
            host: h.hostname.clone(),
            port,
            username: user,
            auth_method: "auto".into(),
            identity_id,
            jump_host_id: None,
            folder_id: None,
            color: "#3b82f6".into(),
            icon: "server".into(),
            theme_id: None,
            is_production: false,
            notes: format!("importado de ~/.ssh/config (Host {})", h.alias),
            created_at: String::new(),
            last_used_at: None,
            use_count: 0,
            tag_ids: Vec::new(),
        })?;
        imported += 1;
    }

    Ok(ImportResult { imported, skipped })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: Vec<String>,
}

fn whoami_fallback() -> String {
    std::env::var("USER").unwrap_or_else(|_| "root".into())
}
