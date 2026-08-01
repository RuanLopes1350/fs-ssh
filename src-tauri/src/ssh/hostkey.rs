use std::sync::{Arc, Mutex};

use russh::keys::ssh_key::{self, HashAlg};
use serde::Serialize;

use crate::store::Db;

/// O que o handler decidiu sobre a chave apresentada pelo servidor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// Ainda não chegou nenhuma host key (falha antes do KEX).
    Pending,
    Trusted,
    Unknown,
    Changed { known_fingerprint: String },
}

#[derive(Debug, Clone)]
pub struct HostKeyState {
    pub fingerprint: String,
    pub algorithm: String,
    pub openssh: String,
    pub verdict: Verdict,
}

impl Default for HostKeyState {
    fn default() -> Self {
        Self {
            fingerprint: String::new(),
            algorithm: String::new(),
            openssh: String::new(),
            verdict: Verdict::Pending,
        }
    }
}

/// Verificador TOFU.
///
/// Duas fontes de verdade, nessa ordem: o catálogo do app e o `~/.ssh/known_hosts`
/// do sistema. Uma chave que já está no known_hosts do OpenSSH é aceita sem
/// perguntar (e importada para o catálogo), porque o usuário já confiou nela
/// fora do app — perguntar de novo só treinaria a pessoa a clicar "aceitar".
pub struct HostKeyVerifier {
    db: Arc<Db>,
    host: String,
    port: u16,
    pub state: Arc<Mutex<HostKeyState>>,
}

impl HostKeyVerifier {
    pub fn new(db: Arc<Db>, host: String, port: u16) -> Self {
        Self {
            db,
            host,
            port,
            state: Arc::new(Mutex::new(HostKeyState::default())),
        }
    }

    pub fn check(&self, key: &ssh_key::PublicKey) -> bool {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = key.algorithm().as_str().to_string();
        let openssh = key.to_openssh().unwrap_or_default();

        let verdict = self.decide(&fingerprint, &algorithm, &openssh, key);
        let trusted = matches!(verdict, Verdict::Trusted);

        if let Ok(mut st) = self.state.lock() {
            *st = HostKeyState {
                fingerprint,
                algorithm,
                openssh,
                verdict,
            };
        }
        trusted
    }

    fn decide(
        &self,
        fingerprint: &str,
        algorithm: &str,
        openssh: &str,
        key: &ssh_key::PublicKey,
    ) -> Verdict {
        // 1. Catálogo do app.
        match self.db.known_host(&self.host, self.port, algorithm) {
            Ok(Some(known)) => {
                return if known.fingerprint == fingerprint {
                    let _ = self.db.trust_host(
                        &self.host,
                        self.port,
                        algorithm,
                        fingerprint,
                        openssh,
                    );
                    Verdict::Trusted
                } else {
                    Verdict::Changed {
                        known_fingerprint: known.fingerprint,
                    }
                };
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("falha ao consultar known_hosts do app: {e}");
            }
        }

        // 2. ~/.ssh/known_hosts do sistema.
        match russh::keys::check_known_hosts(&self.host, self.port, key) {
            Ok(true) => {
                let _ = self
                    .db
                    .trust_host(&self.host, self.port, algorithm, fingerprint, openssh);
                Verdict::Trusted
            }
            Ok(false) => Verdict::Unknown,
            Err(russh::keys::Error::KeyChanged { .. }) => Verdict::Changed {
                known_fingerprint: "(registrada em ~/.ssh/known_hosts)".into(),
            },
            Err(e) => {
                tracing::warn!("falha ao ler ~/.ssh/known_hosts: {e}");
                Verdict::Unknown
            }
        }
    }
}
