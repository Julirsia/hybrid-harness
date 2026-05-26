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

function assertOrder(block, firstNeedle, secondNeedle) {
	const first = block.indexOf(firstNeedle);
	const second = block.indexOf(secondNeedle);
	assert.notEqual(first, -1, `missing ordered marker: ${firstNeedle}`);
	assert.notEqual(second, -1, `missing ordered marker: ${secondNeedle}`);
	assert.ok(first < second, `expected ${firstNeedle} before ${secondNeedle}`);
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

test("serious task plan review is a first-class stage before local implementation", () => {
	assert.match(source, /type PlanReviewVerdict = "READY" \| "NEEDS_REVISION" \| "ESCALATE_TO_USER"/);

	const stageTypeBlock = between("type HybridRunStageId =", "interface HybridRunStage");
	assert.match(stageTypeBlock, /\|\s*"plan-review"/);

	const orderBlock = between("const HYBRID_STAGE_ORDER", "function normalizeHybridRunStageId");
	assertOrder(orderBlock, '"plan-review"', '"local-loop"');

	const detailsBlock = between("function createHybridRunDetails", "function normalizeHybridRunDetailsForRender");
	assertOrder(detailsBlock, 'id: "plan-review"', 'id: "local-loop"');

	const readinessBlock = between("function hybridStageArtifactsReady", "function shouldSkipHybridStage");
	assert.match(readinessBlock, /stage === "plan-review"[\s\S]*planReviewArtifactReady/);
	assert.match(readinessBlock, /stage === "finish"[\s\S]*"claim-evidence-matrix\.md"/);

	const artifactBlock = between("function hybridStageArtifactNames", "function clearHybridStageCheckpoint");
	assert.match(artifactBlock, /stage === "plan-review"[\s\S]*"plan-review\.md"/);
	assert.match(artifactBlock, /stage === "finish"[\s\S]*"claim-evidence-matrix\.md"/);

	const cleanBlock = between("function cleanRunArtifacts", "function truncateMiddle");
	assert.match(cleanBlock, /"plan-review\.md"/);

	const syncBlock = between("function syncHarnessArtifacts", "function reconcileHybridCompletion");
	assert.match(syncBlock, /"plan-review\.md"/);
});

test("frontier design gate commands use frontier model and durable artifacts", () => {
	assert.match(source, /async function runFrontierInterview/);
	assert.match(source, /async function runFrontierGrill/);

	const interviewBlock = between("async function runFrontierInterview", "async function runFrontierGrill");
	assert.match(interviewBlock, /FRONTIER REQUIREMENTS INTERVIEWER/);
	assert.match(interviewBlock, /frontier owns design\/requirements judgment/i);
	assert.match(interviewBlock, /local\/Qwen may provide repo facts/i);
	assert.match(interviewBlock, /must not implement/i);
	assert.match(interviewBlock, /ask exactly one next question/i);
	assert.match(interviewBlock, /implementation-ready handoff/i);
	assert.match(interviewBlock, /model: config\.frontierModel/);
	assert.match(interviewBlock, /thinking: config\.frontierThinking/);
	assert.match(interviewBlock, /writeArtifact\([^)]*"requirements\.md"/s);

	const grillBlock = between("async function runFrontierGrill", "async function runHybridStart");
	assert.match(grillBlock, /FRONTIER DESIGN GRILL/);
	assert.match(grillBlock, /frontier owns design\/requirements judgment/i);
	assert.match(grillBlock, /rejected alternatives/i);
	assert.match(grillBlock, /failure modes/i);
	assert.match(grillBlock, /compatibility/i);
	assert.match(grillBlock, /rollout/i);
	assert.match(grillBlock, /ask exactly one next question/i);
	assert.match(grillBlock, /model: config\.frontierModel/);
	assert.match(grillBlock, /thinking: config\.frontierThinking/);
	assert.match(grillBlock, /writeArtifact\([^)]*"design-grill\.md"/s);

	const cleanBlock = between("function cleanRunArtifacts", "function truncateMiddle");
	assert.match(cleanBlock, /"requirements\.md"/);
	assert.match(cleanBlock, /"design-grill\.md"/);

	const syncBlock = between("function syncHarnessArtifacts", "function reconcileHybridCompletion");
	assert.match(syncBlock, /"requirements\.md"/);
	assert.match(syncBlock, /"design-grill\.md"/);

	const commandBlock = between('pi.registerCommand("hybrid-interview"', 'pi.registerCommand("hybrid-steer"');
	assert.match(commandBlock, /pi\.registerCommand\("hybrid-interview"/);
	assert.match(commandBlock, /runFrontierInterview\(/);
	assert.match(commandBlock, /showReport\("Hybrid Interview"/);
	assert.match(commandBlock, /pi\.registerCommand\("hybrid-grill"/);
	assert.match(commandBlock, /runFrontierGrill\(/);
	assert.match(commandBlock, /showReport\("Hybrid Grill"/);
});

test("plan review parser blocks missing, non-ready, or disagreed verdicts", () => {
	assert.match(source, /function normalizePlanReviewVerdict/);
	assert.match(source, /function normalizePlanReview/);
	assert.match(source, /function parsePlanReviewVerdict/);

	const normalizeVerdictBlock = between("function normalizePlanReviewVerdict(", "function normalizePlanReview(");
	assert.match(normalizeVerdictBlock, /value === "READY"/);
	assert.match(normalizeVerdictBlock, /value === "NEEDS_REVISION"/);
	assert.match(normalizeVerdictBlock, /value === "ESCALATE_TO_USER"/);
	assert.match(normalizeVerdictBlock, /return "NEEDS_REVISION"/);

	const normalizeReviewBlock = between("function normalizePlanReview", "function planReviewToMarkdown");
	assert.match(normalizeReviewBlock, /planArchitectVerdict[\s\S]*!== "READY"/);
	assert.match(normalizeReviewBlock, /planCriticVerdict[\s\S]*!== "READY"/);
	assert.match(normalizeReviewBlock, /verdict[\s\S]*!== "READY"/);
	assert.match(normalizeReviewBlock, /"ESCALATE_TO_USER"/);
	assert.match(normalizeReviewBlock, /"NEEDS_REVISION"/);
});

test("serious task plan review gate runs after brief and before local loop", () => {
	assert.match(source, /function seriousTaskPolicyApplies/);
	assert.match(source, /async function runPlanReview/);

	const policyBlock = between("function seriousTaskPolicyApplies", "function parsePlanReviewVerdict");
	assert.match(policyBlock, /brief\.taskRisk === "medium"/);
	assert.match(policyBlock, /brief\.taskRisk === "high"/);

	const orchestrationBlock = between("async function runHybridOrchestration", "export default async function hybridHarness");
	assertOrder(orchestrationBlock, "createOrchestrationBrief", "runPlanReview");
	assertOrder(orchestrationBlock, "runPlanReview", "runLocalLoop");
	assert.match(orchestrationBlock, /briefBeforeImplementation=false/);
	assert.match(orchestrationBlock, /seriousTaskPolicyApplies\(brief\)/);
	assert.match(orchestrationBlock, /const planReviewReady =/);
	assert.match(orchestrationBlock, /if \(!planReviewReady\)/);
	assert.match(orchestrationBlock, /plan review blocked implementation/i);
});

test("plan review child execution must succeed before local implementation", () => {
	const orchestrationBlock = between("async function runHybridOrchestration", "export default async function hybridHarness");
	assert.match(source, /function planReviewArtifactReady/);
	assert.match(source, /function parsePlanReviewChildOk/);
	assert.match(orchestrationBlock, /const \{ review: planReview,\s*result: planReviewResult \} = await runPlanReview/);
	assert.match(orchestrationBlock, /planReviewResult\.ok === true/);
	assert.match(orchestrationBlock, /planReview\.verdict === "READY" && planReviewResult\.ok === true/);
	assert.match(orchestrationBlock, /Plan review child execution failed/);

	const reuseBlock = between("function planReviewArtifactReady", "function shouldSkipHybridStage");
	assert.match(reuseBlock, /parsePlanReviewVerdict/);
	assert.match(reuseBlock, /parsePlanReviewChildOk/);
	assert.match(reuseBlock, /=== true/);
});

test("plan review prompt uses portable architect and critic rubrics", () => {
	const block = between("async function runPlanReview", "async function runHybridOrchestration");
	assert.match(block, /frontier-design\.md/);
	assert.match(block, /implementation-plan\.json/);
	assert.match(block, /orchestration-brief\.md/);
	assert.match(block, /repo-map\.md/);
	assert.match(block, /progress\.json/);
	assert.match(block, /plan_architect/);
	assert.match(block, /plan_critic/);
	assert.match(block, /CWS-compatible/);
	assert.match(block, /not CWS-dependent/);
	assert.match(block, /planArchitectVerdict/);
	assert.match(block, /planCriticVerdict/);
	assert.match(block, /reviewedValidationContracts/);
	assert.match(block, /sourceEvidence/);
	assert.match(block, /runtimeEvidence/);
});

test("quality-impacting review gates route to frontier model", () => {
	const planReviewBlock = between("async function runPlanReview", "async function createProgressFromDesign");
	assert.match(planReviewBlock, /FRONTIER PLAN REVIEWER/);
	assert.match(planReviewBlock, /model: config\.frontierModel/);
	assert.match(planReviewBlock, /thinking: config\.frontierThinking/);
	assert.doesNotMatch(planReviewBlock, /model: config\.localReviewerModel/);

	const implementationReviewBlock = between("async function runLocalReview", "async function runFrontierFinal");
	assert.match(implementationReviewBlock, /FRONTIER IMPLEMENTATION REVIEWER/);
	assert.match(implementationReviewBlock, /model: config\.frontierModel/);
	assert.match(implementationReviewBlock, /thinking: config\.frontierThinking/);
	assert.match(implementationReviewBlock, /# Frontier Implementation Review/);
	assert.doesNotMatch(implementationReviewBlock, /# Local Review/);
	assert.doesNotMatch(implementationReviewBlock, /model: config\.localReviewerModel/);

	const usageBlock = between("function usageSummaryMarkdown", "function statusMarkdown");
	assert.match(usageBlock, /\{ name: "local-review\.md", bucket: "frontier" \}/);

	const detailsBlock = between("function createHybridRunDetails", "function normalizeHybridRunDetailsForRender");
	assert.match(detailsBlock, /id: "local-review", label: "Frontier implementation review"/);

	const finalCommandBlock = between('pi.registerCommand("hybrid-final"', "});\n}");
	assert.doesNotMatch(finalCommandBlock, /local review/);
});

test("child runs abort repeated tool patterns before burning time", () => {
	assert.match(source, /function hybridToolPattern/);
	const runBlock = between("async function runPiOnce", "async function fetchLocalModels");
	assert.match(runBlock, /lastToolPattern/);
	assert.match(runBlock, /repeatedToolPatternCount/);
	assert.match(runBlock, /stuck-loop-guard/);
	assert.match(runBlock, /proc\.kill\("SIGTERM"\)/);
});

test("acceptance criteria carry executable verification contracts and evidence quality fields", () => {
	const typeBlock = between("interface HarnessProgress", "interface VerificationSummary");
	assert.match(typeBlock, /verificationContracts\?: string\[\]/);
	assert.match(typeBlock, /evidenceType\?:/);
	assert.match(typeBlock, /sourceEvidence\?: string\[\]/);
	assert.match(typeBlock, /runtimeEvidence\?: string\[\]/);
	assert.match(typeBlock, /adversarialProbes\?: string\[\]/);
	assert.match(typeBlock, /reentryProbes\?: string\[\]/);
	assert.match(typeBlock, /residualGaps\?: string\[\]/);

	const markdownBlock = between("function progressToMarkdown", "function fallbackProgress");
	assert.match(markdownBlock, /verification contracts/i);
	assert.match(markdownBlock, /source evidence/i);
	assert.match(markdownBlock, /runtime evidence/i);
	assert.match(markdownBlock, /adversarial probes/i);
	assert.match(markdownBlock, /reentry\/idempotency probes/i);
	assert.match(markdownBlock, /residual gaps/i);
});

test("finish artifacts include a claim-evidence matrix separate from command summary", () => {
	assert.match(source, /interface ClaimEvidenceRow/);
	assert.match(source, /function claimEvidenceMatrixMarkdown/);
	assert.match(source, /"claim-evidence-matrix\.md"/);
	const finishBlock = between("function runVerificationSummary", "function isInteractiveRuntimeText");
	assert.match(finishBlock, /claimEvidenceMatrixMarkdown\(progress,\s*summary\)/);
	assert.match(finishBlock, /writeArtifact\([^)]*"claim-evidence-matrix\.md"/s);
	assert.match(finishBlock, /Evidence type/);
	assert.match(finishBlock, /What would fail if broken/);
	assert.match(finishBlock, /Residual gap/);
});

test("local worker must distrust previous slices and avoid smoke-only completion", () => {
	const promptBlock = between("function localWorkerPrompt", "type Notify");
	assert.match(promptBlock, /smoke evidence cannot satisfy behavioral acceptance criteria/);
	assert.match(promptBlock, /Before starting the next slice, re-check at least one critical claim from the previous completed slice/);
	assert.match(promptBlock, /normal path/);
	assert.match(promptBlock, /invalid input/);
	assert.match(promptBlock, /state reentry/);
	assert.match(promptBlock, /restart\/retry\/idempotency/);
});

test("local and frontier reviewers require claim-evidence review and adversarial probes", () => {
	const localReviewBlock = between("async function runLocalReview", "async function runFrontierFinal");
	assert.match(localReviewBlock, /claimEvidenceMatrix/);
	assert.match(localReviewBlock, /implementationClaims/);
	assert.match(localReviewBlock, /testAssertionQuality/);
	assert.match(localReviewBlock, /independentAdversarialProbe/);
	assert.match(localReviewBlock, /highRiskResidualBlockers/);
	assert.match(localReviewBlock, /source-level evidence is not runtime evidence/);

	const finalBlock = between("async function runFrontierFinal", "async function runHybridOrchestration");
	assert.match(finalBlock, /claimEvidenceMatrix/);
	assert.match(finalBlock, /What would fail if broken/);
	assert.match(finalBlock, /minimum one counterexample/);
	assert.match(finalBlock, /state reentry\/idempotency/);
	assert.match(finalBlock, /public API, data integrity, authentication, payment, migration, or long-lived state/);
});
