use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub label: String,
    /// `host` (encontrada em ~/.ssh), `generated` (criada pelo app) ou `agent`
    /// (só existe dentro do ssh-agent, sem arquivo em disco).
    pub source: String,
    pub path: Option<String>,
    pub pubkey: String,
    pub fingerprint: String,
    pub key_type: String,
    pub has_passphrase: bool,
    #[serde(default)]
    pub comment: String,
    /// Preenchido em tempo de execução: a chave está carregada no ssh-agent.
    #[serde(default)]
    pub in_agent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub is_builtin: bool,
    /// Paleta xterm.js serializada (16 cores ANSI + foreground/background/cursor/selection).
    pub json: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default = "default_auth")]
    pub auth_method: String,
    pub identity_id: Option<String>,
    pub jump_host_id: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    pub theme_id: Option<String>,
    #[serde(default)]
    pub is_production: bool,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_at: String,
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub use_count: i64,
}

fn default_port() -> u16 {
    22
}
fn default_auth() -> String {
    "auto".into()
}
fn default_color() -> String {
    "#3b82f6".into()
}
fn default_icon() -> String {
    "server".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    #[serde(default)]
    pub id: String,
    pub connection_id: String,
    /// `local` (-L) ou `remote` (-R).
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_bind")]
    pub bind_addr: String,
    /// -L: porta local escutada; -R: porta exposta no servidor.
    pub local_port: u16,
    /// -L: destino alcançado pelo servidor; -R: destino na máquina local.
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub auto_start: bool,
}

fn default_bind() -> String {
    "127.0.0.1".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    #[serde(default)]
    pub id: i64,
    /// RFC3339 em UTC.
    pub ts: String,
    pub level: String,
    pub kind: String,
    pub connection_id: Option<String>,
    #[serde(default)]
    pub connection: String,
    pub message: String,
}

/// Filtros da tela de logs. Datas em `YYYY-MM-DD` (dia local do usuário).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub connection_id: Option<String>,
    pub level: Option<String>,
    pub search: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub pubkey: String,
    pub first_seen: String,
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub body: String,
    pub tag_scope: Option<String>,
}
