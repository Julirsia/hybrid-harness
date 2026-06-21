# Hybrid Harness Contract

이 문서는 Pi 전용 `hybrid-harness` package가 쓰는 durable artifact 계약을 설명합니다.

Canonical state directory:

```text
.pi-harness/
```

## Roles

```text
Parent Pi session
  persistent orchestrator; spec-kit tasks 해석, batch/package 결정, 결과 판단

Hybrid harness runtime
  tool/extension layer; package 실행, writer/reviewer/verification loop 호출, artifact 기록

Persistent writer session
  single writer; 구현/repair/debug를 같은 Pi session으로 이어서 수행

Fresh review/frontier sessions
  read-only review/final gate; writer self-approval 방지
```

## Core artifacts

```text
.pi-harness/
  task.md                         # overall task
  requirements.md                 # optional frontier requirements interview
  design-grill.md                 # optional frontier design stress test
  repo-map.md                     # local scout summary
  frontier-design.md              # frontier design package
  orchestration-brief.md          # ambiguity/risk brief
  orchestrator-package.md         # current parent-orchestrator execution package
  plan-review.md                  # serious-task plan review gate
  implementation-plan.json        # structured slices/criteria
  progress.json                   # machine-readable progress
  progress.md                     # human-readable progress
  local-log.md                    # writer output summaries
  test-evidence.md                # verification/test evidence
  verification-summary.json       # structured verification command results
  verification-summary.md         # readable verification summary
  claim-evidence-matrix.md        # claim ↔ evidence mapping
  git-summary.md                  # compact diff/status summary
  local-review.md                 # fresh implementation review
  final-review.md                 # final frontier gate
  run-summary.md                  # run/package summary
  usage-summary.md                # token routing summary
  run-state.json                  # resume state and writer session metadata
  active-run.json                 # background run heartbeat/cancel lock
  steering.jsonl                  # parent steering notes
  sessions/                       # persistent writer session storage
```

## `orchestrator-package.md`

`hybrid_exec` writes the active parent Pi orchestrator package here before invoking the writer. The writer prompt treats this artifact as the current bounded contract.

Required content should include:

- package/task IDs
- source spec-kit task IDs
- exact scope
- non-goals / do-not-start-next-batch notes
- likely files
- acceptance evidence
- verification commands or manual procedure
- stop conditions

## Progress state

`progress.json` tracks:

- current slice
- slice status: `pending | in_progress | done | blocked`
- acceptance criteria status: `pending | satisfied | failed | unknown`
- evidence arrays
- test observations
- frontier re-check triggers
- blockers
- next action

Completion means verified evidence, not a writer claim.

## Evidence rules

- Smoke checks such as build success, import success, HTTP 200, and process-start are baseline only.
- Behavioral acceptance criteria require runtime evidence or a documented manual procedure.
- Source evidence and runtime evidence should remain separate.
- Non-trivial criteria should have executable verification contracts.
- Stateful/retry/resume/persistence work should include reentry/idempotency probes.
- Public API, schema, auth/security, data migration, payment, or long-lived state residual gaps should force review failure or escalation.

## Resume/session rules

- Parent orchestration resume is artifact-backed via `run-state.json` and stage artifacts.
- Implementation/repair/debug uses a persistent writer session by default.
- Scout, review, and frontier gates should remain fresh/read-only.
- Do not run multiple writer sessions against the same workspace unless the work is explicitly isolated.

## Recommended spec-kit loop

```text
read spec.md/plan.md/tasks.md
  → parent Pi orchestrator chooses batch
  → hybrid_exec executionPackage
  → persistent writer implements/repairs/debugs
  → fresh review + verification artifacts
  → parent Pi orchestrator decides next package
  → repeat until complete
```
