pub mod models;
pub mod schema;
pub mod themes;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use models::*;

/// Handle do banco. Uma `rusqlite::Connection` não é `Sync`, então fica atrás de
/// `Mutex`. As operações são de catálogo (milissegundos) e nunca ficam no caminho
/// do stream do terminal, então a serialização aqui não custa nada.
pub struct Db(Mutex<Connection>);

impl Db {
    pub fn open(dir: &PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(dir)?;
        // O banco guarda hosts, usuários e fingerprints — nada de segredo, mas
        // também nada que precise ser legível por outros usuários da máquina.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let conn = Connection::open(dir.join("app.db"))?;
        schema::migrate(&conn)?;
        let db = Db(Mutex::new(conn));
        db.seed_builtin_themes()?;
        Ok(db)
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.0
            .lock()
            .map_err(|_| AppError::msg("banco em estado inconsistente"))
    }

    /// Copia o banco para `dest` com `VACUUM INTO` — seguro com o banco em uso
    /// (WAL) e já sai compactado. Sobrescreve o destino se existir.
    pub fn backup_to(&self, dest: &str) -> AppResult<()> {
        // VACUUM INTO recusa destino existente; o diálogo de salvar do sistema
        // já confirmou a sobrescrita com o usuário.
        let _ = std::fs::remove_file(dest);
        self.lock()?
            .execute("VACUUM INTO ?1", params![dest])?;
        Ok(())
    }

    fn seed_builtin_themes(&self) -> AppResult<()> {
        let c = self.lock()?;
        for t in themes::builtin() {
            c.execute(
                "INSERT INTO themes (id, name, is_builtin, json) VALUES (?1, ?2, 1, ?3)
                 ON CONFLICT(id) DO UPDATE SET name = ?2, json = ?3",
                params![t.id, t.name, t.json.to_string()],
            )?;
        }
        Ok(())
    }

    // ---------------------------------------------------------------- conexões

    pub fn list_connections(&self) -> AppResult<Vec<Connection_>> {
        let c = self.lock()?;
        let mut stmt = c.prepare(
            "SELECT id, name, host, port, username, auth_method, identity_id, jump_host_id,
                    color, icon, theme_id, is_production, notes, created_at, last_used_at, use_count,
                    folder_id
             FROM connections ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], row_to_connection)?;
        let mut out = Vec::new();
        for r in rows {
            let mut conn = r?;
            conn.tag_ids = tag_ids_of(&c, &conn.id)?;
            out.push(conn);
        }
        Ok(out)
    }

    pub fn get_connection(&self, id: &str) -> AppResult<Connection_> {
        let c = self.lock()?;
        let mut conn = c
            .query_row(
                "SELECT id, name, host, port, username, auth_method, identity_id, jump_host_id,
                        color, icon, theme_id, is_production, notes, created_at, last_used_at, use_count,
                        folder_id
                 FROM connections WHERE id = ?1",
                params![id],
                row_to_connection,
            )
            .optional()?
            .ok_or_else(|| AppError::msg(format!("conexão {id} não encontrada")))?;
        conn.tag_ids = tag_ids_of(&c, &conn.id)?;
        Ok(conn)
    }

    pub fn save_connection(&self, mut conn: Connection_) -> AppResult<Connection_> {
        let mut c = self.lock()?;
        let tx = c.transaction()?;

        if conn.id.is_empty() {
            conn.id = Uuid::new_v4().to_string();
            conn.created_at = now();
            tx.execute(
                "INSERT INTO connections
                   (id, name, host, port, username, auth_method, identity_id, jump_host_id,
                    color, icon, theme_id, is_production, notes, created_at, use_count, folder_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,?15)",
                params![
                    conn.id,
                    conn.name,
                    conn.host,
                    conn.port,
                    conn.username,
                    conn.auth_method,
                    conn.identity_id,
                    conn.jump_host_id,
                    conn.color,
                    conn.icon,
                    conn.theme_id,
                    conn.is_production as i64,
                    conn.notes,
                    conn.created_at,
                    conn.folder_id,
                ],
            )?;
        } else {
            tx.execute(
                "UPDATE connections SET name=?2, host=?3, port=?4, username=?5, auth_method=?6,
                        identity_id=?7, jump_host_id=?8, color=?9, icon=?10, theme_id=?11,
                        is_production=?12, notes=?13, folder_id=?14
                 WHERE id=?1",
                params![
                    conn.id,
                    conn.name,
                    conn.host,
                    conn.port,
                    conn.username,
                    conn.auth_method,
                    conn.identity_id,
                    conn.jump_host_id,
                    conn.color,
                    conn.icon,
                    conn.theme_id,
                    conn.is_production as i64,
                    conn.notes,
                    conn.folder_id,
                ],
            )?;
        }

        tx.execute(
            "DELETE FROM connection_tags WHERE connection_id = ?1",
            params![conn.id],
        )?;
        for tag in &conn.tag_ids {
            tx.execute(
                "INSERT OR IGNORE INTO connection_tags (connection_id, tag_id) VALUES (?1, ?2)",
                params![conn.id, tag],
            )?;
        }
        tx.commit()?;
        drop(c);
        self.get_connection(&conn.id)
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        self.lock()?
            .execute("DELETE FROM connections WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn touch_connection(&self, id: &str) -> AppResult<()> {
        self.lock()?.execute(
            "UPDATE connections SET last_used_at = ?2, use_count = use_count + 1 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------------ logs

    /// Registra um evento. Falha de escrita nunca derruba a operação em curso —
    /// log é observabilidade, não parte do fluxo.
    pub fn log_event(
        &self,
        level: &str,
        kind: &str,
        connection_id: Option<&str>,
        connection: &str,
        message: &str,
    ) {
        let Ok(c) = self.lock() else { return };
        let _ = c.execute(
            "INSERT INTO app_logs (ts, level, kind, connection_id, connection, message)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![now(), level, kind, connection_id, connection, message],
        );
    }

    pub fn list_logs(&self, q: &LogQuery) -> AppResult<Vec<LogEntry>> {
        let mut sql = String::from(
            "SELECT id, ts, level, kind, connection_id, connection, message FROM app_logs WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        // As datas chegam como dia local; comparar com o `ts` RFC3339 em UTC
        // funciona porque o formato é ordenável lexicograficamente.
        if let Some(from) = q.from.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND ts >= ?");
            args.push(Box::new(format!("{from}T00:00:00")));
        }
        if let Some(to) = q.to.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND ts <= ?");
            args.push(Box::new(format!("{to}T23:59:59.999")));
        }
        if let Some(id) = q.connection_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND connection_id = ?");
            args.push(Box::new(id.to_string()));
        }
        if let Some(level) = q.level.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND level = ?");
            args.push(Box::new(level.to_string()));
        }
        if let Some(search) = q.search.as_deref().filter(|s| !s.trim().is_empty()) {
            sql.push_str(" AND (message LIKE ? OR connection LIKE ?)");
            let like = format!("%{}%", search.trim());
            args.push(Box::new(like.clone()));
            args.push(Box::new(like));
        }
        sql.push_str(" ORDER BY ts DESC, id DESC LIMIT ?");
        args.push(Box::new(q.limit.unwrap_or(1000).clamp(1, 5000)));

        let c = self.lock()?;
        let mut stmt = c.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok(LogEntry {
                id: r.get(0)?,
                ts: r.get(1)?,
                level: r.get(2)?,
                kind: r.get(3)?,
                connection_id: r.get(4)?,
                connection: r.get(5)?,
                message: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn clear_logs(&self) -> AppResult<()> {
        self.lock()?.execute("DELETE FROM app_logs", [])?;
        Ok(())
    }

    // ---------------------------------------------------------- port forwards

    pub fn list_forwards(&self, connection_id: &str) -> AppResult<Vec<PortForward>> {
        let c = self.lock()?;
        let mut stmt = c.prepare(
            "SELECT id, connection_id, kind, label, bind_addr, local_port, remote_host,
                    remote_port, auto_start
             FROM port_forwards WHERE connection_id = ?1 ORDER BY local_port",
        )?;
        let rows = stmt.query_map(params![connection_id], row_to_forward)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn get_forward(&self, id: &str) -> AppResult<PortForward> {
        let c = self.lock()?;
        c.query_row(
            "SELECT id, connection_id, kind, label, bind_addr, local_port, remote_host,
                    remote_port, auto_start
             FROM port_forwards WHERE id = ?1",
            params![id],
            row_to_forward,
        )
        .optional()?
        .ok_or_else(|| AppError::msg(format!("túnel {id} não encontrado")))
    }

    pub fn save_forward(&self, mut f: PortForward) -> AppResult<PortForward> {
        if !matches!(f.kind.as_str(), "local" | "remote" | "dynamic") {
            return Err(AppError::msg(format!("tipo de túnel inválido: {}", f.kind)));
        }
        if f.local_port == 0 {
            return Err(AppError::msg("porta não pode ser 0"));
        }
        // O SOCKS descobre o destino em tempo de conexão: não há host/porta fixos.
        if f.kind == "dynamic" {
            f.remote_host = String::new();
            f.remote_port = 0;
        } else if f.remote_port == 0 {
            return Err(AppError::msg("porta de destino não pode ser 0"));
        }
        let c = self.lock()?;
        if f.id.is_empty() {
            f.id = Uuid::new_v4().to_string();
        }
        c.execute(
            "INSERT INTO port_forwards
               (id, connection_id, kind, label, bind_addr, local_port, remote_host, remote_port, auto_start)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET
               kind=?3, label=?4, bind_addr=?5, local_port=?6, remote_host=?7,
               remote_port=?8, auto_start=?9",
            params![
                f.id,
                f.connection_id,
                f.kind,
                f.label,
                f.bind_addr,
                f.local_port,
                f.remote_host,
                f.remote_port,
                f.auto_start as i64,
            ],
        )?;
        Ok(f)
    }

    pub fn delete_forward(&self, id: &str) -> AppResult<()> {
        self.lock()?
            .execute("DELETE FROM port_forwards WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------------------------------------------------------------ pastas

    pub fn list_folders(&self) -> AppResult<Vec<Folder>> {
        let c = self.lock()?;
        let mut stmt = c.prepare(
            "SELECT id, name, parent_id, sort FROM folders ORDER BY sort, name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                sort: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn save_folder(&self, mut folder: Folder) -> AppResult<Folder> {
        let c = self.lock()?;
        if folder.id.is_empty() {
            folder.id = Uuid::new_v4().to_string();
            c.execute(
                "INSERT INTO folders (id, name, parent_id, sort) VALUES (?1,?2,?3,?4)",
                params![folder.id, folder.name, folder.parent_id, folder.sort],
            )?;
        } else {
            c.execute(
                "UPDATE folders SET name=?2, parent_id=?3, sort=?4 WHERE id=?1",
                params![folder.id, folder.name, folder.parent_id, folder.sort],
            )?;
        }
        Ok(folder)
    }

    /// As conexões dentro da pasta não são apagadas: a FK `ON DELETE SET NULL`
    /// devolve todas para a raiz.
    pub fn delete_folder(&self, id: &str) -> AppResult<()> {
        self.lock()?
            .execute("DELETE FROM folders WHERE id = ?1", params![id])?;
        Ok(())
    }

    // -------------------------------------------------------------------- tags

    pub fn list_tags(&self) -> AppResult<Vec<Tag>> {
        let c = self.lock()?;
        let mut stmt =
            c.prepare("SELECT id, name, color, parent_id, sort FROM tags ORDER BY sort, name")?;
        let rows = stmt.query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                parent_id: r.get(3)?,
                sort: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn save_tag(&self, mut tag: Tag) -> AppResult<Tag> {
        let c = self.lock()?;
        if tag.id.is_empty() {
            tag.id = Uuid::new_v4().to_string();
            c.execute(
                "INSERT INTO tags (id, name, color, parent_id, sort) VALUES (?1,?2,?3,?4,?5)",
                params![tag.id, tag.name, tag.color, tag.parent_id, tag.sort],
            )?;
        } else {
            c.execute(
                "UPDATE tags SET name=?2, color=?3, parent_id=?4, sort=?5 WHERE id=?1",
                params![tag.id, tag.name, tag.color, tag.parent_id, tag.sort],
            )?;
        }
        Ok(tag)
    }

    pub fn delete_tag(&self, id: &str) -> AppResult<()> {
        self.lock()?
            .execute("DELETE FROM tags WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------------------------------------------------------------ temas

    pub fn list_themes(&self) -> AppResult<Vec<Theme>> {
        let c = self.lock()?;
        let mut stmt = c.prepare("SELECT id, name, is_builtin, json FROM themes ORDER BY name")?;
        let rows = stmt.query_map([], |r| {
            let raw: String = r.get(3)?;
            Ok(Theme {
                id: r.get(0)?,
                name: r.get(1)?,
                is_builtin: r.get::<_, i64>(2)? != 0,
                json: serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null),
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn save_theme(&self, mut theme: Theme) -> AppResult<Theme> {
        let c = self.lock()?;
        if theme.id.is_empty() {
            theme.id = Uuid::new_v4().to_string();
        }
        c.execute(
            "INSERT INTO themes (id, name, is_builtin, json) VALUES (?1, ?2, 0, ?3)
             ON CONFLICT(id) DO UPDATE SET name = ?2, json = ?3 WHERE is_builtin = 0",
            params![theme.id, theme.name, theme.json.to_string()],
        )?;
        Ok(theme)
    }

    pub fn delete_theme(&self, id: &str) -> AppResult<()> {
        self.lock()?.execute(
            "DELETE FROM themes WHERE id = ?1 AND is_builtin = 0",
            params![id],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------- identidades

    /// Reconcilia a lista vinda do disco/agente com o catálogo.
    ///
    /// Faz UPSERT do que foi encontrado e remove só o que sumiu **e** não está
    /// em uso. Um `DELETE` geral seguido de reinserção seria mais simples, mas
    /// dispararia o `ON DELETE SET NULL` da FK `connections.identity_id` e
    /// apagaria a chave escolhida em todas as conexões a cada varredura.
    ///
    /// Chave referenciada por alguma conexão nunca é removida, mesmo que o
    /// arquivo não esteja acessível no momento (volume externo desmontado,
    /// home em rede): perder a configuração é pior que manter uma referência
    /// que falha com uma mensagem clara na hora de conectar.
    pub fn sync_identities(&self, found: &[Identity]) -> AppResult<Vec<Identity>> {
        let mut c = self.lock()?;
        let tx = c.transaction()?;

        {
            let keep: Vec<String> = found.iter().map(|i| i.id.clone()).collect();
            let mut stmt = tx.prepare(
                "SELECT id FROM identities
                 WHERE source != 'generated'
                   AND id NOT IN (
                     SELECT identity_id FROM connections WHERE identity_id IS NOT NULL
                   )",
            )?;
            let existing: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<_, _>>()?;
            drop(stmt);

            for id in existing.iter().filter(|id| !keep.contains(id)) {
                tx.execute("DELETE FROM identities WHERE id = ?1", params![id])?;
            }
        }

        for id in found {
            tx.execute(
                "INSERT INTO identities
                   (id, label, source, path, pubkey, fingerprint, key_type, has_passphrase, comment)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(id) DO UPDATE SET
                   label=?2, source=?3, path=?4, pubkey=?5, key_type=?7, has_passphrase=?8, comment=?9",
                params![
                    id.id,
                    id.label,
                    id.source,
                    id.path,
                    id.pubkey,
                    id.fingerprint,
                    id.key_type,
                    id.has_passphrase as i64,
                    id.comment,
                ],
            )?;
        }
        tx.commit()?;
        drop(c);
        self.list_identities()
    }

    pub fn list_identities(&self) -> AppResult<Vec<Identity>> {
        let c = self.lock()?;
        let mut stmt = c.prepare(
            "SELECT id, label, source, path, pubkey, fingerprint, key_type, has_passphrase, comment
             FROM identities ORDER BY label",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Identity {
                id: r.get(0)?,
                label: r.get(1)?,
                source: r.get(2)?,
                path: r.get(3)?,
                pubkey: r.get(4)?,
                fingerprint: r.get(5)?,
                key_type: r.get(6)?,
                has_passphrase: r.get::<_, i64>(7)? != 0,
                comment: r.get(8)?,
                in_agent: false,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn get_identity(&self, id: &str) -> AppResult<Option<Identity>> {
        Ok(self.list_identities()?.into_iter().find(|i| i.id == id))
    }

    // ------------------------------------------------------------ known_hosts

    pub fn known_host(&self, host: &str, port: u16, key_type: &str) -> AppResult<Option<KnownHost>> {
        let c = self.lock()?;
        Ok(c.query_row(
            "SELECT host, port, key_type, fingerprint, pubkey, first_seen, last_seen
             FROM known_hosts WHERE host=?1 AND port=?2 AND key_type=?3",
            params![host, port, key_type],
            |r| {
                Ok(KnownHost {
                    host: r.get(0)?,
                    port: r.get::<_, i64>(1)? as u16,
                    key_type: r.get(2)?,
                    fingerprint: r.get(3)?,
                    pubkey: r.get(4)?,
                    first_seen: r.get(5)?,
                    last_seen: r.get(6)?,
                })
            },
        )
        .optional()?)
    }

    pub fn trust_host(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        fingerprint: &str,
        pubkey: &str,
    ) -> AppResult<()> {
        let ts = now();
        self.lock()?.execute(
            "INSERT INTO known_hosts (host, port, key_type, fingerprint, pubkey, first_seen, last_seen)
             VALUES (?1,?2,?3,?4,?5,?6,?6)
             ON CONFLICT(host, port, key_type)
               DO UPDATE SET fingerprint=?4, pubkey=?5, last_seen=?6",
            params![host, port, key_type, fingerprint, pubkey, ts],
        )?;
        Ok(())
    }

    pub fn list_known_hosts(&self) -> AppResult<Vec<KnownHost>> {
        let c = self.lock()?;
        let mut stmt = c.prepare(
            "SELECT host, port, key_type, fingerprint, pubkey, first_seen, last_seen
             FROM known_hosts ORDER BY host",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(KnownHost {
                host: r.get(0)?,
                port: r.get::<_, i64>(1)? as u16,
                key_type: r.get(2)?,
                fingerprint: r.get(3)?,
                pubkey: r.get(4)?,
                first_seen: r.get(5)?,
                last_seen: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn forget_host(&self, host: &str, port: u16) -> AppResult<()> {
        self.lock()?.execute(
            "DELETE FROM known_hosts WHERE host=?1 AND port=?2",
            params![host, port],
        )?;
        Ok(())
    }

    // --------------------------------------------------------------- snippets

    pub fn list_snippets(&self) -> AppResult<Vec<Snippet>> {
        let c = self.lock()?;
        let mut stmt = c.prepare("SELECT id, name, body, tag_scope FROM snippets ORDER BY name")?;
        let rows = stmt.query_map([], |r| {
            Ok(Snippet {
                id: r.get(0)?,
                name: r.get(1)?,
                body: r.get(2)?,
                tag_scope: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn save_snippet(&self, mut s: Snippet) -> AppResult<Snippet> {
        let c = self.lock()?;
        if s.id.is_empty() {
            s.id = Uuid::new_v4().to_string();
        }
        c.execute(
            "INSERT INTO snippets (id, name, body, tag_scope) VALUES (?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET name=?2, body=?3, tag_scope=?4",
            params![s.id, s.name, s.body, s.tag_scope],
        )?;
        Ok(s)
    }

    pub fn delete_snippet(&self, id: &str) -> AppResult<()> {
        self.lock()?
            .execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
        Ok(())
    }
}

// `Connection` colide com `rusqlite::Connection`; o alias mantém o modelo legível
// no resto do código sem renomear o tipo público exposto ao frontend.
pub use models::Connection as Connection_;

fn row_to_connection(r: &Row) -> rusqlite::Result<Connection_> {
    Ok(Connection_ {
        id: r.get(0)?,
        name: r.get(1)?,
        host: r.get(2)?,
        port: r.get::<_, i64>(3)? as u16,
        username: r.get(4)?,
        auth_method: r.get(5)?,
        identity_id: r.get(6)?,
        jump_host_id: r.get(7)?,
        color: r.get(8)?,
        icon: r.get(9)?,
        theme_id: r.get(10)?,
        is_production: r.get::<_, i64>(11)? != 0,
        notes: r.get(12)?,
        created_at: r.get(13)?,
        last_used_at: r.get(14)?,
        use_count: r.get(15)?,
        folder_id: r.get(16)?,
        tag_ids: Vec::new(),
    })
}

fn row_to_forward(r: &Row) -> rusqlite::Result<PortForward> {
    Ok(PortForward {
        id: r.get(0)?,
        connection_id: r.get(1)?,
        kind: r.get(2)?,
        label: r.get(3)?,
        bind_addr: r.get(4)?,
        local_port: r.get::<_, i64>(5)? as u16,
        remote_host: r.get(6)?,
        remote_port: r.get::<_, i64>(7)? as u16,
        auto_start: r.get::<_, i64>(8)? != 0,
    })
}

fn tag_ids_of(c: &Connection, conn_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = c.prepare("SELECT tag_id FROM connection_tags WHERE connection_id = ?1")?;
    let rows = stmt.query_map(params![conn_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let dir = std::env::temp_dir().join(format!("fs-ssh-unit-{}", Uuid::new_v4()));
        Db::open(&dir).expect("abrir banco")
    }

    fn identity(id: &str) -> Identity {
        Identity {
            id: id.into(),
            label: format!("chave {id}"),
            source: "host".into(),
            path: Some(format!("/home/u/.ssh/{id}")),
            pubkey: "ssh-ed25519 AAAA".into(),
            fingerprint: id.into(),
            key_type: "ssh-ed25519".into(),
            has_passphrase: false,
            comment: String::new(),
            in_agent: false,
        }
    }

    fn connection(identity_id: Option<&str>) -> Connection_ {
        Connection_ {
            id: String::new(),
            name: "srv".into(),
            host: "10.0.0.1".into(),
            port: 22,
            username: "deploy".into(),
            auth_method: "key".into(),
            identity_id: identity_id.map(str::to_string),
            jump_host_id: None,
            folder_id: None,
            color: "#3b82f6".into(),
            icon: "server".into(),
            theme_id: None,
            is_production: false,
            notes: String::new(),
            created_at: String::new(),
            last_used_at: None,
            use_count: 0,
            tag_ids: vec![],
        }
    }

    /// Regressão: a varredura de chaves roda a cada `loadAll()`. Se ela apagar e
    /// reinserir as identidades, a FK `ON DELETE SET NULL` zera `identity_id` e
    /// a conexão perde a chave escolhida logo depois de ser salva.
    #[test]
    fn resync_preserva_chave_escolhida_na_conexao() {
        let db = db();
        let keys = vec![identity("fp:AAA"), identity("fp:BBB")];
        db.sync_identities(&keys).unwrap();

        let saved = db.save_connection(connection(Some("fp:AAA"))).unwrap();
        assert_eq!(saved.identity_id.as_deref(), Some("fp:AAA"));

        // Varredura seguinte, exatamente as mesmas chaves.
        db.sync_identities(&keys).unwrap();

        let after = db.get_connection(&saved.id).unwrap();
        assert_eq!(
            after.identity_id.as_deref(),
            Some("fp:AAA"),
            "a chave escolhida foi perdida no re-scan"
        );
    }

    /// Chave em uso não some do catálogo nem quando o arquivo desaparece — o
    /// usuário precisa ver o que estava configurado para poder corrigir.
    #[test]
    fn chave_em_uso_sobrevive_ao_sumir_do_disco() {
        let db = db();
        db.sync_identities(&[identity("fp:AAA"), identity("fp:BBB")])
            .unwrap();
        let saved = db.save_connection(connection(Some("fp:AAA"))).unwrap();

        // ~/.ssh agora está vazio.
        db.sync_identities(&[]).unwrap();

        let ids = db.list_identities().unwrap();
        assert!(
            ids.iter().any(|i| i.id == "fp:AAA"),
            "chave referenciada foi removida"
        );
        assert!(
            !ids.iter().any(|i| i.id == "fp:BBB"),
            "chave órfã deveria ter sido removida"
        );
        assert_eq!(
            db.get_connection(&saved.id).unwrap().identity_id.as_deref(),
            Some("fp:AAA")
        );
    }

    #[test]
    fn tags_sobrevivem_a_atualizacao_da_conexao() {
        let db = db();
        let tag = db
            .save_tag(Tag {
                id: String::new(),
                name: "prod".into(),
                color: "#ef4444".into(),
                parent_id: None,
                sort: 0,
            })
            .unwrap();

        let mut conn = connection(None);
        conn.tag_ids = vec![tag.id.clone()];
        let saved = db.save_connection(conn).unwrap();
        assert_eq!(saved.tag_ids, vec![tag.id.clone()]);

        let mut edited = saved.clone();
        edited.name = "srv renomeado".into();
        let updated = db.save_connection(edited).unwrap();
        assert_eq!(updated.tag_ids, vec![tag.id]);
        assert_eq!(updated.id, saved.id, "editar não pode criar outra conexão");
    }
}
