//! Testes contra um sshd real.
//!
//! Suba o servidor antes:
//!
//! ```sh
//! docker run -d --name fs-ssh-test -p 2222:2222 \
//!   -e USER_NAME=testuser -e USER_PASSWORD=testpass -e PASSWORD_ACCESS=true \
//!   lscr.io/linuxserver/openssh-server:latest
//! ```
//!
//! Sem `FS_SSH_TEST_SSH=1` os testes passam sem fazer nada, para não quebrar um
//! `cargo test` numa máquina sem Docker.

use std::sync::Arc;
use std::time::Duration;

use fs_ssh_lib::error::AppError;
use fs_ssh_lib::ssh::connect;
use fs_ssh_lib::store::models::Connection;
use fs_ssh_lib::store::Db;
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;

fn enabled() -> bool {
    std::env::var("FS_SSH_TEST_SSH").as_deref() == Ok("1")
}

fn test_conn() -> Connection {
    Connection {
        id: "test".into(),
        name: "test".into(),
        host: "127.0.0.1".into(),
        port: 2222,
        username: "testuser".into(),
        auth_method: "password".into(),
        identity_id: None,
        jump_host_id: None,
        folder_id: None,
        color: "#000000".into(),
        icon: "server".into(),
        theme_id: None,
        is_production: false,
        notes: String::new(),
        created_at: String::new(),
        last_used_at: None,
        use_count: 0,
    }
}

fn temp_db() -> Arc<Db> {
    let dir = std::env::temp_dir().join(format!("fs-ssh-test-{}", uuid::Uuid::new_v4()));
    Arc::new(Db::open(&dir).expect("abrir banco temporário"))
}

/// Conecta pela primeira vez (deve exigir TOFU), confia na chave, e conecta de novo.
async fn connect_trusting(db: Arc<Db>) -> connect::Connected {
    let conn = test_conn();

    let first = connect::connect(db.clone(), &conn, None, None, None, Some("testpass"), None).await;

    match first {
        Err(AppError::HostKeyUnknown {
            host,
            port,
            fingerprint,
            algorithm,
        }) => {
            db.trust_host(&host, port, &algorithm, &fingerprint, "")
                .expect("registrar host key");
        }
        Err(e) => panic!("erro inesperado na primeira conexão: {e}"),
        // Se o host já estava no ~/.ssh/known_hosts do sistema, conecta direto.
        Ok(c) => return c,
    }

    connect::connect(db, &conn, None, None, None, Some("testpass"), None)
        .await
        .expect("conectar após confiar na host key")
}

#[tokio::test(flavor = "multi_thread")]
async fn tofu_bloqueia_host_desconhecido_e_libera_apos_confiar() {
    if !enabled() {
        return;
    }
    let db = temp_db();
    let conn = test_conn();

    // Um banco vazio + host que não está no known_hosts do sistema precisa
    // recusar. Se isso passar direto, a verificação está desligada.
    let first = connect::connect(db.clone(), &conn, None, None, None, Some("testpass"), None).await;
    let fingerprint = match first {
        Err(AppError::HostKeyUnknown { fingerprint, algorithm, host, port }) => {
            db.trust_host(&host, port, &algorithm, &fingerprint, "").unwrap();
            fingerprint
        }
        Err(e) => panic!("esperava HostKeyUnknown, veio: {e}"),
        Ok(_) => {
            eprintln!("host já confiado no sistema; pulando a parte TOFU");
            return;
        }
    };
    assert!(fingerprint.starts_with("SHA256:"), "fingerprint: {fingerprint}");

    connect::connect(db, &conn, None, None, None, Some("testpass"), None)
        .await
        .expect("segunda conexão deve passar");
}

#[tokio::test(flavor = "multi_thread")]
async fn senha_errada_falha_com_auth_failed() {
    if !enabled() {
        return;
    }
    let db = temp_db();
    // Confia primeiro para isolar a falha de autenticação do TOFU.
    let _ = connect_trusting(db.clone()).await;

    let conn = test_conn();
    let r = connect::connect(db, &conn, None, None, None, Some("senha-errada"), None).await;
    match r {
        Err(AppError::AuthFailed { .. }) => {}
        Err(e) => panic!("esperava AuthFailed, veio: {e}"),
        Ok(_) => panic!("autenticou com senha errada"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pty_executa_comando_e_devolve_saida() {
    if !enabled() {
        return;
    }
    let connected = connect_trusting(temp_db()).await;

    let channel = connected.handle.channel_open_session().await.unwrap();
    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .unwrap();
    channel.request_shell(true).await.unwrap();

    let (mut read, write) = channel.split();
    write
        .data_bytes(b"echo MARCO_INTEGRACAO_OK\n".to_vec())
        .await
        .unwrap();

    let mut acc = Vec::new();
    let found = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(msg) = read.wait().await {
            if let ChannelMsg::Data { data } = msg {
                acc.extend_from_slice(&data);
                // Aparece duas vezes: o eco do PTY e a saída do comando.
                if String::from_utf8_lossy(&acc).matches("MARCO_INTEGRACAO_OK").count() >= 2 {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    assert!(
        found,
        "não veio a saída do comando. buffer:\n{}",
        String::from_utf8_lossy(&acc)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sftp_escreve_le_e_apaga_no_mesmo_canal() {
    if !enabled() {
        return;
    }
    let connected = connect_trusting(temp_db()).await;

    let ch = connected.handle.channel_open_session().await.unwrap();
    ch.request_subsystem(true, "sftp").await.unwrap();
    let sftp = SftpSession::new(ch.into_stream()).await.unwrap();

    let home = sftp.canonicalize(".").await.unwrap();
    let path = format!("{home}/fs-ssh-integracao.txt");
    let payload = b"conteudo de teste \xc3\xa7\xc3\xa3o";

    // `SftpSession::write` não passa CREATE; para criar arquivo novo é preciso
    // abrir explicitamente com as flags certas.
    {
        use tokio::io::AsyncWriteExt;
        let mut f = sftp.create(path.clone()).await.unwrap();
        f.write_all(payload).await.unwrap();
        f.flush().await.unwrap();
        f.shutdown().await.unwrap();
    }

    let back = sftp.read(path.clone()).await.unwrap();
    assert_eq!(back, payload, "conteúdo lido difere do escrito");

    let listing = sftp.read_dir(home.clone()).await.unwrap();
    let names: Vec<String> = listing.map(|e| e.file_name()).collect();
    assert!(
        names.iter().any(|n| n == "fs-ssh-integracao.txt"),
        "arquivo não apareceu na listagem: {names:?}"
    );

    sftp.remove_file(path).await.unwrap();
}

/// Terminal e SFTP têm que conviver na mesma conexão TCP — é a premissa de
/// design que evita um segundo login ao abrir o painel de arquivos.
#[tokio::test(flavor = "multi_thread")]
async fn terminal_e_sftp_coexistem_na_mesma_sessao() {
    if !enabled() {
        return;
    }
    let connected = connect_trusting(temp_db()).await;

    let shell = connected.handle.channel_open_session().await.unwrap();
    shell
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .unwrap();
    shell.request_shell(true).await.unwrap();

    let ch = connected.handle.channel_open_session().await.unwrap();
    ch.request_subsystem(true, "sftp").await.unwrap();
    let sftp = SftpSession::new(ch.into_stream()).await.unwrap();

    // O SFTP responde com o shell aberto...
    let home = sftp.canonicalize(".").await.unwrap();
    assert!(!home.is_empty());

    // ...e o shell continua respondendo depois do SFTP.
    let (mut read, write) = shell.split();
    write.data_bytes(b"echo AINDA_VIVO\n".to_vec()).await.unwrap();

    // Precisa ser `match` e não `while let Some(Data{..})`: o canal entrega
    // `Success` (resposta do request_pty) antes do primeiro byte, e um
    // `while let` com padrão restrito sairia do laço aí.
    let ok = tokio::time::timeout(Duration::from_secs(10), async {
        let mut acc = Vec::new();
        while let Some(msg) = read.wait().await {
            if let ChannelMsg::Data { data } = msg {
                acc.extend_from_slice(&data);
                if String::from_utf8_lossy(&acc).matches("AINDA_VIVO").count() >= 2 {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    assert!(ok, "shell parou de responder depois de abrir o SFTP");
}
