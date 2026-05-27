#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && node -e 'const fs=require("fs"); console.log(fs.realpathSync.native(process.cwd()))')"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/update-plugins.sh [all|pi|opencode|codex ...]

Examples:
  ./scripts/update-plugins.sh
  ./scripts/update-plugins.sh all
  ./scripts/update-plugins.sh pi
  ./scripts/update-plugins.sh opencode codex

npm aliases:
  npm run install:plugins
  npm run update:plugins
  npm run update:pi
  npm run update:opencode
  npm run update:codex

After updating:
  - Pi: installed user-globally from this checkout; run /reload or restart Pi.
  - OpenCode: restart the TUI.
  - Codex: restart the session so the skill/MCP config reloads.

Environment:
  PI_HYBRID_HARNESS_SOURCE  Override the Pi package source.
                            Example: git:github.com/Julirsia/hybrid-harness@main
USAGE
}

run() {
  printf '\n$'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

update_pi() {
  if ! command -v "${PI_BINARY:-pi}" >/dev/null 2>&1; then
    echo "Missing Pi binary: ${PI_BINARY:-pi}" >&2
    echo "Set PI_BINARY=/path/to/pi or install Pi before updating the Pi plugin." >&2
    return 1
  fi

  run node \
    "$ROOT/packages/pi-hybrid-harness/bin/pi-hybrid-harness.js" \
    install \
    --source "${PI_HYBRID_HARNESS_SOURCE:-$ROOT/packages/pi-hybrid-harness}"
}

update_opencode() {
  run node \
    "$ROOT/packages/qwen-harness-opencode/bin/qwen-harness-opencode.js" \
    update
}

update_codex() {
  run node \
    "$ROOT/packages/qwen-harness-codex/bin/qwen-harness-codex.js" \
    update
}

targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(all)
fi

for target in "${targets[@]}"; do
  case "$target" in
    -h|--help|help)
      usage
      exit 0
      ;;
    all)
      update_pi
      update_opencode
      update_codex
      ;;
    pi)
      update_pi
      ;;
    opencode|open-code|oc)
      update_opencode
      ;;
    codex)
      update_codex
      ;;
    *)
      echo "Unknown target: $target" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cat <<'NEXT_STEPS'

Plugin update commands finished.

Reload/restart:
  - Pi: /reload
  - OpenCode: restart TUI
  - Codex: restart session
NEXT_STEPS
