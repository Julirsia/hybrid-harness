import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  installQwenHarnessOpenCode,
  uninstallQwenHarnessOpenCode,
} from "../src/installer.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("qwen-harness-opencode installer", () => {
  it("copies package assets into the OpenCode config and registers the copied plugin", () => {
    const configDir = mkdtempSync(join(tmpdir(), "qwen-harness-opencode-"));
    const logs = [];
    try {
      installQwenHarnessOpenCode({
        configDir,
        packageRoot,
        installConfigDependencies: false,
        log: (line) => logs.push(line),
      });

      const pluginPath = join(configDir, "plugins", "qwen-harness-status.tsx");
      const corePath = join(configDir, "plugins", "qwen-harness-status-core.mjs");
      const skillPath = join(configDir, "skills", "qwen-first-delegation-workflow", "SKILL.md");
      const manifestPath = join(configDir, "qwen-harness-opencode.json");
      const tuiConfigPath = join(configDir, "tui.json");

      assert.equal(existsSync(pluginPath), true);
      assert.equal(existsSync(corePath), true);
      assert.equal(existsSync(skillPath), true);
      assert.equal(existsSync(manifestPath), true);

      const tuiConfig = JSON.parse(readFileSync(tuiConfigPath, "utf8"));
      assert.deepEqual(tuiConfig.plugin, [pluginPath]);

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(manifest.packageName, "qwen-harness-opencode");
      assert.equal(manifest.pluginPath, pluginPath);
      assert.deepEqual(manifest.managedPaths.sort(), [
        corePath,
        join(configDir, "skills", "qwen-first-delegation-workflow"),
        pluginPath,
      ].sort());
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("replaces prior managed copies without backing them up", () => {
    const configDir = mkdtempSync(join(tmpdir(), "qwen-harness-opencode-"));
    try {
      installQwenHarnessOpenCode({
        configDir,
        packageRoot,
        installConfigDependencies: false,
        log: () => {},
      });

      const pluginPath = join(configDir, "plugins", "qwen-harness-status.tsx");
      writeFileSync(pluginPath, "stale managed copy");

      installQwenHarnessOpenCode({
        configDir,
        packageRoot,
        installConfigDependencies: false,
        log: () => {},
      });

      assert.match(readFileSync(pluginPath, "utf8"), /Qwen Harness/);
      assert.equal(existsSync(`${pluginPath}.bak`), false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("backs up pre-existing unmanaged files before installing", () => {
    const configDir = mkdtempSync(join(tmpdir(), "qwen-harness-opencode-"));
    try {
      const pluginDir = join(configDir, "plugins");
      mkdirSync(pluginDir, { recursive: true });
      const pluginPath = join(pluginDir, "qwen-harness-status.tsx");
      writeFileSync(pluginPath, "custom plugin");

      installQwenHarnessOpenCode({
        configDir,
        packageRoot,
        installConfigDependencies: false,
        timestamp: "20260526120000",
        log: () => {},
      });

      assert.equal(readFileSync(`${pluginPath}.bak-20260526120000`, "utf8"), "custom plugin");
      assert.match(readFileSync(pluginPath, "utf8"), /Qwen Harness/);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("uninstalls only manifest-managed assets and removes the plugin registration", () => {
    const configDir = mkdtempSync(join(tmpdir(), "qwen-harness-opencode-"));
    try {
      installQwenHarnessOpenCode({
        configDir,
        packageRoot,
        installConfigDependencies: false,
        log: () => {},
      });

      const unrelatedPluginPath = join(configDir, "plugins", "custom.tsx");
      writeFileSync(unrelatedPluginPath, "keep me");
      uninstallQwenHarnessOpenCode({ configDir, log: () => {} });

      assert.equal(existsSync(join(configDir, "plugins", "qwen-harness-status.tsx")), false);
      assert.equal(existsSync(join(configDir, "plugins", "qwen-harness-status-core.mjs")), false);
      assert.equal(existsSync(join(configDir, "skills", "qwen-first-delegation-workflow")), false);
      assert.equal(existsSync(unrelatedPluginPath), true);

      const tuiConfig = JSON.parse(readFileSync(join(configDir, "tui.json"), "utf8"));
      assert.deepEqual(tuiConfig.plugin, []);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
