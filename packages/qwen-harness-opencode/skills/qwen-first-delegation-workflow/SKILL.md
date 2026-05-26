---
name: qwen-first-delegation-workflow
description: Use when the user says qwen-first, token saving, GPT-5.5 minimization, cheap subagents, or wants high-quality implementation while minimizing orchestrator/oracle token usage.
---

# Qwen-First Delegation Workflow

Use this workflow to minimize GPT-5.5 orchestrator and oracle usage while preserving implementation quality.

This is not a "delegate immediately" workflow. The orchestrator should first create a compact but detailed execution package, similar to the `pi-harness` style: clear goal, done criteria, files, checkpoints, verification, hard stops, routing decisions, and durable state files. Qwen subagents should receive implementation-ready briefs, not vague exploration or design responsibility.

## Goal

The GPT-5.5 orchestrator should spend tokens only where it adds unique value:

- interpreting the user's intent
- identifying risks and unknowns
- designing the implementation approach at the right level of detail
- decomposing work into small executable checkpoints
- writing precise implementation-ready subagent briefs
- integrating results
- deciding whether escalation is necessary
- maintaining compact durable state/progress artifacts when the task is non-trivial

Token-heavy work should go to Qwen-based subagents by default:

- broad codebase exploration
- reading many files
- implementation
- test writing and test repair
- repeated fix loops
- UI polish
- documentation/library lookups when the answer can be gathered by the configured librarian

## Default Routing

Prefer Qwen subagents unless there is a clear reason not to.

| Work type | Default agent |
| --- | --- |
| Locate files, symbols, call paths, project structure | `@explorer` |
| External docs/library behavior | `@librarian` |
| Bounded implementation and bug fixes | `@fixer` |
| Tests, fixtures, mocks, verification loops | `@tester` |
| UI/UX, responsive layout, visual polish | `@designer` |
| Senior architecture/code review | `@oracle` only when escalation criteria are met |

## Expensive Model Budget Rules

### The orchestrator should avoid

- reading many files directly
- doing broad grep/glob exploration directly
- implementing multi-file changes directly
- writing or repairing tests directly
- repeatedly debugging failed test output directly
- calling `@oracle` for routine decisions

### The orchestrator may do directly

- tiny single-file edits when delegation overhead is larger than the edit
- detailed design and checkpoint planning before delegation
- final integration reasoning over compact subagent summaries
- critical requirement clarification with the user
- small verification command selection

## Orchestrator Design-First Contract

Before sending implementation work to Qwen, the orchestrator should produce an internal or user-visible execution package for any non-trivial task.

Non-trivial means any task with one or more of:

- likely multi-file changes
- tests or migrations
- unclear integration points
- external API/library behavior
- UI plus logic
- persistence, auth, security, billing, or data-shape changes
- multiple possible implementation strategies

The package should be detailed enough that a Qwen agent can implement without making product or architecture decisions. For medium and large tasks, write the package and progress state into a harness folder so future turns can resume without reloading all prior conversation.

## Stateful Harness Mode

For medium or large tasks, or whenever the user asks for resumable/progress-managed work, use a project-local harness directory.

Default directory:

```text
.qwen-harness/
```

If the project already uses `.pi-harness/` and the user asks to follow that style, use or mirror that structure instead. Do not create both unless the user explicitly asks.

### Why use a harness folder

- Keeps GPT-5.5 context small across long tasks.
- Gives Qwen agents exact artifact paths instead of long pasted context.
- Makes progress, blockers, verification, and decisions resumable.
- Separates full logs/evidence from frontier-visible summaries.

### Required artifacts

Create these files for medium/large tasks:

```text
.qwen-harness/
  task.md                    # original user request and clarified scope
  repo-map.md                # compact codebase map from explorer
  execution-package.md       # orchestrator design package
  decisions.md               # orchestrator-owned decisions and non-overridable constraints
  implementation-plan.json   # machine-readable slices/checkpoints/acceptance criteria
  progress.md                # human-readable current status
  progress.json              # machine-readable status
  state.json                 # phase, models, timestamps, artifact paths
  events.jsonl               # append-only event log
  live-log.md                # compact running log, not full command dumps
  evidence-bundle.md         # final verification evidence and artifact index
  handoffs/                  # exact prompts/contracts sent to Qwen subagents
    S1-explorer.md
    S2-fixer.md
    S3-tester.md
  checkpoints/
    <timestamp>-<label>/
      README.md
      status.txt
      staged.patch
      worktree.patch
      untracked.txt
```

Small tasks may skip the harness folder unless the user explicitly requests durable state.

### Artifact content rules

Keep artifacts useful but compact.

- `task.md`: exact user request, priorities, non-goals, acceptance criteria.
- `repo-map.md`: relevant files, symbols, tests, commands, architecture notes; include file paths/line refs when available.
- `execution-package.md`: the design-first package from this skill.
- `decisions.md`: design decisions, rejected alternatives, invariants Qwen must not change, and oracle escalation triggers.
- `implementation-plan.json`: slices with `id`, `title`, `status`, `owner`, `risk`, routing flags, dependencies, remaining work, and evidence.
- `progress.md`: current slice, next action, completed slices, blockers, verification summary.
- `progress.json`: same state in compact JSON for machine updates.
- `state.json`: `phase`, `createdAt`, `updatedAt`, `task`, model routing, artifact paths, last completed checkpoint.
- `events.jsonl`: append one JSON object per major event: plan_created, delegated, slice_started, slice_done, test_run, blocker, completed.
- `live-log.md`: concise chronological notes; never paste huge logs.
- `evidence-bundle.md`: commands run, pass/fail, remaining risks, changed files, final acceptance evidence.
- `handoffs/*.md`: exact task briefs given to subagents, one file per delegated slice/attempt.

### Token usage and efficiency contract

When token usage is available, record it in the harness so the OpenCode TUI sidebar can show how token-efficient the workflow is.

Use this compact shape in `progress.json`, `state.json`, slice objects, evidence objects, or `events.jsonl` entries:

```json
{
  "tokenUsage": {
    "frontier": {
      "input": 0,
      "output": 0,
      "total": 0
    },
    "local": {
      "input": 0,
      "output": 0,
      "total": 0
    },
    "unknown": {
      "input": 0,
      "output": 0,
      "total": 0
    }
  }
}
```

Allowed aliases are `usage` or `tokens` instead of `tokenUsage`, and OpenAI-style fields such as `input_tokens`, `output_tokens`, and `total_tokens`. Include `model`, `provider`, `agent`, `owner`, or `category` when possible so tooling can classify usage as `local` or `frontier`.

Recommended event shape:

```json
{
  "type": "delegated",
  "at": "ISO-8601 timestamp",
  "sliceId": "S3",
  "agent": "fixer",
  "model": "llama-server/qwen36-27b-mtp-iq4xs",
  "usage": {
    "input_tokens": 12000,
    "output_tokens": 1800,
    "total_tokens": 13800
  }
}
```

The sidebar computes:

- total observed tokens
- local/Qwen token share
- frontier token total
- local-to-frontier ratio
- efficiency label: `local-heavy`, `balanced`, or `frontier-heavy`

Avoid recording the same token event twice. If both per-event and aggregate usage are present, keep aggregate usage clearly scoped to avoid double counting.

### Artifact size and compaction policy

Harness artifacts exist to reduce expensive-model context, not to become another large context source.

Keep parent-visible files compact:

- `progress.md`: current state only; target 200-400 lines max.
- `repo-map.md`: relevant map only; prefer file paths and line refs over copied code.
- `execution-package.md`: detailed enough for implementation, but avoid full file dumps.
- `decisions.md`: append important decisions, then periodically group superseded decisions under an "Archived/Superseded" section.
- `live-log.md`: compact older entries when it grows beyond ~400 lines.
- `events.jsonl`: append-only; do not read the whole file into GPT-5.5 context unless debugging timeline issues.
- `evidence-bundle.md`: include final summaries and artifact paths, not full logs.
- Command/test logs: store only concise summaries in harness files; keep full logs in separate artifacts only when needed and reference their paths.

When resuming, read in this order and stop when enough context is recovered:

1. `state.json`
2. `progress.md`
3. `implementation-plan.json`
4. `decisions.md`
5. `execution-package.md` only if details are needed
6. `repo-map.md` only if code location context is needed

Do not automatically read `events.jsonl`, old handoffs, or full logs.

### Decisions file

Use `decisions.md` to prevent Qwen subagents from reopening settled strategy.

Recommended shape:

```text
# Decisions

## Active decisions

### D001: <short title>
- Decision: <chosen approach>
- Rationale: <why>
- Alternatives rejected: <brief list>
- Applies to: <slice IDs/files>
- Qwen must not change: <invariants>
- Revisit only if: <explicit trigger>

## Oracle escalation triggers
- <project/task-specific trigger>

## Superseded decisions
- <old decisions moved here when no longer active>
```

Qwen subagents may cite `decisions.md`, but the orchestrator owns edits to it unless explicitly delegated.

### Machine-readable plan shape

Use this shape for `implementation-plan.json`:

```json
{
  "version": 1,
  "updatedAt": "ISO-8601 timestamp",
  "task": "short task summary",
  "currentSliceId": "S1",
  "slices": [
    {
      "id": "S1",
      "title": "bounded slice title",
      "status": "pending | in_progress | completed | blocked | skipped",
      "owner": "explorer | fixer | tester | designer | orchestrator",
      "risk": "low | medium | high",
      "requiresTester": true,
      "requiresOracle": false,
      "parallelSafe": false,
      "dependsOn": [],
      "handoff": ".qwen-harness/handoffs/S1-fixer.md",
      "remaining": ["specific remaining work"],
      "evidence": []
    }
  ],
  "acceptanceCriteria": [
    {
      "id": "AC1",
      "description": "observable acceptance criterion",
      "status": "pending | passed | failed",
      "evidence": []
    }
  ],
  "blockers": [],
  "verification": {
    "focused": [],
    "full": []
  }
}
```

### State shape

Use this shape for `state.json`:

```json
{
  "version": 1,
  "phase": "intake | exploring | designed | implementing | testing | blocked | completed",
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp",
  "task": "full or summarized user task",
  "frontierModel": "openai/gpt-5.5",
  "localWorkerModel": "llama-server/qwen36-27b-mtp-iq4xs",
  "localReviewerModel": "llama-server/qwen36-27b-mtp-iq4xs",
  "artifacts": {
    "task": ".qwen-harness/task.md",
    "repoMap": ".qwen-harness/repo-map.md",
    "executionPackage": ".qwen-harness/execution-package.md",
    "decisions": ".qwen-harness/decisions.md",
    "implementationPlan": ".qwen-harness/implementation-plan.json",
    "progress": ".qwen-harness/progress.md",
    "evidence": ".qwen-harness/evidence-bundle.md",
    "handoffs": ".qwen-harness/handoffs/"
  },
  "lastCompletedSliceId": null,
  "currentSliceId": "S1"
}
```

### Progress update rules

Update harness artifacts at these points:

1. After intake/clarification: write `task.md` and initialize `state.json`.
2. After exploration: write or update `repo-map.md`.
3. After orchestrator design: write `execution-package.md`, `decisions.md`, and `implementation-plan.json`.
4. Before each Qwen delegation: write a `handoffs/<slice>-<agent>-<attempt>.md` file, mark slice `in_progress`, append `delegated` event.
5. After each Qwen result: update slice status, remaining work, evidence, blockers, and `progress.md`.
6. After test/verification runs: append command/result evidence and update acceptance criteria.
7. Before final response: write `evidence-bundle.md` and mark `state.phase = completed` or `blocked`.

Do not let Qwen agents make broad plan/status decisions. They may update their assigned slice evidence if explicitly asked, but the orchestrator owns the canonical plan, acceptance criteria, and final state transitions.

### Checkpoints

Before risky or broad writer work, create a checkpoint under `checkpoints/` containing:

- `README.md`: checkpoint reason and current slice
- `status.txt`: `git status` output, if available
- `staged.patch`: staged diff, if available
- `worktree.patch`: unstaged diff, if available
- `untracked.txt`: relevant untracked files, if available

If the repo is not a git repository, write `README.md` explaining that no git checkpoint was available and record the current artifact state only.

### Subagent usage with harness artifacts

When delegating, pass artifact paths instead of long pasted context whenever possible:

```text
Read .qwen-harness/execution-package.md and .qwen-harness/implementation-plan.json.
Execute slice S3 only.
Do not edit files outside the slice scope.
Return changed files, commands run, evidence, blockers, and whether S3 is complete.
```

The parent orchestrator should then update the canonical harness files.

### Handoff files

Every delegated Qwen task for medium/large work should be saved first under `handoffs/`.

Use filenames that preserve slice, role, and attempt:

```text
.qwen-harness/handoffs/S2-fixer-a1.md
.qwen-harness/handoffs/S2-fixer-a2.md
.qwen-harness/handoffs/S2-tester-a1.md
```

Each handoff should include:

- objective
- artifact paths to read
- slice ID and exact scope
- decisions/invariants to obey
- files allowed to edit
- files forbidden to edit
- verification command or discovery instruction
- stop rules
- return format

Benefits:

- reproducible delegation
- easier bounded retry after failure
- less parent-context usage
- clear audit trail of what Qwen was asked to do

On retry, create a new handoff file with the new attempt number instead of overwriting the old one.

### Execution Package Template

Use this structure before delegation:

```text
# Execution Package: <task name>

## Goal
Objective:
- One concise sentence describing the target outcome.

Done when:
- Observable acceptance criteria.
- User-visible behavior or API behavior.
- Test/verification expectations.

Non-goals:
- Adjacent features or refactors that must not be included.

## Current Context
Known facts:
- Facts from the user request and prior exploration.

Assumptions:
- Safe assumptions the orchestrator is making.

Open questions:
- Questions that must be asked before work, if any.
- If no blocking questions exist, state that implementation can proceed.

## Files and Boundaries
Expected files/directories:
- Likely files to inspect or change.

Must not edit:
- Secret files, generated files, unrelated modules, or user-forbidden paths.

Preserve:
- Existing APIs, behavior, styles, data contracts, compatibility constraints.

## Design
Approach:
- Chosen implementation strategy.

Key decisions:
- Decisions already made by the orchestrator.
- Trade-offs accepted.

Data/control flow:
- How the change should fit into the existing system.

Edge cases:
- Cases the implementation must handle.

## Checkpoints
| ID | Task | Owner | Verify |
| --- | --- | --- | --- |
| CP01 | Explore relevant files and confirm integration points. | explorer | concise map with file refs |
| CP02 | Implement bounded feature/fix slice. | fixer | focused command or static check |
| CP03 | Add/update tests. | tester | focused tests pass |
| CP04 | Final verification and summary. | orchestrator/tester | full relevant checks |

## Verification
Focused commands:
- Smallest useful commands.

Full commands:
- Broader checks to run before done.

If commands are unknown:
- Ask `@tester` to discover the smallest relevant verification command.

## Hard Stops
- destructive command
- secret/credential access or exfiltration
- unexpected large refactor
- public API/data contract change not in the package
- repeated verification failure without new evidence
- architectural decision not already covered

## Parallelization Decision
- `PARALLEL_OK`: independent files/slices, no write conflicts.
- `SEQUENTIAL_RECOMMENDED`: tightly coupled files, shared state, or dirty worktree risk.
- Explain the reason in one sentence.

## Subagent Routing
- explorer: what to inspect and return
- librarian: what docs/API facts to verify, if needed
- fixer: exact implementation slice
- tester: exact test/verification slice
- designer: exact UI/UX slice, if needed
- oracle: only if escalation policy is met
```

The execution package can be compact. Do not over-document tiny changes. But for substantial implementation, spend GPT-5.5 tokens on this package rather than on direct code reading or editing.

## Planning Depth Rules

Use the minimum planning depth that prevents Qwen from guessing.

### Small task

Examples: one obvious bug, one small file, no tests needed.

- No full execution package required.
- Give Qwen a short Objective/Scope/Verification brief, or do it directly if delegation overhead is larger.

### Medium task

Examples: multi-file feature slice, tests required, known framework patterns.

- Create a compact execution package.
- Create harness files, including `decisions.md` and per-slice `risk`/routing fields.
- Usually run `@explorer` first if file targets are not already known.
- Use `@fixer` then `@tester` sequentially unless file ownership is clearly independent.

### Large/high-risk task

Examples: API contract changes, persistence, auth, billing, migrations, cross-cutting refactor.

- Create a full execution package.
- Create full harness state and handoff files before any writer work.
- Use read-only Qwen exploration first.
- Prefer staged orchestration: read-only plan fanout → single writer → read-only validation/test fanout.
- Consider `@oracle` only if escalation policy is met.

## Slice Risk and Routing Fields

Every non-trivial slice in `implementation-plan.json` should include:

- `risk`: `low`, `medium`, or `high`
- `requiresTester`: whether a tester pass is required before the slice can be accepted
- `requiresOracle`: whether oracle review is required before/after implementation
- `parallelSafe`: whether this slice can run concurrently with other writer slices
- `handoff`: path to the current/next handoff file

Risk guidance:

- `low`: isolated, reversible, no public API/data contract impact.
- `medium`: multi-file, behavior-changing, test-sensitive, or user-visible.
- `high`: architecture, security, persistence, migrations, billing, auth, public APIs, data-loss risk, or cross-cutting refactor.

Routing guidance:

- `requiresTester = true` for behavior changes, bug fixes, refactors with tests available, or anything user-visible.
- `requiresOracle = true` only when the oracle escalation policy is already met.
- `parallelSafe = false` for slices touching shared files, config, schemas, package files, central app entrypoints, or any dirty-worktree-sensitive area.
- Parallel writer slices require `parallelSafe = true` and disjoint file sets in the execution package.

## Oracle Escalation Policy

Do not call `@oracle` by default.

Use `@oracle` only when at least one condition is true:

- security, privacy, data integrity, or data-loss risk exists
- a major architecture/API boundary decision is required
- there is a costly trade-off involving maintainability, scalability, or performance
- two bounded Qwen implementation/fix attempts failed
- Qwen reports uncertainty that affects architecture or product behavior
- the user explicitly requests senior review, oracle review, or deep architecture advice

When escalating, pass only compact context:

- the user goal
- relevant file paths
- Qwen summaries
- failing commands/errors
- the exact decision needed

## Decomposition Rules

Before implementation, split the work into small briefs that Qwen can execute without strategy decisions.

Good task boundaries:

- one feature slice
- one subsystem/folder
- one bug and its tests
- one UI component or screen
- one verification/failure loop

Avoid giving Qwen vague strategy tasks such as:

- “make this better”
- “refactor the whole project”
- “figure out the architecture”
- “implement everything”

Each implementation checkpoint should have:

- a single owner
- clear file/scope boundaries
- explicit done criteria
- a verification contract
- stop rules for ambiguity or risk

Prefer one active writer for overlapping files. Parallel writers are allowed only when their file sets are disjoint and the execution package says `PARALLEL_OK`.

## Subagent Brief Template

Use this shape when delegating. For implementation tasks, derive it from the execution package rather than making the child design the solution.

```text
Objective:
- What to accomplish in one sentence.

Context:
- Link to or summarize the relevant execution package/checkpoint.
- Include decisions already made by the orchestrator.

Scope:
- Files, directories, or search areas to inspect/change.

Constraints:
- Behavior that must not change.
- APIs/contracts to preserve.
- Style or patterns to follow.

Non-goals:
- Explicitly exclude adjacent work.

Execution:
- Concrete checkpoint to complete.
- Whether edits are allowed.

Stop rules:
- When to stop and report ambiguity/risk instead of guessing.

Verification:
- Specific commands to run, or ask the agent to discover the smallest relevant command.

Return:
- Files changed.
- Summary of behavior.
- Commands run and results.
- Any blockers/decisions needed.
```

## Parallelization

Parallelize independent Qwen work aggressively:

- `@explorer` can map code while `@librarian` checks docs.
- separate `@fixer` tasks can edit independent folders.
- `@tester` can add tests for a completed bounded feature while another `@fixer` handles an unrelated slice.
- `@designer` can polish UI once functional constraints are known.

Do not parallelize tasks that edit the same files or require sequential decisions.

For broad or risky diffs, prefer staged orchestration instead of simultaneous writers:

1. Read-only planning/exploration fanout.
2. One writer agent applies the accepted plan.
3. Read-only tester/reviewer validation fanout.

This preserves quality while keeping expensive GPT-5.5 context small.

## Implementation Loop

1. Interpret the request and identify unknowns.
2. Choose planning depth: small, medium, or large/high-risk.
3. For medium/large tasks, initialize `.qwen-harness/` or the existing project harness directory.
4. If broad context is needed, delegate exploration to `@explorer` and request compact file/line evidence for `repo-map.md`.
5. Create the execution package with goal, done criteria, files, design, checkpoints, verification, hard stops, and parallelization decision.
6. Write `execution-package.md`, `decisions.md`, `implementation-plan.json`, `progress.md`, and `state.json`.
7. Decide the smallest safe implementation slices.
8. Write a handoff file before each delegation.
9. Send bounded implementation to `@fixer` using checkpoint-specific briefs and artifact paths.
10. Send tests/verification to `@tester` using checkpoint-specific briefs and artifact paths.
11. Integrate subagent summaries against the execution package and update harness artifacts.
12. Compact oversized harness artifacts before resuming or finalizing.
13. Run or request final verification as orchestrator.
14. Write `evidence-bundle.md` and final state.
15. Escalate to `@oracle` only if the escalation policy is met.

## Review Gates

Use review gates sparingly because the goal is GPT-5.5 minimization.

- `@tester` gate: required for changes that add/modify behavior with test coverage available.
- `@designer` gate: required for visually significant UI changes.
- `@oracle` gate: not required by default; use only under the escalation policy.
- Parent/orchestrator gate: always compare final result to the execution package before reporting done.

For large tasks, ask Qwen agents to write compact handoff artifacts or summaries instead of dumping full logs into the parent context.

## Quality Bar

Qwen output is acceptable only when:

- it follows the execution package/checkpoint
- it satisfies the exact brief
- it stays within scope
- it reports changed files
- it reports verification commands and results
- it identifies unresolved blockers instead of guessing

If a Qwen result is incomplete, send one bounded follow-up to the same subagent before considering oracle escalation.

## User Communication

Keep messages concise.

- Mention delegation briefly: “Qwen-first로 탐색/구현을 분리합니다.”
- Do not expose long internal reasoning.
- Summarize only decisions, changed files, verification, and blockers.

## Default Assumption

When this skill is active, assume the user prefers lower GPT-5.5 token usage over the orchestrator directly inspecting or editing large amounts of code.

Only spend GPT-5.5 tokens directly when doing so clearly improves quality, safety, or reliability.
