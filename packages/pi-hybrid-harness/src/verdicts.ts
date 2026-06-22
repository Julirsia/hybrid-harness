// Pure parsers for child-run output: JSON extraction, reviewer/gate verdicts, and
// a usability check for child Pi runs. No fs, no spawn, no Pi runtime deps.

export type LocalVerdict = "PASS" | "PASS_WITH_CONCERNS" | "FAIL" | "UNKNOWN";
export type FrontierVerdict =
	| "APPROVE"
	| "REQUEST_CHANGES"
	| "ESCALATE_TO_USER"
	| "UNKNOWN";

// Best-effort extraction of a single JSON object from model output that may wrap
// it in a ```json fence or surround it with prose.
export function extractJsonObject<T>(text: string): T | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	const candidates = fenced ? [fenced[1], text] : [text];
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate.trim()) as T;
		} catch {
			// try brace extraction below
		}
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(candidate.slice(start, end + 1)) as T;
			} catch {
				// keep trying
			}
		}
	}
	return undefined;
}

export function parseLocalVerdict(text: string): LocalVerdict {
	const json = extractJsonObject<{ verdict?: string }>(text);
	const jsonVerdict = json?.verdict?.toUpperCase();
	if (jsonVerdict === "PASS_WITH_CONCERNS") return "PASS_WITH_CONCERNS";
	if (jsonVerdict === "PASS") return "PASS";
	if (jsonVerdict === "FAIL") return "FAIL";
	const normalized = text.toUpperCase();
	const match = normalized.match(/VERDICT\s*:?\s*(PASS_WITH_CONCERNS|PASS|FAIL)/);
	if (match?.[1] === "PASS_WITH_CONCERNS") return "PASS_WITH_CONCERNS";
	if (match?.[1] === "PASS") return "PASS";
	if (match?.[1] === "FAIL") return "FAIL";
	return "UNKNOWN";
}

export function parseFrontierVerdict(text: string): FrontierVerdict {
	const json = extractJsonObject<{ verdict?: string }>(text);
	const jsonVerdict = json?.verdict?.toUpperCase();
	if (jsonVerdict === "APPROVE") return "APPROVE";
	if (jsonVerdict === "REQUEST_CHANGES") return "REQUEST_CHANGES";
	if (jsonVerdict === "ESCALATE_TO_USER") return "ESCALATE_TO_USER";
	const normalized = text.toUpperCase();
	const match = normalized.match(
		/VERDICT\s*:?\s*(APPROVE|REQUEST_CHANGES|ESCALATE_TO_USER)/,
	);
	if (match?.[1] === "APPROVE") return "APPROVE";
	if (match?.[1] === "REQUEST_CHANGES") return "REQUEST_CHANGES";
	if (match?.[1] === "ESCALATE_TO_USER") return "ESCALATE_TO_USER";
	return "UNKNOWN";
}

// A child Pi run is only usable as stage output when it exited cleanly AND produced
// non-empty text. Timed-out (124), crashed, stuck-loop-guarded (125), or empty
// runs must not be silently captured into an artifact and treated as success.
export function isUsableChildResult(result: {
	ok: boolean;
	text: string;
}): boolean {
	return result.ok === true && result.text.trim().length > 0;
}
