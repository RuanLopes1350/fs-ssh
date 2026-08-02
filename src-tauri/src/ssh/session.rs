use std::sync::Arc;
use std::time::Duration;

use russh::client::Msg;
use russh::{Channel as SshChannel, ChannelMsg};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::ipc::{Channel as IpcChannel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;

use super::handler::ClientHandler;

/// Janela de coalescing do stream do terminal.
///
/// Sem isso, um `cat` de arquivo grande vira dezenas de milhares de mensagens de
/// IPC e o webview trava. 8 ms fica abaixo do limiar perceptível ao digitar
/// (um frame a 120 Hz) e derruba a taxa de mensagens em ordens de magnitude.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
/// Descarrega antes do tick quando o buffer cresce demais, para não segurar
/// memória nem atrasar rajadas grandes.
const FLUSH_BYTES: usize = 64 * 1024;

pub enum SessionCmd {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    OpenSftp(oneshot::Sender<Result<Arc<SftpSession>, String>>),
    /// Executa um comando em um canal exec separado (fora do PTY do usuário) e
    /// devolve `(exit_status, stdout+stderr)`. Usado pela detecção de Docker.
    Exec {
        command: String,
        reply: oneshot::Sender<Result<(u32, Vec<u8>), String>>,
    },
    /// Abre um canal direct-tcpip até `host:port` via servidor — uma conexão de
    /// um túnel local (-L).
    OpenDirectTcpip {
        host: String,
        port: u32,
        reply: oneshot::Sender<Result<SshChannel<Msg>, String>>,
    },
    /// Registra (`register = true`) ou cancela um túnel reverso (-R) no servidor.
    TcpipForward {
        address: String,
        port: u32,
        register: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Liga (`Some(path)`) ou desliga (`None`) a gravação da saída do terminal.
    Record {
        path: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Close,
}

/// Grava a saída do terminal em texto.
///
/// As sequências de escape são removidas: o objetivo é um arquivo legível
/// (auditoria, "o que eu rodei mesmo?"), não um replay fiel — para replay o
/// caminho seria asciinema, que é outro formato.
///
/// É público porque o terminal local usa exatamente a mesma gravação.
pub struct Recorder {
    file: Option<std::fs::File>,
    state: EscState,
}

enum EscState {
    Text,
    Esc,
    Csi,
    Osc,
    /// Dentro de OSC e o último byte foi ESC (fim é `ESC \`).
    OscEsc,
}

impl Recorder {
    /// Gravador desligado — o estado normal de uma sessão.
    pub fn none() -> Self {
        Recorder {
            file: None,
            state: EscState::Text,
        }
    }

    /// Liga a gravação em `path` (fechando a anterior) ou desliga com `None`.
    pub fn set(&mut self, path: Option<String>) -> Result<(), String> {
        let Some(path) = path else {
            self.finish();
            return Ok(());
        };
        match Self::create_file(&path) {
            Ok(file) => {
                self.finish();
                self.file = Some(file);
                self.state = EscState::Text;
                tracing::info!("gravação de sessão iniciada em {path}");
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn create_file(path: &str) -> std::io::Result<std::fs::File> {
        use std::io::Write;
        if let Some(dir) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).append(true);
        // A gravação pode conter tudo que passou pela tela, inclusive segredos
        // digitados ou exibidos: nasce 0600.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(path)?;
        writeln!(
            file,
            "── gravação iniciada em {} ──",
            chrono::Local::now().format("%d/%m/%Y %H:%M:%S")
        )?;
        Ok(file)
    }

    pub fn write(&mut self, data: &[u8]) {
        use std::io::Write;
        if self.file.is_none() {
            return;
        }
        let mut out = Vec::with_capacity(data.len());
        for &b in data {
            match self.state {
                EscState::Text => match b {
                    0x1b => self.state = EscState::Esc,
                    b'\n' | b'\t' => out.push(b),
                    b'\r' => {}                            // CR isolado só move o cursor
                    0x20..=0x7e | 0x80..=0xff => out.push(b), // texto e UTF-8
                    _ => {}
                },
                EscState::Esc => {
                    self.state = match b {
                        b'[' => EscState::Csi,
                        b']' => EscState::Osc,
                        _ => EscState::Text, // ESC de 2 bytes: descarta e segue
                    }
                }
                // CSI termina no primeiro byte final (0x40..=0x7e).
                EscState::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.state = EscState::Text;
                    }
                }
                EscState::Osc => match b {
                    0x07 => self.state = EscState::Text,
                    0x1b => self.state = EscState::OscEsc,
                    _ => {}
                },
                EscState::OscEsc => {
                    self.state = if b == b'\\' { EscState::Text } else { EscState::Osc };
                }
            }
        }
        if let (Some(file), false) = (self.file.as_mut(), out.is_empty()) {
            let _ = file.write_all(&out);
        }
    }

    pub fn finish(&mut self) {
        use std::io::Write;
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let _ = writeln!(
            file,
            "\n── gravação encerrada em {} ──",
            chrono::Local::now().format("%d/%m/%Y %H:%M:%S")
        );
        let _ = file.flush();
        self.file = None;
    }
}

/// Saída máxima de um exec — proteção contra um `docker ps` que nunca termina.
const EXEC_MAX_OUTPUT: usize = 2 * 1024 * 1024;
/// Tempo máximo de um exec.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionClosed {
    session_id: String,
    exit_status: Option<u32>,
    reason: String,
}

/// Task dona da sessão SSH.
///
/// O `Handle` do russh não é `Clone` nem `Sync` de forma útil, então ele vive
/// aqui e todo mundo fala com esta task por `mpsc`. Isso evita um `Mutex` global
/// no caminho quente do terminal e elimina a possibilidade de o SFTP travar o
/// stream de saída (ou vice-versa).
#[allow(clippy::too_many_arguments)]
pub async fn run_session(
    handle: russh::client::Handle<ClientHandler>,
    // Mantido vivo apenas para o túnel do bastion não fechar embaixo da sessão.
    _jump: Option<russh::client::Handle<ClientHandler>>,
    channel: SshChannel<Msg>,
    mut rx: mpsc::Receiver<SessionCmd>,
    out: IpcChannel<InvokeResponseBody>,
    app: AppHandle,
    session_id: String,
) {
    let (mut read, write) = channel.split();

    let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut exit_status: Option<u32> = None;
    let mut recorder = Recorder::none();
    let reason;

    loop {
        tokio::select! {
            biased;

            cmd = rx.recv() => match cmd {
                Some(SessionCmd::Write(data)) => {
                    if write.data_bytes(data).await.is_err() {
                        reason = "canal fechado na escrita".to_string();
                        break;
                    }
                }
                Some(SessionCmd::Resize { cols, rows }) => {
                    let _ = write.window_change(cols, rows, 0, 0).await;
                }
                Some(SessionCmd::OpenSftp(reply)) => {
                    let _ = reply.send(open_sftp(&handle).await);
                }
                Some(SessionCmd::Record { path, reply }) => {
                    let _ = reply.send(recorder.set(path));
                }
                Some(SessionCmd::OpenDirectTcpip { host, port, reply }) => {
                    let r = handle
                        .channel_open_direct_tcpip(host, port, "127.0.0.1", 0)
                        .await
                        .map_err(|e| e.to_string());
                    let _ = reply.send(r);
                }
                Some(SessionCmd::TcpipForward { address, port, register, reply }) => {
                    let r = if register {
                        handle
                            .tcpip_forward(address, port)
                            .await
                            .map(|_| ())
                            .map_err(|e| e.to_string())
                    } else {
                        handle
                            .cancel_tcpip_forward(address, port)
                            .await
                            .map_err(|e| e.to_string())
                    };
                    let _ = reply.send(r);
                }
                Some(SessionCmd::Exec { command, reply }) => {
                    // Só a abertura do canal acontece aqui; a leitura da saída
                    // roda em task própria para não pausar o stream do terminal.
                    match handle.channel_open_session().await {
                        Ok(ch) => {
                            tauri::async_runtime::spawn(run_exec(ch, command, reply));
                        }
                        Err(e) => {
                            let _ = reply.send(Err(format!("abrir canal: {e}")));
                        }
                    }
                }
                Some(SessionCmd::Close) => {
                    reason = "encerrada pelo usuário".to_string();
                    break;
                }
                None => {
                    reason = "handle descartado".to_string();
                    break;
                }
            },

            msg = read.wait() => match msg {
                Some(ChannelMsg::Data { data }) => {
                    recorder.write(&data);
                    buf.extend_from_slice(&data);
                    if buf.len() >= FLUSH_BYTES {
                        flush(&out, &mut buf);
                    }
                }
                // stderr do PTY chega como extended data; no terminal os dois
                // fluxos são a mesma tela, então vão para o mesmo buffer.
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    recorder.write(&data);
                    buf.extend_from_slice(&data);
                    if buf.len() >= FLUSH_BYTES {
                        flush(&out, &mut buf);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status: st }) => {
                    exit_status = Some(st);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                    reason = "canal encerrado pelo servidor".to_string();
                    break;
                }
                None => {
                    reason = "conexão perdida".to_string();
                    break;
                }
                Some(_) => {}
            },

            _ = ticker.tick() => {
                if !buf.is_empty() {
                    flush(&out, &mut buf);
                }
            }
        }
    }

    // Não perde o que ficou no buffer (mensagem de erro do shell, "logout", etc.).
    if !buf.is_empty() {
        flush(&out, &mut buf);
    }

    recorder.finish();

    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    let _ = app.emit(
        "session-closed",
        SessionClosed {
            session_id,
            exit_status,
            reason,
        },
    );
}

/// Executa `command` no canal já aberto e coleta a saída até EOF.
async fn run_exec(
    channel: SshChannel<Msg>,
    command: String,
    reply: oneshot::Sender<Result<(u32, Vec<u8>), String>>,
) {
    let result = tokio::time::timeout(EXEC_TIMEOUT, exec_collect(channel, command)).await;
    let _ = reply.send(match result {
        Ok(r) => r,
        Err(_) => Err(format!("comando não terminou em {}s", EXEC_TIMEOUT.as_secs())),
    });
}

async fn exec_collect(
    mut channel: SshChannel<Msg>,
    command: String,
) -> Result<(u32, Vec<u8>), String> {
    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("exec: {e}"))?;

    let mut out = Vec::new();
    let mut status = 0u32;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                if out.len() + data.len() > EXEC_MAX_OUTPUT {
                    return Err("saída do comando grande demais".into());
                }
                out.extend_from_slice(&data);
            }
            ChannelMsg::ExitStatus { exit_status } => status = exit_status,
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok((status, out))
}

async fn open_sftp(
    handle: &russh::client::Handle<ClientHandler>,
) -> Result<Arc<SftpSession>, String> {
    let ch = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("abrir canal: {e}"))?;
    ch.request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("subsistema sftp: {e}"))?;
    let session = SftpSession::new(ch.into_stream())
        .await
        .map_err(|e| format!("handshake sftp: {e}"))?;
    Ok(Arc::new(session))
}

fn flush(out: &IpcChannel<InvokeResponseBody>, buf: &mut Vec<u8>) {
    let payload = std::mem::replace(buf, Vec::with_capacity(FLUSH_BYTES));
    // `Raw` chega no JS como ArrayBuffer, sem passar por JSON.parse.
    if let Err(e) = out.send(InvokeResponseBody::Raw(payload)) {
        tracing::debug!("canal de saída fechado: {e}");
    }
}
