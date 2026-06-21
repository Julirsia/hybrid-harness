#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && node -e 'const fs=require("fs"); console.log(fs.realpathSync.native(process.cwd()))')"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/update-plugins.sh [pi]

Examples:
  ./scripts/update-plugins.sh
  ./scripts/update-plugins.sh pi

npm aliases:
  npm run install:pi
  npm run update:pi

After updating:
  - Pi: installed user-globally from this checkout; run /reload or restart Pi.

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
    echo "Set PI_BINARY=/path/to/pi or install Pi before updating the Pi package." >&2
    return 1
  fi

  run node \
    "$ROOT/packages/pi-hybrid-harness/bin/pi-hybrid-harness.js" \
    install \
    --source "${PI_HYBRID_HARNESS_SOURCE:-$ROOT}"
}

targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(pi)
fi

for target in "${targets[@]}"; do
  case "$target" in
    -h|--help|help)
      usage
      exit 0
      ;;
    pi|all)
      update_pi
      ;;
    *)
      echo "Unknown target: $target" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cat <<'NEXT_STEPS'

Pi package update command finished.

Reload/restart:
  - Pi: /reload
NEXT_STEPS
