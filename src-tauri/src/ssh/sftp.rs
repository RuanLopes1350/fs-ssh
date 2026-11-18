use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Interrompida a pedido (pausa da fila). O que já chegou fica no disco e a
    /// retomada continua daí — por isso pausa não é erro.
    #[serde(default)]
    pub cancelled: bool,
}

/// Transferências em andamento, por id. Cada uma tem uma bandeira que o laço de
/// cópia consulta a cada bloco: é assim que pausar/cancelar chega até ela sem
/// derrubar a sessão nem o canal SFTP, que são compartilhados.
#[derive(Default)]
pub struct TransferRegistry {
    map: std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
}

impl TransferRegistry {
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut m) = self.map.lock() {
            m.insert(id.to_string(), flag.clone());
        }
        flag
    }

    /// Marca a transferência para parar. `false` se ela já tinha terminado.
    pub fn cancel(&self, id: &str) -> bool {
        let Ok(m) = self.map.lock() else { return false };
        match m.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub fn finish(&self, id: &str) {
        if let Ok(mut m) = self.map.lock() {
            m.remove(id);
        }
    }
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
    cancel: Arc<AtomicBool>,
    on_progress: IpcChannel<Progress>,
) -> AppResult<u64> {
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

    let r = pump(&mut rf, &mut lf, offset, total, &cancel, &on_progress).await;
    lf.flush().await?;
    report_end(&on_progress, offset, total, r)
}

/// Envia um arquivo local para o servidor.
pub async fn upload(
    sftp: Arc<SftpSession>,
    local: String,
    remote: String,
    resume: bool,
    cancel: Arc<AtomicBool>,
    on_progress: IpcChannel<Progress>,
) -> AppResult<u64> {
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

    let r = pump(&mut lf, &mut rf, offset, total, &cancel, &on_progress).await;
    rf.flush().await?;
    let _ = rf.shutdown().await;
    report_end(&on_progress, offset, total, r)
}

/// Copia bloco a bloco até o fim ou até a bandeira de cancelamento subir.
/// Devolve `(bytes, interrompida)`.
async fn pump<R, W>(
    src: &mut R,
    dst: &mut W,
    start: u64,
    total: u64,
    cancel: &AtomicBool,
    on_progress: &IpcChannel<Progress>,
) -> std::io::Result<(u64, bool)>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut transferred = start;
    let mut last = tokio::time::Instant::now();

    loop {
        // A checagem vem antes da leitura: pausar não deve esperar mais um bloco
        // chegar da rede para fazer efeito.
        if cancel.load(Ordering::Relaxed) {
            return Ok((transferred, true));
        }
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
                cancelled: false,
            });
            last = tokio::time::Instant::now();
        }
    }
    Ok((transferred, false))
}

fn report_end(
    on_progress: &IpcChannel<Progress>,
    start: u64,
    total: u64,
    r: std::io::Result<(u64, bool)>,
) -> AppResult<u64> {
    match r {
        Ok((transferred, cancelled)) => {
            let _ = on_progress.send(Progress {
                transferred,
                total,
                done: true,
                error: None,
                cancelled,
            });
            Ok(transferred)
        }
        Err(e) => {
            let _ = on_progress.send(Progress {
                transferred: start,
                total,
                done: true,
                error: Some(e.to_string()),
                cancelled: false,
            });
            Err(AppError::Io(e))
        }
    }
}

/// SHA-256 de um arquivo local, lido em blocos — o par local do `sha256sum`
/// remoto na conferência de cópia.
pub async fn sha256_local(path: &str) -> AppResult<String> {
    use sha2::{Digest, Sha256};

    let mut f = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
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

/// Uma entrada achada por uma varredura de diretório, com o caminho relativo à
/// raiz varrida — é a chave que casa os dois lados na comparação de pastas e o
/// que a transferência de pasta inteira usa para remontar a árvore do outro lado.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    pub rel: String,
    pub size: u64,
    pub mtime: u64,
    /// Só vem preenchido quando a varredura pede os diretórios (`include_dirs`).
    pub is_dir: bool,
}

/// Percorre um diretório remoto inteiro. Iterativo, não recursivo: cada nível é
/// um round-trip SFTP, e uma pilha explícita deixa o teto de entradas óbvio.
///
/// `include_dirs` acrescenta os diretórios à lista: a comparação de pastas só
/// quer arquivos, mas copiar uma pasta precisa recriar a árvore vazia também.
pub async fn walk_remote(
    sftp: &SftpSession,
    base: &str,
    max: usize,
    include_dirs: bool,
) -> AppResult<Vec<WalkEntry>> {
    let base = sftp.canonicalize(base.to_string()).await?;
    let mut out = Vec::new();
    let mut stack = vec![String::new()];

    while let Some(rel_dir) = stack.pop() {
        let dir = if rel_dir.is_empty() {
            base.clone()
        } else {
            join(&base, &rel_dir)
        };
        for entry in sftp.read_dir(dir).await? {
            let name = entry.file_name();
            if name == "." || name == ".." || name.contains('/') || name.contains('\0') {
                continue;
            }
            let rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            let meta = entry.metadata();
            if entry.file_type().is_dir() {
                if include_dirs {
                    out.push(WalkEntry {
                        rel: rel.clone(),
                        size: 0,
                        mtime: meta.mtime.unwrap_or(0) as u64,
                        is_dir: true,
                    });
                }
                stack.push(rel);
            } else if entry.file_type().is_file() {
                out.push(WalkEntry {
                    rel,
                    size: meta.size.unwrap_or(0),
                    mtime: meta.mtime.unwrap_or(0) as u64,
                    is_dir: false,
                });
                if out.len() > max {
                    return Err(AppError::msg(format!(
                        "diretório remoto com mais de {max} arquivos — compare uma pasta menor"
                    )));
                }
            }
        }
    }
    Ok(out)
}

/// Mesma varredura, do lado local. Links simbólicos não são seguidos: um link
/// para `/` transformaria a comparação numa varredura do disco inteiro.
pub fn walk_local(base: &str, max: usize, include_dirs: bool) -> AppResult<Vec<WalkEntry>> {
    let root = Path::new(base);
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_symlink() {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if meta.is_dir() {
                if include_dirs {
                    if let Ok(rel) = path.strip_prefix(root) {
                        out.push(WalkEntry {
                            rel: rel.to_string_lossy().replace('\\', "/"),
                            size: 0,
                            mtime,
                            is_dir: true,
                        });
                    }
                }
                stack.push(path);
                continue;
            }
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            out.push(WalkEntry {
                rel: rel.to_string_lossy().replace('\\', "/"),
                size: meta.len(),
                mtime,
                is_dir: false,
            });
            if out.len() > max {
                return Err(AppError::msg(format!(
                    "diretório local com mais de {max} arquivos — compare uma pasta menor"
                )));
            }
        }
    }
    Ok(out)
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
        .unwrap_or_else(|| {
            #[cfg(windows)]
            {
                Path::new(r"C:\").to_path_buf()
            }
            #[cfg(not(windows))]
            {
                Path::new("/").to_path_buf()
            }
        })
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
