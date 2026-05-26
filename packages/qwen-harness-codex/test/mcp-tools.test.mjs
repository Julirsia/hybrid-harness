import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CODEX_HARNESS_TOOLS,
  callCodexHarnessTool,
} from "../src/mcp-tools.mjs";

describe("CODEX_HARNESS_TOOLS", () => {
  it("exposes compact Codex harness tools", () => {
    assert.deepEqual(CODEX_HARNESS_TOOLS.map((tool) => tool.name), [
      "codex_harness_scout",
      "codex_harness_delegate",
      "codex_harness_status",
      "codex_harness_collect_evidence",
      "codex_harness_review_bundle",
    ]);
  });

  it("rejects unknown tools", async () => {
    await assert.rejects(
      () => callCodexHarnessTool("unknown_tool", {}),
      /Unknown Codex harness tool/,
    );
  });

  it("uses the active .qwen-harness task across MCP delegate, evidence, and review tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qwen-harness-codex-mcp-"));
    try {
      await callCodexHarnessTool("codex_harness_scout", {
        cwd,
        taskId: "mcp-active",
        runId: "run-mcp",
        task: "Scout through MCP",
      });
      const evidence = await callCodexHarnessTool("codex_harness_collect_evidence", {
        cwd,
        verificationCommand: [process.execPath, "-e", "process.exit(0)"],
      });
      const bundle = await callCodexHarnessTool("codex_harness_review_bundle", { cwd });

      assert.equal(evidence.summary.taskId, "mcp-active");
      assert.equal(evidence.summary.runId, "run-mcp");
      assert.equal(bundle.taskId, "mcp-active");
      assert.equal(bundle.runId, "run-mcp");
      assert.equal(existsSync(join(cwd, ".qwen-harness", "runs", "mcp-active", "run-mcp", "test-summary.json")), true);
      assert.equal(existsSync(join(cwd, ".qwen-harness", "runs", "codex-harness-task", "run-001")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
