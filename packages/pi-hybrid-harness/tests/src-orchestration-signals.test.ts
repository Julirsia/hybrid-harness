import assert from "node:assert/strict";
import test from "node:test";
import {
	assessConvergence,
	convergenceDirective,
	isBehavioralTestCommand,
	isFallbackProgress,
} from "../src/orchestration-signals.ts";

test("isFallbackProgress detects the generic single-slice plan", () => {
	assert.equal(
		isFallbackProgress({
			slices: [{ id: "S1", title: "Implement requested change" }],
			acceptanceCriteria: [{ id: "AC1" }],
		}),
		true,
	);
});

test("isFallbackProgress is false for a real decomposed plan", () => {
	assert.equal(
		isFallbackProgress({
			slices: [
				{ id: "S1", title: "Set up Vite project" },
				{ id: "S2", title: "Implement aiming state" },
			],
			acceptanceCriteria: [{ id: "AC1" }, { id: "AC2" }],
		}),
		false,
	);
	// single slice but a real title is not the fallback
	assert.equal(
		isFallbackProgress({
			slices: [{ id: "S1", title: "Wire launch physics" }],
			acceptanceCriteria: [{ id: "AC1" }],
		}),
		false,
	);
});

test("assessConvergence: complete only when review passed and verification passed", () => {
	assert.equal(
		assessConvergence({
			verdict: "PASS",
			verificationPassed: true,
			workspaceChanged: true,
			interactivePolicyActive: false,
			hasDeterministicTest: true,
		}),
		"complete",
	);
	assert.equal(
		assessConvergence({
			verdict: "PASS_WITH_CONCERNS",
			verificationPassed: true,
			workspaceChanged: false,
			interactivePolicyActive: false,
			hasDeterministicTest: true,
		}),
		"complete",
	);
	// review passed but verification failed -> not complete
	assert.notEqual(
		assessConvergence({
			verdict: "PASS",
			verificationPassed: false,
			workspaceChanged: true,
			interactivePolicyActive: false,
			hasDeterministicTest: true,
		}),
		"complete",
	);
});

test("assessConvergence: interactive task without tests is blocked-no-tests", () => {
	// This is the 3D-game failure: FAIL forever because no behavioral test exists.
	assert.equal(
		assessConvergence({
			verdict: "FAIL",
			verificationPassed: true, // tsc/build smoke passed
			workspaceChanged: false,
			interactivePolicyActive: true,
			hasDeterministicTest: false,
		}),
		"blocked-no-tests",
	);
	// once a deterministic test exists, it is no longer blocked-no-tests
	assert.notEqual(
		assessConvergence({
			verdict: "FAIL",
			verificationPassed: false,
			workspaceChanged: false,
			interactivePolicyActive: true,
			hasDeterministicTest: true,
		}),
		"blocked-no-tests",
	);
});

test("assessConvergence: no change + not passing = stalled", () => {
	// The DEBUG-1.2..4 case: writer made no changes, verdict still FAIL.
	assert.equal(
		assessConvergence({
			verdict: "FAIL",
			verificationPassed: false,
			workspaceChanged: false,
			interactivePolicyActive: false,
			hasDeterministicTest: true,
		}),
		"stalled",
	);
});

test("assessConvergence: changing the workspace but not done = progressing", () => {
	assert.equal(
		assessConvergence({
			verdict: "FAIL",
			verificationPassed: false,
			workspaceChanged: true,
			interactivePolicyActive: false,
			hasDeterministicTest: true,
		}),
		"progressing",
	);
});

test("blocked-no-tests outranks a (wrongly) passing review on an interactive task", () => {
	// Smoke must not roll up to complete: even if the reviewer passed and smoke
	// verification passed, an interactive task with no behavioral test stays blocked.
	assert.equal(
		assessConvergence({
			verdict: "PASS",
			verificationPassed: true,
			workspaceChanged: true,
			interactivePolicyActive: true,
			hasDeterministicTest: false,
		}),
		"blocked-no-tests",
	);
});

test("isBehavioralTestCommand distinguishes runtime tests from smoke checks", () => {
	assert.equal(isBehavioralTestCommand("npm test"), true);
	assert.equal(isBehavioralTestCommand("npx playwright test"), true);
	assert.equal(isBehavioralTestCommand("npm run test:e2e"), true);
	assert.equal(isBehavioralTestCommand("vitest run"), true);
	assert.equal(isBehavioralTestCommand("npx tsc --noEmit"), false);
	assert.equal(isBehavioralTestCommand("npm run build"), false);
	assert.equal(isBehavioralTestCommand("npm run lint"), false);
});

test("convergenceDirective gives an actionable instruction per state", () => {
	assert.match(convergenceDirective("blocked-no-tests"), /author a runtime\/e2e test|escalate/i);
	assert.match(convergenceDirective("stalled"), /Do NOT resend|escalate/i);
	assert.match(convergenceDirective("complete"), /\/hybrid-final|next batch/i);
	assert.match(convergenceDirective("progressing"), /blocking issues|missing evidence/i);
});
