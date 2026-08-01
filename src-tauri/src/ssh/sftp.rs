use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel as IpcChannel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};

/// Buffer de transferência. 32 KiB casa com o tamanho típico de pacote do SFTP e
/// evita fragmentação em pacotes menores que a janela do canal.
const CHUNK: usize = 32 * 1024;
/// Intervalo mínimo entre eventos de progresso — sem isso um arquivo de 1 GB
/// gera ~32 mil mensagens de IPC só para desenhar uma barra.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: String, // dir | file | symlink | other
    pub size: u64,
    pub permissions: Option<u32>,
    pub mtime: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub user: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
}

pub async fn list(sftp: &SftpSession, path: &str) -> AppResult<Vec<RemoteEntry>> {
    let base = sftp.canonicalize(path).await?;
    let mut out = Vec::new();

    for entry in sftp.read_dir(base.clone()).await? {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        // Nome de entrada nunca deveria conter separador de caminho. Um servidor
        // hostil pode listar `../../.ssh/authorized_keys` para fazer o download
        // escrever fora do diretório escolhido (zip-slip) — descarta e avisa.
        if name.contains('/') || name.contains('\\') || name.contains('\0') {
            tracing::warn!("entrada SFTP com nome suspeito ignorada: {name:?}");
            continue;
        }
        let meta = entry.metadata();
        let kind = match entry.file_type() {
            t if t.is_dir() => "dir",
            t if t.is_symlink() => "symlink",
            t if t.is_file() => "file",
            _ => "other",
        };
        out.push(RemoteEntry {
            path: join(&base, &name),
            name,
            kind: kind.to_string(),
            size: meta.size.unwrap_or(0),
            permissions: meta.permissions.map(|p| p & 0o7777),
            mtime: meta.mtime,
            uid: meta.uid,
            gid: meta.gid,
            user: meta.user.clone(),
            group: meta.group.clone(),
        });
    }

    // Diretórios primeiro, depois alfabético — o mesmo critério do Finder.
    out.sort_by(|a, b| {
        let da = (a.kind != "dir") as u8;
        let db = (b.kind != "dir") as u8;
        da.cmp(&db)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub async fn canonicalize(sftp: &SftpSession, path: &str) -> AppResult<String> {
    Ok(sftp.canonicalize(path).await?)
}

/// Baixa um arquivo remoto, reportando progresso.
///
/// Retoma de onde parou quando o arquivo local já existe e é menor que o remoto:
/// abre o remoto com seek e o local em append.
pub async fn download(
    sftp: Arc<SftpSession>,
    remote: String,
    local: String,
    resume: bool,
    on_progress: IpcChannel<Progress>,
) -> AppResult<()> {
    let meta = sftp.metadata(remote.clone()).await?;
    let total = meta.size.unwrap_or(0);

    let mut offset = 0u64;
    if resume {
        if let Ok(m) = tokio::fs::metadata(&local).await {
            if m.len() < total {
                offset = m.len();
            }
        }
    }

    let mut rf = sftp.open(remote).await?;
    if offset > 0 {
        use tokio::io::AsyncSeekExt;
        rf.seek(std::io::SeekFrom::Start(offset)).await?;
    }

    let mut lf = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(&local)
        .await?;

    let r = pump(&mut rf, &mut lf, offset, total, &on_progress).await;
    lf.flush().await?;
    report_end(&on_progress, offset, total, r)
}

/// Envia um arquivo local para o servidor.
pub async fn upload(
    sftp: Arc<SftpSession>,
    local: String,
    remote: String,
    resume: bool,
    on_progress: IpcChannel<Progress>,
) -> AppResult<()> {
    let total = tokio::fs::metadata(&local).await?.len();

    let mut offset = 0u64;
    if resume {
        if let Ok(m) = sftp.metadata(remote.clone()).await {
            let existing = m.size.unwrap_or(0);
            if existing < total {
                offset = existing;
            }
        }
    }

    let flags = if offset > 0 {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::APPEND
    } else {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
    };
    let mut rf = sftp.open_with_flags(remote, flags).await?;

    let mut lf = tokio::fs::File::open(&local).await?;
    if offset > 0 {
        use tokio::io::AsyncSeekExt;
        lf.seek(std::io::SeekFrom::Start(offset)).await?;
    }

    let r = pump(&mut lf, &mut rf, offset, total, &on_progress).await;
    rf.flush().await?;
    let _ = rf.shutdown().await;
    report_end(&on_progress, offset, total, r)
}

async fn pump<R, W>(
    src: &mut R,
    dst: &mut W,
    start: u64,
    total: u64,
    on_progress: &IpcChannel<Progress>,
) -> std::io::Result<u64>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut transferred = start;
    let mut last = tokio::time::Instant::now();

    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        transferred += n as u64;

        if last.elapsed() >= PROGRESS_INTERVAL {
            let _ = on_progress.send(Progress {
                transferred,
                total,
                done: false,
                error: None,
            });
            last = tokio::time::Instant::now();
        }
    }
    Ok(transferred)
}

fn report_end(
    on_progress: &IpcChannel<Progress>,
    start: u64,
    total: u64,
    r: std::io::Result<u64>,
) -> AppResult<()> {
    match r {
        Ok(transferred) => {
            let _ = on_progress.send(Progress {
                transferred,
                total,
                done: true,
                error: None,
            });
            Ok(())
        }
        Err(e) => {
            let _ = on_progress.send(Progress {
                transferred: start,
                total,
                done: true,
                error: Some(e.to_string()),
            });
            Err(AppError::Io(e))
        }
    }
}

/// Lê um arquivo remoto inteiro na memória. Usado pelo "editar localmente" —
/// por isso o teto: abrir um core dump de 4 GB no editor não é o caso de uso.
pub async fn read_all(sftp: &SftpSession, path: &str, max: u64) -> AppResult<Vec<u8>> {
    let meta = sftp.metadata(path.to_string()).await?;
    if meta.size.unwrap_or(0) > max {
        return Err(AppError::msg(format!(
            "arquivo maior que {} MiB — use download",
            max / (1024 * 1024)
        )));
    }
    Ok(sftp.read(path.to_string()).await?)
}

pub fn local_list(path: &str) -> AppResult<Vec<LocalEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        let kind = if meta.is_dir() {
            "dir"
        } else if meta.is_symlink() {
            "symlink"
        } else {
            "file"
        };
        out.push(LocalEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            kind: kind.into(),
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| {
        let da = (a.kind != "dir") as u8;
        let db = (b.kind != "dir") as u8;
        da.cmp(&db)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub fn home_dir() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| Path::new("/").to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn join(base: &str, name: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}
