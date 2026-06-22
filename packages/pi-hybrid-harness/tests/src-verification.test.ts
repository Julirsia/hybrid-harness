import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyTestFailure,
	fatalVerificationSignals,
	verificationCommandPassed,
} from "../src/verification.ts";

test("fatalVerificationSignals detects false-green runtime signals", () => {
	assert.deepEqual(fatalVerificationSignals("Error: listen EADDRINUSE :::3000"), [
		"address already in use (EADDRINUSE)",
	]);
	assert.deepEqual(fatalVerificationSignals("clean output, all good"), []);
});

test("verificationCommandPassed requires expected exit AND no fatal signal", () => {
	assert.deepEqual(
		verificationCommandPassed({ ok: true, output: "ok", code: 0 }),
		{ ok: true, fatalSignals: [] },
	);
	// exit 0 but fatal signal present -> not passed (this is the false-green guard)
	const falseGreen = verificationCommandPassed({
		ok: true,
		output: "server up\nEADDRINUSE",
		code: 0,
	});
	assert.equal(falseGreen.ok, false);
	assert.equal(falseGreen.fatalSignals.length, 1);
	// non-zero exit -> not passed
	assert.equal(
		verificationCommandPassed({ ok: false, output: "boom", code: 1 }).ok,
		false,
	);
	// custom expected exit code
	assert.equal(
		verificationCommandPassed({ ok: false, output: "x", code: 3 }, 3).ok,
		true,
	);
});

test("classifyTestFailure returns none when ok", () => {
	assert.equal(classifyTestFailure("anything", true, 0), "none");
});

test("classifyTestFailure recognizes failure categories", () => {
	assert.equal(classifyTestFailure("timed out after 5s", false, null), "timeout");
	assert.equal(classifyTestFailure("no deterministic test", false, 1), "missing_test");
	assert.equal(classifyTestFailure("Cannot find module 'x'", false, 1), "missing_dependency");
	assert.equal(classifyTestFailure("TS2322: is not assignable to", false, 2), "type_error");
	assert.equal(classifyTestFailure("SyntaxError: unexpected token", false, 1), "compile_error");
	assert.equal(classifyTestFailure("eslint found problems", false, 1), "lint_error");
	assert.equal(classifyTestFailure("playwright e2e failed", false, 1), "integration_failure");
	assert.equal(classifyTestFailure("expect(received).toBe failed", false, 1), "unit_failure");
	assert.equal(classifyTestFailure("totally opaque message", false, 1), "unknown");
});

test("classifyTestFailure prioritizes timeout over later categories", () => {
	// 'timeout' is checked before 'test' substring matching.
	assert.equal(classifyTestFailure("test timed out", false, 1), "timeout");
});
