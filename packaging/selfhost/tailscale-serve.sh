#!/usr/bin/env bash
# Publish the local T3 Code hub over HTTPS on a tailnet (Tailscale or Headscale).
# Usage: tailscale-serve.sh [up|down|status]
set -euo pipefail

PORT="${T3CODE_PORT:-3773}"
HTTPS_PORT="${T3CODE_TAILSCALE_SERVE_PORT:-443}"
TAILSCALE_BIN="${TAILSCALE_BIN:-tailscale}"
LOGIN_SERVER="${HEADSCALE_URL:-}"
AUTH_KEY="${TS_AUTHKEY:-}"

command -v "$TAILSCALE_BIN" >/dev/null 2>&1 || {
  echo "tailscale CLI not found (set TAILSCALE_BIN)" >&2
  exit 1
}

ensure_logged_in() {
  if "$TAILSCALE_BIN" status >/dev/null 2>&1; then
    return
  fi
  local args=(up)
  [[ -n "$LOGIN_SERVER" ]] && args+=(--login-server "$LOGIN_SERVER")
  [[ -n "$AUTH_KEY" ]] && args+=(--auth-key "$AUTH_KEY")
  "$TAILSCALE_BIN" "${args[@]}"
}

case "${1:-up}" in
  up)
    ensure_logged_in
    "$TAILSCALE_BIN" serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:${PORT}"
    "$TAILSCALE_BIN" serve status
    ;;
  down)
    "$TAILSCALE_BIN" serve --https="$HTTPS_PORT" off
    ;;
  status)
    "$TAILSCALE_BIN" serve status
    ;;
  *)
    echo "usage: $0 [up|down|status]" >&2
    exit 2
    ;;
esac
