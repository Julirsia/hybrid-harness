#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$ROOT/bin/qwen-harness-opencode.js" install "$@"
