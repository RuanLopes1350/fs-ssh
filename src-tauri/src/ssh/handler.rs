use std::collections::HashMap;
use std::sync::Arc;

use russh::client::{ChannelOpenHandle, Handler, Msg, Session};
use russh::keys::ssh_key;
use russh::{Channel, ChannelId, ChannelOpenFailure};

use super::hostkey::HostKeyVerifier;

/// Destinos dos túneis reversos (-R) ativos, por porta remota exposta.
///
/// Preenchido pelo `SessionHandle` quando um forward reverso é ligado; o
/// handler consulta aqui para saber a quem entregar cada canal que o servidor
/// abre. Porta que não está no mapa é recusada — o servidor não pode empurrar
/// conexões que o usuário não pediu.
pub type RemoteTargets = Arc<std::sync::RwLock<HashMap<u32, (String, u16)>>>;

/// Handler do cliente russh.
///
/// Verifica a host key e atende canais de túnel reverso. Todo o resto (dados
/// do canal da sessão) é consumido pelo `Channel` do lado do chamador, não por
/// callbacks — por isso `data()` não é sobrescrito aqui.
pub struct ClientHandler {
    pub verifier: Arc<HostKeyVerifier>,
    pub banner: Arc<std::sync::Mutex<Option<String>>>,
    pub remote_targets: RemoteTargets,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(self.verifier.check(server_public_key))
    }

    async fn auth_banner(&mut self, banner: &str, _s: &mut Session) -> Result<(), Self::Error> {
        if let Ok(mut b) = self.banner.lock() {
            *b = Some(banner.to_string());
        }
        Ok(())
    }

    async fn channel_open_confirmation(
        &mut self,
        _id: ChannelId,
        _max_packet_size: u32,
        _window_size: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    /// Conexão entrando por um túnel reverso (-R): o servidor abre um canal e
    /// nós o ligamos ao destino local registrado para aquela porta.
    #[allow(clippy::too_many_arguments)]
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let target = self
            .remote_targets
            .read()
            .ok()
            .and_then(|m| m.get(&connected_port).cloned());

        let Some((host, port)) = target else {
            tracing::warn!(
                "canal reverso recusado: porta {connected_port} ({connected_address}) sem túnel registrado"
            );
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };

        reply.accept().await;
        tracing::debug!(
            "túnel -R: {originator_address}:{originator_port} → {host}:{port} (porta remota {connected_port})"
        );
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((host.as_str(), port)).await {
                Ok(mut sock) => {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                }
                Err(e) => {
                    tracing::warn!("túnel -R: destino {host}:{port} inacessível: {e}");
                    let _ = channel.close().await;
                }
            }
        });
        Ok(())
    }
}
