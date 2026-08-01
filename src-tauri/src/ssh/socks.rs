//! Proxy SOCKS5 mínimo para o túnel dinâmico (`ssh -D`).
//!
//! Só o necessário para navegador/curl: método "sem autenticação" e comando
//! CONNECT. BIND e UDP ASSOCIATE são recusados — nenhum cliente comum usa e
//! implementá-los abriria caminhos que este app não precisa expor.

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const VER: u8 = 0x05;
const NO_AUTH: u8 = 0x00;
const CMD_CONNECT: u8 = 0x01;

const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

pub const REP_OK: u8 = 0x00;
pub const REP_GENERAL_FAILURE: u8 = 0x01;
pub const REP_CMD_NOT_SUPPORTED: u8 = 0x07;
pub const REP_ATYP_NOT_SUPPORTED: u8 = 0x08;

/// Negocia o handshake e devolve o destino pedido pelo cliente.
pub async fn handshake<S>(sock: &mut S) -> std::io::Result<(String, u16)>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    // Seleção de método: VER | NMETHODS | METHODS...
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != VER {
        return Err(invalid("versão SOCKS não suportada"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await?;
    if !methods.contains(&NO_AUTH) {
        sock.write_all(&[VER, 0xff]).await?; // nenhum método aceitável
        return Err(invalid("cliente SOCKS exige autenticação"));
    }
    sock.write_all(&[VER, NO_AUTH]).await?;

    // Requisição: VER | CMD | RSV | ATYP | ADDR | PORT
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    if req[0] != VER {
        return Err(invalid("versão SOCKS não suportada"));
    }
    if req[1] != CMD_CONNECT {
        reply(sock, REP_CMD_NOT_SUPPORTED).await?;
        return Err(invalid("apenas CONNECT é suportado"));
    }

    let host = match req[3] {
        ATYP_IPV4 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        ATYP_IPV6 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            sock.read_exact(&mut name).await?;
            String::from_utf8(name).map_err(|_| invalid("domínio inválido"))?
        }
        _ => {
            reply(sock, REP_ATYP_NOT_SUPPORTED).await?;
            return Err(invalid("tipo de endereço não suportado"));
        }
    };

    let mut port = [0u8; 2];
    sock.read_exact(&mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}

/// Resposta ao CONNECT. O endereço de bind vai zerado: o cliente não usa esse
/// campo em CONNECT, e não temos o endereço real do lado do servidor SSH.
pub async fn reply<S>(sock: &mut S, code: u8) -> std::io::Result<()>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    sock.write_all(&[VER, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
        .await
}

fn invalid(msg: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg.to_string())
}
