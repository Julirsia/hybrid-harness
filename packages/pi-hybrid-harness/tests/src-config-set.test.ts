import assert from "node:assert/strict";
import test from "node:test";
import {
	EDITABLE_CONFIG_KEYS,
	THINKING_LEVELS,
	coerceConfigValue,
} from "../src/config-set.ts";

test("coerceConfigValue parses boolean aliases", () => {
	for (const t of ["true", "1", "on", "yes", "Y"]) {
		assert.deepEqual(coerceConfigValue("boolean", t), { ok: true, value: true });
	}
	for (const f of ["false", "0", "off", "no", "N"]) {
		assert.deepEqual(coerceConfigValue("boolean", f), { ok: true, value: false });
	}
	assert.equal(coerceConfigValue("boolean", "maybe").ok, false);
});

test("coerceConfigValue parses numbers and rejects non-numbers", () => {
	assert.deepEqual(coerceConfigValue("number", "3"), { ok: true, value: 3 });
	assert.deepEqual(coerceConfigValue("number", "1.5"), { ok: true, value: 1.5 });
	assert.equal(coerceConfigValue("number", "lots").ok, false);
	assert.equal(coerceConfigValue("number", "").ok, false);
});

test("coerceConfigValue validates the thinking enum", () => {
	for (const level of THINKING_LEVELS) {
		assert.deepEqual(coerceConfigValue("thinking", level), { ok: true, value: level });
	}
	assert.deepEqual(coerceConfigValue("thinking", "HIGH"), { ok: true, value: "high" });
	assert.equal(coerceConfigValue("thinking", "ultra").ok, false);
});

test("coerceConfigValue trims strings", () => {
	assert.deepEqual(coerceConfigValue("string", "  npm test  "), {
		ok: true,
		value: "npm test",
	});
});

test("EDITABLE_CONFIG_KEYS covers the toggles the slash command must expose", () => {
	assert.equal(EDITABLE_CONFIG_KEYS.enableHybridFinalTool, "boolean");
	assert.equal(EDITABLE_CONFIG_KEYS.testCommand, "string");
	assert.equal(EDITABLE_CONFIG_KEYS.maxFrontierPasses, "number");
	assert.equal(EDITABLE_CONFIG_KEYS.frontierThinking, "thinking");
	// array keys are intentionally not editable via the slash command
	assert.equal(EDITABLE_CONFIG_KEYS.protectedPaths, undefined);
	assert.equal(EDITABLE_CONFIG_KEYS.verificationCommands, undefined);
});
