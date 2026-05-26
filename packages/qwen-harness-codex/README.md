# qwen-harness-codex

Codex CLI and MCP bridge for Qwen/Pi-backed harness runs.

The package keeps Codex as the frontier orchestrator and final verifier, while Pi/local Qwen performs high-token scout, implementation, test, repair, and evidence loops. Durable state is always written to `.qwen-harness/`.

## Install

From the package checkout:

```sh
npx qwen-harness-codex install
```

For local development from the monorepo:

```sh
npm run cli -w qwen-harness-codex -- install
```

The installer copies the Codex skill into:

```text
~/.codex/skills/qwen-first-codex-orchestration
```

It also appends/replaces this MCP block in `~/.codex/config.toml`:

```toml
[mcp_servers.qwen_harness_codex]
command = "node"
args = ["<package>/mcp/server.mjs"]
startup_timeout_sec = 30
```

## Commands

```sh
qwen-harness-codex doctor
qwen-harness-codex new-task --task "implement bounded task" --verification-command npm test
qwen-harness-codex scout --task "map repo"
qwen-harness-codex delegate --task "implement task" --verification-command npm test
qwen-harness-codex status
qwen-harness-codex collect-evidence --verification-command npm test
qwen-harness-codex review-bundle
qwen-harness-codex mcp-config
qwen-harness-codex uninstall
```

`scout` and `delegate` default to dry-run mode. Pass `--live` to actually call the `pi` binary.

## MCP Tools

- `codex_harness_scout`
- `codex_harness_delegate`
- `codex_harness_status`
- `codex_harness_collect_evidence`
- `codex_harness_review_bundle`

## Verification

```sh
npm test -w qwen-harness-codex
npm pack --dry-run -w qwen-harness-codex
```
