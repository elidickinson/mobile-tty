#!/bin/bash
# Serve the client. dtach keeps pi alive across reconnects without taking the
# terminal's alternate screen the way tmux does, so scrollback stays in the
# client where the renderer can scroll it natively.
set -euo pipefail

cd "$(dirname "$0")"
port="${PORT:-7681}"
socket="${MTTY_SOCKET:-${TMPDIR:-/tmp}/mobile-tty.sock}"

node build.js
exec ttyd -W -p "$port" --index dist/client.html \
  dtach -A "$socket" -r winch -z "${@:-pi}"
