---
name: spec-kit-hybrid-orchestrator
description: Use when GitHub spec-kit has completed through the tasks stage and the user wants the active Pi session to orchestrate implementation through the hybrid harness with a persistent writer session.
---

# Spec-kit Hybrid Orchestrator

Use this skill after spec-kit has produced implementation-ready `spec.md`, `plan.md`, and `tasks.md` artifacts.

## Role split

- Active parent Pi session: persistent orchestrator. Read spec-kit artifacts, decide the next bounded batch, inspect harness results, and choose next package/repair/debug/stop.
- `hybrid_exec` tool: execution runtime. It receives one concrete `executionPackage`, runs the persistent single-writer implementation/repair loop, runs verification/review, and returns artifact references.
- Hybrid writer session: persistent single writer. It implements/repairs/debugs across packages without losing context.
- Review/final gates: fresh/read-only; do not rely on writer self-approval.

## Loop

1. Read the relevant spec-kit `tasks.md`, `plan.md`, and `spec.md`.
2. Create a small batch/package. Prefer dependent, coherent batches over tiny independent fragments.
3. Call `hybrid_exec` with:
   - `task`: the overall feature goal, unless already active.
   - `packageId`: a stable ID such as `T003`, `B02-core`, or `debug-cycle-1`.
   - `executionPackage`: exact scope, files likely touched, acceptance checks, verification command, stop conditions, and what not to start.
   - `debug: true` only for test-failure/debug loops.
4. After the tool returns, inspect only compact artifacts first:
   - `.pi-harness/run-summary.md`
   - `.pi-harness/progress.json`
   - `.pi-harness/local-review.md`
   - `.pi-harness/verification-summary.json`
   - `.pi-harness/git-summary.md`
5. Decide:
   - next package if review/verification pass for the current batch;
   - repair package if review failed or acceptance evidence is missing;
   - debug package if full tests fail;
   - escalate/ask user if requirements/design conflict, public API/schema/security/data decisions changed, or the same failure repeats.
6. Repeat until all spec-kit tasks are complete and final verification is clean.

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
- Treat smoke evidence as baseline only.
- Preserve task ordering and integration consistency over maximizing parallelism.
