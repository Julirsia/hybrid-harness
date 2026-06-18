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

test("handoff import discovers sibling specs and falls back to prompt validation commands", () => {
	assert.match(source, /function findHandoffSpecPath/);
	const specBlock = between("function findHandoffSpecPath", "function parseHandoffValidationCommandsFromPrompt");
	assert.match(specBlock, /manual-handoff-spec\.json/);
	assert.match(specBlock, /rootBase\.replace\(\/-handoff\$\/i, "-spec\.json"\)/);
	assert.match(specBlock, /siblingSpecs\.length === 1/);
	const promptBlock = between("function parseHandoffValidationCommandsFromPrompt", "function discoverHandoff");
	assert.match(promptBlock, /## Validation Commands/);
	assert.match(promptBlock, /Working directory:/);
	assert.match(promptBlock, /Expected exit:/);
	const discoverBlock = between("const prompt = fs.readFileSync\(promptPath, \"utf8\"\);", "\t});\n\tif \(lanes.length === 0\)");
	assert.match(discoverBlock, /specValidationCommands\.length \? specValidationCommands : parseHandoffValidationCommandsFromPrompt\(prompt\)/);
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

test("hybrid live monitor prioritizes Korean interactive status", () => {
	assert.match(source, /function koreanHybridRunOverviewLines/);
	assert.match(source, /function hybridStageLabelKo/);
	assert.match(source, /function childModelText/);
	assert.match(source, /function compactHybridLiveOutput/);
	assert.match(source, /function ratioBar/);
	assert.match(source, /function statusBadge/);
	assert.match(source, /function stageSummaryKo/);
	assert.match(source, /function localReviewSummary/);
	const monitorBlock = between("class HybridMonitorOverlayComponent", "class HybridLiveMessageComponent");
	assert.match(monitorBlock, /koreanHybridRunOverviewLines\(details,\s*th,\s*now\)/);
	assert.match(monitorBlock, /실시간 로그/);
	assert.match(monitorBlock, /compactHybridLiveOutput\(rawLog\)/);
	assert.match(monitorBlock, /let bodyRowsWritten = 0/);
	assert.match(monitorBlock, /for \(let i = bodyRowsWritten; i < bodyHeight; i\+\+\)/);
	assert.doesNotMatch(monitorBlock, /Math\.min\(bodyHeight,\s*6\)/);
	assert.match(source, /현재 상황/);
	assert.match(source, /현재 슬라이스/);
	assert.match(source, /모델 \$\{child\.model\}/);
	assert.match(source, /type: "child_start"/);
	assert.match(source, /model: options\.model/);
	assert.match(source, /currentSliceTitle/);
	assert.match(source, /currentSliceRemaining/);
	assert.match(source, /진행률/);
	assert.match(source, /다음 행동/);
	assert.match(source, /단계 흐름/);
	assert.match(source, /판정: FAIL/);
	assert.match(source, /이유:/);
	assert.match(source, /조각/);
	assert.match(source, /승인 기준/);
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
	assert.match(block, /const reviewText = readArtifact\(options\.cwd,\s*config,\s*"local-review\.md"\)/);
	assert.match(block, /parseLocalVerdict\(reviewText\)/);
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
	assert.match(block, /실행 취소하려면 x를 한 번 더 누르세요/);
	assert.match(block, /matchesKey\(data,\s*Key\.escape\)[\s\S]*this\.close\(\);[\s\S]*if \(data === "x"/);
});

test("hybrid retry and resume-from clear stage checkpoints", () => {
	assert.match(source, /function clearHybridStageCheckpoint/);
	assert.match(source, /function clearHybridStageFrom/);
	assert.match(source, /function hybridStageReferenceMarkdown/);
	assert.match(source, /function hybridStageDescriptionKo/);
	assert.match(source, /pi\.registerCommand\("hybrid-retry"/);
	assert.match(source, /pi\.registerCommand\("hybrid-resume"/);
	assert.match(source, /pi\.registerCommand\("hybrid-resume-from"/);
	assert.match(source, /pi\.registerCommand\("hybrid-stages"/);
	assert.match(source, /handleHybridRun\("",\s*ctx,\s*\{\},\s*"default"\)/);
	assert.match(source, /clearHybridStageCheckpoint\(ctx\.cwd,\s*config,\s*state,\s*args\.trim\(\)/);
	assert.match(source, /clearHybridStageFrom\(ctx\.cwd,\s*config,\s*state,\s*stageArg\)/);
	assert.match(source, /\/hybrid-resume-from <stage>/);
	assert.match(source, /\/hybrid-resume/);
	assert.match(source, /재개 가능한 단계/);
	assert.match(source, /Run \/hybrid-stages to see descriptions/);
	assert.match(source, /Usage: \/hybrid-resume-from <stage>/);
	assert.match(source, /Unknown hybrid stage\. Run \/hybrid-stages\./);
});

test("serious task plan review is a first-class stage before local implementation", () => {
	assert.match(source, /type PlanReviewVerdict = "READY" \| "NEEDS_REVISION" \| "ESCALATE_TO_USER"/);
	assert.match(source, /function stringifyBriefItem/);
	assert.doesNotMatch(source, /blockingQuestions\.map\(String\)/);
	assert.match(source, /function showHybridClarificationGate/);
	assert.match(source, /답변\/진행 프롬프트 입력/);
	assert.match(source, /답변 없이 계속 진행/);

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

	const artifactListBlock = between("const HYBRID_RUN_ARTIFACTS", "function cleanRunArtifacts");
	assert.match(artifactListBlock, /"plan-review\.md"/);

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

	const artifactListBlock = between("const HYBRID_RUN_ARTIFACTS", "function cleanRunArtifacts");
	assert.match(artifactListBlock, /"requirements\.md"/);
	assert.match(artifactListBlock, /"design-grill\.md"/);

	const syncBlock = between("function syncHarnessArtifacts", "function reconcileHybridCompletion");
	assert.match(syncBlock, /"requirements\.md"/);
	assert.match(syncBlock, /"design-grill\.md"/);

	const commandBlock = between('pi.registerCommand("hybrid-interview"', 'pi.registerCommand("hybrid-steer"');
	assert.match(commandBlock, /pi\.registerCommand\("hybrid-interview"/);
	assert.match(commandBlock, /runFrontierInterview\(/);
	const interviewCommandBlock = between('pi.registerCommand("hybrid-interview"', 'pi.registerCommand("hybrid-grill"');
	assert.doesNotMatch(interviewCommandBlock, /showReport\("Hybrid Interview"/);
	assert.match(interviewCommandBlock, /showHybridInterview\(/);
	const interactiveInterviewBlock = between("const showHybridInterview =", 'pi.registerCommand("hybrid-interview"');
	assert.match(interactiveInterviewBlock, /ctx\.ui\.editor/);
	assert.match(interactiveInterviewBlock, /runFrontierInterview\(/);
	assert.match(interactiveInterviewBlock, /extractHybridInterviewAnswerDraft/);
	assert.match(interactiveInterviewBlock, /action\.kind === "answer"/);
	assert.match(interactiveInterviewBlock, /action\.kind === "run"/);
	assert.match(interactiveInterviewBlock, /action\.kind === "grill"/);
	assert.match(interactiveInterviewBlock, /action\.kind !== "edit"/);
	assert.match(interactiveInterviewBlock, /Current interview/);
	assert.match(source, /type HybridGateAction/);
	assert.match(source, /extractHybridGateChoices/);
	assert.match(source, /확정할까요/);
	assert.match(source, /추천/);
	assert.match(source, /markerIndex/);
	assert.match(source, /hybridGateApprovalSummaryKo/);
	assert.match(source, /이대로 충분합니다/);
	assert.match(source, /그래도 grill/);
	assert.match(source, /이 내용으로 run/);
	assert.match(source, /ensureHybridGateTaskForRun/);
	assert.match(source, /pi\.registerCommand\("hybrid-new"/);
	assert.match(source, /startNewHybridTask/);
	assert.match(source, /archiveHybridRunArtifacts/);
	assert.match(source, /hybrid-new <next task>/);
	assert.match(source, /e 직접 입력/);
	assert.match(source, /selectGateItem\(this\.gateItems\[alphaIndex\]/);
	assert.match(source, /matchesKey\(data, Key\.left\)/);
	assert.match(source, /moveGateSelection/);
	assert.match(source, /setSelectedIndex/);
	assert.match(source, /for \(let i = visible\.length; i < bodyHeight; i\+\+\)/);
	assert.match(source, /for \(let i = 0; i < pickerLinesHeight; i\+\+\)/);
	assert.doesNotMatch(source, /matchesKey\(data, Key\.up\) \|\|\n\t\t\tmatchesKey\(data, Key\.down\)/);
	const overlayBlock = between("class HybridReportOverlayComponent", "function stripHybridArtifactFooter");
	const overlayInputBlock = between("handleInput(data: string): void {", "\n\tprivate buildGateItems");
	assert.ok(
		overlayInputBlock.indexOf("matchesKey(data, Key.left)") <
			overlayInputBlock.indexOf("matchesKey(data, Key.up)"),
		"picker left/right handling should be separate from report up/down scrolling",
	);
	assert.match(overlayInputBlock, /matchesKey\(data, Key\.down\)[\s\S]+this\.scrollOffset = Math\.max\(0, this\.scrollOffset - 1\)/);
	assert.match(overlayInputBlock, /matchesKey\(data, Key\.pageDown\)[\s\S]+this\.scrollOffset = Math\.max\(0, this\.scrollOffset - 10\)/);
	assert.doesNotMatch(overlayBlock, /for \(const line of this\.selectList\.render\(bodyW\)\)/);
	assert.doesNotMatch(overlayBlock, /selectList\.render\(bodyW\)/);
	assert.match(overlayBlock, /private renderGateItem/);
	assert.doesNotMatch(overlayBlock, /selectList\.handleInput\(matchesKey\(data, Key\.left\) \? Key\.up : Key\.down\)/);
	assert.match(source, /class HybridGateLoadingOverlayComponent/);
	assert.match(source, /runWithHybridGateLoading/);
	assert.match(source, /다음 질문을 준비하고 있습니다/);
	assert.match(source, /완료되면 다음 모달이 열립니다/);
	assert.doesNotMatch(source, /s submit draft/);
	assert.match(commandBlock, /pi\.registerCommand\("hybrid-grill"/);
	assert.match(commandBlock, /runFrontierGrill\(/);
	assert.match(commandBlock, /showHybridGrill\(/);
	assert.doesNotMatch(commandBlock, /prepareHybridGateState\(/);

	const startBlock = between("async function runHybridStart", "async function runLocalLoop");
	assert.match(startBlock, /hybridRequirementsContext\(/);
	assert.match(source, /requirements\.md/);
	assert.match(source, /Requirements interview/);
	const workerPromptBlock = between("function localWorkerPrompt", "type Notify");
	assert.match(workerPromptBlock, /requirements\.md/);
	assert.match(workerPromptBlock, /root REQUIREMENTS\.md/);
	const progressPlanBlock = between("async function createProgressFromDesign", "async function updateProgressAfterIteration");
	assert.match(progressPlanBlock, /requirements\.md/);
	assert.match(source, /한국어 요약/);
	assert.match(source, /startHybridBackgroundRun\(/);
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

test("manual-only acceptance criteria are UNVERIFIED and cannot roll up to PASS/APPROVE", () => {
	assert.match(source, /is UNVERIFIED, not satisfied/);
	assert.match(source, /Do not let 'manual audit required'/);
	// Frontier implementation review (verdict PASS|PASS_WITH_CONCERNS|FAIL).
	const localReviewBlock = between("async function runLocalReview", "async function runFrontierFinal");
	assert.match(localReviewBlock, /is UNVERIFIED, not satisfied/);
	assert.match(
		localReviewBlock,
		/every required behavioral acceptance criterion has executed evidence/,
	);
	// Frontier final gate (verdict APPROVE|REQUEST_CHANGES|ESCALATE_TO_USER).
	const finalBlock = between("async function runFrontierFinal", "async function runHybridOrchestration");
	assert.match(finalBlock, /UNVERIFIED, not satisfied/);
	assert.match(finalBlock, /must not roll up to APPROVE/);
	// Local progress reviewer must also refuse to mark a manual-only criterion satisfied.
	assert.match(source, /must not roll up to a satisfied criterion/);
});

test("cross-component seam criteria require executable end-to-end evidence", () => {
	assert.match(source, /Cross-component seam criteria/);
	assert.match(source, /PATCH vs PUT/);
	const workerBlock = between("function localWorkerPrompt", "type Notify");
	assert.match(
		workerBlock,
		/executable end-to-end check that drives the consumer against the real producer/,
	);
	const localReviewBlock = between("async function runLocalReview", "async function runFrontierFinal");
	assert.match(localReviewBlock, /Cross-component seam criteria/);
	const finalBlock = between("async function runFrontierFinal", "async function runHybridOrchestration");
	assert.match(finalBlock, /Cross-component seam criteria/);
});

test("handoff lane reviewer rejects manual-only behavioral criteria and unverified seams", () => {
	const block = between("function handoffReviewPrompt", "type Notify");
	assert.match(block, /is UNVERIFIED, not satisfied/);
	assert.match(block, /manual-validation gap on a behavioral criterion is blocking/);
	assert.match(block, /Cross-component seam criteria/);
	assert.match(block, /PATCH vs PUT/);
});

test("handoff orchestration runs an executable integration seam gate", () => {
	assert.match(source, /function runHandoffIntegrationGate/);
	assert.match(source, /function parseIntegrationGateCommands/);
	assert.match(source, /integrationCommands: HandoffValidationCommand\[\]/);
	assert.match(source, /id: "handoff-integration"/);
	// A multi-lane handoff with no executable gate fails instead of passing on per-lane green.
	assert.match(source, /cross-lane seam is UNVERIFIED/);
	assert.match(source, /runHandoffIntegrationGate\(options\.cwd, config, state, manifest, notify\)/);
});

test("missing integration gate is non-fatal (warn) but configurable to strict", () => {
	// New config flag + default off.
	assert.match(source, /requireIntegrationGate: boolean;/);
	assert.match(source, /requireIntegrationGate: false,/);
	// Missing gate: strict throws; otherwise mark seam unverified and continue (no crash).
	const orch = between("// Executable seam gate:", "reporter.stage(\"summary\"");
	assert.match(orch, /if \(config\.requireIntegrationGate\)/);          // strict branch
	assert.match(orch, /seamUnverified = true;/);                          // non-strict: continue
	assert.match(orch, /"handoff-integration", "skipped"/);                // non-strict: not "failed"
	// A failing gate (exists but fails) still throws regardless of the flag.
	assert.match(orch, /integration gate failed; the consumer<->producer seam is broken/);
	// Verdict is downgraded (not a clean PASS) when the seam is unverified.
	assert.match(source, /seamUnverified \? "PASS_WITH_CONCERNS" : "PASS"/);
});
