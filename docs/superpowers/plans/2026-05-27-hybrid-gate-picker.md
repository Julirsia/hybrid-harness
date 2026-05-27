# Hybrid Gate Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/hybrid-interview` and `/hybrid-grill` use modal picker choices for unresolved questions, and require explicit user approval before starting `/hybrid-run`.

**Architecture:** Extend the existing `HybridReportOverlayComponent` instead of adding a new UI system. Parse choices from frontier markdown, feed them into a `SelectList`, and return explicit modal actions (`answer`, `edit`, `run`, `grill`, `close`) to the command loop.

**Tech Stack:** TypeScript Pi extension, `@earendil-works/pi-tui` `SelectList`, Node test runner source-regression tests.

---

### Task 1: Regression Tests

**Files:**
- Modify: `packages/pi-hybrid-harness/tests/hybrid-harness-regression.test.js`

- [x] Add tests asserting the extension contains:
  - `HybridGateAction` actions for `answer`, `edit`, `run`, `grill`, and `close`.
  - markdown choice extraction helper.
  - ready Korean approval summary helper.
  - interview ready path offering `r` run and `g` grill.
  - grill ready path offering `r` run.
  - removal of `s submit draft`.

- [x] Run `npm test -w pi-hybrid-harness`.

Expected before implementation: FAIL because the new helpers/actions do not exist.

### Task 2: Modal Actions And Choice Picker

**Files:**
- Modify: `packages/pi-hybrid-harness/extensions/hybrid-harness.ts`

- [x] Replace `HybridReportAction` with a richer `HybridGateAction`.
- [x] Add markdown choice extraction for numbered, bullet, option, and recommended-answer lines.
- [x] Add optional `SelectList` rendering below the report body when choices/actions exist.
- [x] Wire keys:
  - `Enter`: selected choice/action.
  - `e`: direct editor input.
  - `r`: run approval when ready.
  - `g`: grill approval from interview-ready only.
  - `q/Esc/F8`: close.

- [x] Run `npm test -w pi-hybrid-harness`.

Expected after implementation: PASS.

### Task 3: Interview And Grill Loops

**Files:**
- Modify: `packages/pi-hybrid-harness/extensions/hybrid-harness.ts`

- [x] Update `/hybrid-interview` to loop until close, run, or grill.
- [x] When interview is ready, show Korean confirmation summary and require `r` or `g`.
- [x] Update `/hybrid-grill` to loop until close or run.
- [x] When grill is ready, show Korean confirmation summary and require `r`.
- [x] Only call `startHybridRunAfterGate` after explicit `r`.

- [x] Run `npm test -w pi-hybrid-harness`.

Expected after implementation: PASS.
