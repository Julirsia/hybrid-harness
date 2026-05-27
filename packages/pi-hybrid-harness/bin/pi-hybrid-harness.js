#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
const PI = process.env.PI_BINARY || "pi";
const DEFAULT_SOURCE = `npm:${pkg.name}`;
const COMPANIONS = ["npm:pi-show-diffs@0.2.13", "npm:pi-subagents"];
const LEGACY = ["npm:pi-subagentura@1.0.12", "npm:pi-subagentura"];

function usage() {
  console.log(`pi-hybrid-harness ${pkg.version}

Usage:
  npx ${pkg.name} install [-l|--local] [--source <source>] [--no-companions]
  npx ${pkg.name} update [-l|--local] [--source <source>] [--no-companions]
  npx ${pkg.name} remove [-l|--local] [--source <source>] [--keep-companions]
  npx ${pkg.name} list
  npx ${pkg.name} doctor

Examples:
  npx ${pkg.name} install -l
  npx ${pkg.name} update -l
  npx ${pkg.name} install -l --source ./packages/pi-hybrid-harness

Notes:
  - Pi loads packages with 'pi install' / 'pi update'. Local updates reinstall with 'pi install -l'.
  - Use -l/--local for project-local install into .pi/settings.json.
  - Restart Pi or run /reload after install/update.
`);
}

function parse(argv) {
  const opts = { local: false, companions: true, keepCompanions: false, source: process.env.PI_HYBRID_HARNESS_SOURCE || DEFAULT_SOURCE };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-l" || arg === "--local") opts.local = true;
    else if (arg === "--no-companions") opts.companions = false;
    else if (arg === "--keep-companions") opts.keepCompanions = true;
    else if (arg === "--source") {
      const value = argv[++i];
      if (!value) fail("--source requires a value");
      opts.source = value;
    } else if (arg.startsWith("--source=")) opts.source = arg.slice("--source=".length);
    else positional.push(arg);
  }
  return { command: positional[0] || "help", args: positional.slice(1), opts };
}

function run(args, { optional = false } = {}) {
  console.log(`$ ${PI} ${args.join(" ")}`);
  const result = spawnSync(PI, args, { stdio: "inherit", shell: false });
  if (result.error) {
    if (optional) return result.status ?? 1;
    fail(result.error.message);
  }
  const code = result.status ?? 0;
  if (code !== 0 && !optional) process.exit(code);
  return code;
}

function fail(message) {
  console.error(`pi-hybrid-harness: ${message}`);
  process.exit(1);
}

function scopedArgs(base, local) {
  return local ? [...base, "-l"] : base;
}

function isLocalSource(source) {
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../") || source.startsWith("/");
}

function packageNameForLocalSource(source) {
  if (!isLocalSource(source)) return undefined;
  try {
    const pkgPath = join(resolve(process.cwd(), source), "package.json");
    if (!existsSync(pkgPath)) return undefined;
    return JSON.parse(readFileSync(pkgPath, "utf8")).name;
  } catch {
    return undefined;
  }
}

function normalizePackageNameFromNpmSource(source) {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice("npm:".length);
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    return secondAt === -1 ? spec : spec.slice(0, secondAt);
  }
  const at = spec.indexOf("@");
  return at === -1 ? spec : spec.slice(0, at);
}

function packageNameForSource(source, baseDir) {
  if (typeof source !== "string") return undefined;
  const npmName = normalizePackageNameFromNpmSource(source);
  if (npmName) return npmName;
  if (!isLocalSource(source)) return undefined;
  try {
    const pkgPath = join(resolve(baseDir, source), "package.json");
    if (!existsSync(pkgPath)) {
      return source.split(/[\\/]/).filter(Boolean).pop();
    }
    return JSON.parse(readFileSync(pkgPath, "utf8")).name;
  } catch {
    return source.split(/[\\/]/).filter(Boolean).pop();
  }
}

function packageSource(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") {
    return entry.source;
  }
  return undefined;
}

function cleanupConflictingUserInstalls(opts) {
  if (opts.local) return;
  const settingsPath = join(process.env.HOME || "", ".pi", "agent", "settings.json");
  if (!existsSync(settingsPath)) return;
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(settings.packages)) return;
  const baseDir = join(process.env.HOME || "", ".pi", "agent");
  const before = settings.packages;
  const after = before.filter((entry) => {
    const source = packageSource(entry);
    if (!source) return true;
    return packageNameForSource(source, baseDir) !== pkg.name;
  });
  if (after.length === before.length) return;
  settings.packages = after;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const removed = before.filter((entry) => !after.includes(entry)).map((entry) => packageSource(entry) ?? JSON.stringify(entry));
  console.log(`Removed conflicting user-global install(s) from ${settingsPath}: ${removed.join(", ")}`);
}

function cleanupConflictingLocalInstalls(opts) {
  if (!opts.local) return;
  if (isLocalSource(opts.source)) return;
  const settingsPath = join(process.cwd(), ".pi", "settings.json");
  if (!existsSync(settingsPath)) return;
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(settings.packages)) return;
  const before = settings.packages;
  const after = before.filter((source) => !(typeof source === "string" && source !== opts.source && packageNameForLocalSource(source) === pkg.name));
  if (after.length === before.length) return;
  settings.packages = after;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const removed = before.filter((source) => !after.includes(source));
  console.log(`Removed conflicting local dev install(s) from .pi/settings.json: ${removed.join(", ")}`);
}

function install(opts) {
  console.log(`Installing ${opts.source}${opts.local ? " project-locally" : " user-globally"}...`);
  cleanupConflictingUserInstalls(opts);
  cleanupConflictingLocalInstalls(opts);
  run(scopedArgs(["install", opts.source], opts.local));
  if (opts.companions) {
    for (const legacy of LEGACY) run(scopedArgs(["remove", legacy], opts.local), { optional: true });
    for (const companion of COMPANIONS) run(scopedArgs(["install", companion], opts.local));
  }
  console.log("\nDone. Restart Pi or run /reload, then try /hybrid-doctor.");
}

function update(opts) {
  console.log(`Updating ${opts.source}${opts.local ? " project-locally" : " user-globally"}...`);
  if (opts.local) {
    cleanupConflictingLocalInstalls(opts);
    run(["install", opts.source, "-l"]);
  } else {
    run(["update", opts.source]);
  }
  if (opts.companions) {
    for (const companion of COMPANIONS) {
      if (opts.local) run(["install", companion, "-l"], { optional: true });
      else run(["update", companion], { optional: true });
    }
  }
  console.log("\nDone. Restart Pi or run /reload.");
}

function remove(opts) {
  console.log(`Removing ${opts.source}${opts.local ? " project-locally" : " user-globally"}...`);
  run(scopedArgs(["remove", opts.source], opts.local), { optional: true });
  if (!opts.keepCompanions) {
    for (const companion of COMPANIONS) run(scopedArgs(["remove", companion], opts.local), { optional: true });
  }
}

function doctor() {
  console.log(`pi-hybrid-harness ${pkg.version}`);
  run(["--version"], { optional: true });
  run(["list"], { optional: true });
  console.log("\nIf the package is installed, run these inside Pi:");
  console.log("  /reload");
  console.log("  /hybrid-doctor");
}

const { command, opts } = parse(process.argv.slice(2));
switch (command) {
  case "install":
  case "add":
    install(opts);
    break;
  case "update":
  case "upgrade":
    update(opts);
    break;
  case "remove":
  case "uninstall":
    remove(opts);
    break;
  case "list":
    run(["list"]);
    break;
  case "doctor":
    doctor();
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
