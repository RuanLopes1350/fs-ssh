# fs-ssh

Cliente SSH/SFTP para macOS com identidade visual por conexão. Feito com **Tauri 2 + React 19 + xterm.js 6** no frontend e **Rust (russh + russh-sftp + SQLite)** no backend — sem Electron, sem conta, sem nuvem: tudo local.

## Funcionalidades

### Catálogo de conexões
- Conexões salvas em SQLite local (`app.db`), com nome, host, porta, usuário, cor, ícone, tema, notas e contador de uso.
- **Pastas** colapsáveis para organizar (arraste uma conexão para dentro de uma pasta), **tags** coloridas com filtro combinado e busca por texto livre.
- Seção **Recentes** (atalho com as 5 últimas usadas) e destaque da conexão da aba ativa na lista.
- **Importação do `~/.ssh/config`** (blocos `Host`, herança de `Host *`, `ProxyJump`), com pré-visualização e detecção de duplicatas.
- Flag **produção**: confirmação extra ao conectar, badge PROD e faixa vermelha na sessão.
- **Backup do banco** em um clique (⌘, → Backup), via `VACUUM INTO`.

### Terminal
- xterm.js com renderização **WebGL** (fallback para DOM), 20 000 linhas de scrollback, Unicode 11, links clicáveis.
- Abas com cor e status por conexão, zoom de fonte (⌘+/⌘−), **busca no scrollback (⌘F)**.
- **Split panes**: ⌘D divide lado a lado, ⌘⇧D empilha — o painel novo abre com um **seletor de servidor** (a sessão atual vem pré-selecionada: Enter duplica, digitar filtra, Esc desfaz o split). Cada painel é uma sessão SSH independente, com divisores arrastáveis, anel de foco e ⌘⌥setas para circular. Atalhos diretos: ⌘K + **⌘Enter** ou botão direito na sidebar → "Conectar em split".
- **Broadcast (cluster mode)**: o que você digita vai para todas as abas abertas — com selo visual, contorno âmbar e, por padrão, **ignorando abas PROD**.
- **Snippets** com CRUD, disparados pela paleta (⌘K).
- **Auto-reconnect com backoff** (2s → 30s, 5 tentativas) para quedas de rede — nunca para `exit` limpo ou fechamento manual.
- **Restauração de sessão**: ao abrir, oferece reconectar às abas da última sessão.

### Autenticação e chaves
- Pipeline `ssh-agent → chave em disco → senha`, configurável por conexão; suporte a `keyboard-interactive`.
- **Jump host (bastion)** como o `ProxyJump` do OpenSSH, com prompt de senha separado para o bastion.
- Gestão de chaves: varredura de `~/.ssh`, chaves só-agente (Secretive/1Password), geração **Ed25519/RSA-4096** com passphrase, `ssh-add` com Keychain do macOS.
- **Instalar chave no servidor** (equivalente ao `ssh-copy-id`) usando a sessão já autenticada.

### Port forwarding
- Túneis **-L (local)** e **-R (reverso)** salvos por conexão, com nome e **auto-início** junto com a sessão.
- Painel "Túneis" para ligar/desligar em tempo real, com status e erros visíveis.
- Funciona através de jump host; bind local padrão em `127.0.0.1`.

### SFTP
- Painel dual-pane local ↔ remoto com **drag & drop**, upload/download com **resume** e barras de progresso.
- Listas **virtualizadas** (diretórios gigantes sem travar), colunas de permissões, tamanho e data.
- mkdir, renomear, excluir e **chmod** (grade rwx + octal) em diálogos próprios.
- **Editar localmente com save-back**: o arquivo abre no seu editor e cada ⌘S volta para o servidor automaticamente; temporários nascem com permissão 0600 e são limpos.

### Docker/Podman remoto
- Painel que lista os containers do host conectado (via canal exec, nada instalado no servidor), com estado e portas.
- Ações "shell no container" e "logs" — o comando é digitado no terminal, à vista.

### Temas
- 6 temas embutidos + **editor de temas** com preview ao vivo nos terminais abertos e **importação de `.itermcolors`**.
- Tema por conexão, com preview imediato ao trocar no formulário.

### Segurança
- **Verificação de host key (TOFU)**: primeiro acesso pede confirmação do fingerprint; **chave alterada** bloqueia com alerta destacado (possível MITM). Gestão de hosts confiados na UI.
- Senhas e passphrases **nunca são persistidas** — usadas uma vez e descartadas.
- Nomes vindos do servidor SFTP são sanitizados (proteção zip-slip).
- CSP restrita, capabilities Tauri mínimas (sem shell/fs/http genéricos), temporários 0600/0700 com varredura no boot, diretório de dados 0700.

### Atalhos
| Atalho | Ação |
|---|---|
| ⌘K / ⌘T | Paleta: conectar ou rodar snippet |
| ⌘F | Buscar no terminal |
| ⌘B | Mostrar/esconder barra lateral |
| ⌘D / ⌘⇧D | Dividir painel (lado a lado / empilhado) |
| ⌘⌥← → ↑ ↓ | Circular foco entre painéis |
| ⌘1–9, ⌘⇧[ ] | Navegar entre abas |
| ⌘W | Fechar painel (último painel fecha a aba) |
| ⌘+ / ⌘− | Fonte |
| ⌘, | Configurações |

## Desenvolvimento

```bash
pnpm install
pnpm app          # tauri dev
pnpm app:build    # bundle .app/.dmg
pnpm typecheck    # tsc --noEmit
```

Testes Rust (os de integração exigem Docker + sshd de teste):

```bash
cd src-tauri
cargo test                        # unitários
FS_SSH_TEST_SSH=1 cargo test      # + integração (sobe sshd em Docker)
```

## Requisitos
- macOS 11+ (o app usa Keychain/`ssh-add --apple-use-keychain` e bundle dmg/app).
- Rust 1.82+, Node + pnpm.
