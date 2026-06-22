import assert from "node:assert/strict";
import test from "node:test";
import {
	estimateRoughTokenCount,
	formatBytes,
	inferContextWindow,
	safeSessionIdPart,
	stripAnsiCodes,
	truncateMiddle,
} from "../src/text.ts";

test("truncateMiddle keeps short text and elides long text", () => {
	assert.equal(truncateMiddle("short", 100), "short");
	const long = "x".repeat(1000);
	const out = truncateMiddle(long, 400);
	assert.ok(out.length < long.length);
	assert.match(out, /chars omitted/);
});

test("stripAnsiCodes removes escape sequences but keeps plain brackets", () => {
	const esc = String.fromCharCode(27);
	assert.equal(stripAnsiCodes(`${esc}[31mred${esc}[0m`), "red");
	assert.equal(stripAnsiCodes("arr[0] = items[1]"), "arr[0] = items[1]");
});

test("safeSessionIdPart slugifies and bounds length", () => {
	assert.equal(safeSessionIdPart("Add Login Flow!"), "add-login-flow");
	assert.equal(safeSessionIdPart("   "), "task");
	assert.ok(safeSessionIdPart("a".repeat(200)).length <= 80);
});

test("formatBytes renders human units and rejects bad input", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(2048), "2.0 KiB");
	assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MiB");
	assert.equal(formatBytes(-1), "unknown");
	assert.equal(formatBytes(Number.NaN), "unknown");
});

test("estimateRoughTokenCount weights ASCII, CJK, and other chars", () => {
	assert.equal(estimateRoughTokenCount(""), 0);
	assert.equal(estimateRoughTokenCount("abcdefgh"), 2); // 8 ascii / 4
	assert.equal(estimateRoughTokenCount("가나다"), 3); // 1 token per CJK char
	assert.ok(estimateRoughTokenCount("x") >= 1);
});

test("inferContextWindow reads size hints from id/description", () => {
	assert.equal(inferContextWindow({ id: "qwen-200k" }), 200_000);
	assert.equal(inferContextWindow({ id: "m", description: "131k ctx" }), 131_000);
	assert.equal(inferContextWindow({ id: "plain" }), 128_000);
});
