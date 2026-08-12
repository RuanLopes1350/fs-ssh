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
        /// `text` (legível) ou `cast` (asciinema v2, com timing).
        format: String,
        cols: u32,
        rows: u32,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Close,
}

/// Grava a saída do terminal, em um de dois formatos.
///
/// `text` remove as sequências de escape e produz um arquivo legível ("o que eu
/// rodei mesmo?"). `cast` é o asciinema v2: preserva tudo, com o tempo de cada
/// pedaço, e permite rever a sessão como ela aconteceu — que é o que auditoria
/// costuma exigir.
///
/// É público porque o terminal local usa exatamente a mesma gravação.
pub struct Recorder {
    file: Option<std::fs::File>,
    state: EscState,
    /// `true` quando o formato é asciinema.
    cast: bool,
    /// Marco zero dos tempos do `.cast`.
    started: Option<std::time::Instant>,
    /// Sobra de UTF-8 partido entre dois blocos do canal: emitir esses bytes
    /// isolados viraria "" no meio de um acento.
    pending: Vec<u8>,
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
            cast: false,
            started: None,
            pending: Vec::new(),
        }
    }

    /// Liga a gravação em `path` (fechando a anterior) ou desliga com `None`.
    pub fn set(
        &mut self,
        path: Option<String>,
        format: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(), String> {
        let Some(path) = path else {
            self.finish();
            return Ok(());
        };
        let cast = format == "cast";
        match Self::create_file(&path, cast, cols, rows) {
            Ok(file) => {
                self.finish();
                self.file = Some(file);
                self.state = EscState::Text;
                self.cast = cast;
                self.started = Some(std::time::Instant::now());
                self.pending.clear();
                tracing::info!("gravação de sessão iniciada em {path} ({format})");
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn create_file(
        path: &str,
        cast: bool,
        cols: u32,
        rows: u32,
    ) -> std::io::Result<std::fs::File> {
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
        if cast {
            // Cabeçalho do asciicast v2: uma linha de JSON, e depois um evento
            // por linha. Qualquer player de asciinema abre o arquivo.
            let header = serde_json::json!({
                "version": 2,
                "width": cols.max(1),
                "height": rows.max(1),
                "timestamp": chrono::Utc::now().timestamp(),
                "env": { "TERM": "xterm-256color" },
            });
            writeln!(file, "{header}")?;
        } else {
            writeln!(
                file,
                "── gravação iniciada em {} ──",
                chrono::Local::now().format("%d/%m/%Y %H:%M:%S")
            )?;
        }
        Ok(file)
    }

    pub fn write(&mut self, data: &[u8]) {
        if self.file.is_none() {
            return;
        }
        if self.cast {
            self.write_cast(data);
        } else {
            self.write_text(data);
        }
    }

    /// Um evento `[tempo, "o", texto]` por bloco recebido do canal.
    fn write_cast(&mut self, data: &[u8]) {
        use std::io::Write;

        let elapsed = self.started.map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0);
        self.pending.extend_from_slice(data);

        // Só a parte completa vira texto; o rabo de um caractere multibyte
        // espera o próximo bloco.
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid == 0 {
            return;
        }
        let chunk = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
        self.pending.drain(..valid);

        let line = serde_json::json!([elapsed, "o", chunk]);
        if let Some(file) = self.file.as_mut() {
            let _ = writeln!(file, "{line}");
        }
    }

    fn write_text(&mut self, data: &[u8]) {
        use std::io::Write;
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
        // No `.cast` o fim é o fim do arquivo: um rodapé em prosa quebraria o
        // formato para qualquer player.
        if !self.cast {
            let _ = writeln!(
                file,
                "\n── gravação encerrada em {} ──",
                chrono::Local::now().format("%d/%m/%Y %H:%M:%S")
            );
        }
        let _ = file.flush();
        self.file = None;
        self.pending.clear();
        self.started = None;
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
                Some(SessionCmd::Record { path, format, cols, rows, reply }) => {
                    let _ = reply.send(recorder.set(path, &format, cols, rows));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(ext: &str) -> String {
        std::env::temp_dir()
            .join(format!("fs-ssh-unit-{}.{ext}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn cast_sai_no_formato_do_asciinema() {
        let path = temp("cast");
        let mut r = Recorder::none();
        r.set(Some(path.clone()), "cast", 120, 40).unwrap();
        r.write(b"\x1b[32mok\x1b[0m\r\n");
        r.finish();

        let text = std::fs::read_to_string(&path).unwrap();
        let mut lines = text.lines();

        let header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(header["version"], 2);
        assert_eq!(header["width"], 120);
        assert_eq!(header["height"], 40);

        // Evento: [tempo, "o", texto] — com as sequências de escape preservadas,
        // que é o que distingue o replay do arquivo de texto.
        let event: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert!(event[0].as_f64().unwrap() >= 0.0);
        assert_eq!(event[1], "o");
        assert_eq!(event[2], "\u{1b}[32mok\u{1b}[0m\r\n");
        assert!(lines.next().is_none(), "o .cast não leva rodapé em prosa");

        let _ = std::fs::remove_file(path);
    }

    /// Um caractere multibyte partido entre dois blocos do canal não pode virar
    /// "" no arquivo: o resto espera o próximo pedaço.
    #[test]
    fn cast_espera_o_utf8_partido_entre_blocos() {
        let path = temp("cast");
        let mut r = Recorder::none();
        r.set(Some(path.clone()), "cast", 80, 24).unwrap();

        let ch = "ç".as_bytes(); // 2 bytes
        r.write(&[b'a', ch[0]]);
        r.write(&[ch[1], b'b']);
        r.finish();

        let text = std::fs::read_to_string(&path).unwrap();
        let chunks: Vec<String> = text
            .lines()
            .skip(1)
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .map(|v| v[2].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(chunks.concat(), "açb");
        assert!(!chunks.concat().contains('\u{fffd}'));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn texto_continua_sem_sequencias_de_escape() {
        let path = temp("log");
        let mut r = Recorder::none();
        r.set(Some(path.clone()), "text", 80, 24).unwrap();
        r.write(b"\x1b[32mok\x1b[0m\r\n\x1b]0;titulo\x07fim\n");
        r.finish();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("ok\nfim"), "saiu: {text:?}");
        assert!(!text.contains('\u{1b}'));

        let _ = std::fs::remove_file(path);
    }
}
