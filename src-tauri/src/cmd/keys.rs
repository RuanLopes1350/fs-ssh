use russh::keys::ssh_key::{HashAlg, PublicKey};
use tauri::State;

use super::net::sections;
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

/// Chave pública que mora no `~/.ssh` do host da sessão — a que se cola no
/// GitHub como deploy key, ou no `authorized_keys` de outra máquina.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePubkey {
    pub path: String,
    pub key_type: String,
    pub fingerprint: String,
    pub comment: String,
    /// Linha OpenSSH completa, pronta para a área de transferência.
    pub pubkey: String,
}

/// Uma seção `##caminho` por arquivo. O glob sem match fica literal no `sh`,
/// e o `-r` descarta esse caso junto com os arquivos sem permissão de leitura.
const REMOTE_PUBKEYS_SCRIPT: &str = r#"for f in "$HOME"/.ssh/*.pub; do
  [ -r "$f" ] || continue
  printf '##%s\n' "$f"
  cat "$f"
  echo
done
exit 0
"#;

/// Lista as chaves públicas do `~/.ssh` do host da sessão (SSH ou terminal
/// local), por exec — não passa pelo terminal do usuário.
#[tauri::command]
pub async fn keys_remote_list(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<RemotePubkey>> {
    let handle = state.sessions.get(&session_id).await?;
    let (_exit_code, out) = handle.exec(REMOTE_PUBKEYS_SCRIPT.to_string()).await?;
    Ok(parse_remote_pubkeys(&String::from_utf8_lossy(&out)))
}

fn parse_remote_pubkeys(text: &str) -> Vec<RemotePubkey> {
    let mut keys: Vec<RemotePubkey> = sections(text)
        .into_iter()
        .filter_map(|(path, body)| {
            // Arquivo `.pub` que não é chave (anotação, lixo) fica de fora em
            // vez de ir parar na área de transferência de alguém.
            let line = body.lines().map(str::trim).find(|l| !l.is_empty())?;
            let key = PublicKey::from_openssh(line).ok()?;
            Some(RemotePubkey {
                path: path.to_string(),
                key_type: key.algorithm().as_str().to_string(),
                fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                comment: key.comment().to_string(),
                pubkey: line.to_string(),
            })
        })
        .collect();
    keys.sort_by(|a, b| a.path.cmp(&b.path));
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED25519: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl deploy@vm";

    #[test]
    fn parses_valid_keys_and_skips_garbage() {
        let out = format!(
            "banner do motd\n##/home/u/.ssh/notes.pub\nnão é chave\n\n##/home/u/.ssh/id_ed25519.pub\n{ED25519}\n\n"
        );
        let keys = parse_remote_pubkeys(&out);
        assert_eq!(keys.len(), 1);
        let k = &keys[0];
        assert_eq!(k.path, "/home/u/.ssh/id_ed25519.pub");
        assert_eq!(k.key_type, "ssh-ed25519");
        assert_eq!(k.comment, "deploy@vm");
        assert_eq!(k.pubkey, ED25519);
        assert!(k.fingerprint.starts_with("SHA256:"));
    }

    #[test]
    fn empty_when_host_has_no_keys() {
        assert!(parse_remote_pubkeys("").is_empty());
    }
}
