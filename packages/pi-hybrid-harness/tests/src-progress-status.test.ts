import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeCriterionStatus,
	normalizeEvidenceType,
	normalizeSliceStatus,
	normalizeStringArray,
} from "../src/progress-status.ts";

test("normalizeSliceStatus maps completion aliases to done", () => {
	for (const v of ["done", "complete", "completed", "pass", "passed", "satisfied"]) {
		assert.equal(normalizeSliceStatus(v), "done", v);
	}
});

test("normalizeSliceStatus maps in-progress and blocked aliases", () => {
	assert.equal(normalizeSliceStatus("in progress"), "in_progress");
	assert.equal(normalizeSliceStatus("running"), "in_progress");
	assert.equal(normalizeSliceStatus("active"), "in_progress");
	assert.equal(normalizeSliceStatus("blocked"), "blocked");
	assert.equal(normalizeSliceStatus("failed"), "blocked");
});

test("normalizeSliceStatus defaults unknown values to pending", () => {
	assert.equal(normalizeSliceStatus("???"), "pending");
	assert.equal(normalizeSliceStatus(undefined), "pending");
	assert.equal(normalizeSliceStatus(null), "pending");
});

test("normalizeCriterionStatus maps aliases and defaults to pending", () => {
	assert.equal(normalizeCriterionStatus("passed"), "satisfied");
	assert.equal(normalizeCriterionStatus("complete"), "satisfied");
	assert.equal(normalizeCriterionStatus("fail"), "failed");
	assert.equal(normalizeCriterionStatus("failed"), "failed");
	assert.equal(normalizeCriterionStatus("unknown"), "unknown");
	assert.equal(normalizeCriterionStatus("weird"), "pending");
});

test("normalizeStringArray keeps only truthy strings", () => {
	assert.deepEqual(normalizeStringArray(["a", "", "b"]), ["a", "b"]);
	assert.deepEqual(normalizeStringArray([1, 2]), ["1", "2"]);
	assert.deepEqual(normalizeStringArray("not an array"), []);
	assert.deepEqual(normalizeStringArray(undefined), []);
});

test("normalizeEvidenceType only accepts known evidence types", () => {
	for (const v of ["unit", "integration", "e2e", "manual", "static", "smoke"]) {
		assert.equal(normalizeEvidenceType(v), v, v);
	}
	assert.equal(normalizeEvidenceType("UNIT"), "unit");
	assert.equal(normalizeEvidenceType("bogus"), undefined);
	assert.equal(normalizeEvidenceType(undefined), undefined);
});
