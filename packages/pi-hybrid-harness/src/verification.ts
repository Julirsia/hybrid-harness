// Pure verification-result analysis: fatal runtime signal detection, exit-code
// evaluation, and test-failure classification. No fs, no spawn, no Pi deps.

import type { TestFailureKind } from "./types.ts";

const FATAL_VERIFICATION_PATTERNS: Array<{
	label: string;
	pattern: RegExp;
}> = [
	{
		label: "address already in use (EADDRINUSE)",
		pattern: /\bEADDRINUSE\b|address already in use/i,
	},
	{
		label: "unhandled promise rejection",
		pattern: /UnhandledPromiseRejection/i,
	},
	{
		label: "fatal runtime error",
		pattern: /^\s*(?:FATAL(?: ERROR)?|Fatal error:)\b/im,
	},
	{ label: "test timeout", pattern: /Test timeout of \d+ms exceeded/i },
];

// A zero exit code is not sufficient: stale/conflicting processes can emit a
// fatal signal (e.g. EADDRINUSE) while still exiting 0, producing a false green.
export function fatalVerificationSignals(output: string): string[] {
	return FATAL_VERIFICATION_PATTERNS.filter(({ pattern }) =>
		pattern.test(output),
	).map(({ label }) => label);
}

export function verificationCommandPassed(
	result: { ok: boolean; output: string; code: number | null },
	expectedExit = 0,
): { ok: boolean; fatalSignals: string[] } {
	const fatalSignals = fatalVerificationSignals(result.output);
	return {
		ok: result.code === expectedExit && fatalSignals.length === 0,
		fatalSignals,
	};
}

export function classifyTestFailure(
	output: string,
	ok: boolean,
	code: number | null,
): TestFailureKind {
	if (ok) return "none";
	const text = output.toLowerCase();
	if (code === null || text.includes("timed out") || text.includes("timeout"))
		return "timeout";
	if (
		text.includes("no configured deterministic test") ||
		text.includes("no deterministic test") ||
		text.includes("missing test command")
	)
		return "missing_test";
	if (
		text.includes("cannot find module") ||
		text.includes("module not found") ||
		text.includes("no such file or directory") ||
		text.includes("command not found")
	)
		return "missing_dependency";
	if (
		text.includes("typescript") ||
		text.includes("tsc") ||
		text.includes("type error") ||
		text.includes("is not assignable to") ||
		(text.includes("property") && text.includes("does not exist"))
	)
		return "type_error";
	if (
		text.includes("syntaxerror") ||
		text.includes("compile") ||
		text.includes("compilation") ||
		text.includes("build failed")
	)
		return "compile_error";
	if (
		text.includes("eslint") ||
		text.includes("lint") ||
		text.includes("prettier") ||
		text.includes("format")
	)
		return "lint_error";
	if (
		text.includes("integration") ||
		text.includes("e2e") ||
		text.includes("playwright") ||
		text.includes("cypress")
	)
		return "integration_failure";
	if (
		text.includes("test") ||
		text.includes("expect") ||
		text.includes("assert") ||
		text.includes("failed")
	)
		return "unit_failure";
	return "unknown";
}
