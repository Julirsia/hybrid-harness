import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CANONICAL_STATE_DIR,
  artifactPaths,
  createCodexHarnessTask,
} from "./taskpack.mjs";

export function buildPiPrompt(options = {}) {
  const phase = options.phase ?? "full";
  const taskId = options.taskId ?? "codex-harness-task";
  const title = options.title ?? taskId;
  const task = options.task ?? title;

  return `# Codex Qwen Harness Prompt

Codex is the frontier orchestrator and final verifier.
Pi/local Qwen handles high-token repository exploration, implementation, testing, repair loops, and compact evidence collection.

## Local Phase: ${phase}

${phase === "scout" ? "Scout-only runs are read-only. Do not edit files during scout mode." : "Stay inside the task scope and write compact evidence for Codex review."}

Use \`${CANONICAL_STATE_DIR}/\` as the durable harness state directory. Do not create any Codex-specific harness state directory.

## Task

- Task ID: ${taskId}
- Title: ${title}

${task}

## Return Format

Return concise Markdown with:
- relevant files
- commands/tests run
- changed files, if any
- blockers
- verification evidence
- residual risks
`;
}

export function delegateToPi(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const phase = options.phase ?? "full";
  const task = options.task ?? options.title;
  const created = createCodexHarnessTask({ ...options, cwd, task });
  const paths = artifactPaths({ cwd, taskId: created.taskId, runId: created.runId });
  const prompt = buildPiPrompt({
    phase,
    taskId: created.taskId,
    title: options.title ?? created.taskId,
    task,
  });
  const piBinary = options.piBinary ?? "pi";
  const model = options.model ?? "local-qwen/qwen36-27b-mtp-iq4xs";
  const timeoutMs = Number(options.timeoutMs ?? 600000);
  const piCommand = {
    runner: "pi",
    mode: options.live ? "live" : "dry-run",
    phase,
    cwd,
    argv: [
      piBinary,
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      model,
      prompt,
    ],
    model,
    timeoutMs,
    shell: false,
  };

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.prompt, prompt, "utf8");
  writeFileSync(paths.piCommand, `${JSON.stringify(piCommand, null, 2)}\n`, "utf8");

  if (!options.live) {
    return {
      ok: true,
      status: "dry-run",
      stateDir: CANONICAL_STATE_DIR,
      taskId: created.taskId,
      runId: created.runId,
      phase,
      piCommand,
      artifacts: paths,
    };
  }

  const result = spawnSync(piBinary, piCommand.argv.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: false,
  });
  writeFileSync(paths.stdout, result.stdout ?? "", "utf8");
  writeFileSync(paths.stderr, result.stderr ?? "", "utf8");

  const exitCode = result.status ?? (result.error ? 1 : 0);
  const transcriptError = detectPiTranscriptError(result.stdout ?? "");
  const ok = exitCode === 0 && !transcriptError;
  return {
    ok,
    status: ok ? "complete" : "blocked",
    stopReason: ok ? null : transcriptError ?? result.error?.message ?? `pi_exit_${exitCode}`,
    stateDir: CANONICAL_STATE_DIR,
    taskId: created.taskId,
    runId: created.runId,
    phase,
    exitCode,
    artifacts: paths,
  };
}

function detectPiTranscriptError(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const message = event?.message;
      if (message?.stopReason === "error") {
        return message.errorMessage || "pi_transcript_error";
      }
      if (typeof message?.errorMessage === "string" && message.errorMessage.length > 0) {
        return message.errorMessage;
      }
      if (typeof event?.finalError === "string" && event.finalError.length > 0) {
        return event.finalError;
      }
    } catch {
      continue;
    }
  }
  return "";
}
