# fs-ssh

Cliente SSH/SFTP multiplataforma (**macOS, Linux e Windows**) com identidade visual por conexão. **Tauri 2 + React 19 + xterm.js 6 + shadcn/ui** no frontend, **Rust (russh + russh-sftp + SQLite)** no backend — sem Electron, sem conta, sem nuvem: tudo local.

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
- **Terminal local e WSL**: um shell da própria máquina (PTY real) tratado como mais uma conexão. No Windows usa **PowerShell** por padrão (`pwsh.exe` / `powershell.exe`), e as distribuições **WSL** instaladas são detectadas nativamente e exibidas em seção separada. No Linux/macOS usa `$SHELL` (com fallback `/bin/bash` e `/bin/zsh`). Shell configurável nas preferências.
- **Backup do banco** em um clique (`VACUUM INTO`, seguro com o app aberto).

### Terminal
- xterm.js com renderização **WebGL** (fallback para DOM), 20 000 linhas de scrollback, Unicode 11 e links clicáveis.
- **Split panes**: ⌘D lado a lado, ⌘⇧D empilhado. O painel novo abre com um **seletor de servidor** (a sessão atual vem pré-selecionada), divisores arrastáveis, anel de foco na cor da conexão e ⌘⌥setas para circular.
- **Busca no scrollback** (⌘F) com navegação e destaque.
- **Auto-reconnect com backoff** (2s → 30s, 5 tentativas) apenas para quedas inesperadas — `exit` limpo e fechamento manual não contam.
- **Restauração de sessão**: ao abrir, oferece reconectar às conexões que estavam ativas.
- **Broadcast (cluster mode)**: o que você digita vai para todas as sessões, com selo, contorno âmbar e proteção contra abas de produção.
- **Snippets** com CRUD, disparados pela paleta ⌘K ou pelo botão dedicado.
- Zoom de fonte por atalho, aplicado a todos os terminais.

### Autenticação e chaves
- Pipeline `ssh-agent → chave em disco → senha`, configurável por conexão; fallback para `keyboard-interactive`.
- **Jump host (bastion)** como o `ProxyJump` do OpenSSH, com prompt de senha separado do destino.
- Gestão de chaves: varredura de `~/.ssh`, chaves só-agente (Secretive/1Password/OpenSSH Agent), geração **Ed25519/RSA-4096** com passphrase, carregar no `ssh-agent` (`--apple-use-keychain` no macOS; named pipe `openssh-ssh-agent` no Windows).
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
- **Editar localmente com save-back**: o arquivo abre no seu editor e cada gravação volta para o servidor; os temporários nascem 0600 e são limpos.

### Port forwarding
- Túneis **-L (local)**, **-R (reverso)** e **-D (SOCKS5)** salvos por conexão, com nome e **auto-início** junto com a sessão.
- Painel para criar, excluir, ligar/desligar em tempo real, com status e erros visíveis.
- Funciona através de jump host; bind local padrão em `127.0.0.1`.

### Docker/Podman (remoto e local)
- Lista os containers do host conectado — ou da própria máquina, no terminal local — via canal exec, sem instalar nada no servidor.
- **Iniciar, parar, reiniciar e excluir**, com confirmação nas ações que derrubam serviço e o erro do docker mostrado na íntegra.
- "Shell no container" e "logs": o comando é digitado no terminal, à vista.

### Sistema do host (remoto e local)
- Painel (⌘⇧S) com seis abas, todas pelo canal exec — nada instalado no servidor:
- **Resumo**: sistema, kernel, uptime, carga, **CPU, memória, swap e discos** em barras, atualizado sozinho a cada 5s. No Linux o uso de CPU vem de duas amostras de `/proc/stat`; no macOS/BSD, da soma do `%cpu` do `ps`.
- **Serviços** (systemd): unidades com **falhas primeiro**, filtro, start/stop/restart com confirmação e `journalctl -u … -f` digitado no terminal.
- **Processos**: lista ordenada por CPU, filtro por comando/usuário/pid, **SIGTERM e SIGKILL** com confirmação.
- **Portas**: o que está escutando (`ss`, `netstat` ou `lsof`), com processo e pid — e um clique **cria e liga o túnel -L** para aquela porta.
- **Updates**: pacotes pendentes (apt, dnf, yum, apk, pacman, brew) e aviso de reboot necessário.
- **Log**: cauda de qualquer arquivo do host com filtro literal e modo "seguir" (poll de 2s, sem prender canal).

### Rede do host (remoto e local)
- Painel (⌘⇧N) com a configuração de rede da máquina conectada: **IP, máscara, gateway e DNS**, mais MAC, IPv6 e domínios de busca — lido por um canal exec só, sem digitar nada no terminal.
- Fala `ip` (Linux) e `ifconfig`/`netstat` (macOS/BSD); com **systemd-resolved**, mostra os servidores que respondem de verdade, não o stub em `127.0.0.53`.
- Cada valor **copia com um clique**; interfaces sem endereço ficam escondidas atrás de um "mostrar mais".

### Histórico de comandos
- Painel (⌘⇧H) com os comandos digitados no terminal: **clicar roda de novo** na sessão ativa, ou o ⏎ ao lado escreve sem executar, para editar antes.
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
- **Gravar sessão** (manual ou automática): a saída do terminal vira arquivo de texto sem códigos de escape, com permissão 0600; a lista permite ver, exportar e apagar.
- **Tela de logs** com filtro por **período, conexão, nível e texto** — conexões, túneis, gravações e falhas; o log bruto do `tracing` fica em outra aba.
- **Hosts conhecidos**: fingerprints confirmados, com opção de esquecer.

### Interface
- Barra lateral **recolhível só com ícones** (⌘B) alinhada à mesma grade da lista expandida, ou escondida por completo (⌘⇧B).
- **Focus mode** (⌘⇧F): tela cheia só com o terminal.
- Barra de abas com rolagem própria e ações sempre fixas; a aba ativa entra em vista ao navegar pelo teclado.
- Painéis laterais (arquivos, containers, rede, sistema, túneis, histórico) são **por sessão** — o que está aberto num servidor não vaza para outro.
- Diálogos com foco preso e devolvido, ARIA em abas e botões, foco visível para teclado e respeito a `prefers-reduced-motion`.

### Segurança
- **Verificação de host key (TOFU)**: primeira conexão pede confirmação do fingerprint; **chave alterada** bloqueia com alerta destacado.
- Senhas e passphrases **nunca são persistidas** — usadas uma vez e descartadas.
- Nomes vindos do servidor SFTP são sanitizados (proteção zip-slip).
- CSP restrita, capabilities Tauri mínimas (sem shell/fs/http genéricos), temporários 0600/0700 com varredura no boot, diretório de dados 0700.
- Identificadores de container validados antes de entrar em qualquer linha de comando.

---

## Atalhos

No **macOS**, o modificador principal é `⌘` (e `⌥`/`⇧`). No **Windows** e no **Linux**, use `Ctrl` no lugar de `⌘` (e `Alt`/`Shift`).

| Atalho | Ação |
|---|---|
| ⌘K | Busca rápida: conectar ou rodar snippet |
| ⌘↵ (na busca) | Conectar em split |
| ⌘N | Nova conexão |
| ⌘L | Focar a busca da barra lateral |
| ↑ ↓ Home End ↵ | Navegar e conectar pela lista |
| ⌘T | Abrir busca para uma nova aba |
| ⌘D / ⌘⇧D | Dividir lado a lado / empilhado |
| ⌘W | Fechar painel (o último fecha a aba) |
| ⌘1…⌘9 | Ir para a aba N (⌘9 = última) |
| ⌘⇧[ / ⌘⇧] | Aba anterior / seguinte |
| ⌘⌥← → ↑ ↓ | Circular o foco entre painéis |
| ⌘R | Reconectar a sessão do painel |
| ⌘F | Buscar no scrollback |
| ⌘E | Painel de arquivos (SFTP) |
| ⌘⇧C | Painel de containers |
| ⌘⇧N | Painel de rede (IP, máscara, gateway, DNS) |
| ⌘⇧S | Painel de sistema (carga, memória, disco, serviços, portas) |
| ⌘⇧T | Painel de túneis |
| ⌘⇧H | Painel de histórico de comandos |
| ⌘⇧M | Configurações na aba de chaves, snippets, temas, gravações e logs |
| ⌘⇧R | Gravar a sessão |
| ⌘+ / ⌘− | Aumentar / diminuir a fonte |
| ⌘B / ⌘⇧B | Recolher para ícones / esconder a barra lateral |
| ⌘⇧F | Focus mode (tela cheia) |
| ⌘, | Configurações (preferências) |
| ⌘/ | Lista de atalhos |
| Esc | Sair do focus mode ou fechar o que estiver aberto |

---

## Desenvolvimento

```bash
make                  # app com hot-reload (instala as dependências na primeira vez)
make deps-linux       # instala GTK3 / WebKitGTK 4.1 e deps nativas no Linux
make build            # bundle apenas do SO atual (despacha para build-linux/windows/macos)
make build-linux      # gera pacotes Linux (.deb, .rpm, .AppImage)
make build-linux-deb  # gera apenas .deb (Debian/Ubuntu)
make build-windows    # gera instaladores Windows (.msi, .exe NSIS)
make build-macos      # gera bundle macOS (.app, .dmg)
make install          # instala/gera o pacote principal do SO atual
make check            # tsc --noEmit + cargo check
make test             # testes unitários Rust
make test-ssh         # + integração (sobe um sshd em Docker na porta 2222)
make help             # lista todos os alvos
```

Sem `make`, você pode chamar os scripts separados diretamente pelo `pnpm`:

```bash
pnpm run build:linux      # --bundles deb,rpm,appimage
pnpm run build:linux:deb  # --bundles deb
pnpm run build:windows    # --bundles msi,nsis
pnpm run build:macos      # --bundles dmg,app
```

O Makefile põe `~/.cargo/bin` no PATH sozinho — sem isso o `pnpm tauri dev` falha
com "cargo: command not found" mesmo com o Rust instalado.

Os testes de integração só rodam com `FS_SSH_TEST_SSH=1`; sem isso passam sem fazer nada, para não quebrar um `cargo test` em máquina sem Docker.

## Requisitos
- **macOS 11+**, **Linux** (com WebKitGTK/GTK de desenvolvimento para compilar via Tauri) ou **Windows 10/11** (WebView2 + OpenSSH Agent opcional).
- Rust 1.82+, Node + pnpm.
- Nenhum emulador de terminal externo é necessário: o app fala SSH direto e, no terminal local, usa PTY nativo (PowerShell / WSL no Windows; `$SHELL` no Linux e macOS).
