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
import { join, resolve } from "node:path";

const PACKAGE_NAME = "qwen-harness-opencode";
const MANIFEST_NAME = "qwen-harness-opencode.json";
const CONFIG_DEPENDENCIES = [
  "@opentui/core@0.2.15",
  "@opentui/keymap@0.2.15",
  "@opentui/solid@0.2.15",
  "solid-js@1.9.12",
];

export function installQwenHarnessOpenCode(options = {}) {
  const configDir = resolve(options.configDir ?? process.env.OPENCODE_CONFIG_DIR ?? join(process.env.HOME, ".config", "opencode"));
  const packageRoot = resolve(options.packageRoot ?? process.cwd());
  const timestamp = options.timestamp ?? timestampForBackup();
  const log = options.log ?? console.log;

  const pluginDir = join(configDir, "plugins");
  const skillDir = join(configDir, "skills");
  const skillTarget = join(skillDir, "qwen-first-delegation-workflow");
  const pluginTarget = join(pluginDir, "qwen-harness-status.tsx");
  const coreTarget = join(pluginDir, "qwen-harness-status-core.mjs");
  const manifestPath = join(configDir, MANIFEST_NAME);

  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });

  const priorManifest = readManifest(manifestPath);
  const managedPaths = new Set(priorManifest?.managedPaths ?? []);

  copyManagedPath({
    source: join(packageRoot, "plugins", "qwen-harness-status.tsx"),
    target: pluginTarget,
    managedPaths,
    timestamp,
    log,
  });
  copyManagedPath({
    source: join(packageRoot, "plugins", "qwen-harness-status-core.mjs"),
    target: coreTarget,
    managedPaths,
    timestamp,
    log,
  });
  copyManagedPath({
    source: join(packageRoot, "skills", "qwen-first-delegation-workflow"),
    target: skillTarget,
    managedPaths,
    timestamp,
    log,
  });

  writeTuiPluginConfig(join(configDir, "tui.json"), pluginTarget, log);

  const manifest = {
    packageName: PACKAGE_NAME,
    installedAt: new Date().toISOString(),
    pluginPath: pluginTarget,
    managedPaths: [pluginTarget, coreTarget, skillTarget],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`Wrote ${manifestPath}`);

  if (options.installConfigDependencies !== false) {
    installOpenCodeConfigDependencies(configDir, log);
  }

  log("\nInstalled qwen-harness-opencode.");
  log("Restart OpenCode TUI to load the sidebar plugin.");
  return manifest;
}

export function uninstallQwenHarnessOpenCode(options = {}) {
  const configDir = resolve(options.configDir ?? process.env.OPENCODE_CONFIG_DIR ?? join(process.env.HOME, ".config", "opencode"));
  const log = options.log ?? console.log;
  const manifestPath = join(configDir, MANIFEST_NAME);
  const manifest = readManifest(manifestPath);
  const fallbackPaths = [
    join(configDir, "plugins", "qwen-harness-status.tsx"),
    join(configDir, "plugins", "qwen-harness-status-core.mjs"),
    join(configDir, "skills", "qwen-first-delegation-workflow"),
  ];
  const managedPaths = manifest?.managedPaths ?? fallbackPaths.filter((path) => isSymlink(path));

  for (const path of managedPaths) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    log(`Removed ${path}`);
  }

  removeTuiPluginConfig(join(configDir, "tui.json"), log);

  if (existsSync(manifestPath)) {
    rmSync(manifestPath, { force: true });
    log(`Removed ${manifestPath}`);
  }

  log("\nUninstalled qwen-harness-opencode.");
}

export function doctorQwenHarnessOpenCode(options = {}) {
  const configDir = resolve(options.configDir ?? process.env.OPENCODE_CONFIG_DIR ?? join(process.env.HOME, ".config", "opencode"));
  const manifestPath = join(configDir, MANIFEST_NAME);
  const manifest = readManifest(manifestPath);
  const pluginPath = join(configDir, "plugins", "qwen-harness-status.tsx");
  const tuiConfig = readJson(join(configDir, "tui.json")) ?? {};
  const registered = Array.isArray(tuiConfig.plugin) && tuiConfig.plugin.includes(pluginPath);

  return {
    configDir,
    manifestPath,
    manifestExists: Boolean(manifest),
    pluginPath,
    pluginExists: existsSync(pluginPath),
    registered,
  };
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

function writeTuiPluginConfig(configPath, pluginPath, log) {
  const config = readJson(configPath) ?? {};
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  config.plugin = plugins.filter((entry) => !isHarnessPluginSpec(entry));
  config.plugin.push(pluginPath);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  log(`Registered ${pluginPath} in ${configPath}`);
}

function removeTuiPluginConfig(configPath, log) {
  if (!existsSync(configPath)) return;
  const config = readJson(configPath);
  if (!config || !Array.isArray(config.plugin)) return;
  const nextPlugins = config.plugin.filter((entry) => !isHarnessPluginSpec(entry));
  if (nextPlugins.length === config.plugin.length) return;
  config.plugin = nextPlugins;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  log(`Removed qwen-harness-opencode plugin from ${configPath}`);
}

function isHarnessPluginSpec(entry) {
  return typeof entry === "string" && entry.endsWith("/qwen-harness-status.tsx");
}

function installOpenCodeConfigDependencies(configDir, log) {
  const packageJsonPath = join(configDir, "package.json");
  if (!existsSync(packageJsonPath)) return;

  log(`Installing OpenCode TUI dependencies in ${configDir}...`);
  const result = spawnSync("npm", ["install", "--save", ...CONFIG_DEPENDENCIES], {
    cwd: configDir,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 0) !== 0) {
    throw new Error(`npm install failed in ${configDir}`);
  }
}

function readManifest(manifestPath) {
  const manifest = readJson(manifestPath);
  return manifest?.packageName === PACKAGE_NAME ? manifest : undefined;
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
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
