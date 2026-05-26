import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve("extensions/hybrid-harness.ts");
const source = readFileSync(sourcePath, "utf8");

function between(startNeedle, endNeedle) {
	const start = source.indexOf(startNeedle);
	assert.notEqual(start, -1, `missing start marker: ${startNeedle}`);
	const end = source.indexOf(endNeedle, start);
	assert.notEqual(end, -1, `missing end marker: ${endNeedle}`);
	return source.slice(start, end);
}

test("report overlays use the custom UI whenever interactive UI is available", () => {
	const block = between("const showReport = async", "let activeHybridMonitorClose");
	assert.match(block, /if \(ctx\?\.hasUI && ctx\?\.ui\?\.custom\) \{/);
	assert.doesNotMatch(block, /ctx\.isIdle\?\.\(\) === false/);
});

test("hybrid_run tool execution publishes live monitor snapshots", () => {
	const block = between("async execute(", "return {");
	assert.match(block, /const liveId = makeHybridLiveId\(\)/);
	assert.match(block, /setLastHybridLiveId\(liveId\)/);
	assert.match(block, /const store = getHybridLiveStore\(\)/);
	assert.match(block, /store\.set\(liveId,\s*\{ version: \+\+version, details: result\.details \}\)/);
});

test("event persistence stores compact metadata instead of raw tool events", () => {
	const block = between("function compactEventForJsonl", "async function runPiOnce");
	assert.match(block, /event\.type === "tool_execution_end"/);
	assert.doesNotMatch(block, /return event;/);
});

test("live logger does not append every live child output line to disk", () => {
	const block = between("function createLiveLogger", "function hybridStageIcon");
	assert.doesNotMatch(block, /appendFileSync\(\s*liveLogPath/);
});

test("hybrid markdown rendering adapts pi theme to markdown theme", () => {
	assert.match(source, /function markdownThemeForPiTheme/);
	const markdownCalls = source.match(/new Markdown\([^;\n]+/g) || [];
	assert.ok(markdownCalls.length > 0, "expected Markdown render calls");
	for (const call of markdownCalls) {
		assert.match(call, /markdownThemeForPiTheme\(/);
	}
});

test("report overlay opens long reports from the top", () => {
	const block = between("class HybridReportOverlayComponent", "async function selectHybridItem");
	assert.match(block, /private scrollOffset = Number\.MAX_SAFE_INTEGER/);
});

test("hybrid config report fences json so glob patterns render literally", () => {
	const block = between('pi.registerCommand("hybrid-config"', 'pi.registerCommand("hybrid-models"');
	assert.match(block, /"# Hybrid Config"/);
	assert.match(block, /"```json"/);
	assert.match(block, /content\.trimEnd\(\)/);
	assert.doesNotMatch(block, /`\/\/ \$\{configFile\}\\n\$\{content\}`/);
});

test("hybrid monitor normalizes tabs before wrapping live output", () => {
	assert.match(source, /function normalizeTuiText/);
	const block = between("class HybridMonitorOverlayComponent", "class HybridLiveMessageComponent");
	assert.match(block, /normalizeTuiText\(line\)/);
	assert.doesNotMatch(block, /wrapTextWithAnsi\(line,\s*bodyWidth\)/);
});

test("local child runs record rough token estimates without persisting raw output", () => {
	assert.match(source, /function estimateRoughTokenCount/);
	const runBlock = between("async function runPiOnce", "async function fetchLocalModels");
	assert.match(runBlock, /estimatedInput: estimateRoughTokenCount\(options\.prompt\)/);
	assert.match(runBlock, /estimateRoughTokenCount\(output\)/);
	assert.match(runBlock, /type: "usage_estimate"/);
	const formatBlock = between("function formatUsage", "function usageSummaryMarkdown");
	assert.match(formatBlock, /estIn=\$\{u\.estimatedInput\}/);
	assert.doesNotMatch(runBlock, /appendFileSync\([^)]*output/s);
});

test("hybrid usage summary visualizes local token savings", () => {
	const block = between("function usageSummaryMarkdown", "function statusMarkdown");
	assert.match(block, /"## Token Routing"/);
	assert.match(block, /frontier tokens avoided/);
	assert.match(block, /avoided frontier share/);
	assert.match(block, /tokenRoutingBar\(localEffective,\s*frontierEffective,\s*32\)/);
	assert.match(block, /estimateFrontierEquivalentCost/);
});

test("hybrid monitor renders live token routing and configured savings", () => {
	assert.match(source, /function formatTokenRoutingLines/);
	const block = between("class HybridMonitorOverlayComponent", "class HybridLiveMessageComponent");
	assert.match(block, /formatTokenRoutingLines\(th,\s*details\)/);
	assert.match(source, /frontierInputCostPerMTok/);
	assert.match(source, /frontierOutputCostPerMTok/);
});

test("progress reconciliation accepts completion aliases and rewrites canonical markdown", () => {
	assert.match(source, /function normalizeSliceStatus/);
	assert.match(source, /function normalizeCriterionStatus/);
	assert.match(source, /case "complete":/);
	assert.match(source, /function reconcileHybridCompletion/);
	const reconcileBlock = between("function reconcileHybridCompletion", "async function runHybridStart");
	assert.match(reconcileBlock, /status: "done"/);
	assert.match(reconcileBlock, /status: "satisfied"/);
	assert.match(reconcileBlock, /writeProgress\(cwd,\s*config,\s*state,\s*progress\)/);
});

test("finishing step records structured verification summary and syncs state artifacts", () => {
	assert.match(source, /verificationCommands: string\[\]/);
	assert.match(source, /function runVerificationSummary/);
	assert.match(source, /"verification-summary.json"/);
	assert.match(source, /const failureKind: TestFailureKind = test\.ok\s*\?\s*"none"\s*:\s*classifyTestFailure/);
	assert.match(source, /function syncHarnessArtifacts/);
	assert.match(source, /"test-evidence.md"/);
	assert.match(source, /state\.phase = "implemented"/);
});

test("non-git workspaces use manifest review policy instead of permanent active FR blocker", () => {
	assert.match(source, /allowManifestReviewWhenNoGit: boolean/);
	assert.match(source, /function isGitRepository/);
	assert.match(source, /function workspaceManifestMarkdown/);
	assert.match(source, /allowManifestReviewWhenNoGit/);
	assert.match(source, /Reviewer rejects manifest-based review due to missing \.git directory/);
});

test("hybrid run and manual final gate finish artifacts before frontier final review", () => {
	const orchestrationBlock = between("async function runHybridOrchestration", "export default async function hybridHarness");
	assert.match(orchestrationBlock, /finishHybridArtifacts\(/);
	assert.ok(
		orchestrationBlock.indexOf("finishHybridArtifacts(") <
			orchestrationBlock.indexOf("runFrontierFinal("),
		"expected finishHybridArtifacts before runFrontierFinal in orchestration",
	);
	const finalBlock = between('pi.registerCommand("hybrid-final"', "});\n}");
	assert.match(finalBlock, /finishHybridArtifacts\(/);
	assert.ok(
		finalBlock.indexOf("finishHybridArtifacts(") <
			finalBlock.indexOf("runFrontierFinal("),
		"expected finishHybridArtifacts before runFrontierFinal in manual final command",
	);
});

test("hybrid orchestration persists cycle-aware run state for artifact-based resume", () => {
	assert.match(source, /interface HybridRunState/);
	assert.match(source, /"run-state.json"/);
	assert.match(source, /completedStages: Record<string,\s*string>/);
	assert.match(source, /function hybridRunStageKey/);
	assert.match(source, /function loadHybridRunState/);
	assert.match(source, /function markHybridRunStage/);
	assert.match(source, /function shouldSkipHybridStage/);
	const orchestrationBlock = between("async function runHybridOrchestration", "export default async function hybridHarness");
	assert.match(orchestrationBlock, /const runState = loadHybridRunState/);
	assert.match(orchestrationBlock, /markHybridRunStage\([^)]*"local-loop"[^)]*frontierPass[^)]*repairCycle/s);
	assert.match(orchestrationBlock, /shouldSkipHybridStage\([^)]*"local-review"[^)]*frontierPass[^)]*repairCycle/s);
	assert.match(orchestrationBlock, /markHybridRunFailure/);
});

test("resume skips completed artifact-backed stages before rerunning child sessions", () => {
	const block = between("async function runHybridOrchestration", "export default async function hybridHarness");
	assert.match(block, /shouldSkipHybridStage\([^)]*"design"/);
	assert.match(block, /shouldSkipHybridStage\([^)]*"brief"/);
	assert.match(block, /shouldSkipHybridStage\([^)]*"finish"/);
	assert.match(block, /parseLocalVerdict\(readArtifact\(options\.cwd,\s*config,\s*"local-review\.md"\)\)/);
	assert.match(block, /parseFrontierVerdict\(readArtifact\(options\.cwd,\s*config,\s*"final-review\.md"\)\)/);
	assert.match(block, /reporter\.stage\(\s*"frontier-final",\s*"skipped"/);
});

test("hybrid_run tool can resume without requiring a task payload", () => {
	const toolBlock = between('pi.registerTool({\n\t\tname: "hybrid_run"', 'pi.registerCommand("hybrid-monitor"');
	assert.match(toolBlock, /task\?: string/);
	assert.match(toolBlock, /required: \[\]/);
	assert.match(toolBlock, /args: params\.resume === true \? "" : \(params\.task \?\? ""\)/);
});

test("hybrid commands start orchestration in the background and expose cancellation", () => {
	assert.match(source, /const HYBRID_ACTIVE_RUN_KEY/);
	assert.match(source, /interface HybridActiveRun/);
	assert.match(source, /function startHybridBackgroundRun/);
	assert.match(source, /function abortHybridActiveRun/);
	const commandBlock = between("async function handleHybridRun", 'pi.registerCommand("hybrid-run"');
	assert.match(commandBlock, /startHybridBackgroundRun\(/);
	assert.doesNotMatch(commandBlock, /await runHybridOrchestration/);
	assert.match(source, /pi\.registerCommand\("hybrid-cancel"/);
	assert.match(source, /abortHybridActiveRun\(ctx\.cwd/);
});

test("parent steering is persisted and injected into later child prompts", () => {
	assert.match(source, /interface HybridSteeringEntry/);
	assert.match(source, /"steering\.jsonl"/);
	assert.match(source, /function appendHybridSteering/);
	assert.match(source, /function hybridSteeringMarkdown/);
	assert.match(source, /pi\.registerCommand\("hybrid-steer"/);
	assert.match(source, /appendHybridSteering\(ctx\.cwd,\s*config,\s*state,\s*args/);
	const workerPromptBlock = between("function localWorkerPrompt", "type Notify");
	assert.match(workerPromptBlock, /hybridSteeringMarkdown\(cwd,\s*config\)/);
	const startBlock = between("async function runHybridStart", "async function runLocalLoop");
	assert.match(startBlock, /hybridSteeringMarkdown\(cwd,\s*config\)/);
	const reviewBlock = between("async function runLocalReview", "async function runFrontierFinal");
	assert.match(reviewBlock, /hybridSteeringMarkdown\(cwd,\s*config\)/);
	const finalBlock = between("async function runFrontierFinal", "async function runHybridOrchestration");
	assert.match(finalBlock, /hybridSteeringMarkdown\(cwd,\s*config\)/);
});

test("hybrid_run tool supports background mode while preserving wait-for-completion", () => {
	const toolBlock = between('pi.registerTool({\n\t\tname: "hybrid_run"', 'pi.registerCommand("hybrid-monitor"');
	assert.match(toolBlock, /background\?: boolean/);
	assert.match(toolBlock, /params\.background !== false/);
	assert.match(toolBlock, /startHybridBackgroundRun\(/);
	assert.match(toolBlock, /await runHybridOrchestration/);
});

test("hybrid run render normalizes partial live details before reading task", () => {
	assert.match(source, /function normalizeHybridRunDetailsForRender/);
	assert.match(source, /"\(task missing\)"/);
	const renderBlock = between(
		"function renderHybridRunResult",
		"type HybridLiveSnapshot",
	);
	assert.match(renderBlock, /normalizeHybridRunDetailsForRender\(details\)/);
	assert.doesNotMatch(renderBlock, /buildHybridRunComponent\(details,/);
	const liveMessageBlock = between(
		"class HybridLiveMessageComponent",
		"function parseLocalVerdict",
	);
	assert.match(liveMessageBlock, /normalizeHybridRunDetailsForRender\(/);
});

test("background runs use workspace lock and heartbeat for cross-session safety", () => {
	assert.match(source, /interface HybridRunLock/);
	assert.match(source, /"active-run\.json"/);
	assert.match(source, /function writeHybridRunLock/);
	assert.match(source, /function heartbeatHybridRunLock/);
	assert.match(source, /function requestHybridRunCancel/);
	assert.match(source, /function isHybridRunLockStale/);
	const backgroundBlock = between("function startHybridBackgroundRun", "class HybridMonitorOverlayComponent");
	assert.match(backgroundBlock, /readHybridRunLock\(options\.cwd,\s*config\)/);
	assert.match(backgroundBlock, /writeHybridRunLock\(/);
	assert.match(backgroundBlock, /setInterval\(\(\) =>/);
	assert.match(backgroundBlock, /heartbeatHybridRunLock\(/);
	assert.match(backgroundBlock, /clearHybridRunLock\(/);
	assert.match(backgroundBlock, /controller\.abort\(\)/);
});

test("steering commands can list clear and mark consumed entries", () => {
	assert.match(source, /consumedAt\?: string/);
	assert.match(source, /consumedStage\?: string/);
	assert.match(source, /function writeHybridSteering/);
	assert.match(source, /function markHybridSteeringConsumed/);
	assert.match(source, /function clearHybridSteering/);
	assert.match(source, /pi\.registerCommand\("hybrid-steering"/);
	assert.match(source, /pi\.registerCommand\("hybrid-steer-clear"/);
	const steeringBlock = between("function hybridSteeringMarkdown", "function hybridRunStageKey");
	assert.match(steeringBlock, /filter\(\(entry\) => !entry\.consumedAt\)/);
});

test("hybrid status reports active run lock and queued steering", () => {
	const block = between("function statusMarkdown", "function setStatusWidget");
	assert.match(block, /readHybridRunLock\(cwd,\s*config\)/);
	assert.match(block, /readHybridSteering\(cwd,\s*config\)/);
	assert.match(block, /## Active Run/);
	assert.match(block, /Queued steering/);
});

test("monitor has explicit two-step cancel while esc only closes", () => {
	const block = between("class HybridMonitorOverlayComponent", "class HybridLiveMessageComponent");
	assert.match(block, /private cancelArmed = false/);
	assert.match(block, /abortHybridActiveRun\(this\.cwd\)/);
	assert.match(block, /data === "x"/);
	assert.match(block, /Press x again to cancel/);
	assert.match(block, /matchesKey\(data,\s*Key\.escape\)[\s\S]*this\.close\(\);[\s\S]*if \(data === "x"/);
});

test("hybrid retry and resume-from clear stage checkpoints", () => {
	assert.match(source, /function clearHybridStageCheckpoint/);
	assert.match(source, /function clearHybridStageFrom/);
	assert.match(source, /pi\.registerCommand\("hybrid-retry"/);
	assert.match(source, /pi\.registerCommand\("hybrid-resume-from"/);
	assert.match(source, /clearHybridStageCheckpoint\(ctx\.cwd,\s*config,\s*state,\s*args\.trim\(\)/);
	assert.match(source, /clearHybridStageFrom\(ctx\.cwd,\s*config,\s*state,\s*args\.trim\(\)/);
});

test("child runs abort repeated tool patterns before burning time", () => {
	assert.match(source, /function hybridToolPattern/);
	const runBlock = between("async function runPiOnce", "async function fetchLocalModels");
	assert.match(runBlock, /lastToolPattern/);
	assert.match(runBlock, /repeatedToolPatternCount/);
	assert.match(runBlock, /stuck-loop-guard/);
	assert.match(runBlock, /proc\.kill\("SIGTERM"\)/);
});
