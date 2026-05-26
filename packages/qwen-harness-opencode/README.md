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

```sh
npm run install:opencode
# or, from the monorepo root:
./packages/qwen-harness-opencode/install.sh
```

The installer symlinks this package into:

```text
~/.config/opencode/plugins/qwen-harness-status.tsx
~/.config/opencode/plugins/qwen-harness-status-core.mjs
~/.config/opencode/skills/qwen-first-delegation-workflow
```

It adds this package's TUI plugin path to `~/.config/opencode/tui.json`. It does not modify `opencode.json` or `oh-my-opencode-slim` settings.

## Uninstall

```sh
npm run uninstall:opencode
# or, from the monorepo root:
./packages/qwen-harness-opencode/uninstall.sh
```

Existing non-symlink files are never removed by the uninstaller.
