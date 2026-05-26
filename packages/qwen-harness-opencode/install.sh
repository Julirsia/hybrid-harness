#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGIN_DIR="$CONFIG_DIR/plugins"
SKILL_DIR="$CONFIG_DIR/skills"
TUI_CONFIG="$CONFIG_DIR/tui.json"
TUI_PLUGIN_SPEC="$ROOT/plugins/qwen-harness-status.tsx"
STAMP="$(date +%Y%m%d%H%M%S)"

mkdir -p "$PLUGIN_DIR" "$SKILL_DIR"

if [ -f "$ROOT/package.json" ]; then
  (
    cd "$ROOT"
    npm install
  )
fi

link_path() {
  local source="$1"
  local target="$2"

  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    mv "$target" "$target.bak-$STAMP"
    printf 'Backed up existing %s to %s\n' "$target" "$target.bak-$STAMP"
  fi

  ln -s "$source" "$target"
  printf 'Linked %s -> %s\n' "$target" "$source"
}

link_path "$ROOT/plugins/qwen-harness-status.tsx" "$PLUGIN_DIR/qwen-harness-status.tsx"
link_path "$ROOT/plugins/qwen-harness-status-core.mjs" "$PLUGIN_DIR/qwen-harness-status-core.mjs"
link_path "$ROOT/skills/qwen-first-delegation-workflow" "$SKILL_DIR/qwen-first-delegation-workflow"

TUI_CONFIG="$TUI_CONFIG" TUI_PLUGIN_SPEC="$TUI_PLUGIN_SPEC" node <<'NODE'
const fs = require("node:fs");

const configPath = process.env.TUI_CONFIG;
const pluginSpec = process.env.TUI_PLUGIN_SPEC;
let config = {};

if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
}

if (!Array.isArray(config.plugin)) {
  config.plugin = [];
}

if (!config.plugin.includes(pluginSpec)) {
  config.plugin.push(pluginSpec);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Added ${pluginSpec} to ${configPath}`);
} else {
  console.log(`${pluginSpec} already present in ${configPath}`);
}
NODE

if [ -f "$CONFIG_DIR/package.json" ]; then
  (
    cd "$CONFIG_DIR"
    npm install --save \
      @opentui/core@0.2.15 \
      @opentui/keymap@0.2.15 \
      @opentui/solid@0.2.15 \
      solid-js@1.9.12
  )
fi

printf '\nInstalled qwen-harness-opencode.\n'
printf 'Restart OpenCode TUI to load the sidebar plugin.\n'
