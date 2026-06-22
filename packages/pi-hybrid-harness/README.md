# pi-hybrid-harness

Pi package for a token-saving hybrid workflow:

```text
local Qwen scout -> GPT-5.5 architect -> local Qwen implementation/test loop -> GPT-5.5 implementation review -> GPT-5.5 final gate
```

The goal is to spend frontier-model tokens on high-leverage design and quality gates, while using the local llama.cpp Qwen models for exploration, implementation, testing, repair loops, and control-plane bookkeeping.

## Defaults

- State directory: `.pi-harness/`
- Local endpoint: `http://192.168.0.44:8080/v1`
- Local worker: `local-qwen/qwen36-27b-mtp-q5kxl`
- Local reviewer: `local-qwen/qwen36-27b-mtp-q5kxl`
- Frontier: `openai-codex/gpt-5.5` with `high` thinking

The shipped local endpoint is the author's LAN. To point the harness at your own local server without editing defaults, set environment variables (they override the packaged defaults but a project `.pi-harness/config.json` still wins):

```bash
export HYBRID_LOCAL_BASE_URL=http://127.0.0.1:8080/v1
export HYBRID_LOCAL_WORKER_MODEL=local-qwen/<your-model>
export HYBRID_LOCAL_REVIEWER_MODEL=local-qwen/<your-model>
export HYBRID_FRONTIER_MODEL=openai-codex/gpt-5.5
# optional: HYBRID_LOCAL_PROVIDER
```

Run `/hybrid-doctor` to verify the endpoint; if it can't reach the local server it prints a "How to fix" section. Use `/hybrid-models` to pick models interactively.

The extension dynamically registers a `local-qwen` provider from the llama.cpp `/v1/models` endpoint. It also registers a `hybrid_run` custom tool with compact/expanded Pi TUI rendering for live harness progress.

## Install / update

The recommended source is the GitHub ref. This keeps Pi aligned with the commits pushed to this repository instead of relying on an npm package publish or package version bump.

```bash
pi install -l git:github.com/Julirsia/hybrid-harness@main
```

Update later with:

```bash
pi update git:github.com/Julirsia/hybrid-harness@main
```

From the monorepo root, the same git source can be passed through the helper script:

```bash
PI_HYBRID_HARNESS_SOURCE=git:github.com/Julirsia/hybrid-harness@main npm run update:pi
```

For local development from this checkout, install the local path instead. This uses your working tree directly and does not automatically track GitHub `main`.

```bash
npx . install -l --source .
# or from the monorepo root:
npx ./packages/pi-hybrid-harness install -l --source ./packages/pi-hybrid-harness
```

Then reload Pi:

```text
/reload
```

## Commands

```text
/hybrid-run <task>      # full orchestration with configured/default maxFrontierPasses (default 2)
/hybrid-run             # resume the latest task from artifact-backed stage checkpoints
/hybrid-run-fast <task> # token-saving mode: maxFrontierPasses forced to 1
/hybrid-run-thorough <task> # thorough mode: maxFrontierPasses forced to 2
/hybrid-handoff-run <dir> # import external handoff docs and run local-only lane implementation/review/repair loops
/hybrid-handoff-resume # resume an imported external handoff from unfinished lanes
/hybrid-handoff-status # show imported handoff lane progress
hybrid_exec tool       # parent Pi orchestrator executes one spec-kit/task batch package through the persistent writer loop
/hybrid-monitor        # toggle live child-session output modal (F8 fallback shortcut)
/hybrid-writer-session # show persistent writer session id/path and bounded transcript metadata
/hybrid-steer <note>    # queue parent steering for the next child session/stage boundary
/hybrid-steering        # show queued/consumed parent steering notes
/hybrid-steer-clear     # clear queued/consumed parent steering notes
/hybrid-cancel          # cancel the active background run and current child session
/hybrid-retry <stage>   # clear one stage checkpoint so it reruns on the next /hybrid-run
/hybrid-resume-from <stage> # clear a stage and downstream checkpoints, then resume
/hybrid-interview <request-or-answer> # frontier-owned requirements interview; writes requirements.md
/hybrid-grill <plan-or-design> # frontier-owned design stress test; writes design-grill.md
/hybrid-doctor          # endpoint, pi subprocess, git, and local model smoke check
/hybrid-config          # create/show .pi-harness/config.json
/hybrid-models          # pick worker/reviewer/frontier models from Pi's available models
/hybrid-install-companions # install pi-show-diffs + pi-subagents, remove legacy pi-subagentura if present
/hybrid-progress        # show slice, acceptance criteria, trigger, and test progress
/hybrid-usage           # show local vs frontier recorded usage totals
/hybrid-checkpoint      # create a git patch checkpoint
/hybrid-rollback        # reverse-apply latest tracked checkpoint patch
/hybrid-reset           # clear current run artifacts while keeping config/doctor
/hybrid-start <task>    # local scout + frontier design package only
/hybrid-loop [n]        # local implementation/test loop, default max from config
/hybrid-review          # frontier read-only implementation review over design, logs, and diff
/hybrid-final           # frontier final gate over compressed artifact pack
/hybrid-status          # show state and artifacts
```

Default full run policy:

```text
1. Local Qwen scout maps the repo.
2. GPT-5.5 writes frontier-design.md.
3. Local Qwen extracts structured progress into progress.json/progress.md: slices, acceptance criteria, frontier re-check triggers.
4. Local Qwen implements and tests for maxLocalLoops.
5. After each iteration, Local Qwen updates progress, classifies test failures, and chooses the next repair strategy.
6. GPT-5.5 reviews implementation quality.
7. If implementation review is FAIL, local repair repeats up to maxReviewRepairCycles.
8. If a frontier re-check trigger becomes active, the local loop stops and escalates to the frontier gate.
9. GPT-5.5 runs the final gate.
7. If GPT-5.5 returns REQUEST_CHANGES and maxFrontierPasses > 1, the final review is fed back into another local repair pass.
8. APPROVE / REQUEST_CHANGES / ESCALATE_TO_USER is written to final-review.md and run-summary.md.
```

## External handoff mode

If another agent/tool already prepared handoff documents, skip frontier scout/design and let the local model run the implementation/review/repair loop over the prepared worker prompts:

```text
/hybrid-handoff-run outputs/personal-finance-handoff
/hybrid-monitor
```

The handoff directory should contain `manual-handoff-spec.json` when available and lane prompts at `lanes/**/05-worker-prompt.md`. The harness imports the handoff into `.pi-harness/requirements.md`, `.pi-harness/frontier-design.md`, `.pi-harness/implementation-plan.json`, `.pi-harness/progress.json`, then processes lanes in numeric order. Each lane runs through the persistent single-writer Pi session using the configured `localWorkerModel`; validation commands from the handoff are executed; `localReviewerModel` reviews the lane in a separate read-only pass; failed validation/review triggers bounded local repair attempts. After all lanes, the harness reruns inferred verification commands and calls the configured frontier model for the final gate. Only `APPROVE` marks the handoff complete. Resume with `/hybrid-handoff-resume` and inspect with `/hybrid-handoff-status`.

Implementation and repair remain local after import; the frontier model is reserved for the final shipping decision.

## Artifacts

The package writes durable state to `.pi-harness/`:

```text
.pi-harness/
  state.json
  run-state.json              # cycle-aware stage checkpoints for resume
  active-run.json             # background run lock/heartbeat while active
  config.json                 # optional overrides
  task.md
  repo-map.md
  frontier-design.md
  implementation-plan.json
  progress.json
  progress.md
  test-evidence.md
  claim-evidence-matrix.md
  plan-review.md
  requirements.md
  design-grill.md
  handoff-manifest.json
  handoff-review-<lane>.md
  local-log.md
  orchestration-brief.md
  orchestrator-package.md
  user-clarifications.md
  steering.jsonl
  git-summary.md
  local-review.md
  final-review.md
  run-summary.md
  usage-summary.md
  live-log.md
  events.jsonl
  doctor.md
  sessions/
  checkpoints/
```

Resume is artifact-backed at the orchestration level, while local implementation/repair/debug work uses one persistent writer session by default. If a run is interrupted, rerun `/hybrid-run` without a task or call `hybrid_run` with `resume: true`; completed stages with matching artifacts are skipped, read-only scout/review/frontier gates remain fresh, and the next local worker turn continues the saved writer session from `.pi-harness/sessions/`. `/hybrid-monitor` shows the active worker stream from memory; `/hybrid-writer-session` shows session id/path and file sizes without duplicating or expanding the transcript.

For spec-kit-style workflows, the parent Pi conversation can act as the persistent orchestrator: after `tasks.md` is ready, it chooses the next batch, calls the `hybrid_exec` tool with a bounded `executionPackage`, receives `progress.json`, `local-log.md`, `test-evidence.md`, `git-summary.md`, `verification-summary.json`, and `local-review.md`, then decides whether to send the next batch, a repair package, a debug package, or stop/escalate. The harness executes packages; the parent orchestrator owns sequencing judgment.

Full `/hybrid-run*` commands now start in the background so the parent Pi conversation can continue. Use `/hybrid-monitor` for live output, `/hybrid-steer <note>` to add parent steering that will be read by later child sessions, and `/hybrid-cancel` to abort the active run and terminate the current child process. Steering is stage-boundary based; it is not injected into the stdin of an already-running child.

Background runs write `.pi-harness/active-run.json` with a heartbeat so another Pi window can see that a run is active. Stale locks are ignored after the heartbeat expires. `/hybrid-status` reports the active lock and queued steering count. The monitor keeps `Esc`/`q` as close-only; press `x` twice or `Ctrl-C` then `x` to cancel the active run.

If a child session appears stuck repeating the same tool/target pattern, the harness aborts that child with a `stuck-loop-guard` message instead of burning time indefinitely.

## Optional config

Create `.pi-harness/config.json`:

```json
{
  "testCommand": "npm test",
  "persistentWriterSession": true,
  "writerSessionDir": "sessions",
  "maxLocalLoops": 4,
  "maxReviewRepairCycles": 2,
  "maxFrontierPasses": 2,
  "requireDeterministicTestsForInteractive": true,
  "enableSafetyGuards": true,
  "allowDestructiveBash": false,
  "protectedPaths": [".env", ".env.*", "**/.env", "**/.env.*", ".git/**", "**/*secret*", "**/*credential*", "**/*token*"],
  "maxDiffCharsBeforeFrontier": 120000,
  "verboseChildOutput": true,
  "liveLogMaxWidgetLines": 30,
  "briefBeforeImplementation": true,
  "askUserOnAmbiguity": true,
  "frontierModel": "openai-codex/gpt-5.5",
  "frontierThinking": "high",
  "localWorkerModel": "local-qwen/qwen36-27b-mtp-q5kxl",
  "localReviewerModel": "local-qwen/qwen36-27b-mtp-q5kxl"
}
```

## Validation hardening

For browser/UI/game/canvas/touch-style tasks, `requireDeterministicTestsForInteractive` defaults to `true`. With this policy enabled, syntax checks, HTTP 200 checks, screenshots without assertions, and worker self-reported smoke tests are not enough for PASS/APPROVE. Configure `testCommand` to run objective runtime assertions (for example an agent-browser or Node harness script that checks game state/DOM/canvas behavior), or the local/final gates will request changes instead of approving.

For all non-trivial tasks, the harness records acceptance criteria as executable verification contracts. Final evidence separates source evidence from runtime evidence and writes `claim-evidence-matrix.md` with Claim, Evidence command, Evidence type, What would fail if broken, and Residual gap.

Inferred verification includes a root `lint` script when present. A zero exit code is rejected when output still contains a fatal runtime signal such as `EADDRINUSE`, preventing stale or conflicting processes from producing false-green E2E results. The final gate also receives canonical `specs/**/tasks.md` checkbox status; unchecked required task IDs block completion when the objective claims that tracker is complete.

For ambiguous requirements or broad designs, use `/hybrid-interview` and `/hybrid-grill` before implementation. These are frontier-owned design gates: they run with `frontierModel` and `frontierThinking`, write `requirements.md` and `design-grill.md`, and do not assign implementation to local/Qwen until the requirement or design branch is ready.

For serious tasks, the harness automatically runs a CWS-compatible, not CWS-dependent frontier `plan-review` stage after the orchestration brief and before the local implementation loop. `taskRisk=medium` or `taskRisk=high` must produce `plan-review.md` with plan architect and plan critic verdicts; local implementation starts only when the final verdict is `READY`. `NEEDS_REVISION` and `ESCALATE_TO_USER` block the run. If `briefBeforeImplementation=false`, the harness still creates a one-off brief so the serious-task policy can be evaluated.

Review routing depends on the mode:

- `/hybrid-run` (fully automatic): plan review, implementation review, and final review all use `frontierModel`/`frontierThinking`. The `local-review.md` artifact records a frontier implementation review in this mode.
- `hybrid_exec` (parent-driven spec-kit/skill mode): each package runs deterministic verification (test/lint/build commands) plus an implementation review by the **local** `localReviewerModel`, and writes the verdict to `local-review.md`. Frontier tokens are not spent per package. Reserve the frontier model for the single ship decision: run `/hybrid-final` once the whole feature is complete. This matches the parent-driven loop where the parent orchestrator session (itself frontier) reads the per-package artifacts and decides the next package, repair, debug, or stop.

Reviewer prompts require test assertion-quality review, at least one adversarial probe, and reentry/idempotency checks for stateful work. Residual gaps block approval for public API, data integrity, authentication, payment, migration, or long-lived state changes.

## Safety and rollback

The extension registers safety guards that apply to parent and child Pi sessions:

- blocks `write`/`edit` to protected paths such as `.env`, `.git/**`, and secret/token/credential-looking files
- blocks destructive bash patterns such as `rm -rf`, `sudo`, `git reset --hard`, and `git clean -fdx` unless `allowDestructiveBash` is enabled
- creates a pre-run git patch checkpoint under `.pi-harness/checkpoints/`
- `/hybrid-rollback` reverse-applies the latest tracked worktree patch; untracked files are not deleted automatically

## Orchestration briefing and clarification

Before implementation, the harness writes `.pi-harness/orchestration-brief.md` with:

- plan summary
- execution strategy
- assumptions
- ambiguities
- blocking questions
- risk level

If `askUserOnAmbiguity` is enabled and the brief finds blocking ambiguity, Pi opens an editor prompt for your answers and stores them in `.pi-harness/user-clarifications.md`. The local worker and frontier final gate then read those clarifications.

## Tool UI

The `hybrid_run` tool provides the subagent-style card UX:

- compact view: current stage, current child/tool, slice/acceptance progress, verdicts, and recent child output
- expanded view: fuller recent output, artifact paths, and usage summary
- `/hybrid-run`, `/hybrid-run-fast`, and `/hybrid-run-thorough` use the same run state and markdown renderer; when an agent calls `hybrid_run` directly, Pi shows the native expandable tool card.
- `hybrid_run` defaults to background mode; set `background: false` when a caller needs to wait for the final result in the tool call.

## Recommended companion packages

These are intentionally not hard dependencies, but they are good companions:

```bash
pi install -l npm:pi-show-diffs@0.2.13
pi install -l npm:pi-subagents
pi remove -l npm:pi-subagentura@1.0.12 # optional legacy cleanup
```

- `pi-show-diffs`: safety gate before edit/write changes.
- `pi-subagents`: mature reference/companion for delegated subagent UX, chain/parallel execution, and background jobs.

This package keeps the core orchestration small so frontier-token routing stays explicit.
