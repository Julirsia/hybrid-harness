// Shared status/enum unions used across the harness and its pure helper modules.
// Kept dependency-free so they can be imported by both the extension entry and
// the unit-tested src/ helpers without pulling in fs/spawn/Pi runtime types.

export type SliceStatus = "pending" | "in_progress" | "done" | "blocked";

export type CriterionStatus = "pending" | "satisfied" | "failed" | "unknown";

export type EvidenceType =
	| "unit"
	| "integration"
	| "e2e"
	| "manual"
	| "static"
	| "smoke";

export type TestFailureKind =
	| "none"
	| "compile_error"
	| "type_error"
	| "lint_error"
	| "unit_failure"
	| "integration_failure"
	| "timeout"
	| "missing_dependency"
	| "missing_test"
	| "unknown";
