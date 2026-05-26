#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
TUI_CONFIG="$CONFIG_DIR/tui.json"
TUI_PLUGIN_SPEC="$ROOT/plugins/qwen-harness-status.tsx"

remove_link() {
  local target="$1"
  if [ ! -L "$target" ]; then
    printf 'Skipped %s; not a symlink managed by this package.\n' "$target"
    return
  fi

  local destination
  destination="$(readlink "$target")"
  case "$destination" in
    "$ROOT"/*)
      rm "$target"
      printf 'Removed %s\n' "$target"
      ;;
    *)
      printf 'Skipped %s; points to %s\n' "$target" "$destination"
      ;;
  esac
}

remove_link "$CONFIG_DIR/plugins/qwen-harness-status.tsx"
remove_link "$CONFIG_DIR/plugins/qwen-harness-status-core.mjs"
remove_link "$CONFIG_DIR/skills/qwen-first-delegation-workflow"

TUI_CONFIG="$TUI_CONFIG" TUI_PLUGIN_SPEC="$TUI_PLUGIN_SPEC" node <<'NODE'
const fs = require("node:fs");

const configPath = process.env.TUI_CONFIG;
const pluginSpec = process.env.TUI_PLUGIN_SPEC;

if (!fs.existsSync(configPath)) {
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!Array.isArray(config.plugin)) {
  process.exit(0);
}

const nextPlugins = config.plugin.filter((entry) => entry !== pluginSpec);
if (nextPlugins.length === config.plugin.length) {
  process.exit(0);
}

config.plugin = nextPlugins;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Removed ${pluginSpec} from ${configPath}`);
NODE

printf '\nUninstalled qwen-harness-opencode symlinks.\n'
