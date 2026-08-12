# fs-ssh — atalhos de desenvolvimento e build.
#
#   make            app com hot-reload (o mesmo que `make dev`)
#   make build      gera .app e .dmg em src-tauri/target/release/bundle/
#   make install    instala/atualiza o .app em /Applications
#
# Rode `make help` para a lista completa.

SHELL := /usr/bin/env bash
# Falha no primeiro erro, inclusive no meio de um pipe: sem `pipefail` um
# `cargo test | tail` esconderia a falha do cargo atrás do êxito do tail.
.SHELLFLAGS := -eu -o pipefail -c

# O cargo mora em ~/.cargo/bin e nem todo shell carrega o ~/.cargo/env — sem
# isto o `pnpm tauri dev` falha com "cargo: command not found" mesmo com o Rust
# instalado.
export PATH := $(HOME)/.cargo/bin:$(PATH)

TAURI_DIR := src-tauri
BUNDLE_DIR := $(TAURI_DIR)/target/release/bundle
APP := $(BUNDLE_DIR)/macos/fs-ssh.app
INSTALL_DIR := /Applications

# Container do sshd usado pelos testes de integração.
SSHD_NAME := fs-ssh-test
SSHD_PORT := 2222

.DEFAULT_GOAL := dev
.PHONY: dev build install check typecheck test test-ssh sshd fmt clean distclean help tools

# ---------------------------------------------------------------- pré-requisitos

## Confere se cargo e pnpm estão no PATH.
tools:
	@missing=0; \
	for bin in cargo pnpm; do \
	  command -v $$bin >/dev/null 2>&1 || { echo "erro: '$$bin' não encontrado no PATH" >&2; missing=1; }; \
	done; \
	if [ $$missing -eq 1 ]; then \
	  echo >&2; \
	  echo "  Rust:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2; \
	  echo "  pnpm:  brew install pnpm" >&2; \
	  exit 1; \
	fi

# Alvo de arquivo, não .PHONY: só reinstala quando o manifesto ou o lock mudam.
# O `touch` existe porque o pnpm nem sempre atualiza o mtime do diretório, e sem
# ele o make reinstalaria tudo a cada invocação.
node_modules: package.json pnpm-lock.yaml | tools
	@echo "▸ instalando dependências do frontend…"
	pnpm install
	@touch node_modules

# ------------------------------------------------------------------- comandos

## App em modo de desenvolvimento, com hot-reload.
dev: node_modules
	pnpm tauri dev

## Bundle de release: .app e .dmg em src-tauri/target/release/bundle/.
build: node_modules
	pnpm tauri build

## Copia o .app recém-buildado para /Applications (fecha o app aberto antes).
install: build
	@if pgrep -f '$(INSTALL_DIR)/fs-ssh.app' >/dev/null 2>&1; then \
	  echo "▸ fechando o fs-ssh em execução…"; \
	  osascript -e 'quit app "fs-ssh"' >/dev/null 2>&1 || true; \
	  sleep 2; \
	fi
	@echo "▸ instalando em $(INSTALL_DIR)…"
	rm -rf "$(INSTALL_DIR)/fs-ssh.app"
	cp -R "$(APP)" "$(INSTALL_DIR)/"
	@echo "▸ instalado: $$(defaults read "$(INSTALL_DIR)/fs-ssh.app/Contents/Info.plist" CFBundleShortVersionString)"

## Typecheck do TypeScript + cargo check.
check: typecheck
	cd $(TAURI_DIR) && cargo check --all-targets

typecheck: node_modules
	pnpm typecheck

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
