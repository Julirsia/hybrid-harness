#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  doctorQwenHarnessOpenCode,
  installQwenHarnessOpenCode,
  uninstallQwenHarnessOpenCode,
} from "../src/installer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

function usage() {
  console.log(`qwen-harness-opencode ${pkg.version}

Usage:
  npx ${pkg.name} install [--config-dir <path>] [--no-config-deps]
  npx ${pkg.name} update [--config-dir <path>] [--no-config-deps]
  npx ${pkg.name} uninstall [--config-dir <path>]
  npx ${pkg.name} doctor [--config-dir <path>]

Notes:
  - install/update copy plugin and skill assets into ~/.config/opencode.
  - If ~/.config/opencode/package.json exists, install/update refreshes TUI dependencies there.
  - Restart OpenCode TUI after install/update.
`);
}

function parse(argv) {
  const opts = { installConfigDependencies: true };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config-dir") {
      const value = argv[++i];
      if (!value) fail("--config-dir requires a value");
      opts.configDir = value;
    } else if (arg.startsWith("--config-dir=")) {
      opts.configDir = arg.slice("--config-dir=".length);
    } else if (arg === "--no-config-deps") {
      opts.installConfigDependencies = false;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? "help", opts };
}

function fail(message) {
  console.error(`qwen-harness-opencode: ${message}`);
  process.exit(1);
}

const { command, opts } = parse(process.argv.slice(2));

try {
  switch (command) {
    case "install":
    case "update":
    case "upgrade":
      installQwenHarnessOpenCode({ ...opts, packageRoot });
      break;
    case "remove":
    case "uninstall":
      uninstallQwenHarnessOpenCode(opts);
      break;
    case "doctor": {
      const report = doctorQwenHarnessOpenCode(opts);
      console.log(`Config: ${report.configDir}`);
      console.log(`Manifest: ${report.manifestExists ? "present" : "missing"} (${report.manifestPath})`);
      console.log(`Plugin: ${report.pluginExists ? "present" : "missing"} (${report.pluginPath})`);
      console.log(`TUI registration: ${report.registered ? "present" : "missing"}`);
      break;
    }
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
