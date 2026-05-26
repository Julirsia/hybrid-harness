import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const HARNESS_DIRS = [".qwen-harness", ".pi-harness"];

const ACTIVE_PHASES = new Set([
  "intake",
  "idle",
  "scouted",
  "exploring",
  "designed",
  "implementing",
  "implemented",
  "testing",
  "blocked",
  "completed",
  "local-reviewed",
  "frontier-reviewed",
]);

const COMPLETE_STATUSES = new Set(["completed", "complete", "done"]);
const NEXT_STATUSES = new Set(["pending", "in_progress", "in-progress", "running"]);

export function loadHarnessSummary(worktree) {
  if (!worktree) {
    return buildHarnessSummary({});
  }

  for (const harnessDir of HARNESS_DIRS) {
    const dir = join(worktree, harnessDir);
    if (!existsSync(dir)) {
      continue;
    }

    return buildHarnessSummary({
      state: readJson(join(dir, "state.json")),
      progress: readJson(join(dir, "progress.json")),
      plan: readJson(join(dir, "implementation-plan.json")),
      events: readJsonLines(join(dir, "events.jsonl")),
    }, harnessDir);
  }

  return buildHarnessSummary({});
}

export function buildHarnessSummary(input = {}, harnessDir = ".qwen-harness") {
  const state = asObject(input.state);
  const progress = asObject(input.progress);
  const plan = asObject(input.plan);
  const slices = Array.isArray(plan.slices) ? plan.slices : Array.isArray(progress.slices) ? progress.slices : [];
  const phase = firstString(progress.phase, state.phase, plan.phase);
  const hasHarness =
    ACTIVE_PHASES.has(phase ?? "") ||
    Boolean(firstString(progress.currentSliceId, state.currentSliceId, plan.currentSliceId)) ||
    slices.length > 0;

  if (!hasHarness) {
    return {
      active: false,
      message: "No qwen harness active",
      tokenUsage: emptyUsage(),
      tokenEfficiency: emptyEfficiency(),
      blockers: [],
    };
  }

  const currentSliceId = firstString(progress.currentSliceId, state.currentSliceId, plan.currentSliceId);
  const currentSlice = slices.find((slice) => slice?.id === currentSliceId) ?? null;
  const nextSlice = findNextSlice(slices, currentSliceId);
  const completedSlices = slices.filter((slice) => isCompleteStatus(slice?.status)).length;
  const blockers = normalizeBlockers(progress.blockers, plan.blockers, slices);
  const tokenUsage = aggregateTokenUsage({ state, progress, plan, events: input.events ?? [] });

  return {
    active: true,
    phase: phase ?? "unknown",
    currentSliceId: currentSliceId ?? null,
    currentSlice,
    nextSlice,
    completedSlices,
    totalSlices: slices.length,
    blockers,
    updatedAt: latestTimestamp(progress.updatedAt, state.updatedAt, plan.updatedAt),
    task: firstString(progress.task, state.task, plan.task) ?? "",
    tokenUsage,
    tokenEfficiency: calculateTokenEfficiency(tokenUsage),
    paths: {
      state: `${harnessDir}/state.json`,
      progress: `${harnessDir}/progress.json`,
      plan: `${harnessDir}/implementation-plan.json`,
    },
  };
}

export function aggregateTokenUsage({ state = {}, progress = {}, plan = {}, events = [] } = {}) {
  const usage = emptyUsage();

  addUsageSource(usage, state.tokenUsage ?? state.usage ?? state.tokens, classifySource(state, "unknown"));
  addUsageSource(usage, progress.tokenUsage ?? progress.usage ?? progress.tokens, classifySource(progress, "unknown"));
  addUsageSource(usage, plan.tokenUsage ?? plan.usage ?? plan.tokens, classifySource(plan, "unknown"));

  for (const slice of Array.isArray(plan.slices) ? plan.slices : []) {
    addUsageSource(usage, slice?.tokenUsage ?? slice?.usage ?? slice?.tokens, classifySource(slice, "unknown"));
    for (const evidence of Array.isArray(slice?.evidence) ? slice.evidence : []) {
      addUsageSource(usage, evidence?.tokenUsage ?? evidence?.usage ?? evidence?.tokens, classifySource(evidence, classifySource(slice, "unknown")));
    }
  }

  for (const event of Array.isArray(events) ? events : []) {
    addUsageSource(usage, event?.tokenUsage ?? event?.usage ?? event?.tokens, classifySource(event, "unknown"));
  }

  finalizeUsage(usage.frontier);
  finalizeUsage(usage.local);
  finalizeUsage(usage.unknown);
  usage.total = usage.frontier.total + usage.local.total + usage.unknown.total;
  usage.input = usage.frontier.input + usage.local.input + usage.unknown.input;
  usage.output = usage.frontier.output + usage.local.output + usage.unknown.output;
  return usage;
}

export function calculateTokenEfficiency(usage) {
  const total = Number(usage?.total ?? 0);
  const local = Number(usage?.local?.total ?? 0);
  const frontier = Number(usage?.frontier?.total ?? 0);

  if (total <= 0) {
    return emptyEfficiency();
  }

  const localSharePercent = Math.round((local / total) * 100);
  const localToFrontierRatio = frontier > 0 ? round1(local / frontier) : null;
  const label =
    localSharePercent >= 70 ? "local-heavy" :
    localSharePercent >= 40 ? "balanced" :
    "frontier-heavy";

  return {
    hasData: true,
    label,
    localSharePercent,
    localToFrontierRatio,
  };
}

export function formatTokenCount(value) {
  const count = Number(value ?? 0);
  if (count >= 1_000_000) return `${round1(count / 1_000_000)}m`;
  if (count >= 10_000) return `${round1(count / 1_000)}k`;
  return String(Math.round(count));
}

export function formatTimestamp(value) {
  if (!value) return "";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return String(value);
  return time.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function findNextSlice(slices, currentSliceId) {
  if (!Array.isArray(slices) || slices.length === 0) return null;
  const currentIndex = slices.findIndex((slice) => slice?.id === currentSliceId);
  const afterCurrent = currentIndex >= 0 ? slices.slice(currentIndex + 1) : slices;
  return afterCurrent.find((slice) => isNextStatus(slice?.status)) ??
    slices.find((slice) => isNextStatus(slice?.status)) ??
    null;
}

function normalizeBlockers(progressBlockers, planBlockers, slices) {
  const result = [];
  for (const blocker of [...toArray(progressBlockers), ...toArray(planBlockers)]) {
    const normalized = normalizeBlocker(blocker);
    if (normalized) result.push(normalized);
  }
  for (const slice of slices) {
    if (slice?.status !== "blocked") continue;
    const normalized = normalizeBlocker(slice.blocker ?? slice.blockers ?? slice.remaining?.[0] ?? slice.title);
    if (normalized) result.push(normalized);
  }
  return [...new Set(result)].slice(0, 4);
}

function normalizeBlocker(blocker) {
  if (typeof blocker === "string") return blocker;
  if (!blocker || typeof blocker !== "object") return "";
  return firstString(blocker.description, blocker.reason, blocker.title, blocker.message) ?? "";
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function normalizeStatus(status) {
  return typeof status === "string" ? status.toLowerCase() : "";
}

function isCompleteStatus(status) {
  return COMPLETE_STATUSES.has(normalizeStatus(status));
}

function isNextStatus(status) {
  return NEXT_STATUSES.has(normalizeStatus(status));
}

function emptyUsage() {
  return {
    frontier: emptyUsageBucket(),
    local: emptyUsageBucket(),
    unknown: emptyUsageBucket(),
    input: 0,
    output: 0,
    total: 0,
  };
}

function emptyUsageBucket() {
  return { input: 0, output: 0, total: 0 };
}

function emptyEfficiency() {
  return {
    hasData: false,
    label: "untracked",
    localSharePercent: null,
    localToFrontierRatio: null,
  };
}

function addUsageSource(target, source, fallbackCategory) {
  if (!source || typeof source !== "object") return;

  let consumedNested = false;
  for (const category of ["frontier", "local", "unknown"]) {
    if (source[category] && typeof source[category] === "object") {
      addUsageBucket(target[category], source[category]);
      consumedNested = true;
    }
  }

  if (!consumedNested) {
    const category = normalizeCategory(source.category ?? source.type ?? fallbackCategory);
    addUsageBucket(target[category], source);
  }
}

function addUsageBucket(bucket, source) {
  const input = numeric(source.input, source.inputTokens, source.input_tokens, source.promptTokens, source.prompt_tokens);
  const output = numeric(source.output, source.outputTokens, source.output_tokens, source.completionTokens, source.completion_tokens);
  const total = numeric(source.total, source.totalTokens, source.total_tokens);
  bucket.input += input;
  bucket.output += output;
  bucket.total += total || input + output;
}

function finalizeUsage(bucket) {
  if (bucket.total === 0) bucket.total = bucket.input + bucket.output;
}

function classifySource(source, fallback) {
  const text = [
    source?.category,
    source?.type,
    source?.model,
    source?.provider,
    source?.agent,
    source?.owner,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/(qwen|llama|local|ollama|mlx|lmstudio|llama-server)/.test(text)) return "local";
  if (/(openai|gpt|claude|anthropic|gemini|frontier|oracle)/.test(text)) return "frontier";
  return normalizeCategory(fallback);
}

function normalizeCategory(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "frontier" || normalized === "oracle") return "frontier";
  if (normalized === "local" || normalized === "qwen" || normalized === "worker") return "local";
  return "unknown";
}

function numeric(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function latestTimestamp(...values) {
  const valid = values
    .filter(Boolean)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((left, right) => right.time - left.time);
  return valid[0]?.value ?? "";
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
