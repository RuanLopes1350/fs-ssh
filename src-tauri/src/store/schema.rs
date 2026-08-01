use rusqlite::Connection;

use crate::error::AppResult;

/// Migrações incrementais. `user_version` do SQLite guarda em qual passo estamos;
/// cada entrada nova roda uma única vez, em ordem.
const MIGRATIONS: &[&str] = &[
    // v1 — esquema inicial
    r#"
    CREATE TABLE tags (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#6b7280',
        parent_id  TEXT REFERENCES tags(id) ON DELETE SET NULL,
        sort       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE identities (
        id             TEXT PRIMARY KEY,
        label          TEXT NOT NULL,
        source         TEXT NOT NULL,           -- 'host' | 'generated' | 'agent'
        path           TEXT,                    -- caminho da chave privada (nunca o conteúdo)
        pubkey         TEXT NOT NULL,
        fingerprint    TEXT NOT NULL,
        key_type       TEXT NOT NULL,
        has_passphrase INTEGER NOT NULL DEFAULT 0,
        comment        TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE themes (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        json       TEXT NOT NULL
    );

    CREATE TABLE connections (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        host          TEXT NOT NULL,
        port          INTEGER NOT NULL DEFAULT 22,
        username      TEXT NOT NULL,
        auth_method   TEXT NOT NULL DEFAULT 'auto',   -- auto | agent | key | password
        identity_id   TEXT REFERENCES identities(id) ON DELETE SET NULL,
        jump_host_id  TEXT REFERENCES connections(id) ON DELETE SET NULL,
        color         TEXT NOT NULL DEFAULT '#3b82f6',
        icon          TEXT NOT NULL DEFAULT 'server',
        theme_id      TEXT REFERENCES themes(id) ON DELETE SET NULL,
        is_production INTEGER NOT NULL DEFAULT 0,
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        last_used_at  TEXT,
        use_count     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE connection_tags (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        tag_id        TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (connection_id, tag_id)
    );

    CREATE TABLE known_hosts (
        host        TEXT NOT NULL,
        port        INTEGER NOT NULL,
        key_type    TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        pubkey      TEXT NOT NULL,
        first_seen  TEXT NOT NULL,
        last_seen   TEXT NOT NULL,
        PRIMARY KEY (host, port, key_type)
    );

    CREATE TABLE snippets (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        body      TEXT NOT NULL,
        tag_scope TEXT
    );

    CREATE INDEX idx_conn_tags_tag ON connection_tags(tag_id);
    CREATE INDEX idx_conn_last_used ON connections(last_used_at DESC);
    "#,
    // v2 — pastas para organizar conexões
    r#"
    CREATE TABLE folders (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
        sort      INTEGER NOT NULL DEFAULT 0
    );

    ALTER TABLE connections
        ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
    "#,
    // v3 — port forwarding por conexão
    //
    // kind = 'local'  (-L): localhost:local_port → remote_host:remote_port via servidor
    // kind = 'remote' (-R): servidor:local_port  → remote_host:remote_port na máquina local
    r#"
    CREATE TABLE port_forwards (
        id            TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL DEFAULT 'local',
        label         TEXT NOT NULL DEFAULT '',
        bind_addr     TEXT NOT NULL DEFAULT '127.0.0.1',
        local_port    INTEGER NOT NULL,
        remote_host   TEXT NOT NULL DEFAULT 'localhost',
        remote_port   INTEGER NOT NULL,
        auto_start    INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_forwards_conn ON port_forwards(connection_id);
    "#,
];

pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;",
    )?;

    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = (i + 1) as i64;
        if version > current {
            conn.execute_batch(sql)?;
            conn.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        }
    }
    Ok(())
}
