//! Configuração de rede do host da sessão (IP, máscara, gateway, DNS).
//!
//! Tudo sai de um único `exec` — nada instalado no servidor, nada digitado no
//! terminal do usuário. O script só coleta; a normalização é aqui, em Rust,
//! onde dá para testar cada formato de saída sem um host de verdade.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};

use tauri::State;

use super::AppState;
use crate::error::{AppError, AppResult};

/// Coletor. Divide a saída em seções (`##NOME`) para o parser não ter que
/// adivinhar de qual comando veio cada linha.
///
/// `ip -o addr` sozinho não serve: com `-o` ele só imprime os endereços, sem a
/// linha de link — MAC, flags e as interfaces sem endereço ficariam de fora.
/// Por isso o `ip -o link` vem junto, na mesma seção.
///
/// `/sbin` e `/usr/sbin` entram no PATH porque em Debian/Ubuntu o `ip` mora em
/// `/usr/sbin` e um usuário comum não o tem no PATH de um shell não interativo
/// — sem isso o painel ficaria vazio justamente nos servidores mais comuns.
const NET_SCRIPT: &str = r#"PATH="$PATH:/sbin:/usr/sbin"; export PATH
echo '##HOST'
hostname 2>/dev/null || uname -n 2>/dev/null
if command -v ip >/dev/null 2>&1; then
  echo '##IPADDR'
  ip -o link show 2>/dev/null
  ip -o addr show 2>/dev/null
  echo '##IPROUTE'
  ip route show default 2>/dev/null
else
  echo '##IFCONFIG'
  ifconfig -a 2>/dev/null
  echo '##BSDROUTE'
  netstat -rn -f inet 2>/dev/null
fi
echo '##RESOLV'
cat /etc/resolv.conf 2>/dev/null
if command -v resolvectl >/dev/null 2>&1; then
  echo '##RESOLVECTL'
  resolvectl dns 2>/dev/null
  resolvectl domain 2>/dev/null
fi
if command -v scutil >/dev/null 2>&1; then
  echo '##SCUTIL'
  scutil --dns 2>/dev/null
fi
exit 0"#;

#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetAddr {
    pub addr: String,
    pub prefix: u8,
    /// Máscara decimal — só IPv4; em IPv6 fica vazia (lá só o prefixo se usa).
    pub netmask: String,
}

#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetInterface {
    pub name: String,
    pub mac: String,
    /// Interface administrativamente ativa (flag `UP`).
    pub up: bool,
    pub ipv4: Vec<NetAddr>,
    pub ipv6: Vec<NetAddr>,
}

#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetRoute {
    pub gateway: String,
    /// Interface por onde a rota sai; vazio quando o sistema não informa.
    pub iface: String,
}

#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetInfo {
    pub hostname: String,
    pub interfaces: Vec<NetInterface>,
    /// Rotas padrão (`default`) — normalmente uma só.
    pub gateways: Vec<NetRoute>,
    pub dns: Vec<String>,
    /// Domínios de busca (`search`/`domain` do resolv.conf).
    pub search: Vec<String>,
}

/// Lê a configuração de rede do host da sessão (SSH ou terminal local).
#[tauri::command]
pub async fn net_info(state: State<'_, AppState>, session_id: String) -> AppResult<NetInfo> {
    let handle = state.sessions.get(&session_id).await?;
    let (_exit_code, out) = handle.exec(NET_SCRIPT.to_string()).await?;
    let info = parse_net_info(&String::from_utf8_lossy(&out));

    // Código de saída não serve de critério: o script termina em `exit 0` de
    // propósito, porque cada coletor pode faltar sem que isso seja erro. O que
    // é erro é não ter sobrado nada para mostrar.
    if info.interfaces.is_empty() && info.gateways.is_empty() && info.dns.is_empty() {
        return Err(AppError::msg(
            "não deu para ler a configuração de rede deste host (sem `ip` nem `ifconfig`)",
        ));
    }
    Ok(info)
}

// ------------------------------------------------------------------- parsing

/// Quebra a saída nas marcas `##NOME`. Linhas antes da primeira marca são
/// descartadas (banner de login, `motd` e afins caem aí).
fn sections(text: &str) -> HashMap<&str, String> {
    let mut map: HashMap<&str, String> = HashMap::new();
    let mut current: Option<&str> = None;
    for line in text.lines() {
        if let Some(name) = line.trim().strip_prefix("##") {
            current = Some(name);
            map.entry(name).or_default();
        } else if let Some(name) = current {
            let buf = map.entry(name).or_default();
            buf.push_str(line);
            buf.push('\n');
        }
    }
    map
}

fn parse_net_info(text: &str) -> NetInfo {
    let s = sections(text);
    let get = |k: &str| s.get(k).map(String::as_str).unwrap_or_default();

    let mut interfaces = if s.contains_key("IPADDR") {
        parse_ip_addr(get("IPADDR"))
    } else {
        parse_ifconfig(get("IFCONFIG"))
    };
    // O que interessa primeiro é a interface que carrega o IP da máquina; veth
    // de container e loopback vão para o fim da lista.
    interfaces.sort_by_key(iface_rank);

    let gateways = if s.contains_key("IPROUTE") {
        parse_ip_route(get("IPROUTE"))
    } else {
        parse_netstat(get("BSDROUTE"))
    };

    let (mut dns, mut search) = parse_resolv(get("RESOLV"));

    // Com systemd-resolved o resolv.conf só aponta para o stub em 127.0.0.53:
    // mostrar isso seria tecnicamente correto e inútil. Quem responde de fato
    // está no `resolvectl`. Em macOS, o `scutil` faz esse papel.
    if dns.iter().all(|d| is_loopback(d)) {
        let (rdns, rsearch) = parse_resolvectl(get("RESOLVECTL"));
        let (sdns, ssearch) = parse_scutil(get("SCUTIL"));
        let (fallback_dns, fallback_search) = if rdns.is_empty() {
            (sdns, ssearch)
        } else {
            (rdns, rsearch)
        };
        if !fallback_dns.is_empty() {
            dns = fallback_dns;
        }
        for d in fallback_search {
            push_unique(&mut search, d);
        }
    }

    let hostname = get("HOST")
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .to_string();

    NetInfo {
        hostname,
        interfaces,
        gateways,
        dns,
        search,
    }
}

/// Ordem de exibição: IPv4 de verdade, depois só-IPv6, depois sem endereço,
/// loopback por último.
fn iface_rank(i: &NetInterface) -> u8 {
    let loopback = i.ipv4.iter().any(|a| is_loopback(&a.addr))
        || i.ipv6.iter().any(|a| is_loopback(&a.addr));
    if loopback {
        3
    } else if !i.ipv4.is_empty() {
        0
    } else if !i.ipv6.is_empty() {
        1
    } else {
        2
    }
}

/// `ip -o addr show`: cada registro numa linha só — o de link traz MAC e flags,
/// os de endereço trazem `inet`/`inet6`.
fn parse_ip_addr(text: &str) -> Vec<NetInterface> {
    let mut out: Vec<NetInterface> = Vec::new();

    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // "2: eth0: <...>" (link) ou "2: eth0 inet ..." (endereço)
        let Some(second) = tokens.get(1) else {
            continue;
        };
        let is_link = second.ends_with(':');
        // VLAN e macvlan aparecem como "eth0.100@eth0:" na linha de link e como
        // "eth0.100" na de endereço: sem cortar o "@pai" seriam duas interfaces.
        let name = second.trim_end_matches(':');
        let name = name.split('@').next().unwrap_or(name);
        if name.is_empty() {
            continue;
        }

        let idx = match out.iter().position(|i| i.name == name) {
            Some(i) => i,
            None => {
                out.push(NetInterface {
                    name: name.to_string(),
                    ..Default::default()
                });
                out.len() - 1
            }
        };
        let iface = &mut out[idx];

        if is_link {
            iface.up = has_up_flag(line);
            if let Some(p) = tokens.iter().position(|t| t.starts_with("link/")) {
                if let Some(mac) = tokens.get(p + 1) {
                    // Loopback e túneis põem "00:00:00:00:00:00", "0.0.0.0" ou
                    // "::" nesse lugar — nada disso é MAC para mostrar.
                    if is_mac(mac) {
                        iface.mac = mac.to_string();
                    }
                }
            }
            continue;
        }

        for (i, tok) in tokens.iter().enumerate() {
            match *tok {
                "inet" => {
                    if let Some(a) = tokens.get(i + 1).and_then(|v| addr_with_prefix(v, 32)) {
                        iface.ipv4.push(a);
                    }
                }
                "inet6" => {
                    if let Some(a) = tokens.get(i + 1).and_then(|v| addr_with_prefix(v, 128)) {
                        iface.ipv6.push(a);
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// `ifconfig -a` (macOS/BSD e net-tools moderno): cabeçalho sem recuo abre a
/// interface, linhas recuadas trazem `ether`/`inet`/`inet6`.
fn parse_ifconfig(text: &str) -> Vec<NetInterface> {
    let mut out: Vec<NetInterface> = Vec::new();

    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        if !line.starts_with([' ', '\t']) {
            let Some((name, rest)) = line.split_once(':') else {
                continue;
            };
            out.push(NetInterface {
                name: name.trim().to_string(),
                up: has_up_flag(rest),
                ..Default::default()
            });
            continue;
        }

        let Some(iface) = out.last_mut() else {
            continue;
        };
        let tokens: Vec<&str> = line.split_whitespace().collect();
        match tokens.first().copied() {
            Some("ether") | Some("lladdr") => {
                if let Some(mac) = tokens.get(1).filter(|m| is_mac(m)) {
                    iface.mac = mac.to_string();
                }
            }
            Some("inet") => {
                let Some(addr) = tokens.get(1) else { continue };
                // A máscara vem em hexa no BSD ("0xffffff00") e em decimal no
                // net-tools ("255.255.255.0").
                let prefix = tokens
                    .iter()
                    .position(|t| *t == "netmask")
                    .and_then(|p| tokens.get(p + 1))
                    .and_then(|m| mask_to_prefix(m))
                    .unwrap_or(32);
                iface.ipv4.push(make_addr(addr, prefix, true));
            }
            Some("inet6") => {
                let Some(addr) = tokens.get(1) else { continue };
                let prefix = tokens
                    .iter()
                    .position(|t| *t == "prefixlen")
                    .and_then(|p| tokens.get(p + 1))
                    .and_then(|v| v.parse::<u8>().ok())
                    .unwrap_or(128);
                // "fe80::1%en0" — o escopo é ruído para quem só quer o endereço.
                let addr = addr.split('%').next().unwrap_or(addr);
                iface.ipv6.push(make_addr(addr, prefix, false));
            }
            _ => {}
        }
    }
    out
}

/// `ip route show default` — inclusive o caso multipath, com `nexthop` por linha.
fn parse_ip_route(text: &str) -> Vec<NetRoute> {
    let mut out = Vec::new();
    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(p) = tokens.iter().position(|t| *t == "via") else {
            continue;
        };
        let Some(gateway) = tokens.get(p + 1) else {
            continue;
        };
        if gateway.parse::<IpAddr>().is_err() {
            continue;
        }
        let iface = tokens
            .iter()
            .position(|t| *t == "dev")
            .and_then(|p| tokens.get(p + 1))
            .copied()
            .unwrap_or_default();
        out.push(NetRoute {
            gateway: gateway.to_string(),
            iface: iface.to_string(),
        });
    }
    out
}

/// `netstat -rn -f inet` (macOS/BSD): colunas Destination, Gateway, Flags, Netif.
fn parse_netstat(text: &str) -> Vec<NetRoute> {
    let mut out = Vec::new();
    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.first().copied() != Some("default") {
            continue;
        }
        let Some(gateway) = tokens.get(1) else {
            continue;
        };
        // Rota default por link ("link#12") não tem gateway para mostrar.
        if gateway.parse::<IpAddr>().is_err() {
            continue;
        }
        out.push(NetRoute {
            gateway: gateway.to_string(),
            iface: tokens.get(3).copied().unwrap_or_default().to_string(),
        });
    }
    out
}

/// `/etc/resolv.conf` → (nameservers, domínios de busca).
fn parse_resolv(text: &str) -> (Vec<String>, Vec<String>) {
    let (mut dns, mut search) = (Vec::new(), Vec::new());
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or(line).trim();
        let mut tokens = line.split_whitespace();
        match tokens.next() {
            Some("nameserver") => {
                if let Some(v) = tokens.next() {
                    if v.parse::<IpAddr>().is_ok() {
                        push_unique(&mut dns, v.to_string());
                    }
                }
            }
            Some("search") | Some("domain") => {
                for v in tokens {
                    push_unique(&mut search, v.to_string());
                }
            }
            _ => {}
        }
    }
    (dns, search)
}

/// `resolvectl dns` + `resolvectl domain`: as duas saídas são "Link N (iface):
/// valores", então o que separa DNS de domínio é o valor parsear como IP.
fn parse_resolvectl(text: &str) -> (Vec<String>, Vec<String>) {
    let (mut dns, mut search) = (Vec::new(), Vec::new());
    for line in text.lines() {
        let Some((_, values)) = line.rsplit_once(':') else {
            continue;
        };
        for v in values.split_whitespace() {
            if v.parse::<IpAddr>().is_ok() {
                push_unique(&mut dns, v.to_string());
            } else if v != "~." && !v.starts_with('~') && v.contains('.') {
                push_unique(&mut search, v.to_string());
            }
        }
    }
    (dns, search)
}

/// `scutil --dns`: linhas "nameserver[0] : 8.8.8.8" e "search domain[0] : x".
fn parse_scutil(text: &str) -> (Vec<String>, Vec<String>) {
    let (mut dns, mut search) = (Vec::new(), Vec::new());
    for line in text.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if key.starts_with("nameserver[") {
            if value.parse::<IpAddr>().is_ok() {
                push_unique(&mut dns, value.to_string());
            }
        } else if key.starts_with("search domain[") || key.starts_with("domain[") {
            push_unique(&mut search, value.to_string());
        }
    }
    (dns, search)
}

// -------------------------------------------------------------------- helpers

/// "192.168.0.10/24" → endereço + prefixo (e máscara, quando IPv4).
fn addr_with_prefix(value: &str, default_prefix: u8) -> Option<NetAddr> {
    let (addr, prefix) = match value.split_once('/') {
        Some((a, p)) => (a, p.parse::<u8>().ok()?),
        None => (value, default_prefix),
    };
    let addr = addr.split('%').next().unwrap_or(addr);
    addr.parse::<IpAddr>().ok()?;
    Some(make_addr(addr, prefix, default_prefix == 32))
}

fn make_addr(addr: &str, prefix: u8, v4: bool) -> NetAddr {
    NetAddr {
        addr: addr.to_string(),
        prefix,
        netmask: if v4 { prefix_to_mask(prefix) } else { String::new() },
    }
}

/// 24 → "255.255.255.0".
fn prefix_to_mask(prefix: u8) -> String {
    if prefix == 0 {
        return Ipv4Addr::UNSPECIFIED.to_string();
    }
    if prefix > 32 {
        return String::new();
    }
    Ipv4Addr::from(u32::MAX << (32 - prefix as u32)).to_string()
}

/// "0xffffff00" ou "255.255.255.0" → 24.
fn mask_to_prefix(mask: &str) -> Option<u8> {
    let bits = match mask.strip_prefix("0x").or_else(|| mask.strip_prefix("0X")) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => u32::from(mask.parse::<Ipv4Addr>().ok()?),
    };
    Some(bits.count_ones() as u8)
}

/// A flag `UP` dentro do `<...>` do `ip`/`ifconfig`. Comparação por token, e não
/// por substring: `LOWER_UP` e `NO-CARRIER` não podem passar por "ligada".
fn has_up_flag(line: &str) -> bool {
    let Some(start) = line.find('<') else {
        return false;
    };
    let Some(len) = line[start..].find('>') else {
        return false;
    };
    line[start + 1..start + len].split(',').any(|f| f == "UP")
}

/// Seis pares hexa separados por `:`, e não todos zerados.
fn is_mac(value: &str) -> bool {
    let parts: Vec<&str> = value.split(':').collect();
    parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit()))
        && value != "00:00:00:00:00:00"
}

fn is_loopback(addr: &str) -> bool {
    addr.parse::<IpAddr>().map(|a| a.is_loopback()).unwrap_or(false)
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !value.is_empty() && !list.contains(&value) {
        list.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX: &str = r#"##HOST
web-01
##IPADDR
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000\    link/ether 52:54:00:a1:b2:c3 brd ff:ff:ff:ff:ff:ff
3: docker0: <NO-CARRIER,BROADCAST,MULTICAST> mtu 1500 qdisc noqueue state DOWN mode DEFAULT group default \    link/ether 02:42:9c:11:22:33 brd ff:ff:ff:ff:ff:ff
4: sit0@NONE: <NOARP> mtu 1480 qdisc noop state DOWN mode DEFAULT group default qlen 1000\    link/sit 0.0.0.0 brd 0.0.0.0
5: eth0.100@eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\    link/ether 52:54:00:a1:b2:c3 brd ff:ff:ff:ff:ff:ff
1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever
2: eth0    inet 192.168.15.42/24 brd 192.168.15.255 scope global dynamic eth0\       valid_lft 84539sec preferred_lft 84539sec
2: eth0    inet6 fe80::5054:ff:fea1:b2c3/64 scope link \       valid_lft forever preferred_lft forever
5: eth0.100    inet 10.20.30.40/28 brd 10.20.30.47 scope global eth0.100\       valid_lft forever preferred_lft forever
##IPROUTE
default via 192.168.15.1 dev eth0 proto dhcp src 192.168.15.42 metric 100
##RESOLV
nameserver 127.0.0.53
options edns0 trust-ad
search lan
##RESOLVECTL
Global:
Link 2 (eth0): 192.168.15.1 1.1.1.1
Link 2 (eth0): lan ~.
"#;

    const MACOS: &str = r#"##HOST
mbp.local
##IFCONFIG
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	ether 3c:22:fb:44:55:66
	inet6 fe80::1c:2d:3e:4f%en0 prefixlen 64 secured scopeid 0xa
	inet 192.168.0.23 netmask 0xffffff00 broadcast 192.168.0.255
	status: active
en5: flags=8802<BROADCAST,SIMPLEX,MULTICAST> mtu 1500
	ether 12:34:56:78:9a:bc
##BSDROUTE
Routing tables

Internet:
Destination        Gateway            Flags           Netif Expire
default            192.168.0.1        UGScg             en0
127                127.0.0.1          UCS               lo0
##RESOLV
nameserver 192.168.0.1
search home.arpa
"#;

    #[test]
    fn le_saida_do_linux() {
        let info = parse_net_info(LINUX);
        assert_eq!(info.hostname, "web-01");

        // Quem tem endereço vem primeiro; sem endereço no meio; lo por último.
        let names: Vec<&str> = info.interfaces.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["eth0", "eth0.100", "docker0", "sit0", "lo"]);

        // A VLAN aparece como "eth0.100@eth0" no link e "eth0.100" no endereço:
        // é uma interface só, com a máscara /28 traduzida.
        let vlan = &info.interfaces[1];
        assert_eq!(vlan.ipv4[0].netmask, "255.255.255.240");
        assert_eq!(info.interfaces[3].mac, ""); // "link/sit 0.0.0.0" não é MAC

        let eth0 = &info.interfaces[0];
        assert!(eth0.up);
        assert_eq!(eth0.mac, "52:54:00:a1:b2:c3");
        assert_eq!(eth0.ipv4[0].addr, "192.168.15.42");
        assert_eq!(eth0.ipv4[0].prefix, 24);
        assert_eq!(eth0.ipv4[0].netmask, "255.255.255.0");
        assert_eq!(eth0.ipv6[0].addr, "fe80::5054:ff:fea1:b2c3");
        assert_eq!(eth0.ipv6[0].netmask, "");

        assert!(!info.interfaces[2].up); // docker0 está DOWN
        assert_eq!(info.interfaces[4].mac, ""); // MAC zerado do loopback não vai para a tela

        assert_eq!(info.gateways[0].gateway, "192.168.15.1");
        assert_eq!(info.gateways[0].iface, "eth0");

        // O stub do systemd-resolved dá lugar a quem responde de verdade.
        assert_eq!(info.dns, ["192.168.15.1", "1.1.1.1"]);
        assert_eq!(info.search, ["lan"]);
    }

    #[test]
    fn le_saida_do_macos() {
        let info = parse_net_info(MACOS);
        assert_eq!(info.hostname, "mbp.local");

        let names: Vec<&str> = info.interfaces.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["en0", "en5", "lo0"]);

        let en0 = &info.interfaces[0];
        assert!(en0.up);
        assert_eq!(en0.mac, "3c:22:fb:44:55:66");
        assert_eq!(en0.ipv4[0].addr, "192.168.0.23");
        assert_eq!(en0.ipv4[0].netmask, "255.255.255.0");
        assert_eq!(en0.ipv6[0].addr, "fe80::1c:2d:3e:4f"); // sem o escopo %en0
        assert_eq!(en0.ipv6[0].prefix, 64);

        assert!(!info.interfaces[1].up); // en5 sem a flag UP
        assert_eq!(info.gateways, [NetRoute { gateway: "192.168.0.1".into(), iface: "en0".into() }]);
        assert_eq!(info.dns, ["192.168.0.1"]);
        assert_eq!(info.search, ["home.arpa"]);
    }

    #[test]
    fn host_sem_ip_nem_ifconfig_nao_inventa_nada() {
        let info = parse_net_info("##HOST\nbusybox\n##IFCONFIG\n##BSDROUTE\n##RESOLV\n");
        assert_eq!(info.hostname, "busybox");
        assert!(info.interfaces.is_empty() && info.gateways.is_empty() && info.dns.is_empty());
    }

    #[test]
    fn banner_de_login_antes_da_primeira_marca_e_ignorado() {
        let info = parse_net_info("Welcome to Ubuntu 24.04\nLast login: qui\n##HOST\nweb-01\n");
        assert_eq!(info.hostname, "web-01");
    }

    #[test]
    fn scutil_entra_quando_o_resolv_conf_so_tem_loopback() {
        let text = "##RESOLV\nnameserver 127.0.0.1\n##SCUTIL\nresolver #1\n  search domain[0] : corp.local\n  nameserver[0] : 10.0.0.53\n  nameserver[1] : 10.0.0.54\n";
        let info = parse_net_info(text);
        assert_eq!(info.dns, ["10.0.0.53", "10.0.0.54"]);
        assert_eq!(info.search, ["corp.local"]);
    }

    #[test]
    fn mascaras_vao_e_voltam() {
        assert_eq!(prefix_to_mask(24), "255.255.255.0");
        assert_eq!(prefix_to_mask(32), "255.255.255.255");
        assert_eq!(prefix_to_mask(0), "0.0.0.0");
        assert_eq!(mask_to_prefix("0xffffff00"), Some(24));
        assert_eq!(mask_to_prefix("255.255.240.0"), Some(20));
        assert_eq!(mask_to_prefix("nada"), None);
    }
}
