import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const skill = readFileSync(
  resolve("skills/qwen-first-delegation-workflow/SKILL.md"),
  "utf8",
);

describe("qwen-first workflow verification contract", () => {
  it("requires executable acceptance criteria and typed evidence", () => {
    assert.match(skill, /verificationContracts/);
    assert.match(skill, /sourceEvidence/);
    assert.match(skill, /runtimeEvidence/);
    assert.match(skill, /evidenceType/);
    assert.match(skill, /residualGaps/);
    assert.match(skill, /smoke evidence cannot satisfy behavioral acceptance criteria/);
  });

  it("requires verifier claim extraction and independent probes", () => {
    assert.match(skill, /implementationClaims/);
    assert.match(skill, /claim-evidence matrix/);
    assert.match(skill, /minimum one counterexample/);
    assert.match(skill, /previous slice/);
    assert.match(skill, /state reentry/);
    assert.match(skill, /restart\/retry\/idempotency/);
  });

  it("requires serious tasks to pass a plan review gate before implementation", () => {
    assert.match(skill, /serious task/i);
    assert.match(skill, /taskRisk[\s\S]*medium[\s\S]*high/);
    assert.match(skill, /plan-review\.md/);
    assert.match(skill, /plan-architect-review\.md/);
    assert.match(skill, /plan-critic-review\.md/);
    assert.match(skill, /no implementation until READY/i);
    assert.match(skill, /NEEDS_REVISION/);
    assert.match(skill, /ESCALATE_TO_USER/);
  });

  it("routes ambiguous requirements and design grilling through frontier gates", () => {
    assert.match(skill, /hybrid-interview/);
    assert.match(skill, /hybrid-grill/);
    assert.match(skill, /requirements\.md/);
    assert.match(skill, /design-grill\.md/);
    assert.match(skill, /frontier-owned/i);
    assert.match(skill, /Qwen[\s\S]*repo facts/);
    assert.match(skill, /No Qwen implementation until/i);
  });

  it("requires quality-impacting review gates to be frontier-owned", () => {
    assert.match(skill, /quality-impacting gates/i);
    assert.match(skill, /plan-review\.md[\s\S]*frontier-owned/);
    assert.match(skill, /Qwen[\s\S]*implementation[\s\S]*after[\s\S]*READY/i);
  });
});
