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
/// Id reservado para a conexão sintética do WSL.
pub const WSL_CONNECTION_ID: &str = "__wsl__";

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
        .or_else(|| {
            #[cfg(windows)]
            {
                Some("powershell.exe".into())
            }
            #[cfg(not(windows))]
            {
                std::env::var("SHELL").ok()
            }
        })
        .unwrap_or_else(|| {
            #[cfg(windows)]
            {
                std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
            }
            #[cfg(target_os = "macos")]
            {
                "/bin/zsh".into()
            }
            #[cfg(all(not(windows), not(target_os = "macos")))]
            {
                "/bin/bash".into()
            }
        })
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
    let parts = shlex::split(&shell).unwrap_or_else(|| vec![shell.clone()]);
    let (prog, args) = parts
        .split_first()
        .map(|(p, a)| (p.as_str(), a))
        .unwrap_or((shell.as_str(), &[]));

    #[cfg(windows)]
    let resolved_prog = if prog.eq_ignore_ascii_case("wsl") || prog.eq_ignore_ascii_case("wsl.exe") {
        let system32_wsl = std::path::Path::new(r"C:\Windows\System32\wsl.exe");
        if system32_wsl.exists() {
            system32_wsl.to_string_lossy().to_string()
        } else {
            prog.to_string()
        }
    } else {
        prog.to_string()
    };
    #[cfg(not(windows))]
    let resolved_prog = prog.to_string();

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::msg(format!("não foi possível abrir o PTY: {e}")))?;

    let mut cmd = CommandBuilder::new(&resolved_prog);
    for arg in args {
        cmd.arg(arg);
    }
    // Shell de login: carrega ~/.zprofile, ~/.bash_profile e afins, senão o
    // PATH aqui não é o mesmo do Terminal.app e nada que o usuário instalou
    // aparece. (No Windows, cmd/powershell não aceitam -l).
    #[cfg(not(windows))]
    if args.is_empty() {
        cmd.arg("-l");
    }
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
        shell.clone(),
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
    shell_cmd: String,
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
                    let session_shell = shell_cmd.clone();
                    tokio::spawn(async move {
                        let _ = reply.send(run_local_command(session_shell, command).await);
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

#[cfg(windows)]
fn extract_wsl_distro(session_shell: &str) -> Option<String> {
    let parts = shlex::split(session_shell)?;
    for window in parts.windows(2) {
        if window[0] == "-d" || window[0] == "--distribution" {
            return Some(window[1].clone());
        }
    }
    None
}

/// Executa um comando na máquina local e devolve `(código, stdout+stderr)`.
///
/// No Unix usa o shell em modo de login (`-lc`) para carregar `/usr/local/bin`
/// e Homebrew; no Windows delega silenciosamente para o WSL (`wsl.exe -- sh -lc`)
/// quando disponível, permitindo que os painéis POSIX funcionem sem falhas.
async fn run_local_command(session_shell: String, command: String) -> Result<(u32, Vec<u8>), String> {
    let run = async {
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let wsl_path = std::path::Path::new(r"C:\Windows\System32\wsl.exe");
            if wsl_path.exists() {
                let mut cmd = tokio::process::Command::new(wsl_path);
                cmd.creation_flags(CREATE_NO_WINDOW);
                if let Some(distro) = extract_wsl_distro(&session_shell) {
                    cmd.args(["-d", &distro]);
                }
                cmd.args(["--", "sh", "-lc", &command]);
                cmd.output().await
            } else {
                let mut cmd = tokio::process::Command::new("cmd.exe");
                cmd.creation_flags(CREATE_NO_WINDOW);
                cmd.args(["/C", &command]);
                cmd.output().await
            }
        }
        #[cfg(not(windows))]
        {
            let _ = session_shell;
            let shell = resolve_shell(None);
            match tokio::process::Command::new(&shell)
                .arg("-lc")
                .arg(&command)
                .output()
                .await
            {
                Ok(out) => Ok(out),
                Err(_) => tokio::process::Command::new("/bin/sh")
                    .arg("-lc")
                    .arg(&command)
                    .output()
                    .await,
            }
        }
    };

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
