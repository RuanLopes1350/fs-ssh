pub mod connect;
pub mod handler;
pub mod hostkey;
pub mod session;
pub mod sftp;
pub mod socks;

use std::collections::HashMap;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::store::models::PortForward;
use handler::RemoteTargets;
use session::SessionCmd;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub connection_id: String,
    pub host: String,
    pub username: String,
    pub fingerprint: String,
    pub banner: Option<String>,
}

/// Um túnel ligado nesta sessão.
struct ActiveForward {
    kind: String,
    /// -L: task do listener local (abortada no stop); -R: nada a abortar aqui.
    task: Option<tokio::task::JoinHandle<()>>,
    bind_addr: String,
    /// Porta escutada: local (-L) ou remota (-R).
    port: u16,
}

pub struct SessionHandle {
    pub info: SessionInfo,
    tx: mpsc::Sender<SessionCmd>,
    /// Criado sob demanda no primeiro uso do painel de arquivos e reaproveitado
    /// depois — abrir o subsistema custa um round-trip.
    sftp: Mutex<Option<Arc<SftpSession>>>,
    /// Mapa consultado pelo handler para os canais de túnel reverso.
    remote_targets: RemoteTargets,
    /// Túneis ativos, por id da definição (`port_forwards.id`).
    forwards: Mutex<HashMap<String, ActiveForward>>,
    /// Caminho da gravação em andamento, se houver.
    recording: Mutex<Option<String>>,
}

impl SessionHandle {
    pub async fn send(&self, cmd: SessionCmd) -> AppResult<()> {
        self.tx
            .send(cmd)
            .await
            .map_err(|_| AppError::msg("sessão encerrada"))
    }

    /// Roda um comando num canal exec separado e espera a saída completa.
    pub async fn exec(&self, command: String) -> AppResult<(u32, Vec<u8>)> {
        let (tx, rx) = oneshot::channel();
        self.send(SessionCmd::Exec { command, reply: tx }).await?;
        rx.await
            .map_err(|_| AppError::msg("sessão encerrada durante o comando"))?
            .map_err(AppError::msg)
    }

    pub async fn sftp(&self) -> AppResult<Arc<SftpSession>> {
        let mut slot = self.sftp.lock().await;
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
        let (tx, rx) = oneshot::channel();
        self.send(SessionCmd::OpenSftp(tx)).await?;
        let sess = rx
            .await
            .map_err(|_| AppError::msg("sessão encerrada durante a abertura do SFTP"))?
            .map_err(AppError::Sftp)?;
        *slot = Some(sess.clone());
        Ok(sess)
    }

    // ------------------------------------------------------------ gravação

    pub async fn recording_path(&self) -> Option<String> {
        self.recording.lock().await.clone()
    }

    /// Liga a gravação em `path` ou desliga (`None`).
    pub async fn set_recording(&self, path: Option<String>) -> AppResult<()> {
        let mut slot = self.recording.lock().await;
        let (tx, rx) = oneshot::channel();
        self.send(SessionCmd::Record {
            path: path.clone(),
            reply: tx,
        })
        .await?;
        rx.await
            .map_err(|_| AppError::msg("sessão encerrada durante a gravação"))?
            .map_err(AppError::msg)?;
        *slot = path;
        Ok(())
    }

    // ------------------------------------------------------------- forwards

    pub async fn active_forward_ids(&self) -> Vec<String> {
        self.forwards.lock().await.keys().cloned().collect()
    }

    /// Liga um túnel (local ou reverso). Idempotente: já ativo é no-op.
    pub async fn start_forward(&self, f: &PortForward) -> AppResult<()> {
        let mut forwards = self.forwards.lock().await;
        if forwards.contains_key(&f.id) {
            return Ok(());
        }

        let active = match f.kind.as_str() {
            "local" => self.start_local(f).await?,
            "remote" => self.start_remote(f).await?,
            "dynamic" => self.start_dynamic(f).await?,
            other => return Err(AppError::msg(format!("tipo de túnel inválido: {other}"))),
        };
        forwards.insert(f.id.clone(), active);
        Ok(())
    }

    /// -L: escuta em `bind_addr:local_port`; cada conexão aceita vira um canal
    /// direct-tcpip até `remote_host:remote_port` via servidor.
    async fn start_local(&self, f: &PortForward) -> AppResult<ActiveForward> {
        let listener = tokio::net::TcpListener::bind((f.bind_addr.as_str(), f.local_port))
            .await
            .map_err(|e| {
                AppError::msg(format!(
                    "não deu para escutar em {}:{}: {e}",
                    f.bind_addr, f.local_port
                ))
            })?;

        let tx = self.tx.clone();
        let host = f.remote_host.clone();
        let port = f.remote_port as u32;
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let tx = tx.clone();
                let host = host.clone();
                tokio::spawn(async move {
                    let (otx, orx) = oneshot::channel();
                    if tx
                        .send(SessionCmd::OpenDirectTcpip {
                            host,
                            port,
                            reply: otx,
                        })
                        .await
                        .is_err()
                    {
                        return; // sessão morreu
                    }
                    let Ok(Ok(channel)) = orx.await else {
                        return; // servidor recusou (destino inacessível, política)
                    };
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                });
            }
        });

        Ok(ActiveForward {
            kind: f.kind.clone(),
            task: Some(task),
            bind_addr: f.bind_addr.clone(),
            port: f.local_port,
        })
    }

    /// -D: proxy SOCKS5 local. Cada conexão negocia o destino com o cliente e
    /// vira um canal direct-tcpip — o servidor SSH faz o papel de saída.
    async fn start_dynamic(&self, f: &PortForward) -> AppResult<ActiveForward> {
        let listener = tokio::net::TcpListener::bind((f.bind_addr.as_str(), f.local_port))
            .await
            .map_err(|e| {
                AppError::msg(format!(
                    "não deu para escutar em {}:{}: {e}",
                    f.bind_addr, f.local_port
                ))
            })?;

        let tx = self.tx.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let (host, port) = match socks::handshake(&mut sock).await {
                        Ok(target) => target,
                        Err(e) => {
                            tracing::debug!("handshake SOCKS falhou: {e}");
                            return;
                        }
                    };

                    let (otx, orx) = oneshot::channel();
                    if tx
                        .send(SessionCmd::OpenDirectTcpip {
                            host: host.clone(),
                            port: port as u32,
                            reply: otx,
                        })
                        .await
                        .is_err()
                    {
                        let _ = socks::reply(&mut sock, socks::REP_GENERAL_FAILURE).await;
                        return;
                    }

                    match orx.await {
                        Ok(Ok(channel)) => {
                            if socks::reply(&mut sock, socks::REP_OK).await.is_err() {
                                return;
                            }
                            let mut stream = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                        }
                        _ => {
                            tracing::debug!("SOCKS: servidor recusou {host}:{port}");
                            let _ = socks::reply(&mut sock, socks::REP_GENERAL_FAILURE).await;
                        }
                    }
                });
            }
        });

        Ok(ActiveForward {
            kind: f.kind.clone(),
            task: Some(task),
            bind_addr: f.bind_addr.clone(),
            port: f.local_port,
        })
    }

    /// -R: pede ao servidor para escutar em `local_port` e registra o destino
    /// local que o handler usa quando os canais chegarem.
    async fn start_remote(&self, f: &PortForward) -> AppResult<ActiveForward> {
        {
            let mut targets = self
                .remote_targets
                .write()
                .map_err(|_| AppError::msg("estado de túneis inconsistente"))?;
            if targets.contains_key(&(f.local_port as u32)) {
                return Err(AppError::msg(format!(
                    "porta remota {} já usada por outro túnel",
                    f.local_port
                )));
            }
            targets.insert(
                f.local_port as u32,
                (f.remote_host.clone(), f.remote_port),
            );
        }

        let (otx, orx) = oneshot::channel();
        let sent = self
            .send(SessionCmd::TcpipForward {
                address: f.bind_addr.clone(),
                port: f.local_port as u32,
                register: true,
                reply: otx,
            })
            .await;
        let result = match sent {
            Ok(()) => orx
                .await
                .map_err(|_| AppError::msg("sessão encerrada durante o pedido de túnel"))?
                .map_err(|e| AppError::msg(format!("servidor recusou o túnel reverso: {e}"))),
            Err(e) => Err(e),
        };

        if result.is_err() {
            if let Ok(mut targets) = self.remote_targets.write() {
                targets.remove(&(f.local_port as u32));
            }
        }
        result?;

        Ok(ActiveForward {
            kind: f.kind.clone(),
            task: None,
            bind_addr: f.bind_addr.clone(),
            port: f.local_port,
        })
    }

    pub async fn stop_forward(&self, forward_id: &str) -> AppResult<()> {
        let Some(active) = self.forwards.lock().await.remove(forward_id) else {
            return Ok(());
        };
        if let Some(task) = active.task {
            task.abort(); // derruba o listener; conexões em voo terminam sozinhas
        }
        if active.kind == "remote" {
            if let Ok(mut targets) = self.remote_targets.write() {
                targets.remove(&(active.port as u32));
            }
            let (otx, _orx) = oneshot::channel();
            let _ = self
                .send(SessionCmd::TcpipForward {
                    address: active.bind_addr,
                    port: active.port as u32,
                    register: false,
                    reply: otx,
                })
                .await;
        }
        Ok(())
    }

    /// Chamado quando a sessão morre: sem isso os listeners locais ficariam
    /// escutando portas de uma sessão que não existe mais.
    pub async fn abort_all_forwards(&self) {
        let mut forwards = self.forwards.lock().await;
        for (_, active) in forwards.drain() {
            if let Some(task) = active.task {
                task.abort();
            }
        }
        if let Ok(mut targets) = self.remote_targets.write() {
            targets.clear();
        }
    }
}

#[derive(Default)]
pub struct SessionManager {
    map: RwLock<HashMap<String, Arc<SessionHandle>>>,
}

impl SessionManager {
    pub fn new_id() -> String {
        Uuid::new_v4().to_string()
    }

    pub async fn insert(
        &self,
        info: SessionInfo,
        tx: mpsc::Sender<SessionCmd>,
        remote_targets: RemoteTargets,
    ) -> Arc<SessionHandle> {
        let handle = Arc::new(SessionHandle {
            info: info.clone(),
            tx,
            sftp: Mutex::new(None),
            remote_targets,
            forwards: Mutex::new(HashMap::new()),
            recording: Mutex::new(None),
        });
        self.map
            .write()
            .await
            .insert(info.session_id.clone(), handle.clone());
        handle
    }

    pub async fn get(&self, id: &str) -> AppResult<Arc<SessionHandle>> {
        self.map
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NoSession(id.to_string()))
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<SessionHandle>> {
        self.map.write().await.remove(id)
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        self.map
            .read()
            .await
            .values()
            .map(|h| h.info.clone())
            .collect()
    }
}
