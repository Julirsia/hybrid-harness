#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildReviewBundle,
  collectEvidence,
} from "../src/evidence.mjs";
import {
  doctorQwenHarnessCodex,
  installQwenHarnessCodex,
  mcpConfigToml,
  uninstallQwenHarnessCodex,
} from "../src/installer.mjs";
import { delegateToPi } from "../src/pi-runner.mjs";
import {
  createCodexHarnessTask,
  loadCodexHarnessStatus,
} from "../src/taskpack.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

function usage() {
  console.log(`qwen-harness-codex ${pkg.version}

Usage:
  qwen-harness-codex doctor [--cwd <path>] [--codex-home <path>]
  qwen-harness-codex new-task --task <text> [--task-id <id>] [--run-id <id>] [--title <text>] [--verification-command <cmd...>]
  qwen-harness-codex scout --task <text> [--live]
  qwen-harness-codex delegate --task <text> [--verification-command <cmd...>] [--live]
  qwen-harness-codex status [--cwd <path>]
  qwen-harness-codex collect-evidence [--verification-command <cmd...>]
  qwen-harness-codex review-bundle [--budget-chars <n>]
  qwen-harness-codex mcp-config
  qwen-harness-codex install [--codex-home <path>]
  qwen-harness-codex uninstall [--codex-home <path>]
`);
}

function parse(argv) {
  const opts = { live: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      opts.verificationCommand = argv.slice(i + 1);
      break;
    } else if (arg === "--live") {
      opts.live = true;
    } else if (arg === "--cwd") {
      opts.cwd = requiredValue(argv, ++i, "--cwd");
    } else if (arg === "--codex-home") {
      opts.codexHome = requiredValue(argv, ++i, "--codex-home");
    } else if (arg === "--task") {
      opts.task = requiredValue(argv, ++i, "--task");
    } else if (arg === "--task-id") {
      opts.taskId = requiredValue(argv, ++i, "--task-id");
    } else if (arg === "--run-id") {
      opts.runId = requiredValue(argv, ++i, "--run-id");
    } else if (arg === "--title") {
      opts.title = requiredValue(argv, ++i, "--title");
    } else if (arg === "--model") {
      opts.model = requiredValue(argv, ++i, "--model");
    } else if (arg === "--pi-binary") {
      opts.piBinary = requiredValue(argv, ++i, "--pi-binary");
    } else if (arg === "--timeout-ms") {
      opts.timeoutMs = Number(requiredValue(argv, ++i, "--timeout-ms"));
    } else if (arg === "--budget-chars") {
      opts.budgetChars = Number(requiredValue(argv, ++i, "--budget-chars"));
    } else if (arg === "--verification-command") {
      opts.verificationCommand = argv.slice(i + 1);
      break;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? "help", opts };
}

function requiredValue(argv, index, name) {
  const value = argv[index];
  if (!value) fail(`${name} requires a value`);
  return value;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message) {
  console.error(`qwen-harness-codex: ${message}`);
  process.exit(1);
}

const { command, opts } = parse(process.argv.slice(2));

try {
  switch (command) {
    case "new-task":
      printJson(createCodexHarnessTask(opts));
      break;
    case "scout":
      printJson(delegateToPi({ ...opts, phase: "scout" }));
      break;
    case "delegate":
      printJson(delegateToPi({ ...opts, phase: "full" }));
      break;
    case "status":
      printJson(loadCodexHarnessStatus(opts));
      break;
    case "collect-evidence":
      printJson(collectEvidence(opts));
      break;
    case "review-bundle":
      printJson(buildReviewBundle(opts));
      break;
    case "mcp-config":
      console.log(mcpConfigToml({ packageRoot }));
      break;
    case "install":
    case "update":
      printJson(installQwenHarnessCodex({ ...opts, packageRoot }));
      break;
    case "uninstall":
    case "remove":
      uninstallQwenHarnessCodex(opts);
      break;
    case "doctor":
      printJson(doctorQwenHarnessCodex(opts));
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(pkg.version);
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      usage();
      fail(`unknown command '${command}'`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
