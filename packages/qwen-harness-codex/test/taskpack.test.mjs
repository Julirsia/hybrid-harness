import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createCodexHarnessTask,
  loadCodexHarnessStatus,
} from "../src/taskpack.mjs";

describe("createCodexHarnessTask", () => {
  it("writes canonical .qwen-harness artifacts and never creates .codex-harness", () => {
    const cwd = mkdtempSync(join(tmpdir(), "qwen-harness-codex-"));
    try {
      const result = createCodexHarnessTask({
        cwd,
        taskId: "codex-package",
        runId: "run-001",
        title: "Codex package",
        task: "Add Codex host harness",
        verificationCommand: ["npm", "test"],
        now: "2026-05-26T00:00:00.000Z",
      });

      assert.equal(result.stateDir, ".qwen-harness");
      assert.equal(existsSync(join(cwd, ".qwen-harness", "state.json")), true);
      assert.equal(existsSync(join(cwd, ".qwen-harness", "progress.json")), true);
      assert.equal(existsSync(join(cwd, ".qwen-harness", "implementation-plan.json")), true);
      assert.equal(existsSync(join(cwd, ".qwen-harness", "events.jsonl")), true);
      assert.equal(existsSync(join(cwd, ".qwen-harness", "handoffs", "codex-package-pi.md")), true);
      assert.equal(existsSync(join(cwd, ".codex-harness")), false);

      const state = JSON.parse(readFileSync(join(cwd, ".qwen-harness", "state.json"), "utf8"));
      assert.equal(state.host, "codex");
      assert.equal(state.phase, "intake");
      assert.equal(state.currentSliceId, "S1");
      assert.equal(state.taskId, "codex-package");

      const plan = JSON.parse(readFileSync(join(cwd, ".qwen-harness", "implementation-plan.json"), "utf8"));
      assert.equal(plan.taskRisk, "medium");
      assert.deepEqual(plan.acceptanceCriteria[0].verificationContracts, ["npm test"]);
      assert.equal(plan.slices[0].owner, "codex-orchestrator");
      assert.equal(plan.slices[1].owner, "pi-local-qwen");

      const event = JSON.parse(readFileSync(join(cwd, ".qwen-harness", "events.jsonl"), "utf8").trim());
      assert.equal(event.type, "task_created");
      assert.equal(event.agent, "codex-orchestrator");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("loadCodexHarnessStatus", () => {
  it("summarizes task state from .qwen-harness", () => {
    const cwd = mkdtempSync(join(tmpdir(), "qwen-harness-codex-"));
    try {
      createCodexHarnessTask({
        cwd,
        taskId: "status-check",
        title: "Status check",
        task: "Report status",
        now: "2026-05-26T00:00:00.000Z",
      });

      const status = loadCodexHarnessStatus({ cwd });

      assert.equal(status.active, true);
      assert.equal(status.stateDir, ".qwen-harness");
      assert.equal(status.phase, "intake");
      assert.equal(status.currentSliceId, "S1");
      assert.equal(status.completedSlices, 0);
      assert.equal(status.totalSlices, 4);
      assert.deepEqual(status.blockers, []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
