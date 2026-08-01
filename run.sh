#!/usr/bin/env bash
# Sobe o fs-ssh em modo de desenvolvimento.
#
# Existe porque `cargo` fica em ~/.cargo/bin e nem todo shell carrega o
# ~/.cargo/env — sem isso o `pnpm tauri dev` falha com "cargo: command not found"
# mesmo com o Rust instalado.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# --------------------------------------------------------------------- PATH

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"

missing=0
for bin in cargo pnpm; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "erro: '$bin' não encontrado no PATH" >&2
    missing=1
  fi
done
if [ "$missing" -eq 1 ]; then
  echo >&2
  echo "  Rust:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
  echo "  pnpm:  brew install pnpm" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "▸ instalando dependências do frontend…"
  pnpm install
fi

# ------------------------------------------------------------------ comandos

usage() {
  cat <<'EOF'
uso: ./run.sh [comando]

  dev         (padrão) app com hot-reload
  build       gera .app e .dmg em src-tauri/target/release/bundle/
  check       typecheck do TypeScript + cargo check
  test        testes unitários (parser de ssh_config)
  test:ssh    testes de integração contra um sshd real em Docker
  fmt         formata o código Rust
  clean       remove artefatos de build
EOF
}

cmd="${1:-dev}"

case "$cmd" in
  dev)
    exec pnpm tauri dev
    ;;

  build)
    exec pnpm tauri build
    ;;

  check)
    pnpm typecheck
    cd src-tauri && exec cargo check
    ;;

  test)
    cd src-tauri && exec cargo test
    ;;

  test:ssh)
    name=fs-ssh-test
    if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
      echo "▸ subindo sshd de teste na porta 2222…"
      docker rm -f "$name" >/dev/null 2>&1 || true
      docker run -d --name "$name" -p 2222:2222 \
        -e USER_NAME=testuser \
        -e USER_PASSWORD=testpass \
        -e PASSWORD_ACCESS=true \
        lscr.io/linuxserver/openssh-server:latest >/dev/null

      # O container responde na porta antes de o sshd terminar de subir.
      for _ in $(seq 1 30); do
        nc -z 127.0.0.1 2222 2>/dev/null && break
        sleep 1
      done
    fi
    cd src-tauri && FS_SSH_TEST_SSH=1 exec cargo test --test integration
    ;;

  fmt)
    cd src-tauri && exec cargo fmt
    ;;

  clean)
    rm -rf dist node_modules/.vite
    cd src-tauri && exec cargo clean
    ;;

  -h | --help | help)
    usage
    ;;

  *)
    echo "comando desconhecido: $cmd" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac
