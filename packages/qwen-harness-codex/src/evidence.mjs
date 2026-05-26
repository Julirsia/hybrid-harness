import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CANONICAL_STATE_DIR,
  artifactPaths,
  normalizeCommand,
  resolveActiveTaskRun,
} from "./taskpack.mjs";

export function collectEvidence(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { taskId, runId } = resolveActiveTaskRun({ ...options, cwd });
  const command = normalizeCommand(options.verificationCommand);
  const paths = artifactPaths({ cwd, taskId, runId });
  mkdirSync(paths.runDir, { recursive: true });

  let exitCode = 0;
  let output = "No verification command provided.\n";
  if (command.length) {
    const result = spawnSync(command[0], command.slice(1), {
      cwd,
      encoding: "utf8",
      shell: false,
    });
    exitCode = result.status ?? (result.error ? 1 : 0);
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.error) output += `\n${result.error.message}\n`;
  }

  writeFileSync(paths.testOutput, output, "utf8");
  const summary = {
    ok: exitCode === 0,
    exitCode,
    command,
    stateDir: CANONICAL_STATE_DIR,
    taskId,
    runId,
    outputPath: paths.testOutput,
  };
  writeFileSync(paths.testSummary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(paths.evidenceBundle, evidenceMarkdown(summary), "utf8");
  return {
    ok: summary.ok,
    status: summary.ok ? "complete" : "verification_failed",
    stateDir: CANONICAL_STATE_DIR,
    artifacts: {
      testOutput: paths.testOutput,
      testSummary: paths.testSummary,
      evidenceBundle: paths.evidenceBundle,
    },
    summary,
  };
}

export function buildReviewBundle(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { taskId, runId } = resolveActiveTaskRun({ ...options, cwd });
  const budgetChars = Number(options.budgetChars ?? 24000);
  const paths = artifactPaths({ cwd, taskId, runId });
  mkdirSync(paths.root, { recursive: true });

  const parts = [
    ["state.json", readIfExists(paths.state)],
    ["progress.json", readIfExists(paths.progress)],
    ["implementation-plan.json", readIfExists(paths.plan)],
    ["evidence-bundle.md", readIfExists(paths.evidenceBundle)],
    ["test-summary.json", readIfExists(paths.testSummary)],
  ];
  let bundle = `# Frontier Review Input

State directory: \`${CANONICAL_STATE_DIR}/\`

`;
  for (const [name, content] of parts) {
    if (!content) continue;
    bundle += `## ${name}\n\n\`\`\`\n${content.trim()}\n\`\`\`\n\n`;
  }
  if (bundle.length > budgetChars) {
    bundle = `${bundle.slice(0, Math.max(0, budgetChars - 80))}\n\n[truncated to ${budgetChars} chars]\n`;
  }
  writeFileSync(paths.reviewInput, bundle, "utf8");
  return {
    ok: true,
    status: "complete",
    stateDir: CANONICAL_STATE_DIR,
    taskId,
    runId,
    artifact: paths.reviewInput,
    chars: bundle.length,
  };
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function evidenceMarkdown(summary) {
  return `# Evidence Bundle

- State directory: \`${CANONICAL_STATE_DIR}/\`
- Command: \`${summary.command.length ? summary.command.join(" ") : "none"}\`
- Exit code: ${summary.exitCode}
- Result: ${summary.ok ? "PASS" : "FAIL"}
`;
}
