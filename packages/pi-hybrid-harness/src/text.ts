// Pure text/number formatting helpers. No fs, no spawn, no Pi runtime deps.

export function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const half = Math.floor((maxChars - 120) / 2);
	return `${text.slice(0, half)}\n\n[... ${text.length - maxChars} chars omitted ...]\n\n${text.slice(-half)}`;
}

export function stripAnsiCodes(text: string): string {
	return text.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

export function safeSessionIdPart(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "task"
	);
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// Rough, provider-agnostic token estimate: ~4 ASCII chars/token, 1 token per CJK
// character, and 2 tokens per other multibyte character.
export function estimateRoughTokenCount(text: string): number {
	if (!text.trim()) return 0;
	let asciiChars = 0;
	let cjkChars = 0;
	let otherChars = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp <= 0x7f) {
			asciiChars++;
		} else if (/[぀-ヿ㐀-鿿가-힯]/u.test(ch)) {
			cjkChars++;
		} else {
			otherChars++;
		}
	}
	return Math.max(1, Math.ceil(asciiChars / 4) + cjkChars + otherChars * 2);
}

export function inferContextWindow(model: {
	id: string;
	description?: string;
}): number {
	const text = `${model.id} ${model.description ?? ""}`.toLowerCase();
	if (text.includes("200k")) return 200_000;
	if (text.includes("131k")) return 131_000;
	return 128_000;
}
