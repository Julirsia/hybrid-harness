import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");
const skill = readFileSync(join(packageRoot, "skills", "qwen-first-codex-orchestration", "SKILL.md"), "utf8");

describe("qwen-first-codex-orchestration skill", () => {
  it("fixes .qwen-harness as the canonical state directory", () => {
    assert.match(skill, /\.qwen-harness/);
    assert.doesNotMatch(skill, /\.codex-harness/);
  });

  it("keeps frontier judgment with Codex and local loops with Pi/Qwen", () => {
    assert.match(skill, /Codex owns requirements/);
    assert.match(skill, /Pi\/local Qwen handles/);
    assert.match(skill, /frontier-owned/);
  });
});
