// Pure path/command safety helpers used by the extension's tool_call guard.
// Only depends on node:path. No fs, no spawn, no Pi runtime deps.

import * as path from "node:path";

export function normalizeRelativePath(cwd: string, candidate: string): string {
	const absolute = path.isAbsolute(candidate)
		? candidate
		: path.resolve(cwd, candidate);
	return path.relative(cwd, absolute).replace(/\\/g, "/");
}

export function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "::DOUBLE_STAR::")
		.replace(/\*/g, "[^/]*")
		.replace(/::DOUBLE_STAR::/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

// Returns the matching protected-path pattern (truthy) or undefined.
export function isProtectedPath(
	cwd: string,
	config: { protectedPaths: string[] },
	candidate: string,
): string | undefined {
	const rel = normalizeRelativePath(cwd, candidate);
	return config.protectedPaths.find(
		(pattern) =>
			globToRegExp(pattern).test(rel) ||
			globToRegExp(pattern).test(path.basename(rel)),
	);
}

// Returns a human-readable reason string when a bash command looks destructive,
// otherwise undefined. Best-effort denylist (defense-in-depth), not a sandbox.
export function isDestructiveCommand(command: string): string | undefined {
	const checks: Array<[RegExp, string]> = [
		[
			/\brm\s+(-[^\n]*[rf]|[^\n]*\s-r|[^\n]*\s-f)/i,
			"rm with recursive/force flags",
		],
		[/\bsudo\b/i, "sudo"],
		[/\bchmod\s+(-R\s+)?777\b/i, "chmod 777"],
		[/\bchown\s+-R\b/i, "recursive chown"],
		[/\bgit\s+(reset\s+--hard|clean\s+-[fdx]+)/i, "destructive git reset/clean"],
		[/\b(killall|pkill)\b/i, "process kill"],
		[/>\s*\.(env|npmrc|pypirc)\b/i, "redirect into sensitive config"],
	];
	return checks.find(([regex]) => regex.test(command))?.[1];
}
