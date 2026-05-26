import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildCodexMcpConfig,
  installQwenHarnessCodex,
  uninstallQwenHarnessCodex,
} from "../src/installer.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("buildCodexMcpConfig", () => {
  it("points Codex at the package MCP server", () => {
    const config = buildCodexMcpConfig({ packageRoot: "/repo/packages/qwen-harness-codex" });

    assert.equal(config.serverName, "qwen_harness_codex");
    assert.equal(config.command, "node");
    assert.deepEqual(config.args, ["/repo/packages/qwen-harness-codex/mcp/server.mjs"]);
  });
});

describe("qwen-harness-codex installer", () => {
  it("installs the Codex skill, records a manifest, and appends MCP config", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "qwen-harness-codex-home-"));
    try {
      installQwenHarnessCodex({
        codexHome,
        packageRoot,
        log: () => {},
      });

      const skillPath = join(codexHome, "skills", "qwen-first-codex-orchestration", "SKILL.md");
      const manifestPath = join(codexHome, "qwen-harness-codex.json");
      const configPath = join(codexHome, "config.toml");

      assert.equal(existsSync(skillPath), true);
      assert.equal(existsSync(manifestPath), true);
      assert.match(readFileSync(configPath, "utf8"), /\[mcp_servers\.qwen_harness_codex\]/);
      assert.match(readFileSync(configPath, "utf8"), /mcp\/server\.mjs/);

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(manifest.packageName, "qwen-harness-codex");
      assert.equal(manifest.skillPath, join(codexHome, "skills", "qwen-first-codex-orchestration"));
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("backs up unmanaged skill directories before installing", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "qwen-harness-codex-home-"));
    try {
      const skillDir = join(codexHome, "skills", "qwen-first-codex-orchestration");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "custom skill");

      installQwenHarnessCodex({
        codexHome,
        packageRoot,
        timestamp: "20260526120000",
        log: () => {},
      });

      assert.equal(readFileSync(`${skillDir}.bak-20260526120000/SKILL.md`, "utf8"), "custom skill");
      assert.match(readFileSync(join(skillDir, "SKILL.md"), "utf8"), /Codex Qwen-First Orchestration/);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("removes only manifest-managed assets and MCP config on uninstall", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "qwen-harness-codex-home-"));
    try {
      installQwenHarnessCodex({
        codexHome,
        packageRoot,
        log: () => {},
      });

      const customSkill = join(codexHome, "skills", "custom", "SKILL.md");
      mkdirSync(dirname(customSkill), { recursive: true });
      writeFileSync(customSkill, "keep me");

      uninstallQwenHarnessCodex({ codexHome, log: () => {} });

      assert.equal(existsSync(join(codexHome, "skills", "qwen-first-codex-orchestration")), false);
      assert.equal(existsSync(customSkill), true);
      assert.doesNotMatch(readFileSync(join(codexHome, "config.toml"), "utf8"), /qwen_harness_codex/);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("replaces only its MCP block while preserving unrelated Codex config", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "qwen-harness-codex-home-"));
    try {
      const configPath = join(codexHome, "config.toml");
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(configPath, [
        'model = "gpt-5.5"',
        "",
        "[mcp_servers.other_tool]",
        'command = "node"',
        'args = ["other.js"]',
        "",
        "[mcp_servers.qwen_harness_codex]",
        'command = "old-node"',
        'args = ["old.js"]',
        "",
        "[features]",
        "goals = true",
        "",
      ].join("\n"));

      installQwenHarnessCodex({
        codexHome,
        packageRoot,
        log: () => {},
      });

      const installed = readFileSync(configPath, "utf8");
      assert.match(installed, /model = "gpt-5\.5"/);
      assert.match(installed, /\[mcp_servers\.other_tool\]/);
      assert.match(installed, /\[features\]/);
      assert.match(installed, /\[mcp_servers\.qwen_harness_codex\]/);
      assert.doesNotMatch(installed, /old-node/);

      uninstallQwenHarnessCodex({ codexHome, log: () => {} });

      const uninstalled = readFileSync(configPath, "utf8");
      assert.match(uninstalled, /model = "gpt-5\.5"/);
      assert.match(uninstalled, /\[mcp_servers\.other_tool\]/);
      assert.match(uninstalled, /\[features\]/);
      assert.doesNotMatch(uninstalled, /qwen_harness_codex/);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
