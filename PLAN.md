# fs-ssh — Cliente SSH/SFTP em Tauri

## Contexto

Não existe nada em `/Users/marco/projects/competicoes/fs-ssh` — projeto do zero.

O objetivo é um cliente SSH + SFTP de desktop com gestão de conexões de primeira classe:
host (IP/DNS), escolha de chave, tags para organização, e customização visual
(tema de cores + ícone) por conexão. O diferencial pretendido não é "mais um terminal",
e sim **identidade visual por servidor** — cor e ícone que atravessam sidebar, aba e
borda do painel — para eliminar a classe de erro mais cara do dia a dia: rodar o comando
certo na máquina errada.

Decisões já tomadas com o usuário:

| Decisão | Escolha |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Plataforma | **macOS apenas** (código isolado para portar depois) |
| Chaves | **Sem vault cifrado próprio** — chaves do host (`~/.ssh`) + `ssh-agent` |
| Escopo | MVP focado, incrementos em fases |

> **Nota sobre "criar novas chaves"**: sem vault, a geração de chaves continua existindo —
> o app gera pares ed25519/RSA-4096, grava em `~/.ssh/<nome>` no formato OpenSSH com
> passphrase e permissão `0600`, e oferece registrar no `ssh-agent`. O "vault" vira uma
> **visão gerenciada sobre `~/.ssh`**, não um cofre paralelo. Nenhum material de chave
> privada é copiado para o banco do app.

---

## Pré-requisito bloqueante

`cargo` e `rustc` não estão instalados nesta máquina (`which cargo` → not found).
Antes da Fase 0: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
Xcode Command Line Tools também são necessários para linkar no macOS.

---

## Stack

**Rust (versões conferidas em crates.io hoje)**

| Crate | Versão | Papel |
|---|---|---|
| `tauri` | 2.11.5 | shell da aplicação |
| `russh` | 0.62.5 | transporte SSH assíncrono (tokio), canais, port forwarding |
| `russh-sftp` | 2.3.0 | subsistema SFTP sobre o mesmo `Handle` do russh |
| `ssh-key` | 0.6.7 | gerar/parsear/cifrar chaves OpenSSH, fingerprints |
| `rusqlite` | 0.40.1 (`bundled`) | catálogo de conexões, tags, temas, histórico |
| `keyring` | 4.1.6 | Keychain do macOS — **apenas** passphrases/senhas opcionais |
| `tokio`, `zeroize`, `dirs`, `thiserror`, `tracing` | — | infra |

**Frontend**

| Pacote | Versão |
|---|---|
| `@xterm/xterm` | 6.0.0 |
| `@xterm/addon-fit` | 0.11.0 |
| `@xterm/addon-webgl` | 0.19.0 |
| `@xterm/addon-search` | 0.16.0 |
| `@xterm/addon-web-links` | 0.12.0 |
| `@xterm/addon-serialize` | (restaurar scrollback ao reabrir aba) |
| `@tauri-apps/api` | 2.11.1 |

Complementos: `zustand` (estado), `@tanstack/react-virtual` (listas do SFTP),
`cmdk` (command palette), `lucide-react` (ícones), `dnd-kit` (drag & drop SFTP).
Evitar o pacote legado `xterm@5` — o escopo correto hoje é `@xterm/*`.

---

## Arquitetura

```
┌─ Webview (React) ────────────────────────────────┐
│  Sidebar tags/busca │ Tabs+Panes │ Painel SFTP   │
│  xterm.js (WebGL) fora do ciclo de render React  │
└───────┬──────────────────────────▲───────────────┘
    invoke() comandos          ipc::Channel (binário)
┌───────▼──────────────────────────┴───────────────┐
│ Rust core                                        │
│  SessionManager  ──┬── task por sessão (owner do │
│   (DashMap)        │   russh Handle, mpsc de cmd)│
│                    ├── canal shell/PTY           │
│                    ├── canal subsystem=sftp      │
│                    └── canais de forwarding      │
│  keys/  store/(sqlite)  hostkey/  sshconfig/     │
└──────────────────────────────────────────────────┘
```

**Regra estrutural**: uma conexão TCP/SSH serve terminal *e* SFTP *e* túneis
simultaneamente (SSH multiplexa canais). O usuário autentica uma vez por sessão e
abre o navegador de arquivos sem novo login.

**Ownership**: o `russh::client::Handle` **não** fica atrás de `Mutex` global. Cada
sessão é uma task tokio dona do handle, recebendo comandos por `mpsc::Sender`
(`Write(Bytes)`, `Resize{cols,rows}`, `OpenSftp`, `Forward{..}`, `Close`). Os comandos
Tauri só falam com o `Sender`. Isso evita contenção e deadlock entre o fluxo do
terminal e operações de arquivo.

### Streaming do terminal — o ponto crítico de performance

A IPC do Tauri serializa payloads em JSON por padrão; um `cat` de arquivo grande
produz milhares de mensagens e trava o webview. Duas medidas obrigatórias:

1. **Canal binário**: `tauri::ipc::Channel<&[u8]>` entrega `ArrayBuffer` no JS sem
   `JSON.parse`. No front, `term.write(new Uint8Array(buf))` — o xterm decodifica
   UTF-8 internamente, mais rápido que passar por `string`.
2. **Coalescing no Rust**: acumular a saída do canal SSH num buffer e emitir a cada
   **~8 ms ou 64 KB**, o que vier primeiro (`tokio::time::interval` + `select!`).
   Reduz a taxa de mensagens IPC em ordens de magnitude sem latência perceptível
   ao digitar.

Input do teclado vai pelo caminho oposto (`invoke("ssh_write")`) — baixa frequência,
sem otimização necessária. `resize` é debounced em 100 ms via `ResizeObserver` + fit addon.

### Contratos IPC (comandos Tauri)

```
ssh_connect(conn_id, on_output: Channel<&[u8]>) -> SessionId | HostKeyPrompt | AuthPrompt
ssh_write(session_id, data: Vec<u8>)
ssh_resize(session_id, cols, rows)
ssh_disconnect(session_id)

sftp_open(session_id) -> SftpId
sftp_list(sftp_id, path) -> Vec<RemoteEntry>
sftp_transfer(sftp_id, direction, src, dst, on_progress: Channel<Progress>) -> TransferId
sftp_mkdir | sftp_rename | sftp_remove | sftp_chmod | sftp_stat

keys_list() -> Vec<Identity>          // varre ~/.ssh + agente
keys_generate(kind, name, comment, passphrase) -> Identity
keys_add_to_agent(path, passphrase, use_keychain: bool)
keys_install_on_host(session_id, public_key)   // ssh-copy-id via sessão autenticada

conn_crud | tags_crud | themes_crud | sshconfig_import
```

Regra de segurança: **passphrases e senhas nunca voltam pela IPC para o front**.
Entram uma vez, são usadas no Rust e passam por `zeroize`.

### Modelo de dados (SQLite em `$APPDATA/fs-ssh/app.db`)

```sql
connections(id, name, host, port, username, auth_method, identity_id,
            jump_host_id, color, icon, theme_id, is_production, notes,
            created_at, last_used_at, use_count)
tags(id, name, color, parent_id)              -- hierárquicas
connection_tags(connection_id, tag_id)
identities(id, label, source, path, pubkey, fingerprint, key_type,
           has_passphrase, in_agent)          -- source: 'host' | 'generated'
themes(id, name, is_builtin, json)            -- 16 ANSI + fg/bg/cursor/selection
known_hosts(host, port, key_type, fingerprint, first_seen, last_seen)
snippets(id, name, body, tag_scope)
transfers(id, session_id, direction, local, remote, bytes, status, ts)
```

`identities` guarda **caminho e chave pública** — jamais bytes de chave privada.

### Pipeline de autenticação (ordem de tentativa)

1. **ssh-agent** via `SSH_AUTH_SOCK` — assinatura delegada, o app nunca lê a chave privada. Caminho preferencial.
2. **Chave explícita** apontada na conexão. Se cifrada: prompt de passphrase, com opção "lembrar no Keychain" (`keyring`) e/ou "adicionar ao agente".
3. **keyboard-interactive / password** — senha opcionalmente no Keychain.

**Verificação de host key sempre ativa**: consulta `~/.ssh/known_hosts` + tabela
própria; TOFU com diálogo mostrando fingerprint SHA256 na primeira vez; alerta
bloqueante e visualmente agressivo em caso de mudança.

**Import de `~/.ssh/config`**: parser próprio para `Host`, `HostName`, `User`, `Port`,
`IdentityFile`, `ProxyJump`, `ForwardAgent` — tela de preview antes de importar,
com detecção de duplicatas.

### Identidade visual (o requisito de cor/ícone, levado a sério)

- Ícone: emoji, biblioteca lucide, ou upload PNG/SVG.
- A cor da conexão não fica só num badge: tinge a aba, a borda do painel ativo e a
  linha na sidebar. Servidor de produção é reconhecível de relance.
- Flag `is_production` → confirmação extra ao conectar e barra superior destacada.
- Editor de tema com preview ao vivo; importador de `.itermcolors`, Windows Terminal
  JSON e base16. Tema pode ser global, por tag, ou sobrescrito por conexão.

---

## Fases

**Fase 0 — Fundação**
`rustup` → `pnpm create tauri-app` (React/TS) → esqueleto de módulos Rust
(`ssh/`, `keys/`, `store/`, `cmd/`) → migrações SQLite → CSP restritiva,
`withGlobalTauri: false`.

**Fase 1 — Terminal funcionando (MVP mínimo utilizável)**
`SessionManager` + task por sessão → PTY/shell via russh → `Channel<&[u8]>` com
coalescing → xterm.js + fit + webgl + resize → known_hosts/TOFU → auth por agente
e por chave. *Critério: conectar a um servidor e usar `vim`/`htop` com fluidez.*

**Fase 2 — Conexões, tags, temas, ícone**
CRUD completo, sidebar com árvore de tags e busca fuzzy, abas persistentes,
editor de tema com preview, seletor de ícone, `is_production`, import do `~/.ssh/config`.

**Fase 3 — Chaves**
Varredura de `~/.ssh` com fingerprints, listagem das chaves carregadas no agente,
geração ed25519/RSA-4096 (`ssh-key`) com passphrase e `0600`,
`ssh-add --apple-use-keychain`, botão "instalar chave no servidor" usando a
própria sessão já autenticada.

**Fase 4 — SFTP**
Canal SFTP na sessão existente, painel duplo local↔remoto virtualizado,
drag & drop, fila de transferências com progresso e velocidade, retomada,
mkdir/rename/chmod/delete, e — o recurso que mais vale a pena — **abrir arquivo
remoto no editor local e enviar de volta ao salvar** (watcher no arquivo temporário).

**Fase 5+ — Diferenciais** (detalhados abaixo)

---

## O que mais eu proponho

Ordenado por relação valor/esforço, para escolher o que entra depois do MVP.

**Alto valor, esforço moderado**

1. **Túneis de porta com UI** — `-L`, `-R` e `-D` (proxy SOCKS5) como configuração
   salva por conexão, ligados automaticamente ao conectar, com indicador de status
   e tráfego. É o recurso que faz o usuário abandonar o `ssh` do terminal.
2. **Jump host / bastion (`ProxyJump`)** — encadeamento de sessões, já modelado no
   schema via `jump_host_id`. Requisito real em qualquer infra séria.
3. **Editar remoto no editor local** (Fase 4) — abre no VS Code/vim local, salva → sobe.
4. **Snippets e command palette (⌘K)** — comandos salvos, com escopo por tag,
   enviados ao terminal. Conectar, trocar tema e rodar snippet sem tocar no mouse.
5. **Reconexão automática** — keepalive, backoff exponencial, restauração do
   scrollback via `addon-serialize`. Wi-Fi caindo deixa de custar a sessão.

**Diferenciais de produto**

6. **Split panes + broadcast de input** — digitar uma vez em N servidores da mesma
   tag. Manutenção de fleet vira trivial.
7. **Gravação de sessão em formato asciinema (`.cast`)** — auditoria e compartilhamento.
8. **Regras de highlight por regex** — pintar `ERROR`/`WARN`/IPs no stream do terminal,
   configurável por tag.
9. **Indicador de latência e uptime** por sessão na barra de status.
10. **Modo produção com confirmação** — já previsto no schema; combina com o requisito
    de cores e evita o incidente clássico.

**Segurança / operação**

11. **Bloqueio por inatividade** com Touch ID para reabrir.
12. **Limpeza automática do clipboard** após copiar de terminal.
13. **Export/import do catálogo** (JSON, sem material de chave) para versionar em git.
14. **Encaminhamento de agente por conexão** — opt-in explícito, com aviso do risco
    em host não confiável.

---

## Arquivos principais a criar

```
src-tauri/src/
  main.rs, lib.rs
  ssh/{mod,session,pty,sftp,hostkey,forward}.rs
  keys/{mod,discovery,generate,agent,sshconfig}.rs
  store/{mod,schema,connections,tags,themes}.rs
  cmd/{ssh,sftp,keys,conn,theme}.rs
src/
  App.tsx
  terminal/{Terminal.tsx,useSshSession.ts,themes.ts}
  sidebar/{ConnectionTree.tsx,TagFilter.tsx,QuickSwitcher.tsx}
  connections/{ConnectionForm.tsx,IconPicker.tsx,ThemeEditor.tsx}
  sftp/{FilePanel.tsx,TransferQueue.tsx}
  store/{connections.ts,sessions.ts,ui.ts}
```

---

## Verificação

**Ambiente de teste**: contêiner OpenSSH em porta 2222
(`docker run -d -p 2222:2222 -e USER_NAME=test -e PUBLIC_KEY_FILE=... lscr.io/linuxserver/openssh-server`),
mais o "Remote Login" do macOS para testar contra o sshd nativo.

**Testes automatizados (`cargo test`)**
- parser de `~/.ssh/config` (incluindo `Host` com wildcard e `Match`)
- parser/matcher de `known_hosts`, incluindo hosts com hash
- lógica de coalescing: N escritas pequenas → ≤ M mensagens no canal
- round-trip de geração de chave: gerar → reabrir com passphrase → fingerprint bate
  com o do `ssh-keygen -lf`

**Testes manuais por fase**
- *Fase 1*: `htop` e `vim` responsivos; `yes | head -c 50000000` não trava a UI;
  redimensionar a janela reflui o `top` corretamente; `Ctrl-C` interrompe.
- *Fase 1*: trocar a host key do servidor de teste → o alerta de mudança precisa
  aparecer e bloquear.
- *Fase 3*: `keys_generate` → `ssh-keygen -lf` externo confirma o fingerprint;
  permissão do arquivo é `600`; conexão autentica com a chave nova.
- *Fase 4*: upload e download de 1 GB com `sha256sum` idêntico nas duas pontas;
  transferência interrompida e retomada; terminal continua utilizável durante a cópia
  (prova de que os canais estão realmente multiplexados).

**Medição de performance**: com o WebGL addon ativo, `cat` de um log de 100 MB deve
manter o frame time do webview abaixo de ~30 ms — verificar no DevTools do webview.
Se degradar, a causa quase sempre é a janela de coalescing curta demais.
