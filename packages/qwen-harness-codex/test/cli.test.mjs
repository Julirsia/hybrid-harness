import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");
const cli = join(packageRoot, "bin", "qwen-harness-codex.js");

describe("qwen-harness-codex CLI", () => {
  it("creates canonical task state through new-task", () => {
    const cwd = mkdtempSync(join(tmpdir(), "qwen-harness-codex-cli-"));
    try {
      const result = runCli([
        "new-task",
        "--cwd",
        cwd,
        "--task-id",
        "cli-task",
        "--task",
        "Create CLI state",
        "--verification-command",
        "npm",
        "test",
      ]);

      assert.equal(result.status, 0);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.stateDir, ".qwen-harness");
      assert.equal(existsSync(join(cwd, ".qwen-harness", "state.json")), true);
      assert.equal(existsSync(join(cwd, ".codex-harness")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("prints MCP config and doctor state for Codex installation", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "qwen-harness-codex-cli-home-"));
    try {
      const mcpConfig = runCli(["mcp-config"]);
      assert.equal(mcpConfig.status, 0);
      assert.match(mcpConfig.stdout, /\[mcp_servers\.qwen_harness_codex\]/);

      const doctor = runCli(["doctor", "--codex-home", codexHome]);
      assert.equal(doctor.status, 0);
      const report = JSON.parse(doctor.stdout);
      assert.equal(report.canonicalStateDir, ".qwen-harness");
      assert.equal(typeof report.piBinaryAvailable, "boolean");
      assert.equal(typeof report.rubyAvailable, "boolean");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}
