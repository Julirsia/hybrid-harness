import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildHarnessSummary,
  formatTokenCount,
  loadHarnessSummary,
} from "../src/status-summary.mjs";

describe("buildHarnessSummary", () => {
  it("summarizes canonical qwen harness state and current slice", () => {
    const summary = buildHarnessSummary({
      state: {
        phase: "implementing",
        currentSliceId: "S3",
        updatedAt: "2026-05-26T02:00:00.000Z",
      },
      progress: {
        blockers: [],
      },
      plan: {
        currentSliceId: "S3",
        slices: [
          { id: "S1", title: "Map repo", status: "completed", owner: "explorer", risk: "low" },
          { id: "S2", title: "Implement core", status: "completed", owner: "fixer", risk: "medium" },
          { id: "S3", title: "Add tests", status: "in_progress", owner: "tester", risk: "medium" },
          { id: "S4", title: "Final verification", status: "pending", owner: "orchestrator", risk: "low" },
        ],
      },
    });

    assert.equal(summary.active, true);
    assert.equal(summary.phase, "implementing");
    assert.equal(summary.currentSlice?.id, "S3");
    assert.equal(summary.currentSlice?.title, "Add tests");
    assert.equal(summary.currentSlice?.owner, "tester");
    assert.equal(summary.completedSlices, 2);
    assert.equal(summary.totalSlices, 4);
    assert.equal(summary.nextSlice?.id, "S4");
    assert.deepEqual(summary.blockers, []);
  });

  it("aggregates local and frontier token usage and reports efficiency", () => {
    const summary = buildHarnessSummary({
      state: {
        phase: "testing",
        tokenUsage: {
          frontier: { input: 1000, output: 250 },
          local: { input: 9000, output: 1750 },
        },
      },
      plan: {
        slices: [
          {
            id: "S1",
            title: "Explorer",
            status: "completed",
            tokenUsage: {
              local: { input: 2000, output: 400 },
            },
          },
        ],
      },
      events: [
        { type: "delegated", model: "qwen36", usage: { input_tokens: 3000, output_tokens: 600 } },
        { type: "review", model: "openai/gpt-5.5", usage: { input_tokens: 500, output_tokens: 150 } },
      ],
    });

    assert.equal(summary.tokenUsage.frontier.total, 1900);
    assert.equal(summary.tokenUsage.local.total, 16750);
    assert.equal(summary.tokenUsage.total, 18650);
    assert.equal(summary.tokenEfficiency.localSharePercent, 90);
    assert.equal(summary.tokenEfficiency.label, "local-heavy");
    assert.equal(summary.tokenEfficiency.localToFrontierRatio, 8.8);
  });

  it("normalizes blockers and missing harness fallback", () => {
    const inactive = buildHarnessSummary({});
    assert.equal(inactive.active, false);
    assert.equal(inactive.message, "No qwen harness active");

    const blocked = buildHarnessSummary({
      state: { phase: "blocked" },
      plan: {
        blockers: ["Need API decision", { description: "Missing fixture" }],
        slices: [
          { id: "S1", title: "Blocked slice", status: "blocked", blocker: "CI unavailable" },
        ],
      },
    });

    assert.deepEqual(blocked.blockers, ["Need API decision", "Missing fixture", "CI unavailable"]);
  });

  it("loads pi harness state when qwen harness state is absent", () => {
    const worktree = mkdtempSync(join(tmpdir(), "qwen-harness-status-"));
    try {
      const harnessDir = join(worktree, ".pi-harness");
      mkdirSync(harnessDir);
      writeFileSync(join(harnessDir, "state.json"), JSON.stringify({
        phase: "implemented",
        task: "Mirror Pi harness",
      }));
      writeFileSync(join(harnessDir, "progress.json"), JSON.stringify({
        currentSliceId: "S2",
        slices: [
          { id: "S1", title: "Scout", status: "done" },
          { id: "S2", title: "Implement", status: "in_progress" },
          { id: "S3", title: "Verify", status: "pending" },
        ],
      }));

      const summary = loadHarnessSummary(worktree);

      assert.equal(summary.active, true);
      assert.equal(summary.phase, "implemented");
      assert.equal(summary.task, "Mirror Pi harness");
      assert.equal(summary.completedSlices, 1);
      assert.equal(summary.currentSlice?.id, "S2");
      assert.equal(summary.nextSlice?.id, "S3");
      assert.equal(summary.paths.state, ".pi-harness/state.json");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});

describe("formatTokenCount", () => {
  it("formats compact token counts", () => {
    assert.equal(formatTokenCount(950), "950");
    assert.equal(formatTokenCount(12500), "12.5k");
    assert.equal(formatTokenCount(1200000), "1.2m");
  });
});
