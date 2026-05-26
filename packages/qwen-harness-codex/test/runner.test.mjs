import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildPiPrompt,
  delegateToPi,
} from "../src/pi-runner.mjs";

describe("buildPiPrompt", () => {
  it("builds a phase-specific Pi prompt with Codex orchestration boundaries", () => {
    const prompt = buildPiPrompt({
      phase: "scout",
      taskId: "codex-package",
      title: "Codex package",
      task: "Add Codex harness",
    });

    assert.match(prompt, /Codex is the frontier orchestrator/);
    assert.match(prompt, /Local Phase: scout/);
    assert.match(prompt, /Scout-only runs are read-only/);
    assert.doesNotMatch(prompt, /\.codex-harness/);
    assert.match(prompt, /\.qwen-harness/);
  });
});

describe("delegateToPi", () => {
  it("creates task artifacts and returns a dry-run Pi command by default", () => {
    const cwd = mkdtempSync(join(tmpdir(), "qwen-harness-codex-"));
    try {
      const result = delegateToPi({
        cwd,
        taskId: "dry-run",
        runId: "run-001",
        phase: "scout",
        title: "Dry run",
        task: "Map repo",
        model: "local-qwen/qwen36-27b-mtp-iq4xs",
        now: "2026-05-26T00:00:00.000Z",
      });

      assert.equal(result.status, "dry-run");
      assert.equal(result.stateDir, ".qwen-harness");
      assert.deepEqual(result.piCommand.argv.slice(0, 5), [
        "pi",
        "--mode",
        "json",
        "-p",
        "--no-session",
      ]);
      assert.equal(result.piCommand.argv.includes("--model"), true);
      assert.equal(result.piCommand.model, "local-qwen/qwen36-27b-mtp-iq4xs");
      assert.equal(result.artifacts.state.endsWith(".qwen-harness/state.json"), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks live runs when Pi transcript reports a model error despite exit 0", () => {
    const cwd = mkdtempSync(join(tmpdir(), "qwen-harness-codex-"));
    try {
      const fakePi = join(cwd, "fake-pi.js");
      writeFileSync(fakePi, [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'message_start', message: { stopReason: 'error', errorMessage: 'Connection error.' } }));",
        "process.exit(0);",
        "",
      ].join("\n"));
      chmodSync(fakePi, 0o755);

      const result = delegateToPi({
        cwd,
        taskId: "live-error",
        runId: "run-001",
        phase: "full",
        title: "Live error",
        task: "Trigger transcript error",
        piBinary: fakePi,
        live: true,
        now: "2026-05-26T00:00:00.000Z",
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, "blocked");
      assert.equal(result.exitCode, 0);
      assert.equal(result.stopReason, "Connection error.");
      assert.match(readFileSync(result.artifacts.stdout, "utf8"), /Connection error/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
