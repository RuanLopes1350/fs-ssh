use std::path::Path;
use std::time::Duration;

use tauri::ipc::Channel as IpcChannel;
use tauri::{AppHandle, Emitter, State};

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::ssh::sftp::{self, LocalEntry, Progress, RemoteEntry};

/// Teto para "abrir no editor local". Acima disso o caminho certo é download.
const MAX_INLINE_EDIT: u64 = 8 * 1024 * 1024;

/// Intervalo do watcher do "editar localmente": barato o bastante para rodar
/// sempre, rápido o bastante para o save-back parecer imediato.
const EDIT_POLL: Duration = Duration::from_secs(1);

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<Vec<RemoteEntry>> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    sftp::list(&s, &path).await
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, session_id: String) -> AppResult<String> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    sftp::canonicalize(&s, ".").await
}

/// Baixa um arquivo remoto. `transfer_id` é o identificador da fila: é por ele
/// que `sftp_cancel` pausa esta transferência e que o histórico a registra.
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    session_id: String,
    transfer_id: String,
    remote: String,
    local: String,
    resume: bool,
    on_progress: IpcChannel<Progress>,
) -> AppResult<()> {
    let handle = state.sessions.get(&session_id).await?;
    let s = handle.sftp().await?;
    // Destino dentro de uma subpasta que ainda não existe (sincronização de
    // diretório) precisa da árvore criada antes de abrir o arquivo.
    if let Some(dir) = Path::new(&local).parent() {
        let _ = std::fs::create_dir_all(dir);
    }

    let cancel = state.transfers.register(&transfer_id);
    let result = sftp::download(
        s,
        remote.clone(),
        local.clone(),
        resume,
        cancel.clone(),
        on_progress,
    )
    .await;
    state.transfers.finish(&transfer_id);

    record_transfer(&state, &handle, "down", &local, &remote, &result, &cancel);
    result.map(|_| ())
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    session_id: String,
    transfer_id: String,
    local: String,
    remote: String,
    resume: bool,
    on_progress: IpcChannel<Progress>,
) -> AppResult<()> {
    let handle = state.sessions.get(&session_id).await?;
    let s = handle.sftp().await?;

    let cancel = state.transfers.register(&transfer_id);
    let result = sftp::upload(
        s,
        local.clone(),
        remote.clone(),
        resume,
        cancel.clone(),
        on_progress,
    )
    .await;
    state.transfers.finish(&transfer_id);

    record_transfer(&state, &handle, "up", &local, &remote, &result, &cancel);
    result.map(|_| ())
}

/// Pausa/cancela uma transferência em andamento. O que já chegou fica no disco;
/// retomar é começar de novo com `resume`.
#[tauri::command]
pub async fn sftp_cancel(state: State<'_, AppState>, transfer_id: String) -> AppResult<bool> {
    Ok(state.transfers.cancel(&transfer_id))
}

/// Anota no histórico o desfecho de uma transferência.
fn record_transfer(
    state: &State<'_, AppState>,
    handle: &std::sync::Arc<crate::ssh::SessionHandle>,
    direction: &str,
    local: &str,
    remote: &str,
    result: &AppResult<u64>,
    cancel: &std::sync::atomic::AtomicBool,
) {
    use crate::store::models::Transfer;

    let cancelled = cancel.load(std::sync::atomic::Ordering::Relaxed);
    let (status, error, bytes) = match result {
        Ok(bytes) if cancelled => ("cancelled", String::new(), *bytes),
        Ok(bytes) => ("done", String::new(), *bytes),
        Err(e) => ("error", e.to_string(), 0),
    };

    let connection = state
        .db
        .get_connection(&handle.info.connection_id)
        .map(|c| c.name)
        .unwrap_or_else(|_| handle.info.host.clone());

    state.db.add_transfer(Transfer {
        id: String::new(),
        ts: String::new(),
        connection_id: Some(handle.info.connection_id.clone()),
        connection,
        direction: direction.to_string(),
        local: local.to_string(),
        remote: remote.to_string(),
        bytes: bytes as i64,
        total: bytes as i64,
        status: status.to_string(),
        error,
    });
}

#[tauri::command]
pub fn transfer_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<crate::store::models::Transfer>> {
    state.db.list_transfers(limit.unwrap_or(200))
}

#[tauri::command]
pub fn transfer_clear(state: State<'_, AppState>) -> AppResult<()> {
    state.db.clear_transfers()
}

// ------------------------------------------------------ favoritos de diretório

#[tauri::command]
pub fn bookmark_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<crate::store::models::SftpBookmark>> {
    state.db.list_bookmarks(&connection_id)
}

#[tauri::command]
pub fn bookmark_save(
    state: State<'_, AppState>,
    bookmark: crate::store::models::SftpBookmark,
) -> AppResult<crate::store::models::SftpBookmark> {
    state.db.save_bookmark(bookmark)
}

#[tauri::command]
pub fn bookmark_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.delete_bookmark(&id)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    s.create_dir(path).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    s.rename(from, to).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    if is_dir {
        s.remove_dir(path).await?;
    } else {
        s.remove_file(path).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    mode: u32,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    let mut meta = s.metadata(path.clone()).await?;
    // Preserva os bits de tipo (dir/link) e troca só a permissão.
    let type_bits = meta.permissions.unwrap_or(0) & !0o7777;
    meta.permissions = Some(type_bits | (mode & 0o7777));
    s.set_metadata(path, meta).await?;
    Ok(())
}

/// Cria o diretório e todos os pais que faltarem (o `mkdir -p` do SFTP, que o
/// protocolo não tem). Diretório existente não é erro.
#[tauri::command]
pub async fn sftp_mkdir_p(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    let mut acc = if path.starts_with('/') { String::from("/") } else { String::new() };
    for part in path.split('/').filter(|p| !p.is_empty()) {
        if !acc.is_empty() && !acc.ends_with('/') {
            acc.push('/');
        }
        acc.push_str(part);
        if s.metadata(acc.clone()).await.is_err() {
            // Corrida com outro cliente criando o mesmo diretório não é falha.
            let _ = s.create_dir(acc.clone()).await;
        }
    }
    Ok(())
}

/// Teto de arquivos numa pasta arrastada de uma ponta à outra. Acima disso a
/// fila viraria uma lista impossível de acompanhar, e a resposta certa é
/// compactar no servidor antes de transferir.
const MAX_TREE_ENTRIES: usize = 5000;

/// Árvore de um diretório remoto (arquivos e subpastas), com caminhos relativos.
/// É o que permite arrastar uma pasta inteira: o outro lado remonta a estrutura.
#[tauri::command]
pub async fn sftp_tree(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<Vec<sftp::WalkEntry>> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    sftp::walk_remote(&s, &path, MAX_TREE_ENTRIES, true).await
}

/// A mesma árvore, do lado local.
#[tauri::command]
pub fn local_tree(path: String) -> AppResult<Vec<sftp::WalkEntry>> {
    sftp::walk_local(&path, MAX_TREE_ENTRIES, true)
}

/// `mkdir -p` local — o par do `sftp_mkdir_p` quando a pasta baixada tem
/// subpastas vazias, que não têm arquivo para criá-las por tabela.
#[tauri::command]
pub fn local_mkdir_p(path: String) -> AppResult<()> {
    std::fs::create_dir_all(path)?;
    Ok(())
}

/// Teto de resultados da busca remota.
const FIND_LIMIT: usize = 500;

/// Procura arquivos no servidor por nome (`find -iname`), sem sair do painel.
#[tauri::command]
pub async fn sftp_find(
    state: State<'_, AppState>,
    session_id: String,
    root: String,
    pattern: String,
    max_depth: u32,
) -> AppResult<Vec<String>> {
    if pattern.trim().is_empty() {
        return Err(AppError::msg("informe o que procurar"));
    }
    // Sem curinga o usuário quer "contém", não "é igual a".
    let needle = if pattern.contains('*') || pattern.contains('?') {
        pattern.clone()
    } else {
        format!("*{pattern}*")
    };

    let cmd = format!(
        "find {} -maxdepth {} -iname {} 2>/dev/null | head -n {FIND_LIMIT}",
        super::sys::quote(&root),
        max_depth.clamp(1, 20),
        super::sys::quote(&needle),
    );
    let (_code, out) = state.sessions.get(&session_id).await?.exec(cmd).await?;

    Ok(String::from_utf8_lossy(&out)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checksum {
    pub remote: String,
    pub local: String,
    pub equal: bool,
}

/// Compara o SHA-256 das duas pontas. O remoto sai do `sha256sum`/`shasum` do
/// próprio host (nada trafega além do hash); o local é calculado aqui.
#[tauri::command]
pub async fn sftp_checksum(
    state: State<'_, AppState>,
    session_id: String,
    remote: String,
    local: String,
) -> AppResult<Checksum> {
    let quoted = super::sys::quote(&remote);
    let cmd = format!(
        "sha256sum -- {quoted} 2>/dev/null || shasum -a 256 -- {quoted} 2>/dev/null || \
         openssl dgst -sha256 {quoted} 2>/dev/null"
    );
    let (_code, out) = state.sessions.get(&session_id).await?.exec(cmd).await?;
    let text = String::from_utf8_lossy(&out);

    // "abc…  arquivo" (sha256sum/shasum) ou "SHA256(arquivo)= abc…" (openssl).
    let remote_hash = text
        .split_whitespace()
        .find(|t| t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|t| t.to_lowercase())
        .ok_or_else(|| {
            AppError::msg(format!(
                "não deu para calcular o hash no servidor: {}",
                text.trim()
            ))
        })?;

    let local_hash = sftp::sha256_local(&local).await?;
    Ok(Checksum {
        equal: remote_hash == local_hash,
        remote: remote_hash,
        local: local_hash,
    })
}

/// Compacta uma seleção ou extrai um arquivo, no próprio servidor — o que evita
/// baixar dez mil arquivos pequenos só para juntá-los de novo do outro lado.
///
/// `target` é o arquivo a criar (`compress`) ou a abrir (`extract`); `entries`
/// só vale em `compress` e traz nomes — não caminhos — dentro de `cwd`.
#[tauri::command]
pub async fn sftp_archive(
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
    action: String,
    target: String,
    entries: Vec<String>,
) -> AppResult<String> {
    let cd = format!("cd {} 2>&1 && ", super::sys::quote(&cwd));

    let cmd = match action.as_str() {
        "compress" => {
            if entries.is_empty() {
                return Err(AppError::msg("nada selecionado para compactar"));
            }
            if entries.iter().any(|e| e.contains('/') || e.is_empty()) {
                return Err(AppError::msg("selecione itens do diretório atual"));
            }
            let list = entries
                .iter()
                .map(|e| super::sys::quote(e))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{cd}tar -czf {} -- {list} 2>&1", super::sys::quote(&target))
        }
        "extract" => {
            let q = super::sys::quote(&target);
            let lower = target.to_lowercase();
            let tool = if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
                format!("tar -xzf {q}")
            } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
                format!("tar -xjf {q}")
            } else if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
                format!("tar -xJf {q}")
            } else if lower.ends_with(".tar") {
                format!("tar -xf {q}")
            } else if lower.ends_with(".zip") {
                format!("unzip -o {q}")
            } else if lower.ends_with(".gz") {
                format!("gunzip -k {q}")
            } else {
                return Err(AppError::msg(format!(
                    "não sei extrair {target} (tar.gz, tar.bz2, tar.xz, tar, zip ou gz)"
                )));
            };
            format!("{cd}{tool} 2>&1")
        }
        other => return Err(AppError::msg(format!("ação inválida: {other}"))),
    };

    let (code, out) = state.sessions.get(&session_id).await?.exec(cmd).await?;
    let text = String::from_utf8_lossy(&out).trim().to_string();
    if code != 0 {
        return Err(AppError::msg(if text.is_empty() {
            format!("falha ao {action}")
        } else {
            text
        }));
    }
    Ok(text)
}

/// Teto da comparação de pastas: acima disso a espera deixa de valer a pena e a
/// resposta certa é comparar uma pasta menor.
const MAX_SYNC_ENTRIES: usize = 5000;
/// Tolerância de mtime. SFTP guarda segundos e sistemas de arquivo arredondam
/// diferente; sem folga, cópia idêntica apareceria como divergente.
const MTIME_SLACK: u64 = 2;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    /// Caminho relativo às duas raízes comparadas.
    pub rel: String,
    /// `onlyLocal` | `onlyRemote` | `differs` | `equal`
    pub status: String,
    pub local_size: u64,
    pub remote_size: u64,
    pub local_mtime: u64,
    pub remote_mtime: u64,
}

/// Compara dois diretórios (recursivo) e devolve o que difere — a prévia que
/// antecede uma sincronização. Não copia nada: quem transfere é a fila.
#[tauri::command]
pub async fn sftp_diff(
    state: State<'_, AppState>,
    session_id: String,
    local_dir: String,
    remote_dir: String,
) -> AppResult<Vec<DiffEntry>> {
    use std::collections::HashMap;

    let s = state.sessions.get(&session_id).await?.sftp().await?;
    let remote = sftp::walk_remote(&s, &remote_dir, MAX_SYNC_ENTRIES, false).await?;
    let local = sftp::walk_local(&local_dir, MAX_SYNC_ENTRIES, false)?;

    let mut remote_map: HashMap<String, sftp::WalkEntry> =
        remote.into_iter().map(|e| (e.rel.clone(), e)).collect();

    let mut out = Vec::new();
    for l in local {
        match remote_map.remove(&l.rel) {
            Some(r) => {
                let same = l.size == r.size && l.mtime.abs_diff(r.mtime) <= MTIME_SLACK;
                out.push(DiffEntry {
                    rel: l.rel,
                    status: if same { "equal" } else { "differs" }.into(),
                    local_size: l.size,
                    remote_size: r.size,
                    local_mtime: l.mtime,
                    remote_mtime: r.mtime,
                });
            }
            None => out.push(DiffEntry {
                rel: l.rel,
                status: "onlyLocal".into(),
                local_size: l.size,
                remote_size: 0,
                local_mtime: l.mtime,
                remote_mtime: 0,
            }),
        }
    }
    for (rel, r) in remote_map {
        out.push(DiffEntry {
            rel,
            status: "onlyRemote".into(),
            local_size: 0,
            remote_size: r.size,
            local_mtime: 0,
            remote_mtime: r.mtime,
        });
    }

    // Diferenças primeiro; iguais ficam no fim, para conferência.
    out.sort_by(|a, b| {
        let rank = |s: &str| match s {
            "onlyLocal" => 0,
            "onlyRemote" => 1,
            "differs" => 2,
            _ => 3,
        };
        rank(&a.status)
            .cmp(&rank(&b.status))
            .then_with(|| a.rel.cmp(&b.rel))
    });
    Ok(out)
}

/// Evento emitido pelo watcher do "editar localmente" a cada gravação enviada
/// (ou tentativa que falhou) de volta ao servidor.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSaved {
    pub session_id: String,
    pub remote: String,
    pub local: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Baixa o arquivo para um temporário local, devolve o caminho para o frontend
/// abrir no editor do sistema e fica vigiando o mtime: cada gravação local é
/// reenviada ao servidor pela mesma sessão SFTP (save-back).
///
/// O temporário pode conter segredo (`.env`, chaves), então o diretório nasce
/// 0700 e o arquivo 0600 — e sobras de execuções anteriores são removidas no
/// boot por `sweep_stale_temp_files`.
#[tauri::command]
pub async fn sftp_edit_local(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<String> {
    let s = state.sessions.get(&session_id).await?.sftp().await?;
    let bytes = sftp::read_all(&s, &path, MAX_INLINE_EDIT).await?;

    let name = path.rsplit('/').next().unwrap_or("arquivo");
    let dir = std::env::temp_dir().join(format!("fs-ssh-edit-{}", uuid::Uuid::new_v4()));
    create_private_dir(&dir)?;
    let local = dir.join(name);
    write_private_file(&local, &bytes)?;

    let sessions = state.sessions.clone();
    let local_str = local.to_string_lossy().into_owned();
    tauri::async_runtime::spawn(watch_and_upload(
        app,
        sessions,
        session_id,
        path,
        local.clone(),
    ));

    Ok(local_str)
}

/// Cria o diretório já com 0700 — sem janela em que fique legível por outros.
fn create_private_dir(dir: &Path) -> AppResult<()> {
    #[allow(unused_mut)]
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)?;
    Ok(())
}

/// Grava o arquivo já com 0600 (create_new + mode), como o askpass.
fn write_private_file(path: &Path, bytes: &[u8]) -> AppResult<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}

/// Poll de mtime + reenvio. Termina quando a sessão morre ou o arquivo some;
/// ao terminar, apaga o temporário e o diretório.
async fn watch_and_upload(
    app: AppHandle,
    sessions: std::sync::Arc<crate::ssh::SessionManager>,
    session_id: String,
    remote: String,
    local: std::path::PathBuf,
) {
    let mut last_mtime = std::fs::metadata(&local).ok().and_then(|m| m.modified().ok());

    loop {
        tokio::time::sleep(EDIT_POLL).await;

        let Ok(meta) = tokio::fs::metadata(&local).await else {
            break; // arquivo apagado — nada mais a vigiar
        };
        let mtime = meta.modified().ok();
        if mtime == last_mtime {
            // Sessão morta encerra o watcher mesmo sem gravações novas.
            if sessions.get(&session_id).await.is_err() {
                break;
            }
            continue;
        }
        last_mtime = mtime;

        let result = upload_back(&sessions, &session_id, &remote, &local).await;
        let (ok, error) = match result {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        let fatal = !ok && sessions.get(&session_id).await.is_err();
        let _ = app.emit(
            "edit-saved",
            EditSaved {
                session_id: session_id.clone(),
                remote: remote.clone(),
                local: local.to_string_lossy().into_owned(),
                ok,
                error,
            },
        );
        if fatal {
            break;
        }
    }

    let _ = std::fs::remove_file(&local);
    if let Some(dir) = local.parent() {
        let _ = std::fs::remove_dir(dir);
    }
}

async fn upload_back(
    sessions: &crate::ssh::SessionManager,
    session_id: &str,
    remote: &str,
    local: &Path,
) -> AppResult<()> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;

    let bytes = tokio::fs::read(local).await?;
    let s = sessions.get(session_id).await?.sftp().await?;
    let mut f = s
        .open_with_flags(
            remote.to_string(),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await?;
    f.write_all(&bytes).await?;
    f.flush().await?;
    f.shutdown().await?;
    Ok(())
}

/// Remove sobras de `fs-ssh-edit-*` e `fs-ssh-askpass-*` de execuções
/// anteriores (crash, panic com `panic = "abort"`). Chamado no setup do app.
pub fn sweep_stale_temp_files() {
    let tmp = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&tmp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("fs-ssh-edit-") {
            let _ = std::fs::remove_dir_all(entry.path());
        } else if name.starts_with("fs-ssh-askpass-") || name.starts_with("fs-ssh-unit-") {
            let p = entry.path();
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(p);
            } else {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

#[tauri::command]
pub fn local_list(path: String) -> AppResult<Vec<LocalEntry>> {
    sftp::local_list(&path)
}

#[tauri::command]
pub fn local_home() -> String {
    sftp::home_dir()
}

#[tauri::command]
pub fn local_parent(path: String) -> String {
    std::path::Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path)
}

#[tauri::command]
pub fn local_read_text(path: String) -> AppResult<String> {
    let meta = std::fs::metadata(&path)?;
    if meta.len() > MAX_INLINE_EDIT {
        return Err(AppError::msg("arquivo grande demais para pré-visualizar"));
    }
    Ok(std::fs::read_to_string(path)?)
}
