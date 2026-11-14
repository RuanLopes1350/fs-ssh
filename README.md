# fs-ssh

Cliente SSH/SFTP multiplataforma (**Windows**, **Linux** e **macOS**) com identidade visual por conexão. **Tauri 2 + React 19 + xterm.js 6 + shadcn/ui** no frontend, **Rust (russh + russh-sftp + SQLite)** no backend — sem Electron, sem conta, sem nuvem: tudo local.

---

## Funcionalidades

### Conexões
- Catálogo em SQLite local com nome, host, porta, usuário, cor, ícone, tema, notas, contador de uso e último acesso.
- **Pastas** colapsáveis; arraste uma conexão para movê-la entre pastas ou para fora delas.
- Busca por nome, host, usuário ou notas.
- **Edição em painel lateral (Sheet)** com **preview ao vivo**: cor, ícone e tema aparecem na sidebar, nas abas e nos terminais abertos enquanto você escolhe; fechar sem salvar reverte tudo.
- **~150 ícones**: sistemas operacionais, clouds, containers, IaC, CI/CD, web/proxy, bancos, mensageria, monitoramento, rede/VPN, runtimes, storage e self-hosted — mais genéricos de categoria (servidor, rack, VM, firewall, load balancer, roteador…), todos pintados com a cor da conexão.
- **Importação do `~/.ssh/config`** (blocos `Host`, herança de `Host *`, `ProxyJump`) com pré-visualização e detecção de duplicatas.
- Marcação de **produção**: confirmação extra ao conectar, badge PROD, faixa vermelha na sessão e exclusão do broadcast por padrão.
- **Terminal local & WSL dedicado**:
  - **Terminal local**: abre um PTY real na máquina host — `powershell.exe` por padrão no Windows, `$SHELL -l` no Linux (fallback `/bin/bash`) e `$SHELL -l` no macOS (fallback `/bin/zsh`). O shell pode ser customizado nas Preferências.
  - **WSL (Linux) no Windows**: no Windows, o backend detecta automaticamente a presença de `C:\Windows\System32\wsl.exe` e lista todas as distribuições instaladas (`wsl -l -q`). Um atalho dedicado **WSL (Linux)** é exibido diretamente na barra lateral, na paleta de comandos (`Ctrl+K`) e no divisor de telas (`Ctrl+D`), permitindo operar PowerShell e WSL lado a lado sem alterar configurações. Nas Preferências (`Ctrl+,`), você pode escolher a distribuição desejada com um clique (ex.: `wsl -d Ubuntu-26.04 ~`), definir argumentos customizados ou ocultar o atalho na barra lateral.
- **Backup do banco** em um clique (`VACUUM INTO`, seguro com o app aberto).

### Terminal
- xterm.js com renderização **WebGL** (fallback para DOM), 20 000 linhas de scrollback, Unicode 11 e links clicáveis.
- **Split panes**: ⌘D / Ctrl+D lado a lado, ⌘⇧D / Ctrl+Shift+D empilhado. O painel novo abre com um **seletor de servidor** (a sessão atual vem pré-selecionada), divisores arrastáveis, anel de foco na cor da conexão e ⌘⌥setas / Ctrl+Alt+setas para circular.
- **Busca no scrollback** (⌘F / Ctrl+F) com navegação e destaque.
- **Auto-reconnect com backoff** (2s → 30s, 5 tentativas) apenas para quedas inesperadas — `exit` limpo e fechamento manual não contam.
- **Restauração de sessão**: ao abrir, oferece reconectar às conexões que estavam ativas.
- **Broadcast (cluster mode)**: o que você digita vai para todas as sessões, com selo, contorno âmbar e proteção contra abas de produção.
- **Snippets** com CRUD, disparados pela paleta ⌘K / Ctrl+K ou pelo botão dedicado.
- Zoom de fonte por atalho, aplicado a todos os terminais.

### Autenticação e chaves
- Pipeline `ssh-agent → chave em disco → senha`, configurável por conexão; fallback para `keyboard-interactive`.
- **Jump host (bastion)** como o `ProxyJump` do OpenSSH, com prompt de senha separado do destino.
- Gestão de chaves: varredura de `~/.ssh`, chaves só-agente (Secretive/1Password/OpenSSH Agent), geração **Ed25519/RSA-4096** com passphrase, carregar no `ssh-agent` (via socket Unix no Linux/macOS — com suporte a Keychain do macOS — e via named pipe nativo no Windows).
- **Instalar chave no servidor** (equivalente ao `ssh-copy-id`) usando a sessão já autenticada.

### SFTP
- Painel dual-pane local ↔ remoto com **drag & drop**, upload/download com **resume** e barras de progresso.
- **Fila de transferências** com duas em paralelo, **pausar e retomar** (a pausa chega ao laço de cópia no Rust; retomar continua de onde parou) e **histórico em SQLite** que sobrevive ao fechar do painel.
- **Comparar pastas** recursivamente (tamanho + data) com prévia do que difere e **sincronização em um clique** nos dois sentidos, criando os diretórios que faltarem.
- **Busca remota** por nome (`find -iname`), com profundidade escolhida e resultado navegável.
- **Conferir cópia por SHA-256** nas duas pontas — o hash remoto é calculado no servidor, só ele trafega.
- **Compactar e extrair no servidor** (tar.gz, tar.bz2, tar.xz, tar, zip, gz) sem baixar nada.
- **Favoritos de diretório** por conexão, para os dois lados.
- Listas **virtualizadas** — diretórios com milhares de arquivos não travam.
- Colunas de permissões, tamanho e data; dono/grupo no tooltip.
- mkdir, renomear, excluir e **chmod** (grade rwx + octal) em diálogos próprios.
- **Editar localmente com save-back**: o arquivo abre no seu editor e cada gravação volta para o servidor; os temporários nascem restritos (`0600` no Unix) e são limpos.

### Port forwarding
- Túneis **-L (local)**, **-R (reverso)** e **-D (SOCKS5)** salvos por conexão, com nome e **auto-início** junto com a sessão.
- Painel para criar, excluir, ligar/desligar em tempo real, com status e erros visíveis.
- Funciona através de jump host; bind local padrão em `127.0.0.1`.

### Docker/Podman (remoto e local)
- Lista os containers do host conectado — ou da própria máquina (inclusive via WSL no Windows) — via canal exec, sem instalar nada no servidor.
- **Iniciar, parar, reiniciar e excluir**, com confirmação nas ações que derrubam serviço e o erro do docker mostrado na íntegra.
- "Shell no container" e "logs": o comando é digitado no terminal, à vista.

### Sistema do host (remoto e local)
- Painel (⌘⇧S / Ctrl+Shift+S) com seis abas, todas pelo canal exec — nada instalado no servidor:
- **Resumo**: sistema, kernel, uptime, carga, **CPU, memória, swap e discos** em barras, atualizado sozinho a cada 5s. No Linux o uso de CPU vem de duas amostras de `/proc/stat`; no macOS/BSD, da soma do `%cpu` do `ps`.
- **Serviços** (systemd): unidades com **falhas primeiro**, filtro, start/stop/restart com confirmação e `journalctl -u … -f` digitado no terminal.
- **Processos**: lista ordenada por CPU, filtro por comando/usuário/pid, **SIGTERM e SIGKILL** com confirmação.
- **Portas**: o que está escutando (`ss`, `netstat` ou `lsof`), com processo e pid — e um clique **cria e liga o túnel -L** para aquela porta.
- **Updates**: pacotes pendentes (apt, dnf, yum, apk, pacman, brew) e aviso de reboot necessário.
- **Log**: cauda de qualquer arquivo do host com filtro literal e modo "seguir" (poll de 2s, sem prender canal).

### Rede do host (remoto e local)
- Painel (⌘⇧N / Ctrl+Shift+N) com a configuração de rede da máquina conectada: **IP, máscara, gateway e DNS**, mais MAC, IPv6 e domínios de busca — lido por um canal exec só, sem digitar nada no terminal.
- Fala `ip` (Linux/WSL) e `ifconfig`/`netstat` (macOS/BSD); com **systemd-resolved**, mostra os servidores que respondem de verdade, não o stub em `127.0.0.53`.
- Cada valor **copia com um clique**; interfaces sem endereço ficam escondidas atrás de um "mostrar mais".

### Histórico de comandos
- Painel (⌘⇧H / Ctrl+Shift+H) com os comandos digitados no terminal: **clicar roda de novo** na sessão ativa, ou o ⏎ ao lado escreve sem executar, para editar antes.
- Ordem do `history` do shell: **do mais recente para o mais antigo**, com filtro por texto e alternância entre **só este servidor** e todos.
- Qualquer linha vira **snippet** num clique; em painel PROD a reexecução pede confirmação mostrando o comando.
- Comando digitado inteiro é remontado do teclado; comando trazido do ↑, completado com ⇥ ou achado no ⌃R é lido da tela, depois do fim do prompt (que a sessão aprende sozinha). **Senha não entra**: prompt de senha não ecoa nem tem fim de prompt, então não sobra o que registrar. Pode ser desligado e limpo nas configurações.

### Temas
- **25 temas embutidos** com as paletas oficiais do [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes): Dracula, Nord, Tokyo Night Storm, Catppuccin (Mocha/Macchiato/Latte), Atom One Dark, Gruvbox (Dark/Light), Solarized (Dark/Light), Kanagawa, Everforest, Rosé Pine, Night Owl, Ayu (Dark/Mirage), GitHub (Dark/Light), Monokai, Material Ocean, Tomorrow Night, Snazzy, Cobalt2 e um vermelho para produção.
- **Editor de temas** com preview ao vivo e **importação de `.itermcolors`**.
- Tema por conexão.

### Auditoria
- **Gravação em asciicast (.cast)** além do texto puro: guarda o timing de tudo que passou pela tela e é reproduzível no **player embutido** (play/pause, seek, 1×–8×, pausas longas comprimidas) — ou em qualquer player de asciinema.
- **Exportar a sessão em HTML** com as cores como estão na tela (⤓ na barra), e **exportar o histórico de comandos em JSON** — o que se anexa a um ticket de incidente.
- **Modo somente leitura**: por conexão ou destravável no cadeado da barra. A trava é do **backend** — teclado, snippets, histórico e broadcast entram todos pelo mesmo `ssh_write` e são recusados juntos.

### Gravação, logs e diagnóstico
- **Gravar sessão** (manual ou automática): a saída do terminal vira arquivo de texto sem códigos de escape, com permissão `0600` (no Unix); a lista permite ver, exportar e apagar.
- **Tela de logs** com filtro por **período, conexão, nível e texto** — conexões, túneis, gravações e falhas; o log bruto do `tracing` fica em outra aba.
- **Hosts conhecidos**: fingerprints confirmados, com opção de esquecer.

### Interface
- Barra lateral **recolhível só com ícones** (⌘B / Ctrl+B) alinhada à mesma grade da lista expandida, ou escondida por completo (⌘⇧B / Ctrl+Shift+B).
- **Focus mode** (⌘⇧F / Ctrl+Shift+F): tela cheia só com o terminal.
- Barra de abas com rolagem própria e ações sempre fixas; a aba ativa entra em vista ao navegar pelo teclado.
- Painéis laterais (arquivos, containers, rede, sistema, túneis, histórico) são **por sessão** — o que está aberto num servidor não vaza para outro.
- Diálogos com foco preso e devolvido, ARIA em abas e botões, foco visível para teclado e respeito a `prefers-reduced-motion`.

### Segurança
- **Verificação de host key (TOFU)**: primeira conexão pede confirmação do fingerprint; **chave alterada** bloqueia com alerta destacado.
- Senhas e passphrases **nunca são persistidas** — usadas uma vez e descartadas.
- Nomes vindos do servidor SFTP são sanitizados (proteção zip-slip).
- CSP restrita, capabilities Tauri mínimas (sem shell/fs/http genéricos), temporários com permissões restritas e varredura no boot, diretório de dados `0700` no Unix.
- Identificadores de container validados antes de entrar em qualquer linha de comando.

---

## Atalhos

> **Nota multiplataforma:** nos sistemas **Windows** e **Linux**, substitua `⌘` por `Ctrl` e `⌥` por `Alt`.

| Atalho (macOS / Win & Linux) | Ação |
|---|---|
| ⌘K / Ctrl+K | Busca rápida: conectar ou rodar snippet |
| ⌘↵ / Ctrl+↵ (na busca) | Conectar em split |
| ⌘N / Ctrl+N | Nova conexão |
| ⌘L / Ctrl+L | Focar a busca da barra lateral |
| ↑ ↓ Home End ↵ | Navegar e conectar pela lista |
| ⌘T / Ctrl+T | Abrir busca para uma nova aba |
| ⌘D / Ctrl+D \| ⌘⇧D / Ctrl+Shift+D | Dividir lado a lado / empilhado |
| ⌘W / Ctrl+W | Fechar painel (o último fecha a aba) |
| ⌘1…⌘9 / Ctrl+1…Ctrl+9 | Ir para a aba N (9 = última) |
| ⌘⇧[ / ⌘⇧] \| Ctrl+Shift+[ / ] | Aba anterior / seguinte |
| ⌘⌥← → ↑ ↓ \| Ctrl+Alt+← → ↑ ↓ | Circular o foco entre painéis |
| ⌘R / Ctrl+R | Reconectar a sessão do painel |
| ⌘F / Ctrl+F | Buscar no scrollback |
| ⌘E / Ctrl+E | Painel de arquivos (SFTP) |
| ⌘⇧C / Ctrl+Shift+C | Painel de containers |
| ⌘⇧N / Ctrl+Shift+N | Painel de rede (IP, máscara, gateway, DNS) |
| ⌘⇧S / Ctrl+Shift+S | Painel de sistema (carga, memória, disco, serviços, portas) |
| ⌘⇧T / Ctrl+Shift+T | Painel de túneis |
| ⌘⇧H / Ctrl+Shift+H | Painel de histórico de comandos |
| ⌘⇧M / Ctrl+Shift+M | Configurações na aba de chaves, snippets, temas, gravações e logs |
| ⌘⇧R / Ctrl+Shift+R | Gravar a sessão |
| ⌘+ / ⌘− \| Ctrl+ / Ctrl− | Aumentar / diminuir a fonte |
| ⌘B / Ctrl+B \| ⌘⇧B / Ctrl+Shift+B | Recolher para ícones / esconder a barra lateral |
| ⌘⇧F / Ctrl+Shift+F | Focus mode (tela cheia) |
| ⌘, / Ctrl+, | Configurações (preferências) |
| ⌘/ / Ctrl+/ | Lista de atalhos |
| Esc | Sair do focus mode ou fechar o que estiver aberto |

---

## Distinções e Comportamento por Sistema Operacional

O `fs-ssh` adapta automaticamente sua camada de sistema para respeitar as convenções e APIs nativas de cada plataforma:

| Recurso | Windows | Linux | macOS |
|---|---|---|---|
| **Terminal Local (PTY)** | ConPTY com `powershell.exe` padrão (fallback `COMSPEC`). Parsing de argumentos via `shlex` (permite ex.: `wsl -d Ubuntu-26.04 ~`). | PTY Unix com `$SHELL -l` (fallback `/bin/bash`). | PTY Unix com `$SHELL -l` (fallback `/bin/zsh`). |
| **Atalho WSL (Linux)** | Detecta `C:\Windows\System32\wsl.exe` e lista distros via `wsl -l -q`. Botão dedicado na barra lateral, paleta e splits; configurável nas Preferências. | Oculto automaticamente (o **Terminal local** já é Linux nativo). | Oculto automaticamente (o **Terminal local** já é Unix nativo). |
| **Agente SSH (`ssh-agent`)** | Conecta via Named Pipe do OpenSSH (`\\.\pipe\openssh-ssh-agent`). Usa script `.cmd` temporário em `SSH_ASKPASS`. | Conecta via Unix Domain Socket (`$SSH_AUTH_SOCK`). Usa script shell `#!/bin/sh` (`0700`) em `SSH_ASKPASS`. | Conecta via Unix Domain Socket (`$SSH_AUTH_SOCK`) e suporta `--apple-use-keychain` no `ssh-add`. |
| **Inspeção Local (Docker, Rede, Sistema)** | Delega comandos POSIX silenciosamente (`CREATE_NO_WINDOW`) para `wsl.exe -- sh -lc` (respeitando `-d <distro>` se configurada), com fallback `cmd.exe /C`. | Executa diretamente com o shell local em modo login (`-lc`, fallback `/bin/sh`). | Executa diretamente com o shell local em modo login (`-lc`). |
| **Permissões de Arquivos** | Herda ACLs do diretório de dados e pasta temporária do usuário. | Aplica explicitamente `0700` no diretório de dados/scripts e `0600` em chaves privadas, gravações e temporários. | Aplica explicitamente `0700` no diretório de dados/scripts e `0600` em chaves privadas, gravações e temporários. |
| **Atalhos Globais** | `Ctrl` + `Alt` (`Ctrl+K`, `Ctrl+D`, `Ctrl+,`). | `Ctrl` + `Alt` (`Ctrl+K`, `Ctrl+D`, `Ctrl+,`). | `⌘` (`Command`) + `⌥` (`Option`). |
| **Empacotamento** | Executável `fs-ssh.exe` e instalador NSIS (`*_x64-setup.exe`). | Binário ELF, pacotes `.deb`, `.rpm` e `.AppImage`. | Bundle `.app` e imagem `.dmg` (mínimo macOS 11.0). |

---

## Guia Completo de Build por Sistema Operacional

Para compilar o aplicativo em qualquer um dos sistemas suportados, basta clonar o repositório em uma máquina com o respectivo sistema operacional e ter os pré-requisitos básicos (**Rust 1.82+**, **Node.js 20+** com `npm` ou `pnpm`, e **NASM** para o backend criptográfico `aws-lc-sys`).

### 1. Linux (Nativo — Ubuntu/Debian, Fedora, Arch)

Instale as dependências de sistema do WebKitGTK/Tauri e o assembler `nasm`:

- **Ubuntu / Debian:**
  ```bash
  sudo apt update
  sudo apt install -y build-essential curl wget file libxdo-dev libssl-dev \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libgtk-3-dev libsoup-3.0-dev nasm pkg-config
  ```
- **Fedora:**
  ```bash
  sudo dnf install -y @development-tools curl wget file openssl-devel \
    webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel gtk3-devel nasm
  ```
- **Arch Linux:**
  ```bash
  sudo pacman -S --needed base-devel curl wget file openssl webkit2gtk-4.1 \
    libappindicator-gtk3 librsvg nasm
  ```

Clone o projeto e execute o build:

```bash
git clone <url-do-repositorio> fs-ssh
cd fs-ssh
npm install          # ou: pnpm install
npm run app:build    # ou: make build
```

Os artefatos serão gerados em:
- Binário executável: `src-tauri/target/release/fs-ssh`
- Pacotes instaladores (`.deb`, `.rpm`, `.AppImage`): `src-tauri/target/release/bundle/`
- Para instalar diretamente o binário em `~/.local/bin/fs-ssh`, execute `make install`.

---

### 2. Windows (Nativo)

1. Instale os pré-requisitos no Windows:
   - **Rust**: baixe pelo [rustup.rs](https://rustup.rs/) (selecione a toolchain MSVC ou GNU).
   - **Microsoft C++ Build Tools** (Visual Studio Installer → *Desenvolvimento para desktop com C++*) **ou** MinGW-w64.
   - **Node.js LTS** (com `npm`).
   - **NASM** (`winget install NASM.NASM` — necessário para compilar `aws-lc-sys`). Garanta que `nasm.exe` esteja no `PATH`.
   - **WebView2 Runtime** (já incluso no Windows 10/11).
2. Caso o PowerShell bloqueie a execução de scripts do `npm` (`PSSecurityException`), libere para o seu usuário ou use `npm.cmd`:
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```
3. Clone e compile:
   ```powershell
   git clone <url-do-repositorio> fs-ssh
   cd fs-ssh
   npm install
   npm run app:build
   ```

Os artefatos serão gerados em:
- Executável: `src-tauri\target\release\fs-ssh.exe`
- Instalador NSIS / MSI: `src-tauri\target\release\bundle\nsis\` e `bundle\msi\`

---

### 3. Windows via Cross-Compilation no WSL2 / Linux

Você pode compilar o executável e o instalador NSIS do Windows diretamente de dentro do Linux ou WSL2 Ubuntu:

1. Instale os compiladores MinGW-w64, NSIS e NASM no Linux/WSL:
   ```bash
   sudo apt update
   sudo apt install -y mingw-w64 nsis nasm
   ```
2. Adicione o target GNU de Windows no Rust:
   ```bash
   rustup target add x86_64-pc-windows-gnu
   ```
3. O arquivo `src-tauri/.cargo/config.toml` já vem configurado no projeto com o linker e arquivador (`x86_64-w64-mingw32-gcc` e `x86_64-w64-mingw32-ar`), e `src-tauri/Cargo.toml` já usa `crate-type = ["staticlib", "rlib"]` para evitar estourar o limite de símbolos exportados PE do MinGW.
4. Instale as dependências Node e rode o build cross-platform:
   ```bash
   npm install
   npm run app:build:windows    # ou: make build-windows
   ```

Os artefatos de Windows gerados ficam em:
- Executável: `src-tauri/target/x86_64-pc-windows-gnu/release/fs-ssh.exe`
- Instalador NSIS: `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/fs-ssh_0.1.0_x64-setup.exe`

---

### 4. macOS (Nativo)

1. Instale as Xcode Command Line Tools (`xcode-select --install`), **Rust 1.82+** e **Node.js + pnpm/npm**.
2. Clone o repositório e compile:
   ```bash
   git clone <url-do-repositorio> fs-ssh
   cd fs-ssh
   make build        # ou: npm install && npm run app:build
   make install      # copia fs-ssh.app para /Applications
   ```

Os artefatos serão gerados em `src-tauri/target/release/bundle/macos/fs-ssh.app` e `src-tauri/target/release/bundle/dmg/`.

---

## Desenvolvimento e Testes

O projeto conta com atalhos tanto via `npm`/`pnpm` quanto via `Makefile`:

```bash
make              # app em modo dev com hot-reload (instala node_modules automaticamente)
make build        # bundle de release nativo para o SO atual
make build-windows # bundle de release Windows via cross-compilation (x86_64-pc-windows-gnu)
make install      # instala o app buildado (macOS: /Applications, Linux: ~/.local/bin)
make check        # tsc --noEmit + cargo check --all-targets
make test         # testes unitários Rust
make test-ssh     # + testes de integração (sobe um sshd em Docker na porta 2222)
make help         # lista todos os alvos disponíveis
```

O `Makefile` adiciona `~/.local/bin` e `~/.cargo/bin` ao `PATH` automaticamente e detecta se `pnpm` ou `npm` está disponível.

Os testes de integração SSH só executam com `FS_SSH_TEST_SSH=1`; sem essa variável, `cargo test` roda apenas os testes unitários e cenários locais sem depender de Docker.

## Requisitos Gerais
- **Windows 10/11** (WebView2), **Linux** (WebKitGTK 4.1) ou **macOS 11+**.
- **Rust 1.82+**, **Node.js 20+** (`npm` ou `pnpm`) e **NASM** (para compilação do `aws-lc-sys`).
- Nenhum emulador de terminal externo é necessário: o app implementa o cliente SSH/SFTP direto em Rust e usa o PTY nativo do sistema operacional (ConPTY no Windows, PTY Unix no Linux/macOS).
