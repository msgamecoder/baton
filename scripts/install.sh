#!/usr/bin/env bash
# Baton installer — installs the CLI, then offers the terminal multiplexer.
#
#   bash scripts/install.sh            # install from this checkout
#   bash scripts/install.sh --no-panes # skip the tmux prompt
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_PANES=0
for arg in "$@"; do
  [ "$arg" = "--no-panes" ] && SKIP_PANES=1
done

say() { printf '%s\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  say "Baton needs Node.js 22.6 or newer. Install it from https://nodejs.org and re-run."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
  say "Baton needs Node.js >= 22.6 (found $(node -v)). Please upgrade and re-run."
  exit 1
fi
say "node $(node -v) — ok"

if ! command -v npm >/dev/null 2>&1; then
  say "npm not found (it ships with Node.js)."
  exit 1
fi

say "installing baton globally from $ROOT ..."
npm install -g "$ROOT"

if ! command -v baton >/dev/null 2>&1; then
  say "baton was installed but is not on PATH. Check your npm global bin directory:"
  say "  npm bin -g"
  exit 1
fi

say ""
baton doctor

if [ "$SKIP_PANES" -eq 0 ] && [ -t 0 ]; then
  say ""
  printf 'Install the terminal multiplexer now? [y/N] '
  read -r answer || answer=""
  case "$answer" in
    [yY]*) baton install ;;
    *) say "skipped — baton will use the PTY fallback until you install one" ;;
  esac
fi

say ""
say "Done. Next:"
say "  baton init"
say "  baton up --dry-run"
say "  baton up"
