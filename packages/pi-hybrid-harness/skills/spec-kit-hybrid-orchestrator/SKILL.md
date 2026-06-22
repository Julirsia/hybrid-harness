---
name: spec-kit-hybrid-orchestrator
description: Use when GitHub spec-kit has completed through the tasks stage and the user wants the active Pi session to orchestrate implementation through the hybrid harness with a persistent writer session.
---

# Spec-kit Hybrid Orchestrator

Use this skill after spec-kit has produced implementation-ready `spec.md`, `plan.md`, and `tasks.md` artifacts.

## Role split

- Active parent Pi session: persistent orchestrator. Read spec-kit artifacts, decide the next bounded batch, inspect harness results, and choose next package/repair/debug/stop.
- `hybrid_exec` tool: execution runtime. It receives one concrete `executionPackage`, runs the persistent single-writer implementation loop, runs deterministic verification (test/lint/build commands), runs a local-reviewer implementation review, and returns artifact references. It does not loop on review failure and does not call the frontier model — the parent drives the loop.
- Hybrid writer session: persistent single writer. It implements/repairs/debugs across packages without losing context.
- Per-package review is fresh/read-only and runs on the **local** `localReviewerModel`; do not rely on writer self-approval. Frontier tokens are reserved for the single final ship decision.
- Final gate: run `/hybrid-final` once, after all packages are complete and verification is clean. This is the only step that spends the frontier model in this mode.

## Before implementation (setup gates)

Do these once, before the first implementation package. Skipping them is the most common reason a run spins without converging.

1. **Decompose `tasks.md` into `progress.json`.** Populate real slices and acceptance criteria. If `.pi-harness/progress.json` is still the generic single-slice fallback (`S1` / "Implement requested change" / `AC1`), the harness flags `SETUP GAP` in run-summary — fix it before continuing, and keep `tasks.md` checkboxes in sync as packages complete.
2. **Establish a deterministic behavioral test for interactive/runtime tasks.** For any browser/UI/game/canvas/gameplay/runtime task, smoke checks (`tsc --noEmit`, `npm run build`, HTTP 200, screenshots) cannot satisfy the gate. Configure `testCommand` or have the first package author a runtime/e2e test (Playwright/Vitest/Puppeteer) that asserts real behavior. Until such a test exists, the harness reports `convergence: blocked-no-tests` and no package can complete.

## Loop

1. Read the relevant spec-kit `tasks.md`, `plan.md`, and `spec.md`.
2. Create a small batch/package. Prefer dependent, coherent batches over tiny independent fragments.
3. Call `hybrid_exec` with:
   - `task`: the overall feature goal, unless already active.
   - `packageId`: a stable ID such as `T003`, `B02-core`, or `debug-cycle-1`.
   - `executionPackage`: exact scope, files likely touched, acceptance checks, verification command, stop conditions, and what not to start.
   - `debug: true` only for test-failure/debug loops.
4. After the tool returns, read `.pi-harness/run-summary.md` **`## Orchestrator directives` block first** — it carries the machine-actionable signal. Then inspect `progress.json`, `local-review.md`, `verification-summary.json`, `git-summary.md` as needed.
5. Decide based on `convergence` in run-summary:
   - **`complete`** → mark the batch's `tasks.md` items checked and send the next package; when all tasks are done, go to step 6.
   - **`progressing`** → send a repair/next package that **targets the listed `highRiskResidualBlockers` and `blockingIssues` first** (highest risk first). Never declare a batch done while a high-risk residual blocker is open.
   - **`blocked-no-tests`** → do **not** send another implementation/debug package; it cannot converge. Send a package that authors a deterministic runtime/e2e test (or set `testCommand`), or escalate to the user.
   - **`stalled`** (writer made no changes, review not passing) → do **not** resend the same package. Change strategy: target the exact blockers, split the batch smaller, or escalate. If `repeatedNonProgressPackages >= 2`, escalate to the user instead of retrying.
   - Always escalate/ask the user if requirements/design conflict, or public API/schema/security/data decisions changed.
6. Repeat until all spec-kit `tasks.md` items are checked, `convergence` is `complete`, and verification is clean.
7. Run `/hybrid-final` once for the frontier ship decision (APPROVE / REQUEST_CHANGES / ESCALATE_TO_USER). This is the only frontier-model gate in this mode; per-package reviews were local.

## Execution package template

```markdown
# Package <id>: <title>

## Source tasks
- T001 ...
- T002 ...

## Scope
Implement only this batch. Do not start <next batch>.

## Required behavior
- ...

## Likely files
- ...

## Acceptance evidence
- command/procedure: ...
- expected result: ...

## Stop conditions
- Stop and report if this requires changing public API/schema/security/data ownership.
- Stop and report if prior completed batch assumptions are contradicted.
```

## Rules

- Do not let multiple writer sessions edit the same target workspace.
- Do not directly implement large changes in the parent orchestrator session.
- Keep review/validation fresh; do not ask the persistent writer to approve itself.
- Treat smoke evidence (typecheck/build/HTTP 200/screenshots) as baseline only — never as completion evidence for behavior.
- Preserve task ordering and integration consistency over maximizing parallelism.
- Obey the `## Orchestrator directives` block in run-summary; it is the source of truth for the next move.
- Never re-send a package that produced `convergence: stalled` or `blocked-no-tests` unchanged. Repeating no-op/blocked packages wastes the loop — change strategy or escalate.
- When the reviewer reports `highRiskResidualBlockers`, the very next package must address them before any new scope. A batch is not done while one is open.
- Prefer a real git repo: without git there is no pre-run checkpoint and review falls back to a file manifest (no diff). `git init` before starting if possible.
