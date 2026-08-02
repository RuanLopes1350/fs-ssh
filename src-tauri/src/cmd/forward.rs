use tauri::State;

use super::AppState;
use crate::error::AppResult;
use crate::store::models::PortForward;

// Definições (persistidas por conexão) ---------------------------------------

#[tauri::command]
pub fn forward_list(state: State<'_, AppState>, connection_id: String) -> AppResult<Vec<PortForward>> {
    state.db.list_forwards(&connection_id)
}

#[tauri::command]
pub fn forward_save(state: State<'_, AppState>, forward: PortForward) -> AppResult<PortForward> {
    state.db.save_forward(forward)
}

#[tauri::command]
pub fn forward_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.delete_forward(&id)
}

// Runtime (por sessão) --------------------------------------------------------

#[tauri::command]
pub async fn forward_start(
    state: State<'_, AppState>,
    session_id: String,
    forward_id: String,
) -> AppResult<()> {
    let forward = state.db.get_forward(&forward_id)?;
    let handle = state.sessions.get(&session_id).await?;
    let result = handle.start_forward(&forward).await;

    let conn = state.db.get_connection(&handle.info.connection_id).ok();
    let name = conn.as_ref().map(|c| c.name.clone()).unwrap_or_default();
    match &result {
        Ok(()) => state.db.log_event(
            "info",
            "tunnel",
            Some(&handle.info.connection_id),
            &name,
            &format!("túnel {} ligado ({})", describe(&forward), forward.kind),
        ),
        Err(e) => state.db.log_event(
            "error",
            "tunnel",
            Some(&handle.info.connection_id),
            &name,
            &format!("falha ao ligar o túnel {}: {e}", describe(&forward)),
        ),
    }
    result
}

#[tauri::command]
pub async fn forward_stop(
    state: State<'_, AppState>,
    session_id: String,
    forward_id: String,
) -> AppResult<()> {
    let handle = state.sessions.get(&session_id).await?;
    handle.stop_forward(&forward_id).await?;

    if let Ok(f) = state.db.get_forward(&forward_id) {
        let name = state
            .db
            .get_connection(&handle.info.connection_id)
            .map(|c| c.name)
            .unwrap_or_default();
        state.db.log_event(
            "info",
            "tunnel",
            Some(&handle.info.connection_id),
            &name,
            &format!("túnel {} desligado", describe(&f)),
        );
    }
    Ok(())
}

/// Ids dos túneis ativos nesta sessão.
#[tauri::command]
pub async fn forward_active(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<String>> {
    Ok(state
        .sessions
        .get(&session_id)
        .await?
        .active_forward_ids()
        .await)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartResult {
    pub started: Vec<String>,
    pub errors: Vec<String>,
}

/// Liga todos os túneis marcados como auto-início da conexão desta sessão.
/// Chamado pelo frontend logo após conectar. Falha de um túnel não impede os
/// outros — a porta ocupada é reportada, o resto sobe.
#[tauri::command]
pub async fn forward_autostart(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<AutostartResult> {
    let handle = state.sessions.get(&session_id).await?;
    let forwards = state.db.list_forwards(&handle.info.connection_id)?;

    let mut started = Vec::new();
    let mut errors = Vec::new();
    for f in forwards.iter().filter(|f| f.auto_start) {
        match handle.start_forward(f).await {
            Ok(()) => started.push(f.id.clone()),
            Err(e) => errors.push(format!("{}: {e}", describe(f))),
        }
    }
    Ok(AutostartResult { started, errors })
}

fn describe(f: &PortForward) -> String {
    if f.label.is_empty() {
        format!("{}:{}", f.local_port, f.remote_port)
    } else {
        f.label.clone()
    }
}
