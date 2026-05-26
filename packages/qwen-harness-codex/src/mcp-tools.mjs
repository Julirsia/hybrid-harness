import { collectEvidence, buildReviewBundle } from "./evidence.mjs";
import { delegateToPi } from "./pi-runner.mjs";
import { loadCodexHarnessStatus } from "./taskpack.mjs";

export const CODEX_HARNESS_TOOLS = [
  {
    name: "codex_harness_scout",
    description: "Create .qwen-harness task state and delegate read-only scout work to Pi/local Qwen.",
    inputSchema: baseRunSchema(),
  },
  {
    name: "codex_harness_delegate",
    description: "Create .qwen-harness task state and delegate implementation/test loop work to Pi/local Qwen.",
    inputSchema: {
      ...baseRunSchema(),
      properties: {
        ...baseRunSchema().properties,
        verificationCommand: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "codex_harness_status",
    description: "Return compact .qwen-harness status for Codex review.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "codex_harness_collect_evidence",
    description: "Run a verification command and write compact .qwen-harness evidence artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        taskId: { type: "string" },
        runId: { type: "string" },
        verificationCommand: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "codex_harness_review_bundle",
    description: "Build bounded frontier review input from .qwen-harness artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        taskId: { type: "string" },
        runId: { type: "string" },
        budgetChars: { type: "number" },
      },
    },
  },
];

export async function callCodexHarnessTool(name, args = {}) {
  switch (name) {
    case "codex_harness_scout":
      return delegateToPi({ ...args, phase: "scout" });
    case "codex_harness_delegate":
      return delegateToPi({ ...args, phase: "full" });
    case "codex_harness_status":
      return loadCodexHarnessStatus(args);
    case "codex_harness_collect_evidence":
      return collectEvidence(args);
    case "codex_harness_review_bundle":
      return buildReviewBundle(args);
    default:
      throw new Error(`Unknown Codex harness tool: ${name}`);
  }
}

function baseRunSchema() {
  return {
    type: "object",
    required: ["task"],
    properties: {
      cwd: { type: "string" },
      task: { type: "string" },
      taskId: { type: "string" },
      runId: { type: "string" },
      title: { type: "string" },
      model: { type: "string" },
      piBinary: { type: "string" },
      live: { type: "boolean" },
      timeoutMs: { type: "number" },
    },
  };
}
