import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CANONICAL_STATE_DIR } from "./taskpack.mjs";

const PACKAGE_NAME = "qwen-harness-codex";
const MANIFEST_NAME = "qwen-harness-codex.json";
const SKILL_NAME = "qwen-first-codex-orchestration";
const MCP_SERVER_NAME = "qwen_harness_codex";

export function buildCodexMcpConfig(options = {}) {
  const packageRoot = resolve(options.packageRoot ?? process.cwd());
  return {
    serverName: MCP_SERVER_NAME,
    command: "node",
    args: [join(packageRoot, "mcp", "server.mjs")],
  };
}

export function installQwenHarnessCodex(options = {}) {
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"));
  const packageRoot = resolve(options.packageRoot ?? process.cwd());
  const timestamp = options.timestamp ?? timestampForBackup();
  const log = options.log ?? console.log;
  const skillRoot = join(codexHome, "skills");
  const skillPath = join(skillRoot, SKILL_NAME);
  const manifestPath = join(codexHome, MANIFEST_NAME);
  const configPath = join(codexHome, "config.toml");
  const priorManifest = readManifest(manifestPath);
  const managedPaths = new Set(priorManifest?.managedPaths ?? []);

  mkdirSync(skillRoot, { recursive: true });
  copyManagedPath({
    source: join(packageRoot, "skills", SKILL_NAME),
    target: skillPath,
    managedPaths,
    timestamp,
    log,
  });

  writeMcpConfigBlock(configPath, buildCodexMcpConfig({ packageRoot }), log);

  const manifest = {
    packageName: PACKAGE_NAME,
    installedAt: new Date().toISOString(),
    skillPath,
    configPath,
    mcpServerName: MCP_SERVER_NAME,
    managedPaths: [skillPath],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(`Wrote ${manifestPath}`);
  return manifest;
}

export function uninstallQwenHarnessCodex(options = {}) {
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"));
  const log = options.log ?? console.log;
  const manifestPath = join(codexHome, MANIFEST_NAME);
  const manifest = readManifest(manifestPath);
  const fallbackSkill = join(codexHome, "skills", SKILL_NAME);
  const managedPaths = manifest?.managedPaths ?? (isSymlink(fallbackSkill) ? [fallbackSkill] : []);

  for (const path of managedPaths) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    log(`Removed ${path}`);
  }

  removeMcpConfigBlock(join(codexHome, "config.toml"), log);
  if (existsSync(manifestPath)) {
    rmSync(manifestPath, { force: true });
    log(`Removed ${manifestPath}`);
  }
}

export function doctorQwenHarnessCodex(options = {}) {
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"));
  const configPath = join(codexHome, "config.toml");
  const manifestPath = join(codexHome, MANIFEST_NAME);
  const skillPath = join(codexHome, "skills", SKILL_NAME);
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const piBinary = options.piBinary ?? "pi";
  const piCheck = spawnSync(piBinary, ["--version"], { encoding: "utf8", shell: false });
  return {
    codexHome,
    canonicalStateDir: CANONICAL_STATE_DIR,
    manifestPath,
    manifestExists: Boolean(readManifest(manifestPath)),
    skillPath,
    skillExists: existsSync(skillPath),
    configPath,
    mcpConfigured: config.includes(`[mcp_servers.${MCP_SERVER_NAME}]`),
    piBinary,
    piBinaryAvailable: !piCheck.error,
  };
}

export function mcpConfigToml(options = {}) {
  const config = buildCodexMcpConfig(options);
  return tomlBlock(config);
}

function copyManagedPath({ source, target, managedPaths, timestamp, log }) {
  if (!existsSync(source)) {
    throw new Error(`Missing package asset: ${source}`);
  }
  if (existsSync(target)) {
    if (managedPaths.has(target)) {
      rmSync(target, { recursive: true, force: true });
    } else {
      const backup = nextBackupPath(target, timestamp);
      renameSync(target, backup);
      log(`Backed up existing ${target} to ${backup}`);
    }
  }
  cpSync(source, target, { recursive: true });
  log(`Installed ${target}`);
}

function writeMcpConfigBlock(configPath, config, log) {
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const next = `${removeMcpBlock(current).trimEnd()}\n\n${tomlBlock(config)}\n`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, next, "utf8");
  log(`Registered ${MCP_SERVER_NAME} in ${configPath}`);
}

function removeMcpConfigBlock(configPath, log) {
  if (!existsSync(configPath)) return;
  const current = readFileSync(configPath, "utf8");
  const next = `${removeMcpBlock(current).trimEnd()}\n`;
  writeFileSync(configPath, next, "utf8");
  log(`Removed ${MCP_SERVER_NAME} from ${configPath}`);
}

function tomlBlock(config) {
  return `[mcp_servers.${config.serverName}]
command = ${tomlString(config.command)}
args = [${config.args.map(tomlString).join(", ")}]
startup_timeout_sec = 30`;
}

function removeMcpBlock(value) {
  const lines = value.split(/\r?\n/);
  const result = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\[mcp_servers\.qwen_harness_codex\]\s*$/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[/.test(line)) {
      skipping = false;
    }
    if (!skipping) result.push(line);
  }
  return result.join("\n");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return manifest?.packageName === PACKAGE_NAME ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function nextBackupPath(target, timestamp) {
  let backup = `${target}.bak-${timestamp}`;
  let counter = 2;
  while (existsSync(backup)) {
    backup = `${target}.bak-${timestamp}-${counter}`;
    counter += 1;
  }
  return backup;
}

function timestampForBackup() {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
