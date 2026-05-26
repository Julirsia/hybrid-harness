import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CANONICAL_STATE_DIR = ".qwen-harness";

export function createCodexHarnessTask(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const now = options.now ?? new Date().toISOString();
  const task = requiredString(options.task, "task");
  const taskId = options.taskId ?? slugify(options.title ?? task);
  const runId = options.runId ?? "run-001";
  const title = options.title ?? taskId;
  const verificationCommand = normalizeCommand(options.verificationCommand);
  const paths = artifactPaths({ cwd, taskId, runId });

  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.handoffsDir, { recursive: true });
  mkdirSync(paths.runDir, { recursive: true });

  const acceptance = [{
    id: "AC1",
    description: "User-requested task has reproducible verification evidence.",
    status: "pending",
    verificationContracts: [verificationCommand.length ? verificationCommand.join(" ") : "Codex final review with manual evidence bundle"],
    evidenceType: verificationCommand.length ? "runtime" : "manual",
    sourceEvidence: [],
    runtimeEvidence: [],
    adversarialProbes: [],
    reentryProbes: [],
    residualGaps: [],
  }];

  const slices = [
    {
      id: "S1",
      title: "Codex plan and acceptance gate",
      owner: "codex-orchestrator",
      risk: "medium",
      status: "in_progress",
      dependencies: [],
      remaining: ["Confirm scope, acceptance criteria, and verification contracts."],
      evidence: [],
    },
    {
      id: "S2",
      title: "Pi/local Qwen scout",
      owner: "pi-local-qwen",
      risk: "low",
      status: "pending",
      dependencies: ["S1"],
      remaining: ["Map relevant files, commands, risks, and unknowns."],
      evidence: [],
    },
    {
      id: "S3",
      title: "Pi/local Qwen implementation and repair loop",
      owner: "pi-local-qwen",
      risk: "medium",
      status: "pending",
      dependencies: ["S2"],
      remaining: ["Implement bounded changes, run tests, and repair failures."],
      evidence: [],
    },
    {
      id: "S4",
      title: "Codex final review and verification",
      owner: "codex-orchestrator",
      risk: "medium",
      status: "pending",
      dependencies: ["S3"],
      remaining: ["Review compact evidence, run final verification, and decide readiness."],
      evidence: [],
    },
  ];

  const state = {
    version: 1,
    host: "codex",
    stateDir: CANONICAL_STATE_DIR,
    phase: "intake",
    taskId,
    runId,
    title,
    task,
    currentSliceId: "S1",
    createdAt: now,
    updatedAt: now,
    models: {
      frontier: "codex",
      localBackend: "pi-local-qwen",
    },
    artifacts: relativeArtifacts(taskId, runId),
  };

  const plan = {
    version: 1,
    host: "codex",
    taskId,
    runId,
    title,
    task,
    phase: "intake",
    taskRisk: "medium",
    currentSliceId: "S1",
    slices,
    acceptanceCriteria: acceptance,
    blockers: [],
    tokenUsage: emptyTokenUsage(),
  };

  const progress = {
    version: 1,
    host: "codex",
    taskId,
    runId,
    title,
    task,
    phase: "intake",
    currentSliceId: "S1",
    slices,
    acceptanceCriteria: acceptance,
    blockers: [],
    nextAction: "Codex should finish the plan gate, then delegate scout/implementation work to Pi/local Qwen.",
    updatedAt: now,
    tokenUsage: emptyTokenUsage(),
  };

  writeFileSync(paths.task, taskMarkdown({ title, task, taskId, runId, verificationCommand }), "utf8");
  writeFileSync(paths.executionPackage, executionPackageMarkdown({ title, task, taskId, runId, verificationCommand }), "utf8");
  writeFileSync(paths.progressMarkdown, progressMarkdown(progress), "utf8");
  writeJson(paths.state, state);
  writeJson(paths.progress, progress);
  writeJson(paths.plan, plan);
  appendEvent(paths.events, {
    type: "task_created",
    at: now,
    agent: "codex-orchestrator",
    taskId,
    runId,
    stateDir: CANONICAL_STATE_DIR,
  });
  writeFileSync(paths.piHandoff, piHandoffMarkdown({ title, task, taskId, runId, verificationCommand }), "utf8");

  return {
    ok: true,
    status: "created",
    stateDir: CANONICAL_STATE_DIR,
    taskId,
    runId,
    artifacts: paths,
  };
}

export function loadCodexHarnessStatus(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = join(cwd, CANONICAL_STATE_DIR);
  if (!existsSync(root)) {
    return {
      active: false,
      stateDir: CANONICAL_STATE_DIR,
      message: "No qwen harness active",
      blockers: [],
    };
  }

  const state = readJson(join(root, "state.json")) ?? {};
  const progress = readJson(join(root, "progress.json")) ?? {};
  const plan = readJson(join(root, "implementation-plan.json")) ?? {};
  const slices = Array.isArray(progress.slices) ? progress.slices : Array.isArray(plan.slices) ? plan.slices : [];
  const completedSlices = slices.filter((slice) => ["complete", "completed", "done"].includes(String(slice?.status ?? "").toLowerCase())).length;

  return {
    active: true,
    stateDir: CANONICAL_STATE_DIR,
    phase: progress.phase ?? state.phase ?? plan.phase ?? "unknown",
    taskId: progress.taskId ?? state.taskId ?? plan.taskId ?? null,
    runId: progress.runId ?? state.runId ?? plan.runId ?? null,
    task: progress.task ?? state.task ?? plan.task ?? "",
    currentSliceId: progress.currentSliceId ?? state.currentSliceId ?? plan.currentSliceId ?? null,
    completedSlices,
    totalSlices: slices.length,
    blockers: normalizeBlockers(progress.blockers ?? plan.blockers),
    updatedAt: progress.updatedAt ?? state.updatedAt ?? null,
    paths: {
      state: `${CANONICAL_STATE_DIR}/state.json`,
      progress: `${CANONICAL_STATE_DIR}/progress.json`,
      plan: `${CANONICAL_STATE_DIR}/implementation-plan.json`,
      events: `${CANONICAL_STATE_DIR}/events.jsonl`,
    },
  };
}

export function artifactPaths({ cwd = process.cwd(), taskId = "task", runId = "run-001" } = {}) {
  const root = join(resolve(cwd), CANONICAL_STATE_DIR);
  const handoffsDir = join(root, "handoffs");
  const runDir = join(root, "runs", taskId, runId);
  return {
    root,
    handoffsDir,
    runDir,
    state: join(root, "state.json"),
    progress: join(root, "progress.json"),
    progressMarkdown: join(root, "progress.md"),
    plan: join(root, "implementation-plan.json"),
    events: join(root, "events.jsonl"),
    task: join(root, "task.md"),
    executionPackage: join(root, "execution-package.md"),
    repoMap: join(root, "repo-map.md"),
    evidenceBundle: join(root, "evidence-bundle.md"),
    reviewInput: join(root, "frontier-review-input.md"),
    piHandoff: join(handoffsDir, `${taskId}-pi.md`),
    piCommand: join(runDir, "pi-command.json"),
    prompt: join(runDir, "prompt.md"),
    stdout: join(runDir, "pi-stdout.log"),
    stderr: join(runDir, "pi-stderr.log"),
    testOutput: join(runDir, "test-output.log"),
    testSummary: join(runDir, "test-summary.json"),
  };
}

export function resolveActiveTaskRun(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const explicitTaskId = options.taskId;
  const explicitRunId = options.runId;
  if (explicitTaskId && explicitRunId) {
    return {
      taskId: explicitTaskId,
      runId: explicitRunId,
    };
  }

  const state = readJson(join(cwd, CANONICAL_STATE_DIR, "state.json")) ?? {};
  return {
    taskId: explicitTaskId ?? state.taskId ?? "codex-harness-task",
    runId: explicitRunId ?? state.runId ?? "run-001",
  };
}

export function normalizeCommand(command) {
  if (!command) return [];
  if (Array.isArray(command)) return command.map(String).filter(Boolean);
  if (typeof command === "string") return command.trim() ? command.trim().split(/\s+/) : [];
  return [];
}

export function updateHarnessPhase({ cwd = process.cwd(), phase, currentSliceId, now = new Date().toISOString() } = {}) {
  const paths = artifactPaths({ cwd });
  const state = readJson(paths.state) ?? {};
  const progress = readJson(paths.progress) ?? {};
  if (phase) {
    state.phase = phase;
    progress.phase = phase;
  }
  if (currentSliceId) {
    state.currentSliceId = currentSliceId;
    progress.currentSliceId = currentSliceId;
  }
  state.updatedAt = now;
  progress.updatedAt = now;
  writeJson(paths.state, state);
  writeJson(paths.progress, progress);
  return { state, progress };
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "codex-harness-task";
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function appendEvent(path, event) {
  writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
}

function normalizeBlockers(blockers) {
  if (!Array.isArray(blockers)) return [];
  return blockers.map((blocker) => typeof blocker === "string" ? blocker : blocker?.description ?? blocker?.reason ?? "").filter(Boolean);
}

function emptyTokenUsage() {
  return {
    frontier: { input: 0, output: 0, total: 0 },
    local: { input: 0, output: 0, total: 0 },
    unknown: { input: 0, output: 0, total: 0 },
  };
}

function relativeArtifacts(taskId, runId) {
  return {
    state: `${CANONICAL_STATE_DIR}/state.json`,
    progress: `${CANONICAL_STATE_DIR}/progress.json`,
    plan: `${CANONICAL_STATE_DIR}/implementation-plan.json`,
    events: `${CANONICAL_STATE_DIR}/events.jsonl`,
    evidenceBundle: `${CANONICAL_STATE_DIR}/evidence-bundle.md`,
    run: `${CANONICAL_STATE_DIR}/runs/${taskId}/${runId}`,
  };
}

function taskMarkdown({ title, task, taskId, runId, verificationCommand }) {
  return `# ${title}

- Task ID: \`${taskId}\`
- Run ID: \`${runId}\`
- Canonical state: \`${CANONICAL_STATE_DIR}/\`
- Verification: \`${verificationCommand.length ? verificationCommand.join(" ") : "Codex final review"}\`

## Request

${task}
`;
}

function executionPackageMarkdown({ title, task, taskId, runId, verificationCommand }) {
  return `# ${title} Execution Package

Codex owns requirements, architecture judgment, plan gates, and final review.
Pi/local Qwen handles repository scout, bounded implementation, test loops, repair loops, and evidence collection.

- Task ID: \`${taskId}\`
- Run ID: \`${runId}\`
- State directory: \`${CANONICAL_STATE_DIR}/\`
- Verification command: \`${verificationCommand.length ? verificationCommand.join(" ") : "manual evidence bundle"}\`

## Task

${task}
`;
}

function progressMarkdown(progress) {
  return `# Qwen Harness Progress

- Host: Codex
- Phase: ${progress.phase}
- Current slice: ${progress.currentSliceId}
- Next action: ${progress.nextAction}
`;
}

function piHandoffMarkdown({ title, task, taskId, runId, verificationCommand }) {
  return `# Pi Local Handoff

Codex is the frontier orchestrator. Use \`${CANONICAL_STATE_DIR}/\` for durable state. Do not create a Codex-specific state directory.

- Title: ${title}
- Task ID: ${taskId}
- Run ID: ${runId}
- Verification: ${verificationCommand.length ? verificationCommand.join(" ") : "Codex final review"}

## Task

${task}
`;
}
