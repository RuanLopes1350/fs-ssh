//! Terminal local: um shell da própria máquina com PTY, exposto ao frontend
//! pela mesma interface das sessões SSH.
//!
//! Do lado da UI não há diferença — mesmo `SessionCmd`, mesmo canal de saída,
//! mesma gravação. O que muda é a origem dos bytes: em vez de um canal SSH,
//! um `portable_pty` falando com o shell do usuário.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel as IpcChannel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

use crate::error::{AppError, AppResult};
use crate::ssh::session::SessionCmd;

/// Mesma janela de coalescing do stream SSH: 8 ms fica abaixo do limiar
/// perceptível ao digitar e derruba a taxa de mensagens de IPC.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const FLUSH_BYTES: usize = 64 * 1024;

/// Id reservado para a conexão sintética do terminal local.
pub const LOCAL_CONNECTION_ID: &str = "__local__";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionClosed {
    session_id: String,
    exit_status: Option<u32>,
    reason: String,
}

/// Shell a usar: o preferido do usuário, com fallback para o do sistema.
fn resolve_shell(requested: Option<&str>) -> String {
    requested
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".into())
}

/// Abre o shell num PTY e devolve o canal de comandos da sessão.
pub fn spawn(
    app: AppHandle,
    session_id: String,
    shell: Option<&str>,
    cols: u16,
    rows: u16,
    out: IpcChannel<InvokeResponseBody>,
) -> AppResult<(mpsc::Sender<SessionCmd>, String)> {
    let shell = resolve_shell(shell);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::msg(format!("não foi possível abrir o PTY: {e}")))?;

    let mut cmd = CommandBuilder::new(&shell);
    // Shell de login: carrega ~/.zprofile, ~/.bash_profile e afins, senão o
    // PATH aqui não é o mesmo do Terminal.app e nada que o usuário instalou
    // aparece.
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "fs-ssh");
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::msg(format!("não foi possível iniciar {shell}: {e}")))?;
    // O lado escravo precisa ser fechado aqui: enquanto ele existir, o EOF do
    // master nunca chega e a saída do shell não termina quando ele morre.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::msg(format!("PTY sem leitor: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::msg(format!("PTY sem escritor: {e}")))?;

    // O `portable_pty` é bloqueante; leitura e escrita ficam em threads e
    // conversam com a task da sessão por canais.
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut writer = writer;
        while let Ok(data) = in_rx.recv() {
            if writer.write_all(&data).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });

    // Espera o shell terminar sem bloquear a runtime.
    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<Option<u32>>();
    std::thread::spawn(move || {
        let status = child.wait().ok().map(|s| s.exit_code());
        let _ = exit_tx.send(status);
    });

    let (tx, rx) = mpsc::channel(64);
    let master = Arc::new(Mutex::new(pair.master));
    tauri::async_runtime::spawn(run_local_session(
        app,
        session_id,
        rx,
        out,
        out_rx,
        in_tx,
        master,
        exit_rx,
    ));

    Ok((tx, shell))
}

#[allow(clippy::too_many_arguments)]
async fn run_local_session(
    app: AppHandle,
    session_id: String,
    mut rx: mpsc::Receiver<SessionCmd>,
    out: IpcChannel<InvokeResponseBody>,
    mut out_rx: mpsc::Receiver<Vec<u8>>,
    in_tx: std::sync::mpsc::Sender<Vec<u8>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    mut exit_rx: tokio::sync::oneshot::Receiver<Option<u32>>,
) {
    let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut recorder = crate::ssh::session::Recorder::none();
    let mut exit_status: Option<u32> = None;
    let reason;

    loop {
        tokio::select! {
            biased;

            cmd = rx.recv() => match cmd {
                Some(SessionCmd::Write(data)) => {
                    if in_tx.send(data).is_err() {
                        reason = "shell encerrado".to_string();
                        break;
                    }
                }
                Some(SessionCmd::Resize { cols, rows }) => {
                    if let Ok(m) = master.lock() {
                        let _ = m.resize(PtySize {
                            rows: rows.max(1) as u16,
                            cols: cols.max(1) as u16,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                }
                Some(SessionCmd::Record { path, format, cols, rows, reply }) => {
                    let _ = reply.send(recorder.set(path, &format, cols, rows));
                }
                // Exec vale para a própria máquina: é o que faz o painel de
                // containers funcionar no terminal local. Roda fora do PTY,
                // como no SSH, para não sujar a tela do usuário.
                Some(SessionCmd::Exec { command, reply }) => {
                    tokio::spawn(async move {
                        let _ = reply.send(run_local_command(command).await);
                    });
                }
                // Recursos que só existem sobre SSH. A mensagem é explícita
                // para o frontend poder mostrá-la sem adivinhar.
                Some(SessionCmd::OpenSftp(reply)) => {
                    let _ = reply.send(Err("o terminal local não tem SFTP".into()));
                }
                Some(SessionCmd::OpenDirectTcpip { reply, .. }) => {
                    let _ = reply.send(Err("túneis exigem uma sessão SSH".into()));
                }
                Some(SessionCmd::TcpipForward { reply, .. }) => {
                    let _ = reply.send(Err("túneis exigem uma sessão SSH".into()));
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

            data = out_rx.recv() => match data {
                Some(data) => {
                    recorder.write(&data);
                    buf.extend_from_slice(&data);
                    if buf.len() >= FLUSH_BYTES {
                        flush(&out, &mut buf);
                    }
                }
                None => {
                    reason = "shell encerrado".to_string();
                    break;
                }
            },

            status = &mut exit_rx => {
                exit_status = status.ok().flatten();
                reason = "shell encerrado".to_string();
                break;
            }

            _ = ticker.tick() => {
                if !buf.is_empty() {
                    flush(&out, &mut buf);
                }
            }
        }
    }

    if !buf.is_empty() {
        flush(&out, &mut buf);
    }
    recorder.finish();

    let _ = app.emit(
        "session-closed",
        SessionClosed {
            session_id,
            exit_status,
            reason,
        },
    );
}

/// Tempo máximo de um exec local — mesmo teto do exec por SSH.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);

/// Executa um comando na máquina local e devolve `(código, stdout+stderr)`.
///
/// Usa o shell em modo de login: sem isso o `PATH` não inclui `/usr/local/bin`
/// nem o Homebrew, e o `docker` do usuário não seria encontrado.
async fn run_local_command(command: String) -> Result<(u32, Vec<u8>), String> {
    let shell = resolve_shell(None);
    let run = tokio::process::Command::new(&shell)
        .arg("-lc")
        .arg(&command)
        .output();

    match tokio::time::timeout(EXEC_TIMEOUT, run).await {
        Ok(Ok(out)) => {
            let mut buf = out.stdout;
            buf.extend_from_slice(&out.stderr);
            Ok((out.status.code().unwrap_or(0).max(0) as u32, buf))
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!(
            "comando não terminou em {}s",
            EXEC_TIMEOUT.as_secs()
        )),
    }
}

fn flush(out: &IpcChannel<InvokeResponseBody>, buf: &mut Vec<u8>) {
    let payload = std::mem::replace(buf, Vec::with_capacity(FLUSH_BYTES));
    if let Err(e) = out.send(InvokeResponseBody::Raw(payload)) {
        tracing::debug!("canal de saída local fechado: {e}");
    }
}
