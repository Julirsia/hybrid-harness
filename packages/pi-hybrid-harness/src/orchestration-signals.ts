// Pure orchestration-health signals for parent-driven (hybrid_exec) mode.
//
// These turn raw per-package outcomes into a machine-readable convergence verdict
// the parent orchestrator can act on, so a run cannot silently spin in a loop that
// makes no progress (the failure mode where a debug package produces no changes but
// the gate keeps failing for the same reason).
//
// No fs, no spawn, no Pi runtime deps.

export type Convergence =
	| "complete"
	| "blocked-no-tests"
	| "stalled"
	| "progressing";

// Detects the generic single-slice progress the harness writes when no structured
// plan was extracted from the design/tasks. If this is still in place mid-run, the
// parent never decomposed spec-kit tasks.md into slices/acceptance criteria.
export function isFallbackProgress(progress: {
	slices: Array<{ id: string; title: string }>;
	acceptanceCriteria: Array<{ id: string }>;
}): boolean {
	const slice = progress.slices[0];
	const criterion = progress.acceptanceCriteria[0];
	return (
		progress.slices.length === 1 &&
		slice?.id === "S1" &&
		/implement requested change/i.test(slice?.title ?? "") &&
		progress.acceptanceCriteria.length === 1 &&
		criterion?.id === "AC1"
	);
}

// Classifies a single package outcome:
// - complete:         review passed and deterministic verification passed.
// - blocked-no-tests: an interactive/runtime task with no deterministic behavioral
//                     test exists -> the gate is structurally unsatisfiable; sending
//                     more implementation/debug packages will never converge.
// - stalled:          the writer produced no workspace change and the review did not
//                     pass -> repeating the same package will not help.
// - progressing:      not done, but the writer is still changing the workspace.
export function assessConvergence(input: {
	verdict: string;
	verificationPassed: boolean;
	workspaceChanged: boolean;
	interactivePolicyActive: boolean;
	hasDeterministicTest: boolean;
}): Convergence {
	const reviewPassed =
		input.verdict === "PASS" || input.verdict === "PASS_WITH_CONCERNS";
	// blocked-no-tests is checked first: an interactive/runtime task with no behavioral
	// test can never legitimately be "complete" (smoke like tsc/build must not roll up to
	// done), so this also guards against a weak reviewer wrongly passing it.
	if (input.interactivePolicyActive && !input.hasDeterministicTest)
		return "blocked-no-tests";
	if (reviewPassed && input.verificationPassed) return "complete";
	if (!input.workspaceChanged) return "stalled";
	return "progressing";
}

// True for a command that exercises runtime/behavioral test assertions, as opposed to
// smoke checks (typecheck/build/lint) that do not prove behavior.
export function isBehavioralTestCommand(command: string): boolean {
	const c = command.toLowerCase();
	if (/(^|\s)(tsc|--noemit|typecheck|build|lint|prettier|format)(\s|$)/.test(c))
		return false;
	return /(test|playwright|cypress|vitest|jest|mocha|e2e|spec)/.test(c);
}

// The directive the parent must follow for a given convergence state. Returned as a
// short imperative so it can be embedded verbatim in run-summary.md.
export function convergenceDirective(convergence: Convergence): string {
	switch (convergence) {
		case "complete":
			return "Package complete. Decide the next batch, or run /hybrid-final once all tasks are done.";
		case "blocked-no-tests":
			return "BLOCKED: interactive/runtime task has no deterministic behavioral test, so the gate cannot pass. The next package MUST author a runtime/e2e test (e.g. Playwright/Vitest) or set testCommand — or escalate to the user. Do NOT send another implementation/debug package; it will not converge.";
		case "stalled":
			return "STALLED: the writer made no workspace changes and the review did not pass. Do NOT resend the same package. Target the blocking issues below explicitly, change strategy, or escalate to the user.";
		case "progressing":
			return "Progressing. Send a repair/next package that targets the blocking issues and missing evidence below.";
	}
}
