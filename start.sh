#!/usr/bin/env bash
# One-command setup & launcher for macOS / Linux
# Automatically downloads CLI_to_API, installs dependencies, starts the local
# API bridge, and launches the desktop video editor.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI2API_DIR="$ROOT_DIR/.cli2api"
WORK_DIR="$ROOT_DIR/.autocut-work"
CLI2API_REPO="https://github.com/alipyth/CLI_to_API.git"
PORT="${CLI2API_PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"

for cmd in git python3 cargo; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[error] '$cmd' is required but not found on PATH." >&2
    exit 1
  fi
done

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[setup] Installing pnpm globally via npm..."
  npm install -g pnpm
fi

mkdir -p "$WORK_DIR"

# 1. Auto-download CLI_to_API if missing
if [ ! -f "$CLI2API_DIR/pyproject.toml" ]; then
  echo "[cli2api] Cloning CLI_to_API into .cli2api..."
  git clone --depth 1 "$CLI2API_REPO" "$CLI2API_DIR"
fi

# 2. Create virtualenv & install cli2api on first run
VENV_PY="$CLI2API_DIR/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo "[cli2api] Creating Python virtual environment and installing dependencies..."
  python3 -m venv "$CLI2API_DIR/.venv"
  "$VENV_PY" -m pip install --quiet --upgrade pip
  "$VENV_PY" -m pip install --quiet -e "$CLI2API_DIR"
fi

CLI_PID=""
cleanup() {
  if [ -n "$CLI_PID" ] && kill -0 "$CLI_PID" 2>/dev/null; then
    echo "[cli2api] Stopping background bridge..."
    kill "$CLI_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# 3. Start cli2api bridge if not already running
if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
  echo "[cli2api] Already running on http://127.0.0.1:${PORT}"
else
  echo "[cli2api] Starting local API bridge on http://127.0.0.1:${PORT}..."
  CLI2API_CORS_ORIGINS="*" CLI2API_WORKDIR="$WORK_DIR" CLI2API_PORT="$PORT" \
    "$VENV_PY" -m cli2api serve --host 127.0.0.1 --port "$PORT" >/dev/null 2>&1 &
  CLI_PID=$!

  printf "[cli2api] Waiting for server"
  for _ in $(seq 1 30); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      echo ""
      echo "[cli2api] Ready at http://127.0.0.1:${PORT}/v1"
      break
    fi
    printf "."
    sleep 0.5
  done
fi

# 4. Install frontend dependencies & launch desktop app
cd "$ROOT_DIR"
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "[autocut] Installing frontend dependencies..."
  pnpm install
fi

echo "[autocut] Launching desktop app..."
pnpm tauri:dev
