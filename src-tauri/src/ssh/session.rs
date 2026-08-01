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
    Close,
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
                    buf.extend_from_slice(&data);
                    if buf.len() >= FLUSH_BYTES {
                        flush(&out, &mut buf);
                    }
                }
                // stderr do PTY chega como extended data; no terminal os dois
                // fluxos são a mesma tela, então vão para o mesmo buffer.
                Some(ChannelMsg::ExtendedData { data, .. }) => {
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
