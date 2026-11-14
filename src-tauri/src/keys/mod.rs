pub mod sshconfig;

use std::path::{Path, PathBuf};

use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey, PublicKey};

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

        let Ok(id) = inspect_file(&path, "host") else {
            continue;
        };
        out.push(id);
    }

    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    Ok(out)
}

/// Garante permissão 0600 (somente leitura/escrita do dono) no arquivo de chave
/// privada no Unix. Em Windows, é um no-op.
pub fn ensure_private_key_mode(path: &Path) -> AppResult<()> {
    set_mode(path, 0o600)
}

/// Lê e valida um arquivo de chave privada (OpenSSH ou PEM/PKCS#8), aplica
/// `chmod 600` no arquivo e devolve a `Identity` correspondente.
pub fn inspect_file(path: &Path, source: &str) -> AppResult<Identity> {
    if !path.exists() || !path.is_file() {
        return Err(AppError::msg(format!(
            "Arquivo de chave não encontrado: {}",
            path.display()
        )));
    }
    if path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".pub"))
    {
        return Err(AppError::msg(
            "Este é o arquivo de chave pública (.pub). Selecione o arquivo da chave privada correspondente (sem .pub).",
        ));
    }

    let id = if let Ok(key) = PrivateKey::read_openssh_file(path) {
        identity_from_key(&key, path, source)
    } else {
        match russh::keys::load_secret_key(path, None) {
            Ok(key) => identity_from_key(&key, path, source),
            Err(russh::keys::Error::KeyIsEncrypted) => encrypted_identity_from_path(path, source),
            Err(e) => {
                if looks_like_encrypted_pem(path) {
                    encrypted_identity_from_path(path, source)
                } else {
                    return Err(AppError::msg(format!(
                        "Não foi possível ler a chave privada em {}: {e}",
                        path.display()
                    )));
                }
            }
        }
    };

    ensure_private_key_mode(path)?;
    Ok(id)
}

/// Aponta um arquivo de chave privada qualquer do disco (equivalente a `ssh -i`),
/// aplicando `chmod 600` e registrando-o como `imported`.
pub fn import_file(path: &Path) -> AppResult<Identity> {
    if !path.exists() || !path.is_file() {
        return Err(AppError::msg(format!(
            "Arquivo de chave não encontrado: {}",
            path.display()
        )));
    }
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    inspect_file(&target, "imported")
}

fn looks_like_encrypted_pem(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    text.contains("BEGIN ENCRYPTED PRIVATE KEY") || text.contains("Proc-Type: 4,ENCRYPTED")
}

fn read_adjacent_pubkey(path: &Path) -> Option<PublicKey> {
    let mut candidates = vec![PathBuf::from(format!("{}.pub", path.display()))];
    let with_ext = path.with_extension("pub");
    if with_ext != path && !candidates.contains(&with_ext) {
        candidates.push(with_ext);
    }
    for cand in candidates {
        let Ok(body) = std::fs::read_to_string(&cand) else {
            continue;
        };
        let Some(line) = body.lines().map(str::trim).find(|l| !l.is_empty()) else {
            continue;
        };
        if let Ok(pk) = PublicKey::from_openssh(line) {
            return Some(pk);
        }
    }
    None
}

fn encrypted_identity_from_path(path: &Path, source: &str) -> Identity {
    let label = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "chave".into());
    let path_str = path.to_string_lossy().into_owned();

    if let Some(pk) = read_adjacent_pubkey(path) {
        let fp = pk.fingerprint(HashAlg::Sha256).to_string();
        return Identity {
            id: format!("fp:{fp}"),
            label,
            source: source.into(),
            path: Some(path_str),
            pubkey: pk.to_openssh().unwrap_or_default(),
            fingerprint: fp,
            key_type: pk.algorithm().as_str().to_string(),
            has_passphrase: true,
            comment: pk.comment().to_string(),
            in_agent: false,
        };
    }

    Identity {
        id: format!("file:{path_str}"),
        label,
        source: source.into(),
        path: Some(path_str),
        pubkey: String::new(),
        fingerprint: String::new(),
        key_type: "encrypted".into(),
        has_passphrase: true,
        comment: String::new(),
        in_agent: false,
    }
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

/// Conecta ao ssh-agent do sistema (socket Unix via `SSH_AUTH_SOCK` no macOS/Linux,
/// named pipe do OpenSSH no Windows).
#[cfg(unix)]
pub async fn connect_agent() -> AppResult<AgentClient<tokio::net::UnixStream>> {
    AgentClient::connect_env().await.map_err(AppError::Key)
}

#[cfg(windows)]
pub async fn connect_agent(
) -> AppResult<AgentClient<tokio::net::windows::named_pipe::NamedPipeClient>> {
    let pipe_path = std::env::var("SSH_AUTH_SOCK")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with(r"\\.\pipe\"))
        .unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".to_string());
    let pipe = tokio::net::windows::named_pipe::ClientOptions::new().open(&pipe_path)?;
    Ok(AgentClient::connect(pipe))
}

/// Chaves atualmente carregadas no ssh-agent, por fingerprint.
pub async fn agent_fingerprints() -> Vec<String> {
    let Ok(mut agent) = connect_agent().await else {
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
    let Ok(mut agent) = connect_agent().await else {
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
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
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
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))] use_keychain: bool,
) -> AppResult<()> {
    let ssh_dir = ssh_dir()?;
    let canonical = std::fs::canonicalize(path)?;
    if !canonical.starts_with(&ssh_dir) {
        return Err(AppError::msg("só é possível adicionar chaves de ~/.ssh"));
    }
    let _ = ensure_private_key_mode(&canonical);

    let mut cmd = tokio::process::Command::new("ssh-add");
    #[cfg(target_os = "macos")]
    if use_keychain {
        cmd.arg("--apple-use-keychain");
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(crate::local::CREATE_NO_WINDOW);
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

    #[cfg(windows)]
    let name = format!("fs-ssh-askpass-{}.cmd", uuid::Uuid::new_v4());
    #[cfg(not(windows))]
    let name = format!("fs-ssh-askpass-{}", uuid::Uuid::new_v4());

    let path = std::env::temp_dir().join(name);
    // A passphrase passa por um arquivo temporário de vida curta em vez da
    // linha de comando, que seria visível para qualquer processo via `ps`.
    // No Unix o arquivo nasce 0700 (create_new + mode) — criar com o umask
    // default e corrigir depois deixaria uma janela em que ele é legível.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o700);
    }
    let mut f = opts.open(&path)?;
    #[cfg(windows)]
    {
        // Em `.cmd`, escapamos `%` e metacaracteres de redirecionamento/pipe do cmd.exe.
        let mut escaped = String::with_capacity(passphrase.len());
        for ch in passphrase.chars() {
            match ch {
                '\r' | '\n' => {}
                '%' => escaped.push_str("%%"),
                '^' | '&' | '|' | '<' | '>' | '(' | ')' => {
                    escaped.push('^');
                    escaped.push(ch);
                }
                _ => escaped.push(ch),
            }
        }
        write!(f, "@echo off\r\necho {escaped}\r\n")?;
    }
    #[cfg(not(windows))]
    {
        writeln!(f, "#!/bin/sh")?;
        writeln!(f, "cat <<'FS_SSH_EOF'")?;
        writeln!(f, "{passphrase}")?;
        writeln!(f, "FS_SSH_EOF")?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_file_validates_key_and_applies_0600() {
        let dir = std::env::temp_dir().join(format!("fs-ssh-key-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let priv_path = dir.join("oracle_test.key");
        let pub_path = dir.join("oracle_test.key.pub");

        let mut rng = rand::rng();
        let key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        key.write_openssh_file(&priv_path, LineEnding::LF).unwrap();
        std::fs::write(&pub_path, key.public_key().to_openssh().unwrap()).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&priv_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        let imported = import_file(&priv_path).unwrap();
        assert_eq!(imported.source, "imported");
        assert!(!imported.has_passphrase);
        assert!(imported.fingerprint.starts_with("SHA256:"));
        assert_eq!(imported.label, "oracle_test.key");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&priv_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        assert!(import_file(&pub_path).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
