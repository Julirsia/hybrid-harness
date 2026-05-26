# qwen-harness-opencode

OpenCode bundle for `.qwen-harness` workflows.

It installs two native OpenCode assets:

- `skills/qwen-first-delegation-workflow/SKILL.md`
- `plugins/qwen-harness-status.tsx`

The skill defines and updates the `.qwen-harness` file contract. The TUI plugin reads that contract and adds a compact right-sidebar status panel through `sidebar_content`, ordered just before `oh-my-opencode-slim`'s panel.

## Sidebar

The panel shows:

- phase and current slice
- completed/total slices
- current slice title, owner, and risk
- next slice
- blockers
- token totals and local/frontier efficiency
- last updated timestamp

Token efficiency is calculated from `tokenUsage`, `usage`, or `tokens` objects in `state.json`, `progress.json`, `implementation-plan.json`, slice evidence, and `events.jsonl`.

## Install

From npm:

```sh
npx qwen-harness-opencode install
```

Update later with:

```sh
npx qwen-harness-opencode update
```

For local development from the monorepo checkout:

```sh
npm run install:opencode
# or:
./packages/qwen-harness-opencode/install.sh
```

The installer copies this package's OpenCode assets into:

```text
~/.config/opencode/plugins/qwen-harness-status.tsx
~/.config/opencode/plugins/qwen-harness-status-core.mjs
~/.config/opencode/skills/qwen-first-delegation-workflow
```

It adds the copied TUI plugin path to `~/.config/opencode/tui.json` and writes `~/.config/opencode/qwen-harness-opencode.json` so future updates know which files are managed by this package. It does not modify `opencode.json` or `oh-my-opencode-slim` settings.

If `~/.config/opencode/package.json` exists, the installer also installs the TUI runtime dependencies needed by the plugin. Pass `--no-config-deps` to skip that step.

## Uninstall

From npm:

```sh
npx qwen-harness-opencode uninstall
```

For local development from the monorepo checkout:

```sh
npm run uninstall:opencode
# or:
./packages/qwen-harness-opencode/uninstall.sh
```

The uninstaller removes only files recorded in the package manifest. Pre-existing unmanaged files are backed up during install instead of being overwritten.
