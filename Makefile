# fs-ssh — atalhos de desenvolvimento e build.
#
#   make                   app com hot-reload (o mesmo que `make dev`)
#   make deps-linux        instala GTK3 / WebKitGTK 4.1 e deps nativas no Linux
#   make build             gera o bundle apenas do SO atual em src-tauri/target/release/bundle/
#   make build-linux       gera bundles de Linux (deb, rpm, appimage)
#   make build-linux-deb   gera apenas pacote .deb (Debian/Ubuntu)
#   make build-windows     gera instaladores nativos de Windows (msi, nsis)
#   make build-windows-gnu gera executável e instalador NSIS via cross-compilation (x86_64-pc-windows-gnu)
#   make build-macos       gera bundles de macOS (app, dmg)
#   make install           instala o bundle gerado
#
# Rode `make help` para a lista completa.

SHELL := /usr/bin/env bash
# Falha no primeiro erro, inclusive no meio de um pipe: sem `pipefail` um
# `cargo test | tail` esconderia a falha do cargo atrás do êxito do tail.
.SHELLFLAGS := -eu -o pipefail -c

# O cargo mora em ~/.cargo/bin (e utilitários como nasm podem estar em ~/.local/bin).
export PATH := $(HOME)/.local/bin:$(HOME)/.cargo/bin:$(PATH)

UNAME_S := $(shell uname -s 2>/dev/null || echo Unknown)
NPM := $(shell command -v pnpm >/dev/null 2>&1 && echo pnpm || echo npm)
TAURI_DIR := src-tauri
BUNDLE_DIR := $(TAURI_DIR)/target/release/bundle
APP := $(BUNDLE_DIR)/macos/fs-ssh.app
INSTALL_DIR := /Applications
LINUX_BIN := $(TAURI_DIR)/target/release/fs-ssh

# Container do sshd usado pelos testes de integração.
SSHD_NAME := fs-ssh-test
SSHD_PORT := 2222

.DEFAULT_GOAL := dev
.PHONY: dev build build-linux build-linux-deb build-windows build-windows-gnu build-macos install check typecheck test test-ssh sshd fmt clean distclean help tools deps-linux

# ---------------------------------------------------------------- pré-requisitos

## Confere se cargo, gerenciador Node e bibliotecas do sistema (no Linux) estão disponíveis.
tools:
	@missing=0; \
	for bin in cargo $(NPM); do \
	  command -v $$bin >/dev/null 2>&1 || { echo "erro: '$$bin' não encontrado no PATH" >&2; missing=1; }; \
	done; \
	if [ "$(UNAME_S)" = "Linux" ]; then \
	  if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists gdk-3.0 webkit2gtk-4.1; then \
	    echo "erro: bibliotecas GTK/WebKitGTK do Tauri não encontradas (gdk-3.0 / webkit2gtk-4.1)" >&2; \
	    echo "  Rode: make deps-linux" >&2; \
	    echo "  Ou no Ubuntu/Debian:" >&2; \
	    echo "    sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf build-essential pkg-config libssl-dev" >&2; \
	    missing=1; \
	  fi; \
	fi; \
	if [ $$missing -eq 1 ]; then \
	  echo >&2; \
	  echo "  Rust:     https://rustup.rs (macOS/Linux: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)" >&2; \
	  echo "  pnpm/npm: corepack enable (ou instale Node.js + npm/pnpm)" >&2; \
	  exit 1; \
	fi

## Instala dependências nativas do Tauri 2 no Linux (Debian/Ubuntu, Fedora, Arch).
deps-linux:
	@if [ "$(UNAME_S)" != "Linux" ]; then \
	  echo "deps-linux só se aplica ao Linux."; \
	  exit 0; \
	fi; \
	if command -v apt-get >/dev/null 2>&1; then \
	  sudo apt-get update && sudo apt-get install -y \
	    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
	    librsvg2-dev patchelf build-essential pkg-config libssl-dev; \
	elif command -v dnf >/dev/null 2>&1; then \
	  sudo dnf install -y \
	    webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel \
	    librsvg2-devel openssl-devel gcc gcc-c++ make pkgconf-pkg-config; \
	elif command -v pacman >/dev/null 2>&1; then \
	  sudo pacman -S --needed --noconfirm \
	    webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg base-devel openssl pkgconf; \
	else \
	  echo "erro: gerenciador de pacotes não reconhecido; instale webkit2gtk-4.1, gtk3 e openssl-dev manualmente." >&2; \
	  exit 1; \
	fi

# Alvo de arquivo, não .PHONY: só reinstala quando o manifesto muda.
# O `touch` existe porque o pnpm nem sempre atualiza o mtime do diretório, e sem
# ele o make reinstalaria tudo a cada invocação.
node_modules: package.json | tools
	@echo "▸ instalando dependências do frontend com $(NPM)…"
	$(NPM) install
	@touch node_modules

# ------------------------------------------------------------------- comandos

## App em modo de desenvolvimento, com hot-reload.
dev: node_modules
	$(NPM) run app

## Bundle de release do SO atual (delega para build-macos, build-linux ou build-windows).
build:
ifeq ($(UNAME_S),Darwin)
	@$(MAKE) build-macos
else ifeq ($(UNAME_S),Linux)
	@$(MAKE) build-linux
else
	@$(MAKE) build-windows
endif

## Bundle para Linux (.deb, .rpm e .AppImage).
build-linux: node_modules | tools
	$(NPM) run build:linux

## Bundle apenas .deb para Debian/Ubuntu.
build-linux-deb: node_modules | tools
	$(NPM) run build:linux:deb

## Bundle nativo para Windows (.msi e .exe NSIS).
build-windows: node_modules | tools
	$(NPM) run build:windows

## Cross-compilation / build do instalador Windows a partir do Linux/WSL (x86_64-pc-windows-gnu).
build-windows-gnu: node_modules
	$(NPM) run build:windows:gnu

## Bundle para macOS (.app e .dmg).
build-macos: node_modules | tools
	$(NPM) run build:macos

## Instala o bundle gerado (macOS: /Applications; Linux: .deb + ~/.local/bin/fs-ssh).
ifeq ($(UNAME_S),Darwin)
install: build-macos
	@if pgrep -f '$(INSTALL_DIR)/fs-ssh.app' >/dev/null 2>&1; then \
	  echo "▸ fechando o fs-ssh em execução…"; \
	  osascript -e 'quit app "fs-ssh"' >/dev/null 2>&1 || true; \
	  sleep 2; \
	fi
	@echo "▸ instalando em $(INSTALL_DIR)…"
	rm -rf "$(INSTALL_DIR)/fs-ssh.app"
	cp -R "$(APP)" "$(INSTALL_DIR)/"
	@echo "▸ instalado: $$(defaults read "$(INSTALL_DIR)/fs-ssh.app/Contents/Info.plist" CFBundleShortVersionString)"
else ifeq ($(UNAME_S),Linux)
install: build-linux-deb
	@mkdir -p "$(HOME)/.local/bin"
	@cp "$(LINUX_BIN)" "$(HOME)/.local/bin/fs-ssh"
	@chmod +x "$(HOME)/.local/bin/fs-ssh"
	@echo "▸ binário instalado em $(HOME)/.local/bin/fs-ssh"
	@echo "▸ pacotes gerados em $(BUNDLE_DIR):"
	@ls -1 "$(BUNDLE_DIR)"/deb/*.deb 2>/dev/null || true
	@echo "  Debian/Ubuntu: sudo dpkg -i $(BUNDLE_DIR)/deb/*.deb"
else
install: build-windows
	@echo "▸ instaladores gerados em $(BUNDLE_DIR):"
	@ls -1 "$(BUNDLE_DIR)"/{msi,nsis}/* 2>/dev/null || true
	@echo "  Execute o instalador .exe (NSIS) ou .msi em $(BUNDLE_DIR)/."
endif

## Typecheck do TypeScript + cargo check.
check: typecheck
	cd $(TAURI_DIR) && cargo check --all-targets

typecheck: node_modules
	$(NPM) run typecheck

## Testes unitários do Rust (parsers de rede, sistema, ssh_config, banco).
test: | tools
	cd $(TAURI_DIR) && cargo test

## Testes de integração contra um sshd real em Docker.
test-ssh: sshd
	cd $(TAURI_DIR) && FS_SSH_TEST_SSH=1 cargo test --test integration

## Sobe o container do sshd de teste se ele ainda não estiver de pé.
sshd:
	@if ! docker ps --format '{{.Names}}' | grep -qx '$(SSHD_NAME)'; then \
	  echo "▸ subindo sshd de teste na porta $(SSHD_PORT)…"; \
	  docker rm -f '$(SSHD_NAME)' >/dev/null 2>&1 || true; \
	  docker run -d --name '$(SSHD_NAME)' -p $(SSHD_PORT):2222 \
	    -e USER_NAME=testuser -e USER_PASSWORD=testpass -e PASSWORD_ACCESS=true \
	    lscr.io/linuxserver/openssh-server:latest >/dev/null; \
	  for _ in $$(seq 1 30); do \
	    nc -z 127.0.0.1 $(SSHD_PORT) 2>/dev/null && break; \
	    sleep 1; \
	  done; \
	fi

## Formata o código Rust.
fmt:
	cd $(TAURI_DIR) && cargo fmt

## Remove artefatos de build (mantém node_modules).
clean:
	rm -rf dist node_modules/.vite
	cd $(TAURI_DIR) && cargo clean

## Como `clean`, e ainda apaga node_modules e o container de teste.
distclean: clean
	rm -rf node_modules
	-docker rm -f '$(SSHD_NAME)' >/dev/null 2>&1

## Lista os alvos com a descrição de cada um.
help:
	@echo "uso: make [alvo]"
	@echo
	@awk '/^## / { desc = substr($$0, 4); next } \
	      /^[a-z][a-z-]*:/ && desc { printf "  \033[36m%-18s\033[0m %s\n", substr($$1, 1, length($$1) - 1), desc; desc = "" } \
	      { if ($$0 !~ /^## /) desc = desc }' $(MAKEFILE_LIST)
