import assert from "node:assert/strict";
import test from "node:test";
import {
	extractJsonObject,
	isUsableChildResult,
	parseFrontierVerdict,
	parseLocalVerdict,
} from "../src/verdicts.ts";

test("extractJsonObject parses a fenced ```json block", () => {
	const out = extractJsonObject<{ verdict: string }>(
		'prose before\n```json\n{"verdict":"PASS"}\n```\nprose after',
	);
	assert.deepEqual(out, { verdict: "PASS" });
});

test("extractJsonObject falls back to brace extraction around prose", () => {
	const out = extractJsonObject<{ a: number }>('noise {"a":1} trailing');
	assert.deepEqual(out, { a: 1 });
});

test("extractJsonObject returns undefined when there is no JSON", () => {
	assert.equal(extractJsonObject("just words, no object"), undefined);
});

test("parseLocalVerdict reads the JSON verdict field first", () => {
	assert.equal(parseLocalVerdict('{"verdict":"PASS_WITH_CONCERNS"}'), "PASS_WITH_CONCERNS");
	assert.equal(parseLocalVerdict('{"verdict":"pass"}'), "PASS");
	assert.equal(parseLocalVerdict('{"verdict":"FAIL"}'), "FAIL");
});

test("parseLocalVerdict falls back to a 'Verdict:' line", () => {
	assert.equal(parseLocalVerdict("Summary...\nVerdict: FAIL\nmore"), "FAIL");
	assert.equal(parseLocalVerdict("VERDICT PASS_WITH_CONCERNS"), "PASS_WITH_CONCERNS");
});

test("parseLocalVerdict returns UNKNOWN when nothing matches", () => {
	assert.equal(parseLocalVerdict("no verdict here"), "UNKNOWN");
	assert.equal(parseLocalVerdict(""), "UNKNOWN");
});

test("parseLocalVerdict prefers PASS_WITH_CONCERNS over substring PASS", () => {
	// Guards against a naive /PASS/ match swallowing PASS_WITH_CONCERNS.
	assert.equal(parseLocalVerdict("Verdict: PASS_WITH_CONCERNS"), "PASS_WITH_CONCERNS");
});

test("parseFrontierVerdict reads JSON and text fallbacks", () => {
	assert.equal(parseFrontierVerdict('{"verdict":"APPROVE"}'), "APPROVE");
	assert.equal(parseFrontierVerdict('{"verdict":"request_changes"}'), "REQUEST_CHANGES");
	assert.equal(parseFrontierVerdict("Verdict: ESCALATE_TO_USER"), "ESCALATE_TO_USER");
	assert.equal(parseFrontierVerdict("inconclusive output"), "UNKNOWN");
});

test("isUsableChildResult requires ok AND non-empty text", () => {
	assert.equal(isUsableChildResult({ ok: true, text: "design package" }), true);
	assert.equal(isUsableChildResult({ ok: false, text: "design package" }), false);
	assert.equal(isUsableChildResult({ ok: true, text: "   \n  " }), false);
	assert.equal(isUsableChildResult({ ok: true, text: "" }), false);
});
