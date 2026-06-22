import assert from "node:assert/strict";
import test from "node:test";
import {
	globToRegExp,
	isDestructiveCommand,
	isProtectedPath,
	normalizeRelativePath,
} from "../src/safety.ts";

test("globToRegExp treats * as single-segment and ** as multi-segment", () => {
	assert.equal(globToRegExp("*.env").test("foo.env"), true);
	assert.equal(globToRegExp("*.env").test("a/foo.env"), false);
	assert.equal(globToRegExp("**/.env").test("a/b/.env"), true);
	assert.equal(globToRegExp(".git/**").test(".git/config/x"), true);
	assert.equal(globToRegExp("**/*secret*").test("src/api_secret_key.ts"), true);
});

test("normalizeRelativePath produces a forward-slash relative path", () => {
	assert.equal(normalizeRelativePath("/repo", "/repo/src/a.ts"), "src/a.ts");
	assert.equal(normalizeRelativePath("/repo", "src/a.ts"), "src/a.ts");
});

const PROTECTED = {
	protectedPaths: [
		".env",
		".env.*",
		"**/.env",
		"**/.env.*",
		".git/**",
		"**/*secret*",
		"**/*token*",
	],
};

test("isProtectedPath blocks env, git, and secret-like paths", () => {
	assert.ok(isProtectedPath("/repo", PROTECTED, "/repo/.env"));
	assert.ok(isProtectedPath("/repo", PROTECTED, "/repo/.env.local"));
	assert.ok(isProtectedPath("/repo", PROTECTED, "/repo/services/api/.env"));
	assert.ok(isProtectedPath("/repo", PROTECTED, "/repo/.git/config"));
	assert.ok(isProtectedPath("/repo", PROTECTED, "/repo/lib/my_secret.json"));
	assert.ok(isProtectedPath("/repo", PROTECTED, "/repo/auth/access_token.ts"));
});

test("isProtectedPath allows ordinary source files", () => {
	assert.equal(isProtectedPath("/repo", PROTECTED, "/repo/src/index.ts"), undefined);
	assert.equal(isProtectedPath("/repo", PROTECTED, "/repo/README.md"), undefined);
});

test("isDestructiveCommand flags dangerous commands with a reason", () => {
	assert.match(String(isDestructiveCommand("rm -rf build")), /rm with recursive/);
	assert.match(String(isDestructiveCommand("sudo apt install x")), /sudo/);
	assert.match(String(isDestructiveCommand("git reset --hard HEAD~1")), /git reset/);
	assert.match(String(isDestructiveCommand("git clean -fdx")), /git/);
	assert.match(String(isDestructiveCommand("chmod 777 file")), /chmod 777/);
	assert.match(String(isDestructiveCommand("pkill node")), /process kill/);
});

test("isDestructiveCommand returns undefined for safe commands", () => {
	assert.equal(isDestructiveCommand("npm test"), undefined);
	assert.equal(isDestructiveCommand("git status"), undefined);
	assert.equal(isDestructiveCommand("rm file.txt"), undefined); // no -r/-f
});
