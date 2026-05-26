---
name: qwen-first-codex-orchestration
description: Use when Codex should save frontier tokens by delegating repository scout, implementation, test, repair, or evidence loops to Pi/local Qwen while Codex keeps requirements, architecture, and final quality gates.
---

# Codex Qwen-First Orchestration

Use this skill when a Codex task is large enough that broad file reading, repeated implementation, or test repair would waste frontier tokens.

## Core Contract

Codex owns requirements, architecture decisions, plan gates, escalation decisions, and final review.

Pi/local Qwen handles repository scout, bounded implementation, test execution, repair loops, and compact evidence generation.

Quality gates are frontier-owned. Local agents may gather facts and produce candidate changes, but they do not decide whether requirements are ready, a plan is safe, or the final result should ship.

## State Directory

Use `.qwen-harness/` as the canonical durable state directory.

Required durable files for non-trivial work:

```text
.qwen-harness/
  task.md
  execution-package.md
  implementation-plan.json
  progress.json
  progress.md
  state.json
  events.jsonl
  evidence-bundle.md
  frontier-review-input.md
  handoffs/
  runs/
```

Do not create a Codex-specific harness directory. If a project already has `.pi-harness/`, import or summarize evidence into `.qwen-harness/` instead of splitting active state.

## Preferred Tool Flow

When MCP tools are available:

1. Use `codex_harness_scout` for read-only exploration before broad Codex file reading.
2. Use `codex_harness_delegate` for bounded implementation/test loops after Codex has supplied acceptance criteria.
3. Use `codex_harness_status` to read compact progress.
4. Use `codex_harness_collect_evidence` for reproducible verification commands.
5. Use `codex_harness_review_bundle` before Codex final review.

Leave `live` false unless the user or current task explicitly wants real Pi execution. Dry-run mode still creates the `.qwen-harness/` taskpack and Pi command preview.

## Escalation

Pause local delegation and keep judgment with Codex when:

- requirements are ambiguous
- public API, schema, auth, payment, migration, or long-lived state behavior changes
- local evidence conflicts with acceptance criteria
- the same verification failure repeats without new evidence
- the local plan requires destructive commands or secret access

Completion requires Codex to inspect compact evidence and run or verify the final command evidence. Do not approve based only on Pi/local Qwen claims.
