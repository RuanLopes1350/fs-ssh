use tauri::State;

use super::AppState;
use crate::error::AppResult;
use crate::keys;
use crate::store::models::Identity;

/// Relista as chaves: varre `~/.ssh`, junta as que só existem no agente e marca
/// quais estão carregadas. É o que alimenta o seletor de chave da conexão.
#[tauri::command]
pub async fn keys_list(state: State<'_, AppState>) -> AppResult<Vec<Identity>> {
    let mut found = keys::discover()?;
    found.extend(keys::agent_only_identities(&found).await);

    let mut stored = state.db.sync_identities(&found)?;

    let loaded = keys::agent_fingerprints().await;
    for id in &mut stored {
        id.in_agent = loaded.contains(&id.fingerprint);
    }
    Ok(stored)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateArgs {
    /// `ed25519` (padrão recomendado) ou `rsa` (4096 bits).
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub comment: String,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub add_to_agent: bool,
    #[serde(default)]
    pub use_keychain: bool,
}

#[tauri::command]
pub async fn keys_generate(
    state: State<'_, AppState>,
    args: GenerateArgs,
) -> AppResult<Identity> {
    let identity = keys::generate(
        &args.kind,
        &args.name,
        &args.comment,
        args.passphrase.as_deref(),
    )?;

    if args.add_to_agent {
        if let Some(path) = &identity.path {
            keys::add_to_agent(path, args.passphrase.as_deref(), args.use_keychain).await?;
        }
    }

    let mut all = state.db.list_identities()?;
    all.push(identity.clone());
    state.db.sync_identities(&all)?;
    Ok(identity)
}

#[tauri::command]
pub async fn keys_add_to_agent(
    path: String,
    passphrase: Option<String>,
    use_keychain: bool,
) -> AppResult<()> {
    keys::add_to_agent(&path, passphrase.as_deref(), use_keychain).await
}

/// Instala a chave pública no `authorized_keys` do servidor usando a sessão
/// já autenticada — sem pedir senha de novo.
#[tauri::command]
pub async fn keys_install_on_host(
    state: State<'_, AppState>,
    session_id: String,
    identity_id: String,
) -> AppResult<()> {
    let identity = state
        .db
        .get_identity(&identity_id)?
        .ok_or_else(|| crate::error::AppError::msg("chave não encontrada"))?;

    let sftp = state.sessions.get(&session_id).await?.sftp().await?;
    keys::install_on_host(&sftp, &identity.pubkey).await
}
