// Pure normalizers that coerce loose model/JSON values into the harness's status
// unions. No fs, no spawn, no Pi runtime deps.

import type {
	CriterionStatus,
	EvidenceType,
	SliceStatus,
} from "./types.ts";

export function normalizeSliceStatus(value: unknown): SliceStatus {
	switch (
		String(value ?? "")
			.toLowerCase()
			.replace(/[-\s]+/g, "_")
	) {
		case "done":
		case "complete":
		case "completed":
		case "pass":
		case "passed":
		case "satisfied":
			return "done";
		case "in_progress":
		case "running":
		case "active":
			return "in_progress";
		case "blocked":
		case "failed":
			return "blocked";
		default:
			return "pending";
	}
}

export function normalizeCriterionStatus(value: unknown): CriterionStatus {
	switch (
		String(value ?? "")
			.toLowerCase()
			.replace(/[-\s]+/g, "_")
	) {
		case "satisfied":
		case "done":
		case "complete":
		case "completed":
		case "pass":
		case "passed":
			return "satisfied";
		case "failed":
		case "fail":
			return "failed";
		case "unknown":
			return "unknown";
		default:
			return "pending";
	}
}

export function normalizeStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function normalizeEvidenceType(value: unknown): EvidenceType | undefined {
	const normalized = String(value ?? "").toLowerCase();
	if (
		normalized === "unit" ||
		normalized === "integration" ||
		normalized === "e2e" ||
		normalized === "manual" ||
		normalized === "static" ||
		normalized === "smoke"
	)
		return normalized;
	return undefined;
}
