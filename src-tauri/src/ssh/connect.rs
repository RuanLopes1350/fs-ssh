use std::sync::Arc;
use std::time::Duration;

use russh::client::Handle;
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{ssh_key, PrivateKeyWithHashAlg};

use crate::error::{AppError, AppResult};
use crate::store::models::{Connection as Conn, Identity};
use crate::store::Db;

use super::handler::{ClientHandler, RemoteTargets};
use super::hostkey::{HostKeyVerifier, Verdict};

pub struct Connected {
    pub handle: Handle<ClientHandler>,
    pub jump: Option<Handle<ClientHandler>>,
    pub server_banner: Option<String>,
    pub host_fingerprint: String,
    /// Mapa de túneis reversos compartilhado com o handler desta sessão.
    pub remote_targets: RemoteTargets,
}

/// Teto para TCP + troca de chaves.
///
/// Sem isso vale o default do macOS (~75 s), tempo demais encarando uma tela de
/// "conectando" quando o host simplesmente não responde — o caso comum de IP
/// errado ou VPN fora do ar.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);

fn client_config() -> Arc<russh::client::Config> {
    Arc::new(russh::client::Config {
        // Keepalive detecta queda de link (Wi-Fi, VPN) em ~60 s em vez de o
        // socket ficar pendurado até o TCP desistir.
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        inactivity_timeout: None,
        ..Default::default()
    })
}

/// Abre a conexão TCP/SSH e autentica, opcionalmente através de um bastion.
pub async fn connect(
    db: Arc<Db>,
    conn: &Conn,
    jump_conn: Option<&Conn>,
    identity: Option<&Identity>,
    jump_identity: Option<&Identity>,
    secret: Option<&str>,
    jump_secret: Option<&str>,
) -> AppResult<Connected> {
    // Bastion: conecta e autentica no jump host primeiro, e só então abre um
    // direct-tcpip até o destino. A sessão final roda por dentro desse túnel,
    // exatamente como o ProxyJump do OpenSSH.
    //
    // O segredo do bastion chega separado (`jump_secret`): um `AuthRequired`
    // daqui sai marcado com `for_jump` para o frontend saber a quem pertence a
    // senha que vai pedir — sem isso a senha do usuário seria reaplicada ao
    // destino e o diálogo entraria em loop.
    let jump_handle = match jump_conn {
        Some(jc) => {
            let (mut h, _, _, _) = transport(db.clone(), jc).await?;
            authenticate(&mut h, jc, jump_identity, jump_secret)
                .await
                .map_err(|e| match e {
                    AppError::AuthRequired { kind, prompt, .. } => AppError::AuthRequired {
                        kind,
                        prompt,
                        for_jump: true,
                    },
                    other => other,
                })?;
            Some(h)
        }
        None => None,
    };

    let (mut handle, banner, fingerprint, remote_targets) = match &jump_handle {
        Some(jh) => {
            let channel = jh
                .channel_open_direct_tcpip(conn.host.clone(), conn.port as u32, "127.0.0.1", 0)
                .await?;
            transport_over(db.clone(), conn, channel.into_stream()).await?
        }
        None => transport(db.clone(), conn).await?,
    };

    authenticate(&mut handle, conn, identity, secret).await?;

    Ok(Connected {
        handle,
        jump: jump_handle,
        server_banner: banner,
        host_fingerprint: fingerprint,
        remote_targets,
    })
}

type Transport = (
    Handle<ClientHandler>,
    Option<String>,
    String,
    RemoteTargets,
);

/// Só o transporte: TCP + KEX + verificação de host key. Sem autenticação.
async fn transport(db: Arc<Db>, conn: &Conn) -> AppResult<Transport> {
    let (handler, verifier, banner, targets) = make_handler(db, conn);
    let handle = tokio::time::timeout(
        CONNECT_TIMEOUT,
        russh::client::connect(client_config(), (conn.host.as_str(), conn.port), handler),
    )
    .await
    .map_err(|_| timeout_error(conn))?
    .map_err(|e| host_key_error(&verifier, conn, e))?;
    Ok(finish(handle, verifier, banner, targets))
}

fn timeout_error(conn: &Conn) -> AppError {
    AppError::msg(format!(
        "{}:{} não respondeu em {}s. Verifique o host, a porta e se a VPN está ativa.",
        conn.host,
        conn.port,
        CONNECT_TIMEOUT.as_secs()
    ))
}

/// Mesma coisa, mas sobre um stream já existente (o canal do bastion).
async fn transport_over<S>(db: Arc<Db>, conn: &Conn, stream: S) -> AppResult<Transport>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (handler, verifier, banner, targets) = make_handler(db, conn);
    let handle = russh::client::connect_stream(client_config(), stream, handler)
        .await
        .map_err(|e| host_key_error(&verifier, conn, e))?;
    Ok(finish(handle, verifier, banner, targets))
}

type Banner = Arc<std::sync::Mutex<Option<String>>>;

fn make_handler(
    db: Arc<Db>,
    conn: &Conn,
) -> (ClientHandler, Arc<HostKeyVerifier>, Banner, RemoteTargets) {
    let verifier = Arc::new(HostKeyVerifier::new(db, conn.host.clone(), conn.port));
    let banner: Banner = Arc::new(std::sync::Mutex::new(None));
    let remote_targets: RemoteTargets = Arc::default();
    let handler = ClientHandler {
        verifier: verifier.clone(),
        banner: banner.clone(),
        remote_targets: remote_targets.clone(),
    };
    (handler, verifier, banner, remote_targets)
}

fn finish(
    handle: Handle<ClientHandler>,
    verifier: Arc<HostKeyVerifier>,
    banner: Banner,
    remote_targets: RemoteTargets,
) -> Transport {
    let fingerprint = verifier
        .state
        .lock()
        .map(|s| s.fingerprint.clone())
        .unwrap_or_default();
    let banner = banner.lock().ok().and_then(|b| b.clone());
    (handle, banner, fingerprint, remote_targets)
}

/// Traduz uma falha de conexão em erro de host key quando foi o verificador que
/// recusou. Sem isso o usuário só veria "Unknown key" e não teria como confiar
/// no servidor.
fn host_key_error(verifier: &HostKeyVerifier, conn: &Conn, e: russh::Error) -> AppError {
    let st = match verifier.state.lock() {
        Ok(s) => s.clone(),
        Err(_) => return AppError::Ssh(e),
    };
    match st.verdict {
        Verdict::Unknown => AppError::HostKeyUnknown {
            host: conn.host.clone(),
            port: conn.port,
            fingerprint: st.fingerprint,
            algorithm: st.algorithm,
        },
        Verdict::Changed { known_fingerprint } => AppError::HostKeyChanged {
            host: conn.host.clone(),
            port: conn.port,
            fingerprint: st.fingerprint,
            known_fingerprint,
            algorithm: st.algorithm,
        },
        _ => AppError::Ssh(e),
    }
}

/// Pipeline de autenticação: agente → chave em disco → senha.
///
/// O agente vem primeiro de propósito: é o único caminho em que o app nunca toca
/// no material da chave privada.
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    conn: &Conn,
    identity: Option<&Identity>,
    secret: Option<&str>,
) -> AppResult<()> {
    let user = conn.username.clone();
    let method = conn.auth_method.as_str();
    let mut tried: Vec<String> = Vec::new();

    if matches!(method, "auto" | "agent") {
        tried.push("agent".into());
        match try_agent(handle, &user, identity).await {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(e) => tracing::debug!("agente indisponível: {e}"),
        }
    }

    if matches!(method, "auto" | "key") {
        if let Some(path) = identity.and_then(|i| i.path.as_deref()) {
            tried.push("publickey".into());
            match russh::keys::load_secret_key(path, secret) {
                Ok(key) => {
                    let hash_alg = handle
                        .best_supported_rsa_hash()
                        .await
                        .ok()
                        .flatten()
                        .flatten();
                    let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
                    if handle.authenticate_publickey(&user, key).await?.success() {
                        return Ok(());
                    }
                }
                // A chave está cifrada e não veio passphrase: isso não é falha,
                // é o app precisando perguntar.
                Err(russh::keys::Error::KeyIsEncrypted) => {
                    return Err(AppError::AuthRequired {
                        kind: "passphrase".into(),
                        prompt: format!(
                            "Passphrase da chave {}",
                            identity.map(|i| i.label.as_str()).unwrap_or(path)
                        ),
                        for_jump: false,
                    });
                }
                Err(e) => tracing::warn!("não foi possível ler {path}: {e}"),
            }
        }
    }

    if matches!(method, "auto" | "password") {
        match secret {
            Some(pw) => {
                tried.push("password".into());
                if handle.authenticate_password(&user, pw).await?.success() {
                    return Ok(());
                }
                // Alguns servidores só expõem senha via keyboard-interactive.
                if try_keyboard_interactive(handle, &user, pw).await? {
                    return Ok(());
                }
            }
            None => {
                return Err(AppError::AuthRequired {
                    kind: "password".into(),
                    prompt: format!("Senha de {user}@{}", conn.host),
                    for_jump: false,
                });
            }
        }
    }

    Err(AppError::AuthFailed { tried })
}

async fn try_agent(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    identity: Option<&Identity>,
) -> AppResult<bool> {
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(AppError::Key)?;
    let identities = agent.request_identities().await.map_err(AppError::Key)?;

    let wanted = identity.map(|i| i.fingerprint.as_str());
    let mut keys: Vec<ssh_key::PublicKey> = identities
        .into_iter()
        .filter_map(|i| match i {
            AgentIdentity::PublicKey { key, .. } => Some(key),
            AgentIdentity::Certificate { .. } => None,
        })
        .collect();

    // Se a conexão aponta uma chave específica, tenta só ela — evita queimar
    // tentativas contra o MaxAuthTries do servidor.
    if let Some(fp) = wanted {
        if let Some(pos) = keys.iter().position(|k| {
            k.fingerprint(ssh_key::HashAlg::Sha256).to_string() == fp
        }) {
            let only = keys.remove(pos);
            keys = vec![only];
        }
    }

    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();

    for key in keys {
        let result = handle
            .authenticate_publickey_with(user, key, hash_alg, &mut agent)
            .await;
        match result {
            Ok(r) if r.success() => return Ok(true),
            Ok(_) => continue,
            Err(e) => {
                tracing::debug!("assinatura pelo agente falhou: {e}");
                continue;
            }
        }
    }
    Ok(false)
}

async fn try_keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    password: &str,
) -> AppResult<bool> {
    use russh::client::KeyboardInteractiveAuthResponse as R;

    let mut response = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await?;

    // Responde a mesma senha em todos os prompts. Cobre o caso comum
    // (PAM pedindo só "Password:"); MFA de verdade precisa de UI própria.
    for _ in 0..3 {
        match response {
            R::Success => return Ok(true),
            R::Failure { .. } => return Ok(false),
            R::InfoRequest { prompts, .. } => {
                let answers = vec![password.to_string(); prompts.len()];
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
    Ok(false)
}
