# fs-ssh — atalhos de desenvolvimento e build.
#
#   make                app com hot-reload (o mesmo que `make dev`)
#   make build          gera o bundle/instalador nativo do SO atual
#   make build-windows  gera .exe e instalador NSIS (x86_64-pc-windows-gnu)
#   make install        instala o app (macOS: /Applications, Linux: ~/.local/bin)
#
# Rode `make help` para a lista completa.

SHELL := /usr/bin/env bash
# Falha no primeiro erro, inclusive no meio de um pipe: sem `pipefail` um
# `cargo test | tail` esconderia a falha do cargo atrás do êxito do tail.
.SHELLFLAGS := -eu -o pipefail -c

# O cargo mora em ~/.cargo/bin (e utilitários como nasm podem estar em ~/.local/bin).
export PATH := $(HOME)/.local/bin:$(HOME)/.cargo/bin:$(PATH)

UNAME_S := $(shell uname -s)
PKG_MGR := $(shell command -v pnpm >/dev/null 2>&1 && echo pnpm || echo npm)
PKG_EXEC := $(shell command -v pnpm >/dev/null 2>&1 && echo pnpm || echo npx)

TAURI_DIR := src-tauri
BUNDLE_DIR := $(TAURI_DIR)/target/release/bundle
APP := $(BUNDLE_DIR)/macos/fs-ssh.app
INSTALL_DIR := /Applications
LINUX_BIN := $(TAURI_DIR)/target/release/fs-ssh

# Container do sshd usado pelos testes de integração.
SSHD_NAME := fs-ssh-test
SSHD_PORT := 2222

.DEFAULT_GOAL := dev
.PHONY: dev build build-windows install check typecheck test test-ssh sshd fmt clean distclean help tools

# ---------------------------------------------------------------- pré-requisitos

## Confere se cargo e pnpm/npm estão no PATH.
tools:
	@missing=0; \
	command -v cargo >/dev/null 2>&1 || { echo "erro: 'cargo' não encontrado no PATH" >&2; missing=1; }; \
	if ! command -v pnpm >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then \
	  echo "erro: nem 'pnpm' nem 'npm' encontrados no PATH" >&2; missing=1; \
	fi; \
	if [ $$missing -eq 1 ]; then \
	  echo >&2; \
	  echo "  Rust:      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2; \
	  echo "  pnpm/npm:  instale Node.js + npm ou pnpm" >&2; \
	  exit 1; \
	fi

# Alvo de arquivo, não .PHONY: só reinstala quando o manifesto muda.
# O `touch` existe porque o pnpm nem sempre atualiza o mtime do diretório, e sem
# ele o make reinstalaria tudo a cada invocação.
node_modules: package.json | tools
	@echo "▸ instalando dependências do frontend com $(PKG_MGR)…"
	$(PKG_MGR) install
	@touch node_modules

# ------------------------------------------------------------------- comandos

## App em modo de desenvolvimento, com hot-reload.
dev: node_modules
	$(PKG_EXEC) tauri dev

## Bundle de release nativo do sistema operacional atual.
build: node_modules
	$(PKG_EXEC) tauri build --ignore-version-mismatches

## Cross-compilation / build do instalador Windows (x86_64-pc-windows-gnu).
build-windows: node_modules
	$(PKG_EXEC) tauri build --target x86_64-pc-windows-gnu --ignore-version-mismatches

## Instala o app (macOS: /Applications; Linux: ~/.local/bin/fs-ssh).
install: build
	@if [ "$(UNAME_S)" = "Darwin" ]; then \
	  if pgrep -f '$(INSTALL_DIR)/fs-ssh.app' >/dev/null 2>&1; then \
	    echo "▸ fechando o fs-ssh em execução…"; \
	    osascript -e 'quit app "fs-ssh"' >/dev/null 2>&1 || true; \
	    sleep 2; \
	  fi; \
	  echo "▸ instalando em $(INSTALL_DIR)…"; \
	  rm -rf "$(INSTALL_DIR)/fs-ssh.app"; \
	  cp -R "$(APP)" "$(INSTALL_DIR)/"; \
	  echo "▸ instalado: $$(defaults read "$(INSTALL_DIR)/fs-ssh.app/Contents/Info.plist" CFBundleShortVersionString)"; \
	elif [ "$(UNAME_S)" = "Linux" ]; then \
	  mkdir -p "$(HOME)/.local/bin"; \
	  cp "$(LINUX_BIN)" "$(HOME)/.local/bin/fs-ssh"; \
	  chmod +x "$(HOME)/.local/bin/fs-ssh"; \
	  echo "▸ binário instalado em $(HOME)/.local/bin/fs-ssh"; \
	  echo "▸ pacotes (.deb/.rpm/.AppImage) disponíveis em $(BUNDLE_DIR)"; \
	else \
	  echo "▸ execute o instalador gerado em $(BUNDLE_DIR)"; \
	fi

## Typecheck do TypeScript + cargo check.
check: typecheck
	cd $(TAURI_DIR) && cargo check --all-targets

typecheck: node_modules
	$(PKG_MGR) run typecheck

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
	      /^[a-z][a-z-]*:/ && desc { printf "  \033[36m%-12s\033[0m %s\n", substr($$1, 1, length($$1) - 1), desc; desc = "" } \
	      { if ($$0 !~ /^## /) desc = desc }' $(MAKEFILE_LIST)
