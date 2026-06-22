// Pure helpers for the /hybrid-set command: which scalar config keys are editable
// from the slash command, and how to coerce/validate a raw string value into the
// right type. No fs, no Pi deps.

export type ConfigValueType = "boolean" | "number" | "string" | "thinking";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

// Scalar config keys editable via /hybrid-set. Array keys (protectedPaths,
// verificationCommands) are intentionally excluded — edit those in config.json.
export const EDITABLE_CONFIG_KEYS: Record<string, ConfigValueType> = {
	stateDir: "string",
	localBaseUrl: "string",
	localProvider: "string",
	localWorkerModel: "string",
	localReviewerModel: "string",
	frontierModel: "string",
	frontierThinking: "thinking",
	frontierInputCostPerMTok: "number",
	frontierOutputCostPerMTok: "number",
	maxLocalLoops: "number",
	maxReviewRepairCycles: "number",
	maxFrontierPasses: "number",
	enableSafetyGuards: "boolean",
	allowDestructiveBash: "boolean",
	maxDiffCharsBeforeFrontier: "number",
	verboseChildOutput: "boolean",
	liveLogMaxWidgetLines: "number",
	briefBeforeImplementation: "boolean",
	askUserOnAmbiguity: "boolean",
	persistentWriterSession: "boolean",
	writerSessionDir: "string",
	testCommand: "string",
	allowManifestReviewWhenNoGit: "boolean",
	requireDeterministicTestsForInteractive: "boolean",
	requireIntegrationGate: "boolean",
	enableHybridFinalTool: "boolean",
};

export type CoerceResult =
	| { ok: true; value: boolean | number | string }
	| { ok: false; error: string };

export function coerceConfigValue(type: ConfigValueType, raw: string): CoerceResult {
	const trimmed = raw.trim();
	switch (type) {
		case "boolean": {
			const v = trimmed.toLowerCase();
			if (["true", "1", "on", "yes", "y"].includes(v)) return { ok: true, value: true };
			if (["false", "0", "off", "no", "n"].includes(v)) return { ok: true, value: false };
			return { ok: false, error: `expected a boolean (true/false), got "${raw}"` };
		}
		case "number": {
			const n = Number(trimmed);
			if (trimmed === "" || !Number.isFinite(n))
				return { ok: false, error: `expected a number, got "${raw}"` };
			return { ok: true, value: n };
		}
		case "thinking": {
			const v = trimmed.toLowerCase();
			if ((THINKING_LEVELS as readonly string[]).includes(v))
				return { ok: true, value: v };
			return {
				ok: false,
				error: `expected one of ${THINKING_LEVELS.join("|")}, got "${raw}"`,
			};
		}
		case "string":
			return { ok: true, value: trimmed };
	}
}
