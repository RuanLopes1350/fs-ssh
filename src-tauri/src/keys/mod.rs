pub mod sshconfig;

use std::path::{Path, PathBuf};

use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};

use crate::error::{AppError, AppResult};
use crate::store::models::Identity;

pub fn ssh_dir() -> AppResult<PathBuf> {
    Ok(dirs::home_dir()
        .ok_or_else(|| AppError::msg("não foi possível localizar o diretório home"))?
        .join(".ssh"))
}

/// Varre `~/.ssh` procurando chaves privadas.
///
/// O formato OpenSSH guarda a parte pública em claro mesmo em chaves cifradas,
/// então dá para extrair fingerprint, tipo e comentário sem nunca pedir a
/// passphrase — a listagem funciona inteira sem prompt.
pub fn discover() -> AppResult<Vec<Identity>> {
    let dir = ssh_dir()?;
    let mut out = Vec::new();

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // Arquivos que nunca são chave privada.
        if name.ends_with(".pub")
            || matches!(
                name.as_str(),
                "known_hosts" | "known_hosts.old" | "config" | "authorized_keys" | "environment"
            )
        {
            continue;
        }

        let Ok(key) = PrivateKey::read_openssh_file(&path) else {
            continue;
        };
        out.push(identity_from_key(&key, &path, "host"));
    }

    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    Ok(out)
}

fn identity_from_key(key: &PrivateKey, path: &Path, source: &str) -> Identity {
    let pubkey = key.public_key();
    let label = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "chave".into());
    Identity {
        id: format!("fp:{}", pubkey.fingerprint(HashAlg::Sha256)),
        label,
        source: source.into(),
        path: Some(path.to_string_lossy().into_owned()),
        pubkey: pubkey.to_openssh().unwrap_or_default(),
        fingerprint: pubkey.fingerprint(HashAlg::Sha256).to_string(),
        key_type: pubkey.algorithm().as_str().to_string(),
        has_passphrase: key.is_encrypted(),
        comment: key.comment().to_string(),
        in_agent: false,
    }
}

/// Chaves atualmente carregadas no ssh-agent, por fingerprint.
pub async fn agent_fingerprints() -> Vec<String> {
    let Ok(mut agent) = AgentClient::connect_env().await else {
        return Vec::new();
    };
    let Ok(ids) = agent.request_identities().await else {
        return Vec::new();
    };
    ids.into_iter()
        .filter_map(|i| match i {
            AgentIdentity::PublicKey { key, .. } => {
                Some(key.fingerprint(HashAlg::Sha256).to_string())
            }
            AgentIdentity::Certificate { .. } => None,
        })
        .collect()
}

/// Chaves que só existem dentro do agente (sem arquivo correspondente em
/// `~/.ssh`) — típico de chaves vindas de smartcard, 1Password ou Secretive.
pub async fn agent_only_identities(known: &[Identity]) -> Vec<Identity> {
    let Ok(mut agent) = AgentClient::connect_env().await else {
        return Vec::new();
    };
    let Ok(ids) = agent.request_identities().await else {
        return Vec::new();
    };

    ids.into_iter()
        .filter_map(|i| match i {
            AgentIdentity::PublicKey { key, comment } => {
                let fp = key.fingerprint(HashAlg::Sha256).to_string();
                if known.iter().any(|k| k.fingerprint == fp) {
                    return None;
                }
                Some(Identity {
                    id: format!("fp:{fp}"),
                    label: if comment.is_empty() {
                        format!("{} (agente)", key.algorithm().as_str())
                    } else {
                        comment.clone()
                    },
                    source: "agent".into(),
                    path: None,
                    pubkey: key.to_openssh().unwrap_or_default(),
                    fingerprint: fp,
                    key_type: key.algorithm().as_str().to_string(),
                    has_passphrase: false,
                    comment,
                    in_agent: true,
                })
            }
            AgentIdentity::Certificate { .. } => None,
        })
        .collect()
}

/// Gera um novo par e grava em `~/.ssh`.
///
/// A chave privada sai com permissão 0600 — o sshd e o próprio ssh recusam
/// chaves com permissão frouxa, então isso não é zelo, é requisito.
pub fn generate(
    kind: &str,
    name: &str,
    comment: &str,
    passphrase: Option<&str>,
) -> AppResult<Identity> {
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return Err(AppError::msg("nome de chave inválido"));
    }

    let algorithm = match kind {
        "ed25519" => Algorithm::Ed25519,
        "rsa" => Algorithm::Rsa { hash: None },
        other => return Err(AppError::msg(format!("tipo de chave não suportado: {other}"))),
    };

    let dir = ssh_dir()?;
    std::fs::create_dir_all(&dir)?;
    let priv_path = dir.join(name);
    let pub_path = dir.join(format!("{name}.pub"));
    if priv_path.exists() || pub_path.exists() {
        return Err(AppError::msg(format!("{name} já existe em ~/.ssh")));
    }

    let mut rng = rand::rng();
    let mut key = PrivateKey::random(&mut rng, algorithm)?;
    key.set_comment(comment);

    let to_write = match passphrase {
        Some(p) if !p.is_empty() => key.encrypt(&mut rng, p)?,
        _ => key.clone(),
    };

    to_write.write_openssh_file(&priv_path, LineEnding::LF)?;
    std::fs::write(&pub_path, key.public_key().to_openssh()?)?;
    set_mode(&priv_path, 0o600)?;
    set_mode(&pub_path, 0o644)?;

    Ok(identity_from_key(&to_write, &priv_path, "generated"))
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> AppResult<()> {
    Ok(())
}

/// Delega ao `ssh-add` do sistema.
///
/// Reimplementar a integração do `--apple-use-keychain` significaria falar com o
/// Keychain e com o agente por conta própria; chamar a ferramenta oficial é mais
/// curto e não diverge do comportamento que o usuário já conhece.
pub async fn add_to_agent(
    path: &str,
    passphrase: Option<&str>,
    use_keychain: bool,
) -> AppResult<()> {
    let ssh_dir = ssh_dir()?;
    let canonical = std::fs::canonicalize(path)?;
    if !canonical.starts_with(&ssh_dir) {
        return Err(AppError::msg("só é possível adicionar chaves de ~/.ssh"));
    }

    let mut cmd = tokio::process::Command::new("ssh-add");
    if use_keychain {
        cmd.arg("--apple-use-keychain");
    }
    cmd.arg(&canonical);

    // O ssh-add só lê a passphrase de um TTY ou via SSH_ASKPASS. Com uma
    // passphrase em mãos, usamos o askpass; sem ela, deixamos o ssh-add pedir
    // (chave sem passphrase entra direto).
    let _askpass_guard;
    if let Some(p) = passphrase.filter(|p| !p.is_empty()) {
        let script = write_askpass(p)?;
        cmd.env("SSH_ASKPASS", &script);
        cmd.env("SSH_ASKPASS_REQUIRE", "force");
        cmd.env("DISPLAY", ":0");
        _askpass_guard = AskpassGuard(script);
    }

    let out = cmd.output().await?;
    if out.status.success() {
        Ok(())
    } else {
        Err(AppError::msg(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

struct AskpassGuard(PathBuf);

impl Drop for AskpassGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write_askpass(passphrase: &str) -> AppResult<PathBuf> {
    use std::io::Write;

    let path = std::env::temp_dir().join(format!("fs-ssh-askpass-{}", uuid::Uuid::new_v4()));
    // A passphrase passa por um arquivo temporário de vida curta em vez da
    // linha de comando, que seria visível para qualquer processo via `ps`.
    // O arquivo nasce 0700 (create_new + mode) — criar com o umask default e
    // corrigir depois deixaria uma janela em que ele é legível por todos.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o700);
    }
    let mut f = opts.open(&path)?;
    writeln!(f, "#!/bin/sh")?;
    writeln!(f, "cat <<'FS_SSH_EOF'")?;
    writeln!(f, "{passphrase}")?;
    writeln!(f, "FS_SSH_EOF")?;
    Ok(path)
}

/// Instala uma chave pública no `~/.ssh/authorized_keys` do servidor, usando a
/// sessão SFTP já autenticada. É o `ssh-copy-id` sem precisar de outro login.
pub async fn install_on_host(
    sftp: &russh_sftp::client::SftpSession,
    public_key: &str,
) -> AppResult<()> {
    let home = sftp.canonicalize(".").await?;
    let ssh_path = format!("{home}/.ssh");
    let auth_path = format!("{ssh_path}/authorized_keys");

    if !sftp.try_exists(ssh_path.clone()).await.unwrap_or(false) {
        sftp.create_dir(ssh_path.clone()).await?;
    }

    let mut existing = match sftp.read(auth_path.clone()).await {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(_) => String::new(),
    };

    let entry = public_key.trim();
    if existing.lines().any(|l| l.trim() == entry) {
        return Ok(()); // idempotente: rodar de novo não duplica a linha
    }
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(entry);
    existing.push('\n');

    // `SftpSession::write` abre com WRITE puro, sem CREATE: falharia com
    // NoSuchFile justamente no caso mais comum, o de um servidor onde
    // `authorized_keys` ainda não existe.
    {
        use tokio::io::AsyncWriteExt;
        let mut f = sftp
            .open_with_flags(
                auth_path.clone(),
                russh_sftp::protocol::OpenFlags::WRITE
                    | russh_sftp::protocol::OpenFlags::CREATE
                    | russh_sftp::protocol::OpenFlags::TRUNCATE,
            )
            .await?;
        f.write_all(existing.as_bytes()).await?;
        f.flush().await?;
        f.shutdown().await?;
    }

    let mut meta = sftp.metadata(auth_path.clone()).await?;
    meta.permissions = Some(0o600);
    sftp.set_metadata(auth_path, meta).await?;

    let mut dir_meta = sftp.metadata(ssh_path.clone()).await?;
    dir_meta.permissions = Some(0o40700);
    sftp.set_metadata(ssh_path, dir_meta).await?;

    Ok(())
}
