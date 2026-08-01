use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// Uma entrada de `~/.ssh/config` já resolvida, pronta para virar conexão.
/// Trafega nos dois sentidos: sai em `sshconfig_read` e volta em `sshconfig_import`
/// com a seleção do usuário.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub forward_agent: bool,
}

/// Parser do `~/.ssh/config`.
///
/// Cobre o que interessa para importar conexões: blocos `Host`, as diretivas
/// mais usadas, e herança do bloco `Host *`. Blocos com wildcard não viram
/// conexões (não são hosts reais), mas seus valores servem de default.
pub fn parse(text: &str) -> Vec<SshConfigHost> {
    let mut defaults: HashMap<String, String> = HashMap::new();
    let mut blocks: Vec<(Vec<String>, HashMap<String, String>)> = Vec::new();
    let mut current: Option<(Vec<String>, HashMap<String, String>)> = None;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Aceita tanto `Key value` quanto `Key=value`.
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.trim().to_lowercase(), v.trim_start_matches('=').trim()),
            None => continue,
        };

        if key == "host" {
            if let Some(block) = current.take() {
                blocks.push(block);
            }
            let patterns: Vec<String> = value.split_whitespace().map(str::to_string).collect();
            current = Some((patterns, HashMap::new()));
            continue;
        }

        // `Match` muda o escopo de forma que não modelamos; fecha o bloco atual
        // para não atribuir diretivas ao Host errado.
        if key == "match" {
            if let Some(block) = current.take() {
                blocks.push(block);
            }
            continue;
        }

        match current.as_mut() {
            Some((_, map)) => {
                map.insert(key, value.to_string());
            }
            None => {
                defaults.insert(key, value.to_string());
            }
        }
    }
    if let Some(block) = current.take() {
        blocks.push(block);
    }

    // Valores de `Host *` valem como default para todo mundo.
    let wildcard: HashMap<String, String> = blocks
        .iter()
        .filter(|(pats, _)| pats.iter().any(|p| p == "*"))
        .flat_map(|(_, map)| map.clone())
        .collect();

    let mut out = Vec::new();
    for (patterns, map) in &blocks {
        for alias in patterns {
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                continue;
            }
            let get = |k: &str| -> Option<String> {
                map.get(k)
                    .or_else(|| wildcard.get(k))
                    .or_else(|| defaults.get(k))
                    .cloned()
            };
            out.push(SshConfigHost {
                hostname: get("hostname").unwrap_or_else(|| alias.clone()),
                alias: alias.clone(),
                user: get("user"),
                port: get("port").and_then(|p| p.parse().ok()),
                identity_file: get("identityfile").map(expand_tilde),
                proxy_jump: get("proxyjump"),
                forward_agent: get("forwardagent")
                    .map(|v| v.eq_ignore_ascii_case("yes"))
                    .unwrap_or(false),
            });
        }
    }
    out
}

pub fn load() -> AppResult<Vec<SshConfigHost>> {
    let path = super::ssh_dir()?.join("config");
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(parse(&text)),
        Err(_) => Ok(Vec::new()),
    }
}

fn expand_tilde(p: String) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_block() {
        let hosts = parse(
            "Host prod\n  HostName 10.0.0.1\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "prod");
        assert_eq!(hosts[0].hostname, "10.0.0.1");
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
        assert_eq!(hosts[0].port, Some(2222));
        assert!(hosts[0].identity_file.as_ref().unwrap().ends_with("id_ed25519"));
    }

    #[test]
    fn wildcard_is_default_not_a_host() {
        let hosts = parse("Host *\n  User root\n\nHost web\n  HostName web.example.com\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "web");
        assert_eq!(hosts[0].user.as_deref(), Some("root"));
    }

    #[test]
    fn own_value_wins_over_wildcard() {
        let hosts = parse("Host *\n  User root\n\nHost web\n  User deploy\n");
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
    }

    #[test]
    fn multiple_aliases_in_one_block() {
        let hosts = parse("Host a b\n  HostName shared.example.com\n");
        assert_eq!(hosts.len(), 2);
        assert!(hosts.iter().all(|h| h.hostname == "shared.example.com"));
    }

    #[test]
    fn accepts_equals_syntax_and_comments() {
        let hosts = parse("# comentário\nHost gw\nHostName=192.168.0.1\nProxyJump=bastion\n");
        assert_eq!(hosts[0].hostname, "192.168.0.1");
        assert_eq!(hosts[0].proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn match_block_does_not_leak_into_previous_host() {
        let hosts = parse("Host web\n  User deploy\n\nMatch host bastion\n  User root\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
    }
}
