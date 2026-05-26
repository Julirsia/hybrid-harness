import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildReviewBundle,
  collectEvidence,
} from "../src/evidence.mjs";
import { createCodexHarnessTask } from "../src/taskpack.mjs";

describe("evidence active task resolution", () => {
  it("reuses the active taskId and runId from .qwen-harness/state.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "qwen-harness-codex-evidence-"));
    try {
      createCodexHarnessTask({
        cwd,
        taskId: "active-task",
        runId: "run-active",
        task: "Collect evidence for active task",
        now: "2026-05-26T00:00:00.000Z",
      });

      const evidence = collectEvidence({
        cwd,
        verificationCommand: [process.execPath, "-e", "process.exit(0)"],
      });
      const bundle = buildReviewBundle({ cwd });

      const activeRunDir = join(cwd, ".qwen-harness", "runs", "active-task", "run-active");
      const fallbackRunDir = join(cwd, ".qwen-harness", "runs", "codex-harness-task", "run-001");

      assert.equal(evidence.summary.taskId, "active-task");
      assert.equal(evidence.summary.runId, "run-active");
      assert.equal(evidence.artifacts.testSummary, join(activeRunDir, "test-summary.json"));
      assert.equal(bundle.taskId, "active-task");
      assert.equal(bundle.runId, "run-active");
      assert.equal(existsSync(join(activeRunDir, "test-summary.json")), true);
      assert.equal(existsSync(fallbackRunDir), false);
      assert.match(readFileSync(bundle.artifact, "utf8"), /active-task/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
