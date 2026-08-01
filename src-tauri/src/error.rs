use serde::Serialize;

/// Erros da aplicação.
///
/// A serialização é estruturada (`kind` + `message` + `data`) em vez de uma string
/// solta, porque o frontend precisa reagir de forma diferente a `host_key_unknown`
/// (mostrar diálogo TOFU) e a `auth_required` (pedir senha/passphrase) — ambos são
/// parte do fluxo normal de conexão, não falhas.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),

    #[error("banco de dados: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("ssh: {0}")]
    Ssh(#[from] russh::Error),

    #[error("chave: {0}")]
    Key(#[from] russh::keys::Error),

    #[error("ssh-key: {0}")]
    SshKey(#[from] russh::keys::ssh_key::Error),

    #[error("sftp: {0}")]
    Sftp(String),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("sessão {0} não encontrada")]
    NoSession(String),

    /// Host desconhecido — o frontend deve mostrar o diálogo TOFU com o fingerprint.
    #[error("host key desconhecida para {host}:{port}")]
    HostKeyUnknown {
        host: String,
        port: u16,
        fingerprint: String,
        algorithm: String,
    },

    /// Host key mudou — potencial MITM. Bloqueia a conexão.
    #[error("a host key de {host}:{port} MUDOU")]
    HostKeyChanged {
        host: String,
        port: u16,
        fingerprint: String,
        known_fingerprint: String,
        algorithm: String,
    },

    /// Falta um segredo para completar a autenticação.
    #[error("autenticação requer {kind}")]
    AuthRequired {
        /// `passphrase` (chave cifrada) ou `password` (senha do usuário).
        kind: String,
        prompt: String,
        /// O segredo pedido é do jump host (bastion), não do destino final.
        for_jump: bool,
    },

    #[error("autenticação recusada pelo servidor")]
    AuthFailed { tried: Vec<String> },
}

impl AppError {
    pub fn msg(m: impl Into<String>) -> Self {
        AppError::Msg(m.into())
    }

    fn kind(&self) -> &'static str {
        match self {
            AppError::HostKeyUnknown { .. } => "host_key_unknown",
            AppError::HostKeyChanged { .. } => "host_key_changed",
            AppError::AuthRequired { .. } => "auth_required",
            AppError::AuthFailed { .. } => "auth_failed",
            AppError::NoSession(_) => "no_session",
            AppError::Db(_) => "db",
            AppError::Io(_) => "io",
            AppError::Sftp(_) => "sftp",
            _ => "error",
        }
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        AppError::Sftp(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 3)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        let data = match self {
            AppError::HostKeyUnknown {
                host,
                port,
                fingerprint,
                algorithm,
            } => serde_json::json!({
                "host": host, "port": port,
                "fingerprint": fingerprint, "algorithm": algorithm
            }),
            AppError::HostKeyChanged {
                host,
                port,
                fingerprint,
                known_fingerprint,
                algorithm,
            } => serde_json::json!({
                "host": host, "port": port,
                "fingerprint": fingerprint, "knownFingerprint": known_fingerprint,
                "algorithm": algorithm
            }),
            AppError::AuthRequired {
                kind,
                prompt,
                for_jump,
            } => {
                serde_json::json!({ "authKind": kind, "prompt": prompt, "forJump": for_jump })
            }
            AppError::AuthFailed { tried } => serde_json::json!({ "tried": tried }),
            _ => serde_json::Value::Null,
        };
        st.serialize_field("data", &data)?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
