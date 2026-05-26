# Harness Contract

This repo contains packages that serve the same local-Qwen workflow from different host apps. The packages may use different runtime directories, but changes to durable state shape should be reflected across host packages.

## Packages

| Package | Host | Main responsibility | Current state directory |
| --- | --- | --- | --- |
| `pi-hybrid-harness` | Pi | orchestrates local/frontier runs and writes durable run artifacts | `.pi-harness/` |
| `qwen-harness-codex` | Codex | provides a Codex CLI/MCP bridge that delegates scout/implementation/evidence loops to Pi/local Qwen while Codex owns frontier gates | `.qwen-harness/` |
| `qwen-harness-opencode` | OpenCode | provides a Qwen-first workflow skill and sidebar summary | `.qwen-harness/` |

Codex and OpenCode use `.qwen-harness/` as the canonical state directory. Do not introduce a Codex-specific harness directory. The OpenCode package reads `.qwen-harness/` first and falls back to `.pi-harness/` when a project already uses the Pi harness directory. Avoid creating both directories in one target project unless the user explicitly asks.

## Shared Concepts

Both packages should keep these concepts compatible:

- task/request summary
- current phase
- current slice/checkpoint
- acceptance criteria
- blockers
- verification evidence
- local vs frontier token usage
- compact progress suitable for a parent/orchestrator model

## Validation Contract Vocabulary

Use this vocabulary in both harnesses so verifier behavior does not drift:

- Executable verification contract: a reproducible command, script, fixture, diff expectation, or manual procedure attached to an acceptance criterion.
- Behavioral acceptance criterion: a user-visible or API-visible outcome that must be proven by runtime, unit, integration, or manual evidence.
- Source evidence: static proof such as a function, file, type, prompt, or config existing in the source tree.
- Runtime evidence: proof that behavior executed, such as a passing unit/integration/e2e command, CLI sample run, API call, UI probe, or manual procedure result.
- Smoke evidence: baseline survival evidence such as build passed, HTTP 200, server responds, import succeeds, or process starts.
- Claim-evidence matrix: final review table with Claim, Evidence command, Evidence type, What would fail if broken, and Residual gap.
- Adversarial probe: at least one verifier-owned counterexample, edge case, alternate call order, invalid input, or retry path that differs from the implementer's happy path.
- Reentry/idempotency probe: repeated run, restart, retry, resume, or state-transition-after-reentry check.

Smoke evidence cannot satisfy behavioral acceptance criteria by itself. It may support source/static or baseline readiness claims, but behavioral completion needs runtime evidence or a documented manual procedure.

High-risk residual gaps are approval blockers for public API, data integrity, authentication, payment, migration, or long-lived state changes. Do not downgrade those gaps to "acceptable concerns" without a user decision.

## Frontier Design Gates

Ambiguous requirements and broad design choices should be handled by frontier-owned gates before Qwen/local implementation starts. The Pi harness exposes `/hybrid-interview <request-or-answer>` and `/hybrid-grill <plan-or-design>` for this purpose.

The durable artifacts are `requirements.md` and `design-grill.md`. `requirements.md` should either ask exactly one next question or produce an implementation-ready handoff with executable acceptance criteria. `design-grill.md` should stress-test design branches, rejected alternatives, failure modes, compatibility, rollout, rollback, state ownership, and verification implications.

Qwen/local agents may gather repo facts for these gates, but they do not own product, requirements, or architecture judgment. No Qwen/local implementation should start from an unresolved requirements interview, unresolved grill, or non-ready plan review.

## Frontier Quality Gates

Quality-impacting gates should be frontier-owned. This includes serious-task `plan-review.md`, implementation review, and final review. Local/Qwen agents may run scout, implementation, tests, repair loops, progress extraction, and repo-fact gathering, but they should not make final quality or readiness judgments.

The Pi harness keeps the legacy `local-review.md` artifact name for compatibility. Treat it as the implementation review artifact; its execution model should be frontier when it affects approval, repair, or final readiness.

## Serious Task Plan Gate

For serious tasks, both harnesses should require a CWS-compatible, portable plan review before implementation. Serious means `taskRisk` is `medium` or `high`, or the task touches multiple components, public API/CLI/schema/auth/data integrity, ordered implementation, rollback compatibility, or multiple verification commands.

The plan review artifact is `plan-review.md`, or equivalent split `plan-architect-review.md` and `plan-critic-review.md` files. It must record plan architect verdict, plan critic verdict, final verdict, blocking issues, required revisions, reviewed validation contracts, residual risks, and next action. Only `READY` allows implementation; `NEEDS_REVISION`, `ESCALATE_TO_USER`, missing verdicts, and unknown verdicts block implementation.

Every non-trivial acceptance criterion should record:

```json
{
  "id": "AC1",
  "description": "observable behavior",
  "status": "pending",
  "verificationContracts": ["sample input + command + expected output/diff"],
  "evidenceType": "unit | integration | e2e | manual | static | smoke",
  "sourceEvidence": [],
  "runtimeEvidence": [],
  "adversarialProbes": [],
  "reentryProbes": [],
  "residualGaps": []
}
```

## Token Usage Shape

Prefer this shape wherever token usage is recorded:

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

Aliases currently accepted by the OpenCode sidebar parser include `usage` and `tokens`, plus OpenAI-style fields such as `input_tokens`, `output_tokens`, and `total_tokens`.

## Change Checklist

Before changing artifact names, statuses, phase values, token accounting, or progress JSON structure:

1. Update this document with the new contract.
2. Update the Pi package docs and writer/reader code.
3. Update the OpenCode skill docs and sidebar parser.
4. Add or update tests for the package that parses the changed shape.
5. Run root verification with `npm test --workspaces --if-present`.

Do not add a shared runtime package until both host packages need the same executable logic. A documented contract is the preferred shared layer for now.
