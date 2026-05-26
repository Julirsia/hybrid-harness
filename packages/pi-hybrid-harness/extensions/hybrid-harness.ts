import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	SelectList,
	Spacer,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type MarkdownTheme,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";

type HarnessPhase =
	| "idle"
	| "scouted"
	| "designed"
	| "implemented"
	| "local-reviewed"
	| "frontier-reviewed";

interface HarnessConfig {
	stateDir: string;
	localBaseUrl: string;
	localProvider: string;
	localApiKey: string;
	localWorkerModel: string;
	localReviewerModel: string;
	frontierModel: string;
	frontierThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	frontierInputCostPerMTok: number;
	frontierOutputCostPerMTok: number;
	maxLocalLoops: number;
	maxReviewRepairCycles: number;
	maxFrontierPasses: number;
	enableSafetyGuards: boolean;
	allowDestructiveBash: boolean;
	protectedPaths: string[];
	maxDiffCharsBeforeFrontier: number;
	verboseChildOutput: boolean;
	liveLogMaxWidgetLines: number;
	briefBeforeImplementation: boolean;
	askUserOnAmbiguity: boolean;
	testCommand?: string;
	verificationCommands: string[];
	allowManifestReviewWhenNoGit: boolean;
	/**
	 * For interactive/runtime-heavy tasks (web apps, games, canvas, UI, browser automation),
	 * require objective deterministic validation before PASS/APPROVE.
	 * This prevents syntax/HTTP smoke checks or worker self-reports from being treated as
	 * sufficient evidence of actual runtime behavior.
	 */
	requireDeterministicTestsForInteractive: boolean;
}

interface HarnessState {
	version: 1;
	phase: HarnessPhase;
	task?: string;
	createdAt?: string;
	updatedAt: string;
	localWorkerModel: string;
	localReviewerModel: string;
	frontierModel: string;
	frontierThinking: string;
	lastRun?: string;
	artifacts: Record<string, string>;
}

type SliceStatus = "pending" | "in_progress" | "done" | "blocked";
type CriterionStatus = "pending" | "satisfied" | "failed" | "unknown";
type TestFailureKind =
	| "none"
	| "compile_error"
	| "type_error"
	| "lint_error"
	| "unit_failure"
	| "integration_failure"
	| "timeout"
	| "missing_dependency"
	| "missing_test"
	| "unknown";

interface HarnessProgress {
	version: 1;
	updatedAt: string;
	task: string;
	currentSliceId?: string;
	slices: Array<{
		id: string;
		title: string;
		status: SliceStatus;
		evidence: string[];
		remaining: string[];
	}>;
	acceptanceCriteria: Array<{
		id: string;
		description: string;
		status: CriterionStatus;
		evidence: string[];
	}>;
	frontierRecheckTriggers: Array<{
		id: string;
		description: string;
		active: boolean;
		evidence: string;
	}>;
	testObservations: Array<{
		iteration: string;
		command?: string;
		ok: boolean;
		failureKind: TestFailureKind;
		summary: string;
	}>;
	blockers: string[];
	nextAction: string;
}

interface VerificationSummary {
	version: 1;
	updatedAt: string;
	commands: Array<{
		command: string;
		ok: boolean;
		code: number | null;
		failureKind: TestFailureKind;
		summary: string;
	}>;
	allPassed: boolean;
}

interface PiRunResult {
	ok: boolean;
	exitCode: number;
	text: string;
	stderr: string;
	messages: unknown[];
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
		toolCalls: number;
		estimatedInput: number;
		estimatedOutput: number;
	};
}

type HybridStageStatus = "pending" | "running" | "done" | "failed" | "skipped";

type HybridRunStageId =
	| "checkpoint"
	| "design"
	| "brief"
	| "local-loop"
	| "finish"
	| "local-review"
	| "frontier-final"
	| "summary";

interface HybridRunStage {
	id: string;
	label: string;
	status: HybridStageStatus;
	startedAt?: string;
	endedAt?: string;
	summary?: string;
}

interface HybridRunState {
	version: 1;
	task: string;
	mode: HybridRunDetails["mode"];
	status: "running" | "done" | "failed";
	startedAt: string;
	updatedAt: string;
	currentStage?: HybridRunStageId;
	lastCompletedStage?: HybridRunStageId;
	frontierPass: number;
	repairCycle: number;
	completedStages: Record<string, string>;
	lastError?: string;
}

interface HybridSteeringEntry {
	version: 1;
	id: string;
	createdAt: string;
	source: "command" | "tool";
	message: string;
	consumedAt?: string;
	consumedStage?: string;
	clearedAt?: string;
}

interface HybridActiveRun {
	liveId: string;
	cwd: string;
	startedAt: string;
	controller: AbortController;
	promise?: Promise<HybridRunDetails>;
	heartbeat?: ReturnType<typeof setInterval>;
}

interface HybridRunLock {
	version: 1;
	liveId: string;
	pid: number;
	cwd: string;
	task: string;
	mode: HybridRunDetails["mode"];
	status: "running";
	startedAt: string;
	updatedAt: string;
	currentStage?: string;
	cancelRequestedAt?: string;
}

interface HybridChildStats {
	label: string;
	status: "running" | "done" | "failed";
	startedAt: string;
	updatedAt: string;
	endedAt?: string;
	currentTool?: string;
	currentToolStartedAt?: string;
	lastOutput?: string;
	toolCalls: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

interface HybridRunDetails {
	version: 1;
	status: "running" | "done" | "failed";
	mode: "fast" | "default" | "thorough";
	task: string;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	currentStage?: string;
	currentChild?: string;
	currentTool?: string;
	recentOutput: string[];
	liveOutput: string[];
	stages: HybridRunStage[];
	children: Record<string, HybridChildStats>;
	childOrder: string[];
	progress?: {
		slicesDone: number;
		slicesTotal: number;
		acceptanceSatisfied: number;
		acceptanceTotal: number;
		activeFrontierTriggers: number;
		nextAction?: string;
	};
	localVerdict?: ReturnType<typeof parseLocalVerdict>;
	frontierVerdict?: ReturnType<typeof parseFrontierVerdict>;
	frontierInputCostPerMTok?: number;
	frontierOutputCostPerMTok?: number;
	artifacts: Record<string, string>;
	usageSummary?: string;
	error?: string;
}

interface HybridRunParams {
	task?: string;
	mode?: "fast" | "default" | "thorough";
	maxFrontierPasses?: number;
	resume?: boolean;
	background?: boolean;
}

interface OrchestrationBrief {
	planSummary: string;
	executionStrategy: string[];
	assumptions: string[];
	ambiguities: string[];
	blockingQuestions: string[];
	taskRisk: "low" | "medium" | "high";
	recommendedAction: "proceed" | "ask_user" | "stop";
}

const HYBRID_RUN_MESSAGE_TYPE = "hybrid-run-result";
const HYBRID_REPORT_MESSAGE_TYPE = "hybrid-report";
const HYBRID_LIVE_STORE_KEY = "__piHybridHarnessLiveRuns";
const HYBRID_LAST_LIVE_ID_KEY = "__piHybridHarnessLastLiveId";
const HYBRID_ACTIVE_RUN_KEY = "__piHybridHarnessActiveRun";
const HYBRID_LIVE_OUTPUT_LIMIT = 500;
const LOCAL_OPENAI_COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
} as const;

const DEFAULT_CONFIG: HarnessConfig = {
	stateDir: ".pi-harness",
	localBaseUrl: "http://192.168.0.44:8080/v1",
	localProvider: "local-qwen",
	localApiKey: "local",
	localWorkerModel: "local-qwen/qwen36-27b-mtp-iq4xs",
	localReviewerModel: "local-qwen/qwen36-35b-a3b-iq4xs",
	frontierModel: "openai-codex/gpt-5.5",
	frontierThinking: "high",
	frontierInputCostPerMTok: 0,
	frontierOutputCostPerMTok: 0,
	maxLocalLoops: 4,
	maxReviewRepairCycles: 2,
	maxFrontierPasses: 2,
	enableSafetyGuards: true,
	allowDestructiveBash: false,
	protectedPaths: [
		".env",
		".env.*",
		"**/.env",
		"**/.env.*",
		".git/**",
		".ssh/**",
		"**/id_rsa",
		"**/id_ed25519",
		"**/*secret*",
		"**/*credential*",
		"**/*token*",
	],
	maxDiffCharsBeforeFrontier: 120_000,
	verboseChildOutput: true,
	liveLogMaxWidgetLines: 30,
	briefBeforeImplementation: true,
	askUserOnAmbiguity: true,
	verificationCommands: [],
	allowManifestReviewWhenNoGit: true,
	requireDeterministicTestsForInteractive: true,
};

function nowIso(): string {
	return new Date().toISOString();
}

function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJsonFile(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function updateConfigFile(
	cwd: string,
	config: HarnessConfig,
	updates: Partial<HarnessConfig>,
): string {
	ensureStateDir(cwd, config);
	const configFile = artifactPath(cwd, config, "config.json");
	const existing = readJsonFile<Partial<HarnessConfig>>(configFile) ?? {};
	writeJsonFile(configFile, { ...existing, ...updates });
	return configFile;
}

function loadConfig(
	cwd: string,
	overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
	const stateConfig = readJsonFile<Partial<HarnessConfig>>(
		path.join(cwd, DEFAULT_CONFIG.stateDir, "config.json"),
	);
	const piConfig = readJsonFile<Partial<HarnessConfig>>(
		path.join(cwd, ".pi", "hybrid-harness.json"),
	);
	const merged = {
		...DEFAULT_CONFIG,
		...piConfig,
		...stateConfig,
		...overrides,
	};
	if (!merged.localWorkerModel.includes("/")) {
		merged.localWorkerModel = `${merged.localProvider}/${merged.localWorkerModel}`;
	}
	if (!merged.localReviewerModel.includes("/")) {
		merged.localReviewerModel = `${merged.localProvider}/${merged.localReviewerModel}`;
	}
	return merged;
}

function statePath(cwd: string, config: HarnessConfig): string {
	return path.join(cwd, config.stateDir, "state.json");
}

function artifactPath(
	cwd: string,
	config: HarnessConfig,
	name: string,
): string {
	return path.join(cwd, config.stateDir, name);
}

function ensureStateDir(cwd: string, config: HarnessConfig): void {
	fs.mkdirSync(path.join(cwd, config.stateDir), { recursive: true });
}

function loadState(cwd: string, config: HarnessConfig): HarnessState {
	const existing = readJsonFile<HarnessState>(statePath(cwd, config));
	if (existing?.version === 1) return existing;
	return {
		version: 1,
		phase: "idle",
		updatedAt: nowIso(),
		localWorkerModel: config.localWorkerModel,
		localReviewerModel: config.localReviewerModel,
		frontierModel: config.frontierModel,
		frontierThinking: config.frontierThinking,
		artifacts: {},
	};
}

function saveState(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
): void {
	state.updatedAt = nowIso();
	writeJsonFile(statePath(cwd, config), state);
}

function writeArtifact(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	name: string,
	content: string,
): string {
	ensureStateDir(cwd, config);
	const filePath = artifactPath(cwd, config, name);
	fs.writeFileSync(
		filePath,
		content.endsWith("\n") ? content : `${content}\n`,
		"utf8",
	);
	state.artifacts[name] = path.relative(cwd, filePath);
	return filePath;
}

function readArtifact(
	cwd: string,
	config: HarnessConfig,
	name: string,
): string {
	try {
		return fs.readFileSync(artifactPath(cwd, config, name), "utf8");
	} catch {
		return "";
	}
}

function activeRunLockPath(cwd: string, config: HarnessConfig): string {
	return artifactPath(cwd, config, "active-run.json");
}

function readHybridRunLock(
	cwd: string,
	config: HarnessConfig,
): HybridRunLock | undefined {
	const lock = readJsonFile<Partial<HybridRunLock>>(
		activeRunLockPath(cwd, config),
	);
	if (lock?.version !== 1 || typeof lock.liveId !== "string") return undefined;
	return {
		version: 1,
		liveId: lock.liveId,
		pid: Number(lock.pid) || 0,
		cwd: typeof lock.cwd === "string" ? lock.cwd : cwd,
		task: typeof lock.task === "string" ? lock.task : "(unknown)",
		mode:
			lock.mode === "fast" || lock.mode === "thorough"
				? lock.mode
				: "default",
		status: "running",
		startedAt: typeof lock.startedAt === "string" ? lock.startedAt : nowIso(),
		updatedAt: typeof lock.updatedAt === "string" ? lock.updatedAt : nowIso(),
		currentStage:
			typeof lock.currentStage === "string" ? lock.currentStage : undefined,
		cancelRequestedAt:
			typeof lock.cancelRequestedAt === "string"
				? lock.cancelRequestedAt
				: undefined,
	};
}

function writeHybridRunLock(
	cwd: string,
	config: HarnessConfig,
	lock: HybridRunLock,
): void {
	writeJsonFile(activeRunLockPath(cwd, config), {
		...lock,
		updatedAt: lock.updatedAt || nowIso(),
	});
}

function isHybridRunLockStale(
	lock: HybridRunLock,
	staleMs = 120_000,
): boolean {
	const updatedAt = Date.parse(lock.updatedAt);
	return !Number.isFinite(updatedAt) || Date.now() - updatedAt > staleMs;
}

function heartbeatHybridRunLock(
	cwd: string,
	config: HarnessConfig,
	liveId: string,
	currentStage?: string,
): HybridRunLock | undefined {
	const lock = readHybridRunLock(cwd, config);
	if (!lock || lock.liveId !== liveId) return lock;
	lock.updatedAt = nowIso();
	if (currentStage) lock.currentStage = currentStage;
	writeHybridRunLock(cwd, config, lock);
	return lock;
}

function requestHybridRunCancel(
	cwd: string,
	config: HarnessConfig,
): boolean {
	const lock = readHybridRunLock(cwd, config);
	if (!lock) return false;
	lock.cancelRequestedAt = nowIso();
	lock.updatedAt = nowIso();
	writeHybridRunLock(cwd, config, lock);
	return true;
}

function clearHybridRunLock(
	cwd: string,
	config: HarnessConfig,
	liveId?: string,
): void {
	const lock = readHybridRunLock(cwd, config);
	if (liveId && lock && lock.liveId !== liveId) return;
	try {
		fs.rmSync(activeRunLockPath(cwd, config), { force: true });
	} catch {
		// ignore
	}
}

function steeringPath(cwd: string, config: HarnessConfig): string {
	return artifactPath(cwd, config, "steering.jsonl");
}

function appendHybridSteering(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	message: string,
	source: HybridSteeringEntry["source"] = "command",
): HybridSteeringEntry {
	const trimmed = message.trim();
	if (!trimmed) throw new Error("Usage: /hybrid-steer <message>");
	ensureStateDir(cwd, config);
	const entry: HybridSteeringEntry = {
		version: 1,
		id: `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		createdAt: nowIso(),
		source,
		message: trimmed,
	};
	fs.appendFileSync(steeringPath(cwd, config), `${JSON.stringify(entry)}\n`, "utf8");
	state.artifacts["steering.jsonl"] = path.relative(
		cwd,
		steeringPath(cwd, config),
	);
	saveState(cwd, config, state);
	return entry;
}

function writeHybridSteering(
	cwd: string,
	config: HarnessConfig,
	entries: HybridSteeringEntry[],
): void {
	ensureStateDir(cwd, config);
	const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
	fs.writeFileSync(
		steeringPath(cwd, config),
		content ? `${content}\n` : "",
		"utf8",
	);
}

function readHybridSteering(
	cwd: string,
	config: HarnessConfig,
): HybridSteeringEntry[] {
	const text = readArtifact(cwd, config, "steering.jsonl");
	const entries: HybridSteeringEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as Partial<HybridSteeringEntry>;
			if (entry.version === 1 && typeof entry.message === "string") {
				entries.push({
					version: 1,
					id: typeof entry.id === "string" ? entry.id : `steer-${entries.length + 1}`,
					createdAt:
						typeof entry.createdAt === "string" ? entry.createdAt : nowIso(),
					source: entry.source === "tool" ? "tool" : "command",
					message: entry.message,
					consumedAt:
						typeof entry.consumedAt === "string"
							? entry.consumedAt
							: undefined,
					consumedStage:
						typeof entry.consumedStage === "string"
							? entry.consumedStage
							: undefined,
					clearedAt:
						typeof entry.clearedAt === "string" ? entry.clearedAt : undefined,
				});
			}
		} catch {
			// Ignore malformed steering lines rather than breaking a run.
		}
	}
	return entries;
}

function markHybridSteeringConsumed(
	cwd: string,
	config: HarnessConfig,
	stage: string,
): void {
	const entries = readHybridSteering(cwd, config);
	if (entries.length === 0) return;
	let changed = false;
	const consumedAt = nowIso();
	const next = entries.map((entry) => {
		if (entry.consumedAt || entry.clearedAt) return entry;
		changed = true;
		return { ...entry, consumedAt, consumedStage: stage };
	});
	if (changed) writeHybridSteering(cwd, config, next);
}

function clearHybridSteering(cwd: string, config: HarnessConfig): number {
	const entries = readHybridSteering(cwd, config);
	try {
		fs.rmSync(steeringPath(cwd, config), { force: true });
	} catch {
		// ignore
	}
	return entries.filter((entry) => !entry.clearedAt).length;
}

function hybridSteeringMarkdown(cwd: string, config: HarnessConfig): string {
	const entries = readHybridSteering(cwd, config).filter((entry) => !entry.consumedAt);
	if (entries.length === 0) return "";
	const lines = [
		"## Parent Steering",
		"",
		"The parent/orchestrator may add these notes while the hybrid run is active. Treat newer entries as higher priority, but do not violate the original task or safety rules.",
		"",
	];
	for (const entry of entries.slice(-20)) {
		lines.push(
			`- ${entry.createdAt} (${entry.source}, ${entry.id}): ${entry.message.replace(/\s+/g, " ")}`,
		);
	}
	return truncateMiddle(lines.join("\n"), 12_000);
}

function hybridRunStageKey(
	stage: HybridRunStageId,
	frontierPass?: number,
	repairCycle?: number,
): string {
	if (stage === "local-loop" || stage === "finish" || stage === "local-review") {
		return `${stage}:F${frontierPass ?? 1}R${repairCycle ?? 1}`;
	}
	if (stage === "frontier-final") return `${stage}:F${frontierPass ?? 1}`;
	return stage;
}

function loadHybridRunState(
	cwd: string,
	config: HarnessConfig,
	task: string,
	mode: HybridRunDetails["mode"],
): HybridRunState {
	const existing = readJsonFile<Partial<HybridRunState>>(
		artifactPath(cwd, config, "run-state.json"),
	);
	const timestamp = nowIso();
	if (existing?.version === 1 && existing.task === task) {
		const completedStages =
			existing.completedStages && typeof existing.completedStages === "object"
				? Object.fromEntries(
						Object.entries(existing.completedStages).filter(
							([key, value]) =>
								typeof key === "string" && typeof value === "string",
						),
					)
				: {};
		return {
			version: 1,
			task,
			mode,
			status: existing.status === "done" ? "done" : "running",
			startedAt: existing.startedAt || timestamp,
			updatedAt: existing.updatedAt || timestamp,
			currentStage: existing.currentStage,
			lastCompletedStage: existing.lastCompletedStage,
			frontierPass: Number.isFinite(existing.frontierPass)
				? Number(existing.frontierPass)
				: 1,
			repairCycle: Number.isFinite(existing.repairCycle)
				? Number(existing.repairCycle)
				: 1,
			completedStages,
			lastError:
				typeof existing.lastError === "string" ? existing.lastError : undefined,
		};
	}
	return {
		version: 1,
		task,
		mode,
		status: "running",
		startedAt: timestamp,
		updatedAt: timestamp,
		frontierPass: 1,
		repairCycle: 1,
		completedStages: {},
	};
}

function saveHybridRunState(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	runState: HybridRunState,
): void {
	runState.updatedAt = nowIso();
	writeArtifact(
		cwd,
		config,
		state,
		"run-state.json",
		JSON.stringify(runState, null, "\t"),
	);
	saveState(cwd, config, state);
}

function markHybridRunStage(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	runState: HybridRunState,
	stage: HybridRunStageId,
	status: HybridStageStatus,
	frontierPass = runState.frontierPass,
	repairCycle = runState.repairCycle,
	error?: string,
): void {
	runState.currentStage = stage;
	runState.frontierPass = frontierPass;
	runState.repairCycle = repairCycle;
	runState.status = status === "failed" ? "failed" : "running";
	if (status === "done" || status === "skipped") {
		runState.completedStages[hybridRunStageKey(stage, frontierPass, repairCycle)] =
			nowIso();
		runState.lastCompletedStage = stage;
		runState.lastError = undefined;
	}
	if (status === "failed") runState.lastError = error;
	if (stage === "summary" && status === "done") runState.status = "done";
	saveHybridRunState(cwd, config, state, runState);
}

function markHybridRunFailure(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	runState: HybridRunState,
	error: unknown,
): void {
	runState.status = "failed";
	runState.lastError = String(error instanceof Error ? error.message : error);
	saveHybridRunState(cwd, config, state, runState);
}

function artifactReady(
	cwd: string,
	config: HarnessConfig,
	name: string,
): boolean {
	try {
		return fs.statSync(artifactPath(cwd, config, name)).size > 0;
	} catch {
		return false;
	}
}

function hybridStageArtifactsReady(
	cwd: string,
	config: HarnessConfig,
	stage: HybridRunStageId,
): boolean {
	if (stage === "checkpoint") return true;
	if (stage === "design")
		return (
			artifactReady(cwd, config, "frontier-design.md") &&
			artifactReady(cwd, config, "progress.json")
		);
	if (stage === "brief")
		return artifactReady(cwd, config, "orchestration-brief.md");
	if (stage === "local-loop")
		return (
			artifactReady(cwd, config, "local-log.md") &&
			artifactReady(cwd, config, "progress.json")
		);
	if (stage === "finish")
		return (
			artifactReady(cwd, config, "verification-summary.json") &&
			artifactReady(cwd, config, "progress.json")
		);
	if (stage === "local-review")
		return artifactReady(cwd, config, "local-review.md");
	if (stage === "frontier-final")
		return artifactReady(cwd, config, "final-review.md");
	return (
		artifactReady(cwd, config, "run-summary.md") &&
		artifactReady(cwd, config, "usage-summary.md")
	);
}

function shouldSkipHybridStage(
	cwd: string,
	config: HarnessConfig,
	runState: HybridRunState,
	stage: HybridRunStageId,
	frontierPass?: number,
	repairCycle?: number,
): boolean {
	const key = hybridRunStageKey(stage, frontierPass, repairCycle);
	if (runState.completedStages[key]) {
		return hybridStageArtifactsReady(cwd, config, stage);
	}
	return stage === "design" && hybridStageArtifactsReady(cwd, config, stage);
}

const HYBRID_STAGE_ORDER: HybridRunStageId[] = [
	"checkpoint",
	"design",
	"brief",
	"local-loop",
	"finish",
	"local-review",
	"frontier-final",
	"summary",
];

function normalizeHybridRunStageId(value: string): HybridRunStageId {
	const normalized = value.trim() as HybridRunStageId;
	if (!HYBRID_STAGE_ORDER.includes(normalized)) {
		throw new Error(
			`Unknown hybrid stage "${value}". Expected one of: ${HYBRID_STAGE_ORDER.join(", ")}`,
		);
	}
	return normalized;
}

function hybridStageArtifactNames(stage: HybridRunStageId): string[] {
	if (stage === "design")
		return ["repo-map.md", "frontier-design.md", "implementation-plan.json"];
	if (stage === "brief") return ["orchestration-brief.md"];
	if (stage === "local-loop")
		return ["local-log.md", "test-evidence.md", "git-summary.md"];
	if (stage === "finish")
		return ["verification-summary.json", "verification-summary.md"];
	if (stage === "local-review") return ["local-review.md"];
	if (stage === "frontier-final") return ["final-review.md"];
	if (stage === "summary") return ["run-summary.md", "usage-summary.md"];
	return [];
}

function clearHybridStageCheckpoint(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	stageName: string,
): string[] {
	const stage = normalizeHybridRunStageId(stageName);
	const runState = state.task
		? loadHybridRunState(cwd, config, state.task, "default")
		: undefined;
	if (runState) {
		for (const key of Object.keys(runState.completedStages)) {
			if (key === stage || key.startsWith(`${stage}:`)) {
				delete runState.completedStages[key];
			}
		}
		saveHybridRunState(cwd, config, state, runState);
	}
	const removed: string[] = [];
	for (const name of hybridStageArtifactNames(stage)) {
		try {
			fs.rmSync(artifactPath(cwd, config, name), { force: true });
			delete state.artifacts[name];
			removed.push(name);
		} catch {
			// ignore
		}
	}
	saveState(cwd, config, state);
	return removed;
}

function clearHybridStageFrom(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	stageName: string,
): string[] {
	const stage = normalizeHybridRunStageId(stageName);
	const start = HYBRID_STAGE_ORDER.indexOf(stage);
	const removed: string[] = [];
	for (const candidate of HYBRID_STAGE_ORDER.slice(start)) {
		removed.push(...clearHybridStageCheckpoint(cwd, config, state, candidate));
	}
	return [...new Set(removed)];
}

function normalizeRelativePath(cwd: string, candidate: string): string {
	const absolute = path.isAbsolute(candidate)
		? candidate
		: path.resolve(cwd, candidate);
	return path.relative(cwd, absolute).replace(/\\/g, "/");
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "::DOUBLE_STAR::")
		.replace(/\*/g, "[^/]*")
		.replace(/::DOUBLE_STAR::/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

function isProtectedPath(
	cwd: string,
	config: HarnessConfig,
	candidate: string,
): string | undefined {
	const rel = normalizeRelativePath(cwd, candidate);
	return config.protectedPaths.find(
		(pattern) =>
			globToRegExp(pattern).test(rel) ||
			globToRegExp(pattern).test(path.basename(rel)),
	);
}

function isDestructiveCommand(command: string): string | undefined {
	const checks: Array<[RegExp, string]> = [
		[
			/\brm\s+(-[^\n]*[rf]|[^\n]*\s-r|[^\n]*\s-f)/i,
			"rm with recursive/force flags",
		],
		[/\bsudo\b/i, "sudo"],
		[/\bchmod\s+(-R\s+)?777\b/i, "chmod 777"],
		[/\bchown\s+-R\b/i, "recursive chown"],
		[
			/\bgit\s+(reset\s+--hard|clean\s+-[fdx]+)/i,
			"destructive git reset/clean",
		],
		[/\b(killall|pkill)\b/i, "process kill"],
		[/>\s*\.(env|npmrc|pypirc)\b/i, "redirect into sensitive config"],
	];
	return checks.find(([regex]) => regex.test(command))?.[1];
}

function cleanRunArtifacts(cwd: string, config: HarnessConfig): void {
	for (const name of [
		"state.json",
		"task.md",
		"repo-map.md",
		"frontier-design.md",
		"implementation-plan.json",
		"progress.json",
		"progress.md",
		"test-evidence.md",
		"verification-summary.json",
		"verification-summary.md",
		"local-log.md",
		"git-summary.md",
		"local-review.md",
		"final-review.md",
		"run-summary.md",
		"run-state.json",
		"active-run.json",
		"usage-summary.md",
		"orchestration-brief.md",
		"user-clarifications.md",
		"steering.jsonl",
		"live-log.md",
		"events.jsonl",
	]) {
		try {
			fs.rmSync(artifactPath(cwd, config, name), { force: true });
		} catch {
			// ignore
		}
	}
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const half = Math.floor((maxChars - 120) / 2);
	return `${text.slice(0, half)}\n\n[... ${text.length - maxChars} chars omitted ...]\n\n${text.slice(-half)}`;
}

function extractJsonObject<T>(text: string): T | undefined {
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

function classifyTestFailure(
	output: string,
	ok: boolean,
	code: number | null,
): TestFailureKind {
	if (ok) return "none";
	const text = output.toLowerCase();
	if (code === null || text.includes("timed out") || text.includes("timeout"))
		return "timeout";
	if (
		text.includes("no configured deterministic test") ||
		text.includes("no deterministic test") ||
		text.includes("missing test command")
	)
		return "missing_test";
	if (
		text.includes("cannot find module") ||
		text.includes("module not found") ||
		text.includes("no such file or directory") ||
		text.includes("command not found")
	)
		return "missing_dependency";
	if (
		text.includes("typescript") ||
		text.includes("tsc") ||
		text.includes("type error") ||
		text.includes("is not assignable to") ||
		(text.includes("property") && text.includes("does not exist"))
	)
		return "type_error";
	if (
		text.includes("syntaxerror") ||
		text.includes("compile") ||
		text.includes("compilation") ||
		text.includes("build failed")
	)
		return "compile_error";
	if (
		text.includes("eslint") ||
		text.includes("lint") ||
		text.includes("prettier") ||
		text.includes("format")
	)
		return "lint_error";
	if (
		text.includes("integration") ||
		text.includes("e2e") ||
		text.includes("playwright") ||
		text.includes("cypress")
	)
		return "integration_failure";
	if (
		text.includes("test") ||
		text.includes("expect") ||
		text.includes("assert") ||
		text.includes("failed")
	)
		return "unit_failure";
	return "unknown";
}

function progressToMarkdown(progress: HarnessProgress): string {
	const sliceLines = progress.slices.map((slice) =>
		[
			`### ${slice.id}: ${slice.title}`,
			`- status: ${slice.status}`,
			`- evidence: ${slice.evidence.length ? slice.evidence.join("; ") : "none"}`,
			`- remaining: ${slice.remaining.length ? slice.remaining.join("; ") : "none"}`,
		].join("\n"),
	);
	const criteriaLines = progress.acceptanceCriteria.map(
		(criterion) =>
			`- [${criterion.status === "satisfied" ? "x" : " "}] ${criterion.id}: ${criterion.description} (${criterion.status})${criterion.evidence.length ? ` — ${criterion.evidence.join("; ")}` : ""}`,
	);
	const triggerLines = progress.frontierRecheckTriggers.map(
		(trigger) =>
			`- ${trigger.active ? "ACTIVE" : "inactive"} ${trigger.id}: ${trigger.description}${trigger.evidence ? ` — ${trigger.evidence}` : ""}`,
	);
	const testLines = progress.testObservations.map(
		(test) =>
			`- ${test.iteration}: ${test.ok ? "PASS" : "FAIL"} ${test.failureKind}${test.command ? ` \`${test.command}\`` : ""} — ${test.summary}`,
	);
	return [
		"# Hybrid Progress",
		"",
		`- Task: ${progress.task}`,
		`- Current slice: ${progress.currentSliceId ?? "none"}`,
		`- Next action: ${progress.nextAction}`,
		`- Updated: ${progress.updatedAt}`,
		"",
		"## Slices",
		...(sliceLines.length ? sliceLines : ["(none)"]),
		"",
		"## Acceptance Criteria",
		...(criteriaLines.length ? criteriaLines : ["(none)"]),
		"",
		"## Frontier Re-check Triggers",
		...(triggerLines.length ? triggerLines : ["(none)"]),
		"",
		"## Test Observations",
		...(testLines.length ? testLines : ["(none)"]),
		"",
		"## Blockers",
		...(progress.blockers.length
			? progress.blockers.map((b) => `- ${b}`)
			: ["(none)"]),
	].join("\n");
}

function fallbackProgress(task: string): HarnessProgress {
	return {
		version: 1,
		updatedAt: nowIso(),
		task,
		currentSliceId: "S1",
		slices: [
			{
				id: "S1",
				title: "Implement requested change",
				status: "pending",
				evidence: [],
				remaining: ["No structured implementation plan was extracted."],
			},
		],
		acceptanceCriteria: [
			{
				id: "AC1",
				description: "Requested task is implemented without regressions",
				status: "pending",
				evidence: [],
			},
		],
		frontierRecheckTriggers: [
			{
				id: "FR1",
				description:
					"Implementation requires architectural changes not covered by frontier-design.md",
				active: false,
				evidence: "",
			},
		],
		testObservations: [],
		blockers: [],
		nextAction: "Implement S1 according to frontier-design.md.",
	};
}

function normalizeSliceStatus(value: unknown): SliceStatus {
	switch (String(value ?? "").toLowerCase().replace(/[-\s]+/g, "_")) {
		case "done":
		case "complete":
		case "completed":
		case "pass":
		case "passed":
		case "satisfied":
			return "done";
		case "in_progress":
		case "running":
		case "active":
			return "in_progress";
		case "blocked":
		case "failed":
			return "blocked";
		default:
			return "pending";
	}
}

function normalizeCriterionStatus(value: unknown): CriterionStatus {
	switch (String(value ?? "").toLowerCase().replace(/[-\s]+/g, "_")) {
		case "satisfied":
		case "done":
		case "complete":
		case "completed":
		case "pass":
		case "passed":
			return "satisfied";
		case "failed":
		case "fail":
			return "failed";
		case "unknown":
			return "unknown";
		default:
			return "pending";
	}
}

function normalizeProgress(
	raw: Partial<HarnessProgress> | undefined,
	task: string,
): HarnessProgress {
	const fallback = fallbackProgress(task);
	if (!raw) return fallback;
	return {
		version: 1,
		updatedAt: nowIso(),
		task: typeof raw.task === "string" && raw.task ? raw.task : task,
		currentSliceId:
			typeof raw.currentSliceId === "string"
				? raw.currentSliceId
				: fallback.currentSliceId,
		slices:
			Array.isArray(raw.slices) && raw.slices.length
					? raw.slices.map((s: any, i) => ({
						id: String(s.id || `S${i + 1}`),
						title: String(s.title || `Slice ${i + 1}`),
						status: normalizeSliceStatus(s.status),
						evidence: Array.isArray(s.evidence) ? s.evidence.map(String) : [],
						remaining: Array.isArray(s.remaining)
							? s.remaining.map(String)
							: [],
					}))
				: fallback.slices,
		acceptanceCriteria:
			Array.isArray(raw.acceptanceCriteria) && raw.acceptanceCriteria.length
				? raw.acceptanceCriteria.map((c: any, i) => ({
						id: String(c.id || `AC${i + 1}`),
						description: String(
							c.description || `Acceptance criterion ${i + 1}`,
						),
						status: normalizeCriterionStatus(c.status),
						evidence: Array.isArray(c.evidence) ? c.evidence.map(String) : [],
					}))
				: fallback.acceptanceCriteria,
		frontierRecheckTriggers:
			Array.isArray(raw.frontierRecheckTriggers) &&
			raw.frontierRecheckTriggers.length
				? raw.frontierRecheckTriggers.map((t: any, i) => ({
						id: String(t.id || `FR${i + 1}`),
						description: String(
							t.description || `Frontier re-check trigger ${i + 1}`,
						),
						active: Boolean(t.active),
						evidence: String(t.evidence || ""),
					}))
				: fallback.frontierRecheckTriggers,
		testObservations: Array.isArray(raw.testObservations)
			? raw.testObservations.map((t: any) => ({
					iteration: String(t.iteration || "unknown"),
					command: typeof t.command === "string" ? t.command : undefined,
					ok: Boolean(t.ok),
					failureKind: [
						"none",
						"compile_error",
						"type_error",
						"lint_error",
						"unit_failure",
						"integration_failure",
						"timeout",
						"missing_dependency",
						"missing_test",
						"unknown",
					].includes(t.failureKind)
						? t.failureKind
						: "unknown",
					summary: String(t.summary || ""),
				}))
			: [],
		blockers: Array.isArray(raw.blockers) ? raw.blockers.map(String) : [],
		nextAction:
			typeof raw.nextAction === "string" && raw.nextAction
				? raw.nextAction
				: fallback.nextAction,
	};
}

function readProgress(
	cwd: string,
	config: HarnessConfig,
	task: string,
): HarnessProgress {
	return normalizeProgress(
		readJsonFile<Partial<HarnessProgress>>(
			artifactPath(cwd, config, "progress.json"),
		),
		task,
	);
}

function writeProgress(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	progress: HarnessProgress,
): void {
	progress.updatedAt = nowIso();
	writeArtifact(
		cwd,
		config,
		state,
		"progress.json",
		JSON.stringify(progress, null, "\t"),
	);
	writeArtifact(
		cwd,
		config,
		state,
		"progress.md",
		progressToMarkdown(progress),
	);
}

function runCommand(
	cwd: string,
	command: string,
	timeoutMs = 120_000,
): { ok: boolean; output: string; code: number | null } {
	const result = spawnSync(command, {
		cwd,
		shell: true,
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 5 * 1024 * 1024,
	});
	return {
		ok: result.status === 0,
		code: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function inferVerificationCommands(cwd: string): string[] {
	const pkg = readJsonFile<{ scripts?: Record<string, string> }>(
		path.join(cwd, "package.json"),
	);
	const scripts = pkg?.scripts ?? {};
	const commands: string[] = [];
	if (scripts.test && !/no test specified/i.test(scripts.test)) {
		commands.push("npm test");
	}
	if (scripts["test:e2e"]) {
		commands.push("npm run test:e2e");
	} else if (
		fs.existsSync(path.join(cwd, "playwright.config.ts")) ||
		fs.existsSync(path.join(cwd, "playwright.config.js")) ||
		fs.existsSync(path.join(cwd, "playwright.config.mjs"))
	) {
		commands.push("npx playwright test");
	}
	if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
		commands.push("npx tsc --noEmit");
	}
	if (scripts.build) {
		commands.push("npm run build");
	}
	return uniqueStrings(commands);
}

function verificationCommands(cwd: string, config: HarnessConfig): string[] {
	if (config.verificationCommands.length > 0)
		return uniqueStrings(config.verificationCommands);
	if (config.testCommand) return uniqueStrings([config.testCommand]);
	return inferVerificationCommands(cwd);
}

function verificationSummaryMarkdown(summary: VerificationSummary): string {
	const lines = [
		"# Verification Summary",
		"",
		`- Updated: ${summary.updatedAt}`,
		`- Overall: ${summary.allPassed ? "PASS" : "FAIL"}`,
		"",
	];
	for (const result of summary.commands) {
		lines.push(
			`## ${result.command}`,
			"",
			`- ok: ${result.ok}`,
			`- code: ${result.code ?? "null"}`,
			`- failureKind: ${result.failureKind}`,
			`- summary: ${result.summary}`,
			"",
		);
	}
	return lines.join("\n");
}

function runVerificationSummary(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	notify?: Notify,
): VerificationSummary {
	const commands = verificationCommands(cwd, config);
	const results: VerificationSummary["commands"] = [];
	const evidenceLines = [
		readArtifact(cwd, config, "test-evidence.md") ||
			`# Test Evidence\n\nTask: ${state.task ?? "(task missing)"}\n`,
		"",
		"## Deterministic Verification",
		"",
		`Generated: ${nowIso()}`,
		"",
	];
	for (const command of commands) {
		notify?.(`Hybrid finish: running ${command}...`, "info");
		const test = runCommand(cwd, command, 10 * 60_000);
		const failureKind: TestFailureKind = test.ok
			? "none"
			: classifyTestFailure(test.output, test.ok, test.code);
		const compactOutput = test.output.replace(/\s+/g, " ").trim();
		const summary = test.ok
			? "Command passed."
			: truncateMiddle(compactOutput || "Command failed without output.", 500);
		results.push({
			command,
			ok: test.ok,
			code: test.code,
			failureKind,
			summary,
		});
		evidenceLines.push(
			`### ${command}`,
			"",
			`- ok: ${test.ok}`,
			`- code: ${test.code ?? "null"}`,
			`- failureKind: ${failureKind}`,
			"",
			"```",
			truncateMiddle(test.output.trim(), 20_000),
			"```",
			"",
		);
	}
	const summary: VerificationSummary = {
		version: 1,
		updatedAt: nowIso(),
		commands: results,
		allPassed: results.length > 0 && results.every((result) => result.ok),
	};
	writeArtifact(
		cwd,
		config,
		state,
		"verification-summary.json",
		JSON.stringify(summary, null, "\t"),
	);
	writeArtifact(
		cwd,
		config,
		state,
		"verification-summary.md",
		verificationSummaryMarkdown(summary),
	);
	if (results.length > 0) {
		writeArtifact(cwd, config, state, "test-evidence.md", evidenceLines.join("\n"));
	}
	return summary;
}

function isInteractiveRuntimeText(text: string): boolean {
	return /\b(web|browser|ui|ux|canvas|game|gameplay|animation|touch|mouse|click|form|flipper|pinball|electron|playwright|cypress|agent-browser)\b/i.test(
		text,
	);
}

function interactiveRuntimePolicyApplies(
	cwd: string,
	config: HarnessConfig,
	task: string,
): boolean {
	if (!config.requireDeterministicTestsForInteractive) return false;
	const artifactText = [
		readArtifact(cwd, config, "frontier-design.md"),
		readArtifact(cwd, config, "implementation-plan.json"),
		readArtifact(cwd, config, "progress.json"),
	].join("\n");
	return isInteractiveRuntimeText(`${task}\n${artifactText}`);
}

function hasPassingConfiguredTest(progress: HarnessProgress): boolean {
	return progress.testObservations.some(
		(test) => Boolean(test.command) && test.ok,
	);
}

function deterministicVerificationPassed(
	cwd: string,
	config: HarnessConfig,
	progress: HarnessProgress,
): boolean {
	const summary = readJsonFile<VerificationSummary>(
		artifactPath(cwd, config, "verification-summary.json"),
	);
	if (summary?.commands?.length) return summary.allPassed;
	return hasPassingConfiguredTest(progress);
}

function interactiveValidationGuidance(
	task: string,
	config: HarnessConfig,
): string[] {
	if (
		!config.requireDeterministicTestsForInteractive ||
		!isInteractiveRuntimeText(task)
	)
		return [];
	return [
		"",
		"Interactive/runtime validation policy:",
		"- This task appears to involve browser/UI/gameplay/runtime behavior.",
		"- Syntax checks, HTTP 200 checks, screenshots without assertions, and worker self-reported smoke tests are not enough to claim PASS.",
		"- Provide objective deterministic validation for core runtime behavior: a configured test command, a script/harness with numeric assertions, or browser automation that reads runtime state and asserts expected transitions.",
		"- If objective validation is not possible, report missing validation as a blocker instead of marking the slice/acceptance criteria complete.",
	];
}

function workspaceManifestMarkdown(cwd: string, config?: HarnessConfig): string {
	const ignored = new Set([
		".git",
		"node_modules",
		".DS_Store",
		".next",
		".nuxt",
		".cache",
		"coverage",
	]);
	const stateDir = config?.stateDir ?? ".pi-harness";
	const rows: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (ignored.has(entry.name)) continue;
			const absolute = path.join(dir, entry.name);
			const rel = path.relative(cwd, absolute).replace(/\\/g, "/");
			if (rel === `${stateDir}/events.jsonl`) continue;
			if (entry.isDirectory()) {
				walk(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			const stat = fs.statSync(absolute);
			rows.push(`| \`${rel}\` | ${stat.size} B |`);
			if (rows.length >= 250) return;
		}
	};
	try {
		walk(cwd);
	} catch {
		// best-effort manifest
	}
	return [
		"# File Manifest",
		"",
		"Git is unavailable in this workspace. Manifest-based review is enabled for non-git workspaces when `allowManifestReviewWhenNoGit` is true.",
		"",
		"| File | Size |",
		"|------|------|",
		...(rows.length ? rows.sort() : ["| (none) | 0 B |"]),
	].join("\n");
}

function gitSummary(cwd: string, config?: HarnessConfig): string {
	if (!isGitRepository(cwd)) {
		return [
			"# Git Summary",
			"",
			"## Status",
			"",
			"Not a git repository. No tracked diff is available.",
			"",
			"## Manifest Fallback",
			"",
			workspaceManifestMarkdown(cwd, config),
		].join("\n");
	}
	const status = runCommand(cwd, "git status --short", 30_000).output.trim();
	const stat = runCommand(cwd, "git diff --stat", 30_000).output.trim();
	const diff = runCommand(cwd, "git diff -- .", 60_000).output;
	return [
		"# Git Summary",
		"",
		"## Status",
		"```",
		status || "(clean or not a git repository)",
		"```",
		"",
		"## Diff Stat",
		"```",
		stat || "(no tracked diff)",
		"```",
		"",
		"## Diff",
		"```diff",
		truncateMiddle(diff || "(no tracked diff)", 80_000),
		"```",
	].join("\n");
}

function isGitRepository(cwd: string): boolean {
	return (
		spawnSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
		}).status === 0
	);
}

function createGitCheckpoint(
	cwd: string,
	config: HarnessConfig,
	label: string,
): string | undefined {
	if (!isGitRepository(cwd)) return undefined;
	const safeLabel =
		label.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "checkpoint";
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = artifactPath(
		cwd,
		config,
		path.join("checkpoints", `${stamp}-${safeLabel}`),
	);
	fs.mkdirSync(dir, { recursive: true });
	const patch = runCommand(cwd, "git diff --binary", 60_000).output;
	const stagedPatch = runCommand(
		cwd,
		"git diff --cached --binary",
		60_000,
	).output;
	const status = runCommand(cwd, "git status --short", 30_000).output;
	const untracked = runCommand(
		cwd,
		"git ls-files --others --exclude-standard",
		30_000,
	).output;
	fs.writeFileSync(path.join(dir, "worktree.patch"), patch, "utf8");
	fs.writeFileSync(path.join(dir, "staged.patch"), stagedPatch, "utf8");
	fs.writeFileSync(path.join(dir, "status.txt"), status, "utf8");
	fs.writeFileSync(path.join(dir, "untracked.txt"), untracked, "utf8");
	fs.writeFileSync(
		path.join(dir, "README.md"),
		[
			`# Hybrid checkpoint ${stamp}`,
			"",
			`Label: ${label}`,
			"",
			"This checkpoint stores tracked worktree and staged patches plus an untracked file list.",
			"Use /hybrid-rollback to reverse-apply the latest tracked worktree patch. Untracked files are not deleted automatically.",
		].join("\n"),
		"utf8",
	);
	return path.relative(cwd, dir);
}

function latestCheckpointDir(
	cwd: string,
	config: HarnessConfig,
): string | undefined {
	const dir = artifactPath(cwd, config, "checkpoints");
	try {
		const entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		const latest = entries.at(-1);
		return latest ? path.join(dir, latest) : undefined;
	} catch {
		return undefined;
	}
}

async function writeTempPrompt(
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-hybrid-"));
	const filePath = path.join(dir, "prompt.md");
	await fs.promises.writeFile(filePath, prompt, {
		encoding: "utf8",
		mode: 0o600,
	});
	return { dir, filePath };
}

function stripAnsiCodes(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractTextContent(result: any): string {
	return stripAnsiCodes(
		result?.content
			?.map((part: any) => {
				if (part?.type === "text") return part.text ?? part.content ?? "";
				if (part?.type === "image") return "[image]";
				return "";
			})
			.filter(Boolean)
			.join("\n") ?? "",
	).replace(/\r/g, "");
}

function inlineCode(value: unknown, fallback = "..."): string {
	const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
	return `\`${text.replace(/`/g, "\\`")}\``;
}

function formatLineRange(args: any): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const start = Number.isFinite(Number(args?.offset)) ? Number(args.offset) : 1;
	const end =
		args?.limit !== undefined && Number.isFinite(Number(args.limit))
			? start + Number(args.limit) - 1
			: undefined;
	return `:${start}${end !== undefined ? `-${end}` : ""}`;
}

function formatNativeToolSummary(
	toolName: string | undefined,
	args: any,
	isError = false,
): string {
	const suffix = isError ? " failed" : "";
	switch (toolName) {
		case "bash":
			return `Ran ${inlineCode(args?.command)}${suffix}`;
		case "read":
			return `Read ${inlineCode(args?.path ?? args?.file_path)}${formatLineRange(args)}${suffix}`;
		case "ls":
			return `Listed ${inlineCode(args?.path || ".")}${suffix}`;
		case "grep":
			return `Searched ${inlineCode(args?.pattern ?? args?.query)}${args?.path ? ` in ${inlineCode(args.path)}` : ""}${suffix}`;
		case "find":
			return `Found files under ${inlineCode(args?.path || ".")}${suffix}`;
		case "edit":
			return `Edited ${inlineCode(args?.path ?? args?.file_path)}${suffix}`;
		case "write":
			return `Wrote ${inlineCode(args?.path ?? args?.file_path)}${suffix}`;
		default:
			return `Used ${inlineCode(toolName ?? "tool")}${suffix}`;
	}
}

function formatNativeToolOutputBlock(output: string, maxChars: number): string[] {
	const trimmed = output.trim();
	if (!trimmed) return [];
	return ["```", truncateMiddle(trimmed, maxChars), "```"];
}

function formatToolEndForLive(event: any, args?: any): string[] {
	const output = extractTextContent(event.result);
	return [
		formatNativeToolSummary(event.toolName, args ?? event.args, Boolean(event.isError)),
		...formatNativeToolOutputBlock(output, 4000),
	];
}

function formatLiveEvent(event: any, args?: any): string[] {
	// Lifecycle and model tool-call assembly events are useful as compact metadata,
	// but noisy in the live UI. Show the same human-facing shape as native Pi:
	// assistant text plus concise tool summaries/results.
	if (
		event.type === "agent_start" ||
		event.type === "agent_end" ||
		event.type === "turn_start" ||
		event.type === "turn_end" ||
		event.type === "tool_execution_update"
	)
		return [];
	if (event.type === "tool_execution_start")
		return [`Running ${formatNativeToolSummary(event.toolName, event.args).replace(/^Ran /, "").replace(/^(Read|Listed|Searched|Found files under|Edited|Wrote|Used) /, "$1 ")}...`];
	if (event.type === "tool_execution_end") return formatToolEndForLive(event, args);
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		// Token-level deltas are coalesced in runPiOnce before reaching this formatter.
		if (
			update?.type === "text_delta" ||
			update?.type === "thinking_delta" ||
			update?.type === "toolcall_delta" ||
			update?.type === "toolcall_start" ||
			update?.type === "toolcall_end"
		)
			return [];
		if (update?.type === "text_end" && update.content) {
			const preview = String(update.content).trim().replace(/\s+/g, " ");
			return preview ? [truncateMiddle(preview, 1600)] : [];
		}
		return [];
	}
	if (event.type === "message_end" && event.message?.role === "assistant")
		return [];
	if (event.type === "response" && event.success === false)
		return [`response ${event.command ?? ""} success=false`];
	if (event.type === "extension_error")
		return [`extension_error ${event.error ?? ""}`];
	return [];
}

function hybridToolPattern(event: any): string | undefined {
	if (event.type !== "tool_execution_start") return undefined;
	const args = event.args ?? event.input ?? {};
	const target =
		args.path ??
		args.file_path ??
		args.pattern ??
		args.query ??
		args.command ??
		args.cmd ??
		"";
	return `${event.toolName ?? "tool"}:${String(target).replace(/\s+/g, " ").slice(0, 300)}`;
}

function compactEventForJsonl(event: any): unknown {
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent ?? {};
		return {
			type: event.type,
			assistantMessageEvent: {
				type: update.type,
				contentIndex: update.contentIndex,
				delta:
					typeof update.delta === "string"
						? truncateMiddle(update.delta, 400)
						: undefined,
				content:
					typeof update.content === "string"
						? truncateMiddle(update.content, 4000)
						: undefined,
				toolCall: update.toolCall,
			},
		};
	}
	if (event.type === "message_end" && event.message) {
		const text =
			event.message.content
				?.filter((part: any) => part.type === "text")
				.map((part: any) => part.text ?? part.content ?? "")
				.join("\n\n") ?? "";
		return {
			type: event.type,
			role: event.message.role,
			text: truncateMiddle(text, 4000),
			usage: event.message.usage,
		};
	}
	if (event.type === "turn_end" && event.message)
		return { type: event.type, role: event.message.role };
	if (event.type === "tool_execution_start") {
		return {
			type: event.type,
			toolName: event.toolName,
			summary: formatNativeToolSummary(event.toolName, event.args),
		};
	}
	if (event.type === "tool_execution_update") {
		return {
			type: event.type,
			toolName: event.toolName,
		};
	}
	if (event.type === "tool_execution_end") {
		const output = extractTextContent(event.result);
		return {
			type: event.type,
			toolName: event.toolName,
			isError: Boolean(event.isError),
			summary: formatNativeToolSummary(event.toolName, event.args, Boolean(event.isError)),
			outputChars: output.length,
		};
	}
	if (event.type === "agent_start" || event.type === "agent_end")
		return {
			type: event.type,
			command: event.command,
			success: event.success,
		};
	if (event.type === "turn_start" || event.type === "response")
		return {
			type: event.type,
			command: event.command,
			success: event.success,
		};
	if (event.type === "extension_error")
		return {
			type: event.type,
			error: truncateMiddle(String(event.error ?? ""), 1000),
		};
	return { type: String(event.type ?? "unknown") };
}

async function runPiOnce(options: {
	cwd: string;
	model: string;
	thinking?: string;
	prompt: string;
	tools?: string[];
	noTools?: boolean;
	timeoutMs?: number;
	liveLabel?: string;
	rawEventPath?: string;
	onLog?: (line: string) => void;
	signal?: AbortSignal;
}): Promise<PiRunResult> {
	const tmp = await writeTempPrompt(options.prompt);
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		options.model,
	];
	if (options.thinking) args.push("--thinking", options.thinking);
	if (options.noTools) args.push("--no-tools");
	else if (options.tools?.length) args.push("--tools", options.tools.join(","));
	args.push(`@${tmp.filePath}`);

	try {
		return await new Promise<PiRunResult>((resolve, reject) => {
			const effectiveSignal = options.signal ?? (options.onLog as any)?.signal;
			const childEvent = (options.onLog as any)?.onEvent as
				| ((label: string, event: any) => void)
				| undefined;
			const command = process.env.PI_BINARY || "pi";
			const proc = spawn(command, args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdoutBuffer = "";
			let stderr = "";
			let finalText = "";
			const messages: unknown[] = [];
			const usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 0,
				toolCalls: 0,
				estimatedInput: estimateRoughTokenCount(options.prompt),
				estimatedOutput: 0,
			};
			let settled = false;
			let assistantDeltaBuffer = "";
			let thinkingDeltaBuffer = "";
			let finalizedEstimatedOutput = 0;
			let currentAssistantText = "";
			let lastToolPattern = "";
			let repeatedToolPatternCount = 0;

			const emitLive = (line: string) => {
				if (!options.onLog) return;
				const prefix = options.liveLabel ? `[${options.liveLabel}] ` : "";
				options.onLog(`${prefix}${line}`);
			};

			const emitUsageEstimate = () => {
				if (!childEvent || !options.liveLabel) return;
				childEvent(options.liveLabel, {
					type: "usage_estimate",
					input: usage.estimatedInput,
					output: usage.estimatedOutput,
				});
			};

			const shouldFlushDelta = (buffer: string): boolean => {
				if (buffer.includes("\n")) return true;
				if (buffer.length >= 240) return true;
				return /[.!?。！？]\s*$/.test(buffer);
			};

			const flushDelta = (kind: "assistant" | "thinking", force = false) => {
				const value =
					kind === "assistant" ? assistantDeltaBuffer : thinkingDeltaBuffer;
				if (!value.trim()) {
					if (kind === "assistant") assistantDeltaBuffer = "";
					else thinkingDeltaBuffer = "";
					return;
				}
				if (!force && !shouldFlushDelta(value)) return;
				if (kind === "assistant") {
					const compact = value.replace(/\s+/g, " ").trim();
					emitLive(`assistant: ${truncateMiddle(compact, 1200)}`);
					assistantDeltaBuffer = "";
				} else {
					// Thinking/encrypted/internal reasoning is not part of the visible child session.
					thinkingDeltaBuffer = "";
				}
			};

			const flushAllDeltas = () => {
				flushDelta("assistant", true);
				flushDelta("thinking", true);
			};

			const finish = (exitCode: number) => {
				if (settled) return;
				flushAllDeltas();
				if (currentAssistantText.trim()) {
					usage.estimatedOutput =
						finalizedEstimatedOutput + estimateRoughTokenCount(currentAssistantText);
				}
				emitUsageEstimate();
				settled = true;
				if (effectiveSignal?.aborted) {
					reject(new Error("Hybrid child run aborted by parent signal"));
					return;
				}
				resolve({
					ok: exitCode === 0,
					exitCode,
					text: finalText.trim(),
					stderr,
					messages,
					usage,
				});
			};

			const abortHandler = () => {
				stderr += "Aborted by parent signal\n";
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.();
				finish(130);
			};
			if (effectiveSignal?.aborted) {
				abortHandler();
				return;
			}
			effectiveSignal?.addEventListener("abort", abortHandler, { once: true });
			emitUsageEstimate();

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				const toolPattern = hybridToolPattern(event);
				if (toolPattern) {
					if (toolPattern === lastToolPattern) {
						repeatedToolPatternCount++;
					} else {
						lastToolPattern = toolPattern;
						repeatedToolPatternCount = 1;
					}
					if (repeatedToolPatternCount >= 25) {
						const message = `stuck-loop-guard: repeated ${toolPattern} ${repeatedToolPatternCount} times`;
						stderr += `${message}\n`;
						emitLive(message);
						proc.kill("SIGTERM");
						setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.();
						finish(125);
						return;
					}
				}
				const update =
					event.type === "message_update"
						? event.assistantMessageEvent
						: undefined;
				const isTokenDelta =
					update?.type === "text_delta" ||
					update?.type === "thinking_delta" ||
					update?.type === "toolcall_delta";
				if (options.rawEventPath && !isTokenDelta) {
					try {
						fs.appendFileSync(
							options.rawEventPath,
							`${JSON.stringify(compactEventForJsonl(event))}\n`,
							"utf8",
						);
					} catch {
						// ignore logging failures
					}
				}
				if (childEvent && options.liveLabel && !isTokenDelta)
					childEvent(options.liveLabel, event);
				if (
					update?.type === "text_end" &&
					update.content &&
					childEvent &&
					options.liveLabel
				) {
					childEvent(options.liveLabel, {
						type: "assistant_preview",
						text: String(update.content),
					});
				}
				if (update?.type === "text_delta" && update.delta) {
					currentAssistantText += String(update.delta);
					assistantDeltaBuffer += String(update.delta);
					flushDelta("assistant");
				} else if (update?.type === "thinking_delta" && update.delta) {
					thinkingDeltaBuffer += String(update.delta);
					flushDelta("thinking");
				} else if (options.onLog) {
					flushAllDeltas();
					for (const formatted of formatLiveEvent(event)) emitLive(formatted);
				}
				if (event.type === "tool_execution_end") {
					usage.toolCalls++;
					const output = extractTextContent(event.result);
					if (output.trim()) {
						usage.estimatedInput += estimateRoughTokenCount(output);
						emitUsageEstimate();
					}
				}
				if (update?.type === "text_end" && update.content) {
					currentAssistantText = String(update.content);
					usage.estimatedOutput =
						finalizedEstimatedOutput + estimateRoughTokenCount(currentAssistantText);
					emitUsageEstimate();
				}
				if (event.type === "message_end" && event.message) {
					messages.push(event.message);
					if (event.message.role === "assistant") {
						usage.turns++;
						const u = event.message.usage;
						if (u) {
							usage.input += u.input || 0;
							usage.output += u.output || 0;
							usage.cacheRead += u.cacheRead || 0;
							usage.cacheWrite += u.cacheWrite || 0;
							usage.cost += u.cost?.total || 0;
						}
						const parts = event.message.content || [];
						const textParts = parts
							.filter((p: any) => p.type === "text")
							.map((p: any) => p.text);
						if (textParts.length) {
							finalText = textParts.join("\n\n");
							finalizedEstimatedOutput += estimateRoughTokenCount(finalText);
						} else if (currentAssistantText.trim()) {
							finalizedEstimatedOutput += estimateRoughTokenCount(currentAssistantText);
						}
						currentAssistantText = "";
						usage.estimatedOutput = finalizedEstimatedOutput;
						emitUsageEstimate();
					}
				}
			};

			proc.stdout.on("data", (chunk) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			proc.on("error", (error) => {
				stderr += `${error instanceof Error ? error.message : String(error)}\n`;
				finish(1);
			});
			proc.on("close", (code) => {
				effectiveSignal?.removeEventListener("abort", abortHandler);
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				finish(code ?? 0);
			});

			const timeout = options.timeoutMs ?? 20 * 60_000;
			setTimeout(() => {
				if (settled) return;
				stderr += `Timed out after ${timeout}ms\n`;
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.();
				finish(124);
			}, timeout).unref?.();
		});
	} finally {
		try {
			await fs.promises.rm(tmp.dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}

async function fetchLocalModels(
	config: HarnessConfig,
): Promise<Array<{ id: string; name?: string; description?: string }>> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(
			`${config.localBaseUrl.replace(/\/$/, "")}/models`,
			{ signal: controller.signal },
		);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const payload = (await res.json()) as {
			data?: Array<{ id: string; name?: string; description?: string }>;
		};
		return payload.data ?? [];
	} finally {
		clearTimeout(timeout);
	}
}

function inferContextWindow(model: {
	id: string;
	description?: string;
}): number {
	const text = `${model.id} ${model.description ?? ""}`.toLowerCase();
	if (text.includes("200k")) return 200_000;
	if (text.includes("131k")) return 131_000;
	return 128_000;
}

function formatUsage(result: PiRunResult): string {
	const u = result.usage;
	const parts = [
		`turns=${u.turns}`,
		`tools=${u.toolCalls}`,
		`in=${u.input}`,
		`out=${u.output}`,
	];
	if (u.cacheRead) parts.push(`cacheRead=${u.cacheRead}`);
	if (u.cacheWrite) parts.push(`cacheWrite=${u.cacheWrite}`);
	if (!u.input && u.estimatedInput) parts.push(`estIn=${u.estimatedInput}`);
	if (!u.output && u.estimatedOutput) parts.push(`estOut=${u.estimatedOutput}`);
	if (u.cost) parts.push(`cost=$${u.cost.toFixed(4)}`);
	return parts.join(" ");
}

function usageSummaryMarkdown(cwd: string, config: HarnessConfig): string {
	const files = [
		{ name: "repo-map.md", bucket: "local" },
		{ name: "frontier-design.md", bucket: "frontier" },
		{ name: "local-log.md", bucket: "local" },
		{ name: "local-review.md", bucket: "local" },
		{ name: "final-review.md", bucket: "frontier" },
	] as const;
	const totals = {
		local: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			estimatedInput: 0,
			estimatedOutput: 0,
			effectiveInput: 0,
			effectiveOutput: 0,
			estimatedRuns: 0,
		},
		frontier: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			estimatedInput: 0,
			estimatedOutput: 0,
			effectiveInput: 0,
			effectiveOutput: 0,
			estimatedRuns: 0,
		},
	};
	const lines = ["# Hybrid Usage Summary", ""];
	for (const file of files) {
		const content = readArtifact(cwd, config, file.name);
		const usageLines = [...content.matchAll(/usage:\s*([^\n]+)/gi)].map(
			(m) => m[1],
		);
		for (const usage of usageLines) {
			const input = Number(usage.match(/\bin=(\d+)/)?.[1] ?? 0);
			const output = Number(usage.match(/\bout=(\d+)/)?.[1] ?? 0);
			const cacheRead = Number(usage.match(/\bcacheRead=(\d+)/)?.[1] ?? 0);
			const cacheWrite = Number(usage.match(/\bcacheWrite=(\d+)/)?.[1] ?? 0);
			const estimatedInput = Number(usage.match(/\bestIn=(\d+)/)?.[1] ?? 0);
			const estimatedOutput = Number(usage.match(/\bestOut=(\d+)/)?.[1] ?? 0);
			const cost = Number(usage.match(/\bcost=\$?([0-9.]+)/)?.[1] ?? 0);
			totals[file.bucket].input += input;
			totals[file.bucket].output += output;
			totals[file.bucket].cacheRead += cacheRead;
			totals[file.bucket].cacheWrite += cacheWrite;
			totals[file.bucket].estimatedInput += estimatedInput;
			totals[file.bucket].estimatedOutput += estimatedOutput;
			totals[file.bucket].effectiveInput += input || estimatedInput;
			totals[file.bucket].effectiveOutput += output || estimatedOutput;
			if ((!input && estimatedInput) || (!output && estimatedOutput))
				totals[file.bucket].estimatedRuns++;
			totals[file.bucket].cost += cost;
			lines.push(`- ${file.bucket} ${file.name}: ${usage}`);
		}
	}
	const localEffective =
		totals.local.effectiveInput + totals.local.effectiveOutput;
	const frontierEffective =
		totals.frontier.effectiveInput + totals.frontier.effectiveOutput;
	const routedEffective = localEffective + frontierEffective;
	if (routedEffective > 0) {
		const avoidedShare = (localEffective / routedEffective) * 100;
		lines.push("", "## Token Routing", "");
		lines.push(
			`- local model tokens: ${formatApproxTokenCount(localEffective, totals.local.estimatedRuns > 0)}`,
			`- frontier model tokens: ${formatApproxTokenCount(frontierEffective, totals.frontier.estimatedRuns > 0)}`,
			`- frontier tokens avoided: ${formatApproxTokenCount(localEffective, totals.local.estimatedRuns > 0)}`,
			`- avoided frontier share: ≈${avoidedShare.toFixed(1)}%`,
			`- routing bar: \`${tokenRoutingBar(localEffective, frontierEffective, 32).plain}\``,
		);
		const savings = estimateFrontierEquivalentCost(
			totals.local.effectiveInput,
			totals.local.effectiveOutput,
			config.frontierInputCostPerMTok,
			config.frontierOutputCostPerMTok,
		);
		if (savings !== undefined) {
			lines.push(`- estimated frontier-equivalent savings: ≈${formatUsd(savings)}`);
		}
	}
	lines.push("", "## Totals", "");
	for (const bucket of ["local", "frontier"] as const) {
		const t = totals[bucket];
		lines.push(
			`- ${bucket}: in=${t.input} out=${t.output} estIn=${t.estimatedInput} estOut=${t.estimatedOutput} cacheRead=${t.cacheRead} cacheWrite=${t.cacheWrite} cost=$${t.cost.toFixed(4)}`,
		);
	}
	lines.push(
		"",
		"Note: estimated local tokens are rough counts from prompts, streamed assistant text, and in-memory tool outputs. Raw tool output is still not persisted.",
	);
	return lines.join("\n");
}

function statusMarkdown(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
): string {
	const activeLock = readHybridRunLock(cwd, config);
	const steeringEntries = readHybridSteering(cwd, config);
	const queuedSteering = steeringEntries.filter(
		(entry) => !entry.consumedAt && !entry.clearedAt,
	).length;
	const artifactLines = Object.entries(state.artifacts)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, rel]) => `- ${name}: \`${rel}\``)
		.join("\n");
	const activeRunLines = activeLock
		? [
				`- liveId: \`${activeLock.liveId}\``,
				`- pid: ${activeLock.pid}`,
				`- task: ${activeLock.task}`,
				`- mode: ${activeLock.mode}`,
				`- current stage: ${activeLock.currentStage ?? "unknown"}`,
				`- heartbeat: ${activeLock.updatedAt}${isHybridRunLockStale(activeLock) ? " (stale)" : ""}`,
				activeLock.cancelRequestedAt
					? `- cancel requested: ${activeLock.cancelRequestedAt}`
					: "- cancel requested: no",
			].join("\n")
		: "- none";
	return [
		"# Hybrid Harness Status",
		"",
		`- Phase: **${state.phase}**`,
		`- State dir: \`${path.relative(cwd, path.join(cwd, config.stateDir)) || config.stateDir}\``,
		`- Local worker: \`${config.localWorkerModel}\``,
		`- Local reviewer: \`${config.localReviewerModel}\``,
		`- Frontier: \`${config.frontierModel}\` (${config.frontierThinking})`,
		`- Frontier cost rates: input=$${config.frontierInputCostPerMTok}/MTok output=$${config.frontierOutputCostPerMTok}/MTok`,
		`- Verification commands: ${config.verificationCommands.length ? config.verificationCommands.map((command) => `\`${command}\``).join(", ") : config.testCommand ? `\`${config.testCommand}\`` : "auto-detect"}`,
		`- Non-git manifest review: ${config.allowManifestReviewWhenNoGit ? "allowed" : "blocked"}`,
		`- Live child output: ${config.verboseChildOutput ? "on" : "off"}`,
		`- Safety guards: ${config.enableSafetyGuards ? "on" : "off"}; destructive bash: ${config.allowDestructiveBash ? "allowed" : "blocked"}`,
		`- Local loops per cycle: ${config.maxLocalLoops}`,
		`- Review repair cycles: ${config.maxReviewRepairCycles}`,
		`- Frontier passes: ${config.maxFrontierPasses}`,
		`- Test command: ${config.testCommand ? `\`${config.testCommand}\`` : "not configured"}`,
		`- Interactive deterministic-test policy: ${config.requireDeterministicTestsForInteractive ? "on" : "off"}`,
		state.task ? `- Task: ${state.task}` : "- Task: not set",
		`- Queued steering: ${queuedSteering}`,
		`- Updated: ${state.updatedAt}`,
		"",
		"## Active Run",
		activeRunLines,
		"",
		"## Artifacts",
		artifactLines || "(none)",
	].join("\n");
}

function setStatusWidget(ctx: any, markdown: string): void {
	if (!ctx?.ui) return;
	const lines = markdown.split("\n").slice(0, 18);
	ctx.ui.setWidget?.("hybrid-harness", lines, { placement: "aboveEditor" });
}

function requireTask(args: string, state: HarnessState): string {
	const task = args.trim() || state.task || "";
	if (!task)
		throw new Error(
			"Usage: /hybrid-start <task> or create an existing task in state.json",
		);
	return task;
}

function localWorkerPrompt(
	task: string,
	config: HarnessConfig,
	iteration: number,
	cwd?: string,
): string {
	const steering = cwd ? hybridSteeringMarkdown(cwd, config) : "";
	if (steering && cwd) markHybridSteeringConsumed(cwd, config, "local-worker");
	return [
		"You are the LOCAL IMPLEMENTER in a hybrid Pi coding harness.",
		"The frontier model already prepared the design. Follow it closely; do not redesign unless the repo proves it impossible.",
		"",
		"Rules:",
		"- Make surgical, minimal changes.",
		"- Prefer existing project conventions.",
		"- Run relevant tests or checks. If no test command is configured, infer the smallest safe verification command.",
		"- If blocked, write a clear blocker report instead of inventing broad rewrites.",
		"- Do not modify .pi-harness except when explicitly asked.",
		"",
		`Task: ${task}`,
		`Iteration: ${iteration}`,
		...(steering ? ["", steering] : []),
		config.testCommand
			? `Configured test command: ${config.testCommand}`
			: "Configured test command: none; infer from repository.",
		"",
		"Read these artifacts first:",
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/repo-map.md`,
		`- ${config.stateDir}/progress.md and ${config.stateDir}/progress.json`,
		`- ${config.stateDir}/orchestration-brief.md and ${config.stateDir}/user-clarifications.md if present`,
		`- ${config.stateDir}/local-review.md if present`,
		`- ${config.stateDir}/final-review.md if present`,
		"",
		"If local-review.md or final-review.md requests changes, prioritize those fixes without broad redesign.",
		...interactiveValidationGuidance(task, config),
		"Implement the next necessary slice, verify it, then summarize:",
		"1. Files changed",
		"2. Verification commands and results",
		"3. Remaining work or blockers",
	].join("\n");
}

type Notify = (message: string, type?: "info" | "warning" | "error") => void;
type LiveLog = (line: string) => void;

function createLiveLogger(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	_ctx: any,
): LiveLog {
	ensureStateDir(cwd, config);
	const liveLogPath = artifactPath(cwd, config, "live-log.md");
	state.artifacts["live-log.md"] = path.relative(cwd, liveLogPath);
	const eventsPath = artifactPath(cwd, config, "events.jsonl");
	state.artifacts["events.jsonl"] = path.relative(cwd, eventsPath);
	fs.writeFileSync(
		liveLogPath,
		[
			"# Hybrid Live Log",
			"",
			`Started: ${nowIso()}`,
			"",
			"Live child output is kept in memory for `/hybrid-monitor` while the run is active.",
			"Raw live output is not persisted to disk.",
			"",
		].join("\n"),
		"utf8",
	);
	return (_line: string) => {};
}

function hybridStageIcon(status: HybridStageStatus): string {
	if (status === "done") return "✓";
	if (status === "running") return "⏳";
	if (status === "failed") return "✗";
	if (status === "skipped") return "-";
	return "○";
}

function createHybridRunDetails(
	task: string,
	mode: HybridRunDetails["mode"],
	config?: HarnessConfig,
): HybridRunDetails {
	const stages: HybridRunStage[] = [
		{ id: "checkpoint", label: "Pre-run checkpoint", status: "pending" },
		{ id: "design", label: "Local scout + frontier design", status: "pending" },
		{
			id: "brief",
			label: "Orchestration briefing / clarification gate",
			status: "pending",
		},
		{ id: "local-loop", label: "Local worker/test loops", status: "pending" },
		{ id: "finish", label: "Deterministic finish/reconcile", status: "pending" },
		{ id: "local-review", label: "Local reviewer", status: "pending" },
		{ id: "frontier-final", label: "Frontier final gate", status: "pending" },
		{ id: "summary", label: "Artifact summary", status: "pending" },
	];
	return {
		version: 1,
		status: "running",
		mode,
		task,
		startedAt: nowIso(),
		updatedAt: nowIso(),
		recentOutput: [],
		liveOutput: [],
		stages,
		children: {},
		childOrder: [],
		frontierInputCostPerMTok: config?.frontierInputCostPerMTok,
		frontierOutputCostPerMTok: config?.frontierOutputCostPerMTok,
		artifacts: {},
	};
}

function updateHybridProgressDetails(
	details: HybridRunDetails,
	progress: HarnessProgress | undefined,
): void {
	if (!progress) return;
	details.progress = {
		slicesDone: progress.slices.filter((slice) => slice.status === "done")
			.length,
		slicesTotal: progress.slices.length,
		acceptanceSatisfied: progress.acceptanceCriteria.filter(
			(criterion) => criterion.status === "satisfied",
		).length,
		acceptanceTotal: progress.acceptanceCriteria.length,
		activeFrontierTriggers: progress.frontierRecheckTriggers.filter(
			(trigger) => trigger.active,
		).length,
		nextAction: progress.nextAction,
	};
}

function formatMs(ms: number | undefined): string {
	if (!ms || ms < 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

function estimateRoughTokenCount(text: string): number {
	if (!text.trim()) return 0;
	let asciiChars = 0;
	let cjkChars = 0;
	let otherChars = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp <= 0x7f) {
			asciiChars++;
		} else if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(ch)) {
			cjkChars++;
		} else {
			otherChars++;
		}
	}
	return Math.max(1, Math.ceil(asciiChars / 4) + cjkChars + otherChars * 2);
}

function formatApproxTokenCount(tokens: number, approximate: boolean): string {
	return `${approximate ? "≈" : ""}${formatTokenCount(tokens)}`;
}

function formatUsd(value: number): string {
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

function estimateFrontierEquivalentCost(
	inputTokens: number,
	outputTokens: number,
	inputCostPerMTok?: number,
	outputCostPerMTok?: number,
): number | undefined {
	const inputRate = Math.max(0, inputCostPerMTok ?? 0);
	const outputRate = Math.max(0, outputCostPerMTok ?? 0);
	if (!inputRate && !outputRate) return undefined;
	return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

function tokenRoutingBar(
	localTokens: number,
	frontierTokens: number,
	width: number,
): { local: string; frontier: string; plain: string } {
	const total = localTokens + frontierTokens;
	if (total <= 0 || width <= 0) return { local: "", frontier: "", plain: "" };
	let localCells = Math.round((localTokens / total) * width);
	if (localTokens > 0 && localCells === 0) localCells = 1;
	if (frontierTokens > 0 && localCells === width) localCells = width - 1;
	const frontierCells = Math.max(0, width - localCells);
	const local = "█".repeat(localCells);
	const frontier = "░".repeat(frontierCells);
	return {
		local,
		frontier,
		plain: `${"L".repeat(localCells)}${"F".repeat(frontierCells)}`,
	};
}

// ── TUI rendering helpers (subagents-style) ──────────────────────────────

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function normalizeTuiText(text: string): string {
	return text.replace(/\r/g, "").replace(/\t/g, "   ");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 */
function truncLine(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (maxWidth === 1) return "…";
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return `${result}…${activeStyles.length ? "\x1b[0m" : ""}`;
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return `${result}…${activeStyles.length ? "\x1b[0m" : ""}`;
}

function runningGlyph(seed?: number): string {
	if (seed === undefined) return "●";
	return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

function hybridRunningSeed(details: HybridRunDetails): number | undefined {
	let seed: number | undefined;
	const now = Date.now();
	seed = runningSeed(seed, details.updatedAt ? now - Date.parse(details.updatedAt) : undefined);
	for (const child of Object.values(details.children)) {
		seed = runningSeed(seed, child.updatedAt ? now - Date.parse(child.updatedAt) : undefined);
	}
	return seed;
}

function runningSeed(...values: Array<number | undefined>): number | undefined {
	let seed: number | undefined;
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) continue;
		seed = (seed ?? 0) + Math.trunc(value);
	}
	return seed;
}

function themeBold(theme: any, text: string): string {
	return theme.bold?.(text) ?? text;
}

function markdownThemeForPiTheme(theme: any): MarkdownTheme {
	const required = [
		"heading",
		"link",
		"linkUrl",
		"code",
		"codeBlock",
		"codeBlockBorder",
		"quote",
		"quoteBorder",
		"hr",
		"listBullet",
		"bold",
		"italic",
		"strikethrough",
		"underline",
	];
	if (theme && required.every((name) => typeof theme[name] === "function")) {
		return theme as MarkdownTheme;
	}

	const fg = (name: string, text: string) =>
		typeof theme?.fg === "function" ? theme.fg(name, text) : text;
	return {
		heading: (text) => fg("mdHeading", text),
		link: (text) => fg("mdLink", text),
		linkUrl: (text) => fg("mdLinkUrl", text),
		code: (text) => fg("mdCode", text),
		codeBlock: (text) => fg("mdCodeBlock", text),
		codeBlockBorder: (text) => fg("mdCodeBlockBorder", text),
		quote: (text) => fg("mdQuote", text),
		quoteBorder: (text) => fg("mdQuoteBorder", text),
		hr: (text) => fg("mdHr", text),
		listBullet: (text) => fg("mdListBullet", text),
		bold: (text) => theme?.bold?.(text) ?? text,
		italic: (text) => theme?.italic?.(text) ?? text,
		strikethrough: (text) => theme?.strikethrough?.(text) ?? text,
		underline: (text) => theme?.underline?.(text) ?? text,
		highlightCode: theme?.highlightCode,
		codeBlockIndent: theme?.codeBlockIndent,
	};
}

function statJoin(theme: any, parts: string[]): string {
	return parts.filter(Boolean).map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

function formatTokenStat(tokens: number, approximate = false): string {
	return `${approximate ? "≈" : ""}${formatTokens(tokens)} token`;
}

function formatToolUseStat(count: number): string {
	return `${count} tool use${count === 1 ? "" : "s"}`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

function childActualTokenTotal(child: HybridChildStats): number {
	return child.inputTokens + child.outputTokens;
}

function childEffectiveInputTokens(child: HybridChildStats): number {
	return child.inputTokens || child.estimatedInputTokens;
}

function childEffectiveOutputTokens(child: HybridChildStats): number {
	return child.outputTokens || child.estimatedOutputTokens;
}

function childEffectiveTokenTotal(child: HybridChildStats): number {
	return childEffectiveInputTokens(child) + childEffectiveOutputTokens(child);
}

function childHasEstimatedTokens(child: HybridChildStats): boolean {
	return childEffectiveTokenTotal(child) > childActualTokenTotal(child);
}

function hybridChildBucket(label: string): "frontier" | "local" {
	return label.startsWith("frontier-") ? "frontier" : "local";
}

function hybridTokenRouting(details: HybridRunDetails): {
	localInput: number;
	localOutput: number;
	frontierInput: number;
	frontierOutput: number;
	localEstimated: boolean;
	frontierEstimated: boolean;
} {
	const totals = {
		localInput: 0,
		localOutput: 0,
		frontierInput: 0,
		frontierOutput: 0,
		localEstimated: false,
		frontierEstimated: false,
	};
	for (const [label, child] of Object.entries(details.children)) {
		const bucket = hybridChildBucket(label);
		const input = childEffectiveInputTokens(child);
		const output = childEffectiveOutputTokens(child);
		if (bucket === "frontier") {
			totals.frontierInput += input;
			totals.frontierOutput += output;
			totals.frontierEstimated ||= childHasEstimatedTokens(child);
		} else {
			totals.localInput += input;
			totals.localOutput += output;
			totals.localEstimated ||= childHasEstimatedTokens(child);
		}
	}
	return totals;
}

function formatTokenRoutingLines(
	theme: any,
	details: HybridRunDetails,
): string[] {
	const routing = hybridTokenRouting(details);
	const localTokens = routing.localInput + routing.localOutput;
	const frontierTokens = routing.frontierInput + routing.frontierOutput;
	const totalTokens = localTokens + frontierTokens;
	if (totalTokens <= 0) return [];
	const avoidedPct = (localTokens / totalTokens) * 100;
	const bar = tokenRoutingBar(localTokens, frontierTokens, 28);
	const lines = [
		theme.fg(
			"dim",
			`Tokens: local ${formatApproxTokenCount(localTokens, routing.localEstimated)} · frontier ${formatApproxTokenCount(frontierTokens, routing.frontierEstimated)} · avoided ≈${avoidedPct.toFixed(0)}%`,
		),
		`${theme.fg("success", bar.local)}${theme.fg("warning", bar.frontier)} ${theme.fg("dim", "local/frontier")}`,
	];
	const savings = estimateFrontierEquivalentCost(
		routing.localInput,
		routing.localOutput,
		details.frontierInputCostPerMTok,
		details.frontierOutputCostPerMTok,
	);
	if (savings !== undefined) {
		lines.push(theme.fg("dim", `Frontier-equivalent savings: ≈${formatUsd(savings)}`));
	}
	return lines;
}

function formatDuration(ms: number): string {
	if (ms < 0) ms = 0;
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function formatProgressStats(theme: any, progress: HybridRunDetails): string {
	const parts: string[] = [];
	if (progress.currentChild || Object.keys(progress.children).length > 0) {
		const running = Object.values(progress.children).filter((c) => c.status === "running").length;
		if (running > 0) parts.push(`${running} child${running > 1 ? "ren" : ""} running`);
	}
	const children = Object.values(progress.children);
	const totalTokens = children.reduce((s, c) => s + childEffectiveTokenTotal(c), 0);
	if (totalTokens > 0)
		parts.push(formatTokenStat(totalTokens, children.some(childHasEstimatedTokens)));
	const totalTools = children.reduce((s, c) => s + c.toolCalls, 0);
	if (totalTools > 0) parts.push(formatToolUseStat(totalTools));
	if (progress.startedAt && progress.updatedAt) {
		const dur = Math.max(0, Date.parse(progress.updatedAt) - Date.parse(progress.startedAt));
		if (dur > 0) parts.push(formatDuration(dur));
	}
	return statJoin(theme, parts);
}

function stageIcon(status: HybridStageStatus, theme: any, seed?: number): string {
	if (status === "running") return theme.fg("accent", runningGlyph(seed));
	if (status === "done") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "skipped") return theme.fg("muted", "- ");
	return theme.fg("muted", "○");
}

function childGlyph(status: HybridChildStats["status"], theme: any, seed?: number): string {
	if (status === "running") return theme.fg("accent", runningGlyph(seed));
	if (status === "failed") return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function childActivity(child: HybridChildStats, now: number): string {
	const facts: string[] = [];
	if (child.currentTool && child.currentToolStartedAt) {
		const dur = Math.max(0, now - Date.parse(child.currentToolStartedAt));
		facts.push(`${child.currentTool} ${formatDuration(dur)}`);
	} else if (child.currentTool) {
		facts.push(child.currentTool);
	}
	if (child.turns > 0) facts.push(`${child.turns} turns`);
	if (child.toolCalls > 0) facts.push(`${formatToolUseStat(child.toolCalls)}`);
	const tokenTotal = childEffectiveTokenTotal(child);
	if (tokenTotal > 0) facts.push(formatTokenStat(tokenTotal, childHasEstimatedTokens(child)));
	if (child.lastOutput) facts.push(truncLine(child.lastOutput, 80));
	return facts.join(" · ") || "thinking…";
}

function cloneHybridDetails(details: HybridRunDetails): HybridRunDetails {
	return {
		...details,
		stages: details.stages.map((stage) => ({ ...stage })),
		recentOutput: [...details.recentOutput],
		liveOutput: [...(details.liveOutput ?? [])],
		artifacts: { ...details.artifacts },
		childOrder: [...details.childOrder],
		children: Object.fromEntries(
			Object.entries(details.children).map(([label, child]) => [
				label,
				{ ...child },
			]),
		),
	};
}

function normalizeHybridRunDetailsForRender(
	value: Partial<HybridRunDetails> | undefined,
): HybridRunDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const mode: HybridRunDetails["mode"] =
		value.mode === "fast" || value.mode === "thorough"
			? value.mode
			: "default";
	const task =
		typeof value.task === "string" && value.task.trim()
			? value.task
			: "(task missing)";
	const base = createHybridRunDetails(task, mode);
	const children = normalizeHybridChildren(value.children);
	const childOrder = Array.isArray(value.childOrder)
		? value.childOrder.map(String).filter((label) => children[label])
		: Object.keys(children);
	return {
		...base,
		...value,
		version: 1,
		status:
			value.status === "done" || value.status === "failed"
				? value.status
				: "running",
		mode,
		task,
		startedAt:
			typeof value.startedAt === "string" ? value.startedAt : base.startedAt,
		updatedAt:
			typeof value.updatedAt === "string" ? value.updatedAt : base.updatedAt,
		recentOutput: Array.isArray(value.recentOutput)
			? value.recentOutput.map(String)
			: [],
		liveOutput: Array.isArray(value.liveOutput)
			? value.liveOutput.map(String)
			: [],
		stages: normalizeHybridStages(value.stages, base.stages),
		children,
		childOrder,
		artifacts: normalizeStringRecord(value.artifacts),
	};
}

function normalizeHybridStages(
	stages: HybridRunStage[] | undefined,
	fallback: HybridRunStage[],
): HybridRunStage[] {
	if (!Array.isArray(stages) || stages.length === 0)
		return fallback.map((stage) => ({ ...stage }));
	return stages.map((stage, index) => ({
		id: String(stage?.id || `stage-${index + 1}`),
		label: String(stage?.label || stage?.id || `Stage ${index + 1}`),
		status: normalizeHybridStageStatus(stage?.status),
		startedAt:
			typeof stage?.startedAt === "string" ? stage.startedAt : undefined,
		endedAt: typeof stage?.endedAt === "string" ? stage.endedAt : undefined,
		summary: typeof stage?.summary === "string" ? stage.summary : undefined,
	}));
}

function normalizeHybridStageStatus(
	status: unknown,
): HybridStageStatus {
	return status === "running" ||
		status === "done" ||
		status === "failed" ||
		status === "skipped"
		? status
		: "pending";
}

function normalizeHybridChildren(
	children: Record<string, HybridChildStats> | undefined,
): Record<string, HybridChildStats> {
	if (!children || typeof children !== "object") return {};
	return Object.fromEntries(
		Object.entries(children)
			.filter(([, child]) => child && typeof child === "object")
			.map(([label, child]) => [
				label,
				normalizeHybridChild(label, child as Partial<HybridChildStats>),
			]),
	);
}

function normalizeHybridChild(
	label: string,
	child: Partial<HybridChildStats>,
): HybridChildStats {
	const now = nowIso();
	return {
		label: String(child.label || label),
		status:
			child.status === "done" || child.status === "failed"
				? child.status
				: "running",
		startedAt: typeof child.startedAt === "string" ? child.startedAt : now,
		updatedAt: typeof child.updatedAt === "string" ? child.updatedAt : now,
		endedAt: typeof child.endedAt === "string" ? child.endedAt : undefined,
		currentTool:
			typeof child.currentTool === "string" ? child.currentTool : undefined,
		currentToolStartedAt:
			typeof child.currentToolStartedAt === "string"
				? child.currentToolStartedAt
				: undefined,
		lastOutput:
			typeof child.lastOutput === "string" ? child.lastOutput : undefined,
		toolCalls: Number(child.toolCalls) || 0,
		turns: Number(child.turns) || 0,
		inputTokens: Number(child.inputTokens) || 0,
		outputTokens: Number(child.outputTokens) || 0,
		estimatedInputTokens: Number(child.estimatedInputTokens) || 0,
		estimatedOutputTokens: Number(child.estimatedOutputTokens) || 0,
		cacheReadTokens: Number(child.cacheReadTokens) || 0,
		cacheWriteTokens: Number(child.cacheWriteTokens) || 0,
	};
}

function normalizeStringRecord(
	value: Record<string, string> | undefined,
): Record<string, string> {
	if (!value || typeof value !== "object") return {};
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [String(key), String(item)]),
	);
}

function createHybridReporter(
	details: HybridRunDetails,
	onUpdate?: (result: AgentToolResult<HybridRunDetails>) => void,
	ctx?: any,
): {
	details: HybridRunDetails;
	emit: (content?: string) => void;
	log: (line: string) => void;
	childEvent: (label: string, event: any) => void;
	stage: (id: string, status: HybridStageStatus, summary?: string) => void;
	setProgress: (progress: HarnessProgress | undefined) => void;
} {
	const emit = (content?: string) => {
		details.updatedAt = nowIso();
		onUpdate?.({
			content: [
				{
					type: "text",
					text: content ?? hybridDetailsToMarkdown(details, false),
				},
			],
			details: cloneHybridDetails(details),
		});
		ctx?.ui?.requestRender?.();
	};
	return {
		details,
		emit,
		log(line: string) {
			const cleaned = line.replace(/\s+$/g, "");
			if (!cleaned) return;
			details.recentOutput.push(cleaned);
			while (details.recentOutput.length > 20) details.recentOutput.shift();
			details.liveOutput.push(cleaned);
			while (details.liveOutput.length > HYBRID_LIVE_OUTPUT_LIMIT)
				details.liveOutput.shift();
			const toolMatch = cleaned.match(
				/\btool_(?:start|update|end)\s+([^\s:]+)/,
			);
			if (toolMatch?.[1]) details.currentTool = toolMatch[1];
			const childMatch = cleaned.match(/^\[([^\]]+)\]/);
			if (childMatch?.[1]) details.currentChild = childMatch[1];
			emit();
		},
		childEvent(label: string, event: any) {
			const timestamp = nowIso();
			let child = details.children[label];
			if (!child) {
				child = {
					label,
					status: "running",
					startedAt: timestamp,
					updatedAt: timestamp,
					toolCalls: 0,
					turns: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedInputTokens: 0,
					estimatedOutputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				};
				details.children[label] = child;
				details.childOrder.push(label);
			}
			child.updatedAt = timestamp;
			details.currentChild = label;
			if (event.type === "tool_execution_start") {
				child.currentTool = event.toolName;
				child.currentToolStartedAt = timestamp;
				details.currentTool = event.toolName;
			} else if (event.type === "usage_estimate") {
				child.estimatedInputTokens = Math.max(
					child.estimatedInputTokens,
					Number(event.input) || 0,
				);
				child.estimatedOutputTokens = Math.max(
					child.estimatedOutputTokens,
					Number(event.output) || 0,
				);
			} else if (event.type === "tool_execution_end") {
				child.toolCalls++;
				child.currentTool = undefined;
				child.currentToolStartedAt = undefined;
				if (details.currentChild === label) details.currentTool = undefined;
				child.lastOutput = event.isError
					? `${event.toolName} failed`
					: `${event.toolName} ok`;
			} else if (
				event.type === "message_end" &&
				event.message?.role === "assistant"
			) {
				child.turns++;
				const usage = event.message.usage;
				if (usage) {
					child.inputTokens += usage.input || 0;
					child.outputTokens += usage.output || 0;
					child.cacheReadTokens += usage.cacheRead || 0;
					child.cacheWriteTokens += usage.cacheWrite || 0;
				}
				const text =
					event.message.content
						?.filter((part: any) => part.type === "text")
						.map((part: any) => part.text)
						.join(" ") ?? "";
				if (text.trim())
					child.lastOutput = truncateMiddle(
						text.trim().replace(/\s+/g, " "),
						220,
					);
			} else if (event.type === "agent_end" || event.type === "response") {
				child.status = event.success === false ? "failed" : "done";
				child.endedAt = timestamp;
			}
			emit();
		},
		stage(id: string, status: HybridStageStatus, summary?: string) {
			const stage = details.stages.find((candidate) => candidate.id === id);
			if (stage) {
				stage.status = status;
				if (status === "running" && !stage.startedAt)
					stage.startedAt = nowIso();
				if (["done", "failed", "skipped"].includes(status))
					stage.endedAt = nowIso();
				if (summary !== undefined) stage.summary = summary;
			}
			details.currentStage = id;
			emit(summary);
		},
		setProgress(progress: HarnessProgress | undefined) {
			updateHybridProgressDetails(details, progress);
			emit();
		},
	};
}

// ── Component-based rendering (subagents-style) ──────────────────────────

class HybridRunComponent implements Component {
	constructor(
		private readonly details: HybridRunDetails,
		private readonly expanded: boolean,
		private readonly theme: any,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		return buildHybridRunContainer(
			this.details,
			this.expanded,
			this.theme,
			width,
		).render(width);
	}
}

function buildHybridRunComponent(
	details: HybridRunDetails,
	expanded: boolean,
	theme: any,
): Component {
	return new HybridRunComponent(details, expanded, theme);
}

function buildHybridRunContainer(
	details: HybridRunDetails,
	expanded: boolean,
	theme: any,
	renderWidth: number,
): Component {
	const w = Math.max(20, renderWidth - 4);
	const fit = (text: string) => truncLine(text, w);
	const now = Date.now();

	// Status glyph
	const isRunning = details.status === "running";
	const hasError = details.status === "failed";
	const seed = isRunning ? hybridRunningSeed(details) : undefined;

	const c = new Container();

	// Header line: glyph + mode + stats
	const headerGlyph = isRunning
		? theme.fg("accent", runningGlyph(seed))
		: hasError
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const modeLabel = `hybrid run ${details.mode}`;
	const statsParts: string[] = [];
	if (details.localVerdict || details.frontierVerdict) {
		statsParts.push(`local=${details.localVerdict ?? "pending"}`);
		statsParts.push(`frontier=${details.frontierVerdict ?? "pending"}`);
	}
	const stats = statsParts.length ? ` · ${statJoin(theme, statsParts)}` : "";

	c.addChild(
		new Text(fit(`${headerGlyph} ${themeBold(theme, modeLabel)}${stats}`), 0, 0),
	);
	c.addChild(new Spacer(1));

	// Task preview
	const taskPreviewLimit = Math.max(20, w - 8);
	const taskPreview = expanded || details.task.length <= taskPreviewLimit
		? details.task
		: `${details.task.slice(0, taskPreviewLimit)}…`;
	c.addChild(new Text(fit(theme.fg("dim", `Task: ${taskPreview}`)), 0, 0));
	c.addChild(new Spacer(1));

	// Progress summary (slices / AC / triggers)
	if (details.progress) {
		const p = details.progress;
		const progressParts: string[] = [];
		progressParts.push(`slices ${p.slicesDone}/${p.slicesTotal}`);
		progressParts.push(`AC ${p.acceptanceSatisfied}/${p.acceptanceTotal}`);
		if (p.activeFrontierTriggers > 0) {
			progressParts.push(`${p.activeFrontierTriggers} active trigger${p.activeFrontierTriggers > 1 ? "s" : ""}`);
		}
		c.addChild(new Text(fit(theme.fg("dim", `Progress: ${statJoin(theme, progressParts)}`)), 0, 0));
		if (p.nextAction && expanded) {
			c.addChild(new Text(fit(theme.fg("dim", `Next: ${truncateMiddle(p.nextAction, 200)}`)), 0, 0));
		}
		c.addChild(new Spacer(1));
	}

	// Current activity
	if (isRunning && (details.currentChild || details.currentTool)) {
		const facts: string[] = [];
		if (details.currentChild) facts.push(details.currentChild);
		if (details.currentTool) facts.push(details.currentTool);
		c.addChild(new Text(fit(theme.fg("dim", `Current: ${facts.join(" · ")}`)), 0, 0));
	}

	const tokenRoutingLines = formatTokenRoutingLines(theme, details);
	if (tokenRoutingLines.length > 0) {
		for (const line of tokenRoutingLines) {
			c.addChild(new Text(fit(line), 0, 0));
		}
		c.addChild(new Spacer(1));
	}

	// Stage list
	const runningStageSeed = hybridRunningSeed(details);
	let stageIdx = 0;
	for (const stage of details.stages) {
		const icon = stageIcon(stage.status, theme, stageIdx === 0 && isRunning ? runningStageSeed : undefined);
		const suffix = stage.summary
			? ` — ${truncateMiddle(stage.summary, expanded ? 240 : 120)}`
			: "";
		c.addChild(new Text(fit(`${icon} ${themeBold(theme, stage.label)}${suffix}`), 0, 0));
		stageIdx++;
	}

	// Error
	if (details.error) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(fit(theme.fg("error", `Error: ${truncateMiddle(details.error, 200)}`)), 0, 0));
	}

	// Child runs
	const activeChildren = details.childOrder
		.map((label) => details.children[label])
		.filter(Boolean);

	if (activeChildren.length > 0) {
		c.addChild(new Spacer(1));
		const childrenToShow = expanded ? activeChildren : activeChildren.slice(-6);
		for (let ci = 0; ci < childrenToShow.length; ci++) {
			const child = childrenToShow[ci];
			const cs = childGlyph(child.status, theme, ci === 0 && isRunning ? runningStageSeed : undefined);
			const dur = formatMs(
				child.endedAt
					? Math.max(0, (child.endedAt ? Date.parse(child.endedAt) : now) - Date.parse(child.startedAt))
					: Math.max(0, now - Date.parse(child.startedAt)),
			);
			const tokenTotal = childEffectiveTokenTotal(child);
			const parts: string[] = [];
			if (child.currentTool) {
				if (child.currentToolStartedAt) {
					parts.push(`${child.currentTool} ${formatDuration(Math.max(0, now - Date.parse(child.currentToolStartedAt)))}`);
				} else {
					parts.push(child.currentTool);
				}
			}
			parts.push(`${child.toolCalls} tool${child.toolCalls !== 1 ? "s" : ""}`);
			parts.push(formatTokenStat(tokenTotal, childHasEstimatedTokens(child)));
			parts.push(dur);

			const header = `${cs} ${themeBold(theme, child.label)} · ${statJoin(theme, parts)}`;
			c.addChild(new Text(fit(header), 0, 0));

			if (expanded && child.lastOutput) {
				c.addChild(new Text(fit(theme.fg("dim", `    ⎿ ${truncateMiddle(child.lastOutput, 220)}`)), 0, 0));
			}
			if (child.status === "running" && expanded) {
				const activity = childActivity(child, now);
				c.addChild(new Text(fit(theme.fg("dim", `    ⎿ ${activity}`)), 0, 0));
			}
		}

		if (!expanded && activeChildren.length > 6) {
			const hidden = activeChildren.length - 6;
			c.addChild(new Text(fit(theme.fg("dim", `  +${hidden} more children`)), 0, 0));
		}
	}

	// Recent output stays expanded-only; the live modal is the main log surface.
	if (expanded && details.recentOutput.length > 0) {
		c.addChild(new Spacer(1));
		const recentLines = details.recentOutput;
		for (const line of recentLines) {
			c.addChild(new Text(fit(theme.fg("dim", `  ${truncateMiddle(line, 400)}`)), 0, 0));
		}
	}

	// Expanded details
	if (expanded) {
		const artifacts = Object.entries(details.artifacts);
		if (artifacts.length > 0) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", "Artifacts:")), 0, 0));
			for (const [name, rel] of artifacts.sort()) {
				c.addChild(new Text(fit(theme.fg("dim", `  ${name}: ${rel}`)), 0, 0));
			}
		}
		if (details.usageSummary) {
			c.addChild(new Spacer(1));
			c.addChild(new Markdown(details.usageSummary, 0, 0, markdownThemeForPiTheme(theme)));
		}
	} else if (isRunning && activeChildren.length > 0) {
		c.addChild(new Text(fit(theme.fg("accent", "  F8, Ctrl+Alt+H, or /hybrid-monitor for live output")), 0, 0));
	} else {
		c.addChild(new Text(fit(keyHint("app.tools.expand", "full hybrid output")), 0, 0));
	}

	return c;
}

function hybridDetailsToMarkdown(
	details: HybridRunDetails,
	expanded: boolean,
): string {
	// Legacy fallback: build plain-text markdown for non-component contexts
	const lines: string[] = [];
	const statusIcon =
		details.status === "done" ? "✓" : details.status === "failed" ? "✗" : "⏳";
	lines.push(`${statusIcon} Hybrid run (${details.mode})`);
	lines.push(`Task: ${truncateMiddle(details.task, 140)}`);
	if (details.progress) {
		lines.push(
			`Progress: slices ${details.progress.slicesDone}/${details.progress.slicesTotal} · AC ${details.progress.acceptanceSatisfied}/${details.progress.acceptanceTotal} · active frontier triggers ${details.progress.activeFrontierTriggers}`,
		);
		if (details.progress.nextAction)
			lines.push(`Next: ${truncateMiddle(details.progress.nextAction, 160)}`);
	}
	if (details.currentChild || details.currentTool) {
		lines.push(
			`Current: ${details.currentChild ?? "child"}${details.currentTool ? ` · ${details.currentTool}` : ""}`,
		);
	}
	if (details.localVerdict || details.frontierVerdict) {
		lines.push(
			`Verdicts: local=${details.localVerdict ?? "pending"} · frontier=${details.frontierVerdict ?? "pending"}`,
		);
	}
	const routing = hybridTokenRouting(details);
	const localTokens = routing.localInput + routing.localOutput;
	const frontierTokens = routing.frontierInput + routing.frontierOutput;
	if (localTokens + frontierTokens > 0) {
		const avoidedPct = (localTokens / (localTokens + frontierTokens)) * 100;
		lines.push(
			`Tokens: local ${formatApproxTokenCount(localTokens, routing.localEstimated)} · frontier ${formatApproxTokenCount(frontierTokens, routing.frontierEstimated)} · avoided ≈${avoidedPct.toFixed(0)}%`,
		);
	}
	const activeChildren = details.childOrder
		.map((label) => details.children[label])
		.filter(Boolean);
	if (activeChildren.length > 0) {
		const totalTools = activeChildren.reduce(
			(sum, child) => sum + child.toolCalls,
			0,
		);
		const totalTokens = activeChildren.reduce(
			(sum, child) => sum + childEffectiveTokenTotal(child),
			0,
		);
		lines.push(
			`Children: ${activeChildren.filter((child) => child.status === "running").length} running · ${totalTools} tools · ${formatApproxTokenCount(totalTokens, activeChildren.some(childHasEstimatedTokens))} tokens`,
		);
	}
	lines.push("");
	for (const stage of details.stages) {
		const suffix = stage.summary
			? ` — ${truncateMiddle(stage.summary, expanded ? 240 : 120)}`
			: "";
		lines.push(`${hybridStageIcon(stage.status)} ${stage.label}${suffix}`);
	}
	if (details.error) {
		lines.push("", "Error:", details.error);
	}
	if (activeChildren.length > 0) {
		lines.push("", expanded ? "Child runs:" : "Active child runs:");
		const now = Date.now();
		const childrenToShow = expanded ? activeChildren : activeChildren.slice(-6);
		for (const child of childrenToShow) {
			const started = Date.parse(child.startedAt);
			const ended = child.endedAt ? Date.parse(child.endedAt) : now;
			const duration = Number.isFinite(started)
				? formatMs(Math.max(0, ended - started))
				: "0s";
			const currentToolDuration = child.currentToolStartedAt
				? ` ${formatMs(Math.max(0, now - Date.parse(child.currentToolStartedAt)))}`
				: "";
			const tokenTotal = childEffectiveTokenTotal(child);
			const status =
				child.status === "running"
					? "⏳"
					: child.status === "failed"
						? "✗"
						: "✓";
			const tool = child.currentTool
				? ` · ${child.currentTool}${currentToolDuration}`
				: "";
			lines.push(
				`${status} ${child.label}${tool} · ${child.toolCalls} tools · ${formatApproxTokenCount(tokenTotal, childHasEstimatedTokens(child))} tok · ${duration}`,
			);
			if (expanded && child.lastOutput)
				lines.push(`  ⎿ ${truncateMiddle(child.lastOutput, 220)}`);
		}
	}
	const recent = expanded ? details.recentOutput : [];
	if (recent.length > 0) {
		lines.push("", "Recent child output:");
		for (const line of recent)
			lines.push(`  ${truncateMiddle(line, 400)}`);
	}
	if (expanded) {
		const artifacts = Object.entries(details.artifacts);
		if (artifacts.length > 0) {
			lines.push("", "Artifacts:");
			for (const [name, rel] of artifacts.sort())
				lines.push(`- ${name}: ${rel}`);
		}
		if (details.usageSummary)
			lines.push("", "Usage summary:", details.usageSummary);
	} else {
		lines.push("", keyHint("app.tools.expand", "full hybrid output"));
	}
	return lines.join("\n");
}

type HybridModelConfigKey =
	| "localWorkerModel"
	| "localReviewerModel"
	| "frontierModel";

const HYBRID_MODEL_CONFIG_KEYS: Array<{
	key: HybridModelConfigKey;
	label: string;
	description: string;
}> = [
	{
		key: "localWorkerModel",
		label: "Local worker",
		description: "Main child session that implements slices",
	},
	{
		key: "localReviewerModel",
		label: "Local reviewer",
		description: "Local review, repair checks, and final local review",
	},
	{
		key: "frontierModel",
		label: "Frontier",
		description: "Design and final approval gate",
	},
];

function hybridModelFullId(model: { provider: unknown; id: string }): string {
	return `${String(model.provider)}/${model.id}`;
}

function hybridModelDescription(model: {
	api?: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}): string {
	const parts = [
		model.name,
		model.api,
		model.reasoning ? "reasoning" : undefined,
		model.contextWindow ? `ctx ${formatTokenCount(model.contextWindow)}` : undefined,
		model.maxTokens ? `max ${formatTokenCount(model.maxTokens)}` : undefined,
	];
	return parts.filter(Boolean).join(" · ");
}

class HybridReportOverlayComponent implements Component {
	private scrollOffset = Number.MAX_SAFE_INTEGER;
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		private readonly tui: TUI,
		private readonly title: string,
		private readonly markdown: string,
		private readonly theme: any,
		private readonly done: () => void,
	) {}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, Key.f8) ||
			data === "q" ||
			data === "Q"
		) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k" || data === "K") {
			this.scrollOffset += 1;
		} else if (matchesKey(data, Key.down) || data === "j" || data === "J") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset += 10;
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		} else if (matchesKey(data, Key.home)) {
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
		} else if (matchesKey(data, Key.end)) {
			this.scrollOffset = 0;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const panelWidth = Math.max(60, Math.min(width, 120));
		const innerW = panelWidth - 2;
		const bodyW = Math.max(20, innerW - 2);
		const bodyHeight = 28;
		const th = this.theme;
		const lines: string[] = [];
		const row = (content = "") =>
			`${th.fg("border", "│")}${truncateToWidth(normalizeTuiText(content), innerW, "…", true)}${th.fg("border", "│")}`;

		if (this.cachedWidth !== bodyW) {
			this.cachedWidth = bodyW;
			this.cachedLines = new Markdown(this.markdown, 0, 0, markdownThemeForPiTheme(th))
				.render(bodyW)
				.flatMap((line) => wrapTextWithAnsi(line, bodyW));
		}

		const maxScroll = Math.max(0, this.cachedLines.length - bodyHeight);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const end = Math.max(bodyHeight, this.cachedLines.length - this.scrollOffset);
		const start = Math.max(0, end - bodyHeight);
		const visible = this.cachedLines.slice(start, end);

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", themeBold(th, this.title))}`));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		for (const line of visible) lines.push(row(` ${line}`));
		for (let i = visible.length; i < Math.min(bodyHeight, 6); i++)
			lines.push(row(""));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		const scroll = this.cachedLines.length > bodyHeight
			? ` ${start + 1}-${end}/${this.cachedLines.length}`
			: "";
		lines.push(row(` ${th.fg("dim", `↑↓/j/k scroll · PgUp/PgDn · F8/q/Esc close${scroll}`)}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}
}

async function selectHybridItem(
	ctx: any,
	title: string,
	items: SelectItem[],
): Promise<string | null> {
	if (!items.length) return null;
	return await ctx.ui.custom((tui: TUI, theme: any, _kb: unknown, done: (result: string | null) => void) => {
		let filter = "";
		let selectList = makeSelectList();

		function filteredItems(): SelectItem[] {
			if (!filter) return items;
			const needle = filter.toLowerCase();
			return items.filter(
				(item) =>
					item.label.toLowerCase().includes(needle) ||
					item.value.toLowerCase().includes(needle) ||
					(item.description ?? "").toLowerCase().includes(needle),
			);
		}

		function makeSelectList(): SelectList {
			const list = new SelectList(filteredItems(), Math.min(items.length, 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			return list;
		}

		function rebuild(): void {
			selectList = makeSelectList();
			tui.requestRender();
		}

		return {
			render(width: number) {
				const lines: string[] = [];
				const add = (text: string) =>
					lines.push(truncateToWidth(text, width, "…", true));
				add(theme.fg("accent", theme.bold(title)));
				add(theme.fg("dim", `Filter: ${filter || "(type to search)"}`));
				lines.push("");
				for (const line of selectList.render(width)) lines.push(line);
				lines.push("");
				add(theme.fg("dim", "type filter · backspace clear · ↑↓ navigate · enter select · esc cancel"));
				return lines;
			},
			invalidate() {
				selectList.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.backspace)) {
					if (filter) {
						filter = filter.slice(0, -1);
						rebuild();
					}
					return;
				}
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					filter += data;
					rebuild();
					return;
				}
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function renderHybridRunResult(
	result: AgentToolResult<HybridRunDetails>,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: any,
): Component {
	const details = result.details;
	const normalizedDetails = normalizeHybridRunDetailsForRender(details);
	if (!normalizedDetails) {
		const text =
			result.content
				?.map((part: any) => part.text)
				.filter(Boolean)
				.join("\n") || "Hybrid run produced no details.";
		return new Text(text, 0, 0);
	}
	return buildHybridRunComponent(normalizedDetails, Boolean(options.expanded), theme);
}

type HybridLiveSnapshot = { version: number; details: HybridRunDetails };

function getHybridLiveStore(): Map<string, HybridLiveSnapshot> {
	const globalStore = globalThis as Record<string, unknown>;
	let store = globalStore[HYBRID_LIVE_STORE_KEY] as
		| Map<string, HybridLiveSnapshot>
		| undefined;
	if (!store) {
		store = new Map<string, HybridLiveSnapshot>();
		globalStore[HYBRID_LIVE_STORE_KEY] = store;
	}
	return store;
}

function getLastHybridLiveId(): string | undefined {
	const globalStore = globalThis as Record<string, unknown>;
	const value = globalStore[HYBRID_LAST_LIVE_ID_KEY];
	return typeof value === "string" ? value : undefined;
}

function setLastHybridLiveId(liveId: string): void {
	const globalStore = globalThis as Record<string, unknown>;
	globalStore[HYBRID_LAST_LIVE_ID_KEY] = liveId;
}

function makeHybridLiveId(): string {
	return `hybrid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getHybridActiveRun(): HybridActiveRun | undefined {
	const globalStore = globalThis as Record<string, unknown>;
	const active = globalStore[HYBRID_ACTIVE_RUN_KEY] as
		| HybridActiveRun
		| undefined;
	if (active?.controller.signal.aborted) {
		delete globalStore[HYBRID_ACTIVE_RUN_KEY];
		return undefined;
	}
	return active;
}

function setHybridActiveRun(run: HybridActiveRun): void {
	const globalStore = globalThis as Record<string, unknown>;
	globalStore[HYBRID_ACTIVE_RUN_KEY] = run;
}

function clearHybridActiveRun(liveId: string): void {
	const globalStore = globalThis as Record<string, unknown>;
	const active = globalStore[HYBRID_ACTIVE_RUN_KEY] as
		| HybridActiveRun
		| undefined;
	if (!active || active.liveId === liveId) delete globalStore[HYBRID_ACTIVE_RUN_KEY];
}

function abortHybridActiveRun(cwd?: string): boolean {
	const active = getHybridActiveRun();
	let cancelled = false;
	if (cwd) {
		const config = loadConfig(cwd);
		cancelled = requestHybridRunCancel(cwd, config) || cancelled;
	}
	if (!active) return cancelled;
	if (cwd && path.resolve(active.cwd) !== path.resolve(cwd)) return cancelled;
	active.controller.abort();
	return true;
}

function startHybridBackgroundRun(options: {
	pi: ExtensionAPI;
	cwd: string;
	ctx?: any;
	args: string;
	configOverrides?: Partial<HarnessConfig>;
	mode?: HybridRunDetails["mode"];
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<HybridRunDetails>) => void;
}): { liveId: string; details: HybridRunDetails; promise: Promise<HybridRunDetails> } {
	const existing = getHybridActiveRun();
	if (existing) {
		throw new Error(
			`Hybrid run already active (${existing.liveId}). Use /hybrid-monitor or /hybrid-cancel.`,
		);
	}

	const config = loadConfig(options.cwd, options.configOverrides ?? {});
	const state = loadState(options.cwd, config);
	const existingLock = readHybridRunLock(options.cwd, config);
	if (existingLock && !isHybridRunLockStale(existingLock)) {
		throw new Error(
			`Hybrid run already active (${existingLock.liveId}). Use /hybrid-monitor or /hybrid-cancel.`,
		);
	}
	if (existingLock && isHybridRunLockStale(existingLock)) {
		clearHybridRunLock(options.cwd, config, existingLock.liveId);
	}
	const explicitTask = options.args.trim();
	const taskPreview = explicitTask || state.task || "resume existing task";
	const mode =
		options.mode ??
		(config.maxFrontierPasses <= 1
			? "fast"
			: config.maxFrontierPasses >= 2
				? "thorough"
				: "default");
	const liveId = makeHybridLiveId();
	const controller = new AbortController();
	const store = getHybridLiveStore();
	let version = 0;
	const details = createHybridRunDetails(taskPreview, mode, config);
	details.currentStage = "background";
	details.recentOutput.push(
		"Hybrid run is running in the background. Use /hybrid-monitor, /hybrid-steer, or /hybrid-cancel.",
	);
	store.set(liveId, { version: ++version, details });
	setLastHybridLiveId(liveId);
	options.pi.sendMessage({
		customType: HYBRID_RUN_MESSAGE_TYPE,
		content: `Hybrid run starting: ${taskPreview}`,
		display: true,
		details: { liveId, fallback: details },
	});
	writeHybridRunLock(options.cwd, config, {
		version: 1,
		liveId,
		pid: process.pid,
		cwd: options.cwd,
		task: taskPreview,
		mode,
		status: "running",
		startedAt: nowIso(),
		updatedAt: nowIso(),
		currentStage: details.currentStage,
	});
	const parentAbort = () => controller.abort();
	options.signal?.addEventListener("abort", parentAbort, { once: true });
	const heartbeat = setInterval(() => {
		const lock = heartbeatHybridRunLock(
			options.cwd,
			config,
			liveId,
			details.currentStage,
		);
		if (lock?.cancelRequestedAt) controller.abort();
	}, 5000);
	heartbeat.unref?.();

	const promise = runHybridOrchestration({
		cwd: options.cwd,
		ctx: options.ctx,
		args: options.args,
		configOverrides: options.configOverrides,
		mode,
		signal: controller.signal,
		onUpdate: (result) => {
			if (result.details) {
				details.currentStage = result.details.currentStage;
				store.set(liveId, { version: ++version, details: result.details });
				heartbeatHybridRunLock(
					options.cwd,
					config,
					liveId,
					result.details.currentStage,
				);
			}
			options.onUpdate?.(result);
			options.ctx?.ui?.requestRender?.();
		},
	})
		.then((finalDetails) => {
			store.set(liveId, { version: ++version, details: finalDetails });
			options.onUpdate?.({
				content: [
					{ type: "text", text: hybridDetailsToMarkdown(finalDetails, true) },
				],
				details: finalDetails,
				isError: finalDetails.status === "failed",
			});
			options.ctx?.ui?.requestRender?.();
			options.ctx?.ui?.notify?.(
				`Hybrid run ${finalDetails.status}: ${finalDetails.frontierVerdict ?? finalDetails.error ?? "see monitor"}`,
				finalDetails.status === "failed" ? "error" : "info",
			);
			return finalDetails;
		})
		.catch((error) => {
			const failed = createHybridRunDetails(taskPreview, mode, config);
			failed.status = "failed";
			failed.finishedAt = nowIso();
			failed.error = String(error instanceof Error ? error.message : error);
			store.set(liveId, { version: ++version, details: failed });
			options.onUpdate?.({
				content: [{ type: "text", text: hybridDetailsToMarkdown(failed, true) }],
				details: failed,
				isError: true,
			});
			options.ctx?.ui?.requestRender?.();
			options.ctx?.ui?.notify?.(`Hybrid run failed: ${failed.error}`, "error");
			return failed;
		})
		.finally(() => {
			options.signal?.removeEventListener("abort", parentAbort);
			clearInterval(heartbeat);
			clearHybridRunLock(options.cwd, config, liveId);
			clearHybridActiveRun(liveId);
		});

	setHybridActiveRun({
		liveId,
		cwd: options.cwd,
		startedAt: nowIso(),
		controller,
		promise,
		heartbeat,
	});
	return { liveId, details, promise };
}

class HybridMonitorOverlayComponent implements Component {
	private scrollOffset = 0;
	private followTail = true;
	private cancelArmed = false;
	private closed = false;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly liveId: string,
		private readonly cwd: string,
		private readonly done: () => void,
	) {
		this.timer = setInterval(() => this.tui.requestRender(), 300);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.done();
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.f8) ||
			matchesKey(data, Key.ctrlAlt("h")) ||
			data === "q" ||
			data === "Q"
		) {
			this.close();
			return;
		}

		if (data === "x" || data === "X" || matchesKey(data, Key.ctrl("c"))) {
			if (!this.cancelArmed) {
				this.cancelArmed = true;
				this.tui.requestRender();
				return;
			}
			abortHybridActiveRun(this.cwd);
			this.close();
			return;
		}

		this.cancelArmed = false;

		if (data === "f" || data === "F" || matchesKey(data, "f")) {
			this.followTail = !this.followTail;
			if (this.followTail) this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}

		const before = this.scrollOffset;
		if (matchesKey(data, Key.up) || data === "k" || data === "K") {
			this.followTail = false;
			this.scrollOffset += 1;
		} else if (matchesKey(data, Key.down) || data === "j" || data === "J") {
			this.followTail = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.followTail = false;
			this.scrollOffset += 10;
		} else if (matchesKey(data, Key.pageDown)) {
			this.followTail = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		} else if (matchesKey(data, Key.home)) {
			this.followTail = false;
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
		} else if (matchesKey(data, Key.end)) {
			this.followTail = true;
			this.scrollOffset = 0;
		}

		if (this.scrollOffset !== before) this.tui.requestRender();
	}

	render(width: number): string[] {
		const snapshot = getHybridLiveStore().get(this.liveId);
		const details = snapshot?.details;
		const panelWidth = Math.max(60, Math.min(width, 120));
		const innerW = panelWidth - 2;
		const th = this.theme;
		const lines: string[] = [];
		const row = (content = "") =>
			`${th.fg("border", "│")}${truncateToWidth(normalizeTuiText(content), innerW, "…", true)}${th.fg("border", "│")}`;
		const separator = () =>
			lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", themeBold(th, "Hybrid Monitor"))} ${th.fg("dim", this.liveId)}`));
		separator();

		if (!details) {
			lines.push(row(" Waiting for hybrid run output..."));
			lines.push(row(""));
			lines.push(row(` ${th.fg("dim", "q/Esc close")}`));
			lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
			return lines;
		}

		const status =
			details.status === "running"
				? th.fg("accent", "running")
				: details.status === "failed"
					? th.fg("error", "failed")
					: th.fg("success", "done");
		const stats = formatProgressStats(th, details);
		lines.push(row(` Status: ${status} ${th.fg("dim", `mode=${details.mode}`)}${stats ? ` ${stats}` : ""}`));
		if (details.currentStage || details.currentChild || details.currentTool) {
			const current = [
				details.currentStage ? `stage=${details.currentStage}` : "",
				details.currentChild ? `child=${details.currentChild}` : "",
				details.currentTool ? `tool=${details.currentTool}` : "",
			].filter(Boolean);
			lines.push(row(` Current: ${th.fg("dim", current.join(" · "))}`));
		}
		if (details.progress) {
			const p = details.progress;
			lines.push(row(` Progress: ${th.fg("dim", `slices ${p.slicesDone}/${p.slicesTotal} · AC ${p.acceptanceSatisfied}/${p.acceptanceTotal} · triggers ${p.activeFrontierTriggers}`)}`));
		}
		if (details.localVerdict || details.frontierVerdict) {
			lines.push(row(` Verdicts: ${th.fg("dim", `local=${details.localVerdict ?? "pending"} · frontier=${details.frontierVerdict ?? "pending"}`)}`));
		}
		for (const line of formatTokenRoutingLines(th, details)) {
			lines.push(row(` ${line}`));
		}
		separator();

		const liveOutput = details.liveOutput ?? [];
		const rawLog = liveOutput.length > 0 ? liveOutput : details.recentOutput;
		const bodyWidth = Math.max(20, innerW - 2);
		const bodyLines = rawLog.flatMap((line) =>
			wrapTextWithAnsi(normalizeTuiText(line), bodyWidth).map((wrapped) => ` ${wrapped}`),
		);
		const bodyHeight = 24;
		const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
		if (this.followTail) {
			this.scrollOffset = 0;
		} else {
			this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		}
		const end = this.followTail
			? bodyLines.length
			: Math.max(bodyHeight, bodyLines.length - this.scrollOffset);
		const start = Math.max(0, end - bodyHeight);
		const visibleBody = bodyLines.slice(start, end);

		if (visibleBody.length === 0) {
			lines.push(row(` ${th.fg("dim", "No child output yet.")}`));
		} else {
			for (const line of visibleBody) lines.push(row(line));
		}

		for (let i = visibleBody.length; i < Math.min(bodyHeight, 6); i++) {
			lines.push(row(""));
		}

		separator();
		const follow = this.followTail ? th.fg("success", "follow:on") : th.fg("warning", "follow:off");
		const scroll = bodyLines.length > bodyHeight
			? th.fg("dim", ` ${start + 1}-${end}/${bodyLines.length}`)
			: "";
		const cancelHint = this.cancelArmed
			? th.fg("warning", " Press x again to cancel active run")
			: th.fg("dim", " · x/Ctrl-C cancel");
		lines.push(row(` ${follow}${scroll} ${th.fg("dim", "↑↓/j/k scroll · PgUp/PgDn · f follow · F8/q/Esc close")}${cancelHint}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}
}

class HybridLiveMessageComponent implements Component {
	private lastVersion = -1;
	private inner: Component = new Text("", 0, 0);

	constructor(
		private readonly liveId: string,
		private readonly fallback: HybridRunDetails | undefined,
		private readonly expanded: boolean,
		private readonly theme: any,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const snapshot = getHybridLiveStore().get(this.liveId);
		const details = normalizeHybridRunDetailsForRender(
			snapshot?.details ?? this.fallback,
		);
		const version = snapshot?.version ?? 0;
		if (!details)
			return [`Hybrid run ${this.liveId}: waiting for first update...`];
		if (version !== this.lastVersion || details.status === "running") {
			this.lastVersion = version;
			this.inner = buildHybridRunComponent(details, this.expanded, this.theme);
		}
		return this.inner.render(width);
	}
}

function parseLocalVerdict(
	text: string,
): "PASS" | "PASS_WITH_CONCERNS" | "FAIL" | "UNKNOWN" {
	const json = extractJsonObject<{ verdict?: string }>(text);
	const jsonVerdict = json?.verdict?.toUpperCase();
	if (jsonVerdict === "PASS_WITH_CONCERNS") return "PASS_WITH_CONCERNS";
	if (jsonVerdict === "PASS") return "PASS";
	if (jsonVerdict === "FAIL") return "FAIL";
	const normalized = text.toUpperCase();
	const match = normalized.match(
		/VERDICT\s*:?\s*(PASS_WITH_CONCERNS|PASS|FAIL)/,
	);
	if (match?.[1] === "PASS_WITH_CONCERNS") return "PASS_WITH_CONCERNS";
	if (match?.[1] === "PASS") return "PASS";
	if (match?.[1] === "FAIL") return "FAIL";
	return "UNKNOWN";
}

function parseFrontierVerdict(
	text: string,
): "APPROVE" | "REQUEST_CHANGES" | "ESCALATE_TO_USER" | "UNKNOWN" {
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

function normalizeBrief(
	value: Partial<OrchestrationBrief> | undefined,
): OrchestrationBrief {
	return {
		planSummary: String(
			value?.planSummary ||
				"Proceed with the frontier design package and structured progress plan.",
		),
		executionStrategy: Array.isArray(value?.executionStrategy)
			? value.executionStrategy.map(String).filter(Boolean)
			: [],
		assumptions: Array.isArray(value?.assumptions)
			? value.assumptions.map(String).filter(Boolean)
			: [],
		ambiguities: Array.isArray(value?.ambiguities)
			? value.ambiguities.map(String).filter(Boolean)
			: [],
		blockingQuestions: Array.isArray(value?.blockingQuestions)
			? value.blockingQuestions.map(String).filter(Boolean)
			: [],
		taskRisk:
			value?.taskRisk === "high" ||
			value?.taskRisk === "medium" ||
			value?.taskRisk === "low"
				? value.taskRisk
				: "medium",
		recommendedAction:
			value?.recommendedAction === "ask_user" ||
			value?.recommendedAction === "stop" ||
			value?.recommendedAction === "proceed"
				? value.recommendedAction
				: "proceed",
	};
}

function briefToMarkdown(brief: OrchestrationBrief): string {
	const section = (title: string, items: string[]) => [
		`## ${title}`,
		"",
		...(items.length ? items.map((item) => `- ${item}`) : ["- none"]),
		"",
	];
	return [
		"# Hybrid Orchestration Brief",
		"",
		`- Risk: ${brief.taskRisk}`,
		`- Recommended action: ${brief.recommendedAction}`,
		"",
		"## Plan summary",
		"",
		brief.planSummary,
		"",
		...section("Execution strategy", brief.executionStrategy),
		...section("Assumptions", brief.assumptions),
		...section("Ambiguities", brief.ambiguities),
		...section("Blocking questions", brief.blockingQuestions),
	].join("\n");
}

async function createOrchestrationBrief(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	task: string,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<OrchestrationBrief> {
	notify?.(
		"Hybrid brief: summarizing plan and checking for ambiguity...",
		"info",
	);
	const steering = hybridSteeringMarkdown(cwd, config);
	if (steering) markHybridSteeringConsumed(cwd, config, "brief");
	const prompt = [
		"You are the LOCAL ORCHESTRATOR for a hybrid coding harness.",
		"Brief the user/parent before implementation. Do not modify files.",
		"Identify whether the plan is clear enough to proceed autonomously or whether user clarification is required.",
		"Only mark recommendedAction=ask_user when ambiguity can materially change implementation, API, data, security, or UX behavior.",
		"Return only JSON with this shape:",
		`{"planSummary":"...","executionStrategy":["..."],"assumptions":["..."],"ambiguities":["..."],"blockingQuestions":["..."],"taskRisk":"low|medium|high","recommendedAction":"proceed|ask_user|stop"}`,
		"",
		`Task: ${task}`,
		...(steering ? ["", steering] : []),
		"Read these artifacts:",
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/repo-map.md`,
		`- ${config.stateDir}/progress.md and ${config.stateDir}/progress.json`,
	].join("\n");
	const result = await runPiOnce({
		cwd,
		model: config.localReviewerModel,
		prompt,
		tools: ["read", "grep", "find", "ls"],
		timeoutMs: 8 * 60_000,
		liveLabel: "brief",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	const brief = normalizeBrief(
		extractJsonObject<Partial<OrchestrationBrief>>(result.text),
	);
	writeArtifact(
		cwd,
		config,
		state,
		"orchestration-brief.md",
		`${briefToMarkdown(brief)}\n\n---\n\n## Brief run\n\n- ok: ${result.ok}\n- exitCode: ${result.exitCode}\n- usage: ${formatUsage(result)}\n\n\`\`\`stderr\n${truncateMiddle(result.stderr, 4000)}\n\`\`\`\n`,
	);
	return brief;
}

async function createProgressFromDesign(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	task: string,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<HarnessProgress> {
	notify?.(
		"Hybrid progress: extracting slices, acceptance criteria, and frontier triggers...",
		"info",
	);
	const steering = hybridSteeringMarkdown(cwd, config);
	if (steering) markHybridSteeringConsumed(cwd, config, "progress-plan");
	const prompt = [
		"You are the LOCAL CONTROL-PLANE PLANNER for a hybrid coding harness.",
		"Convert the frontier design package into strict JSON progress state. Do not modify files.",
		"",
		`Task: ${task}`,
		...(steering ? ["", steering] : []),
		"",
		"Read these artifacts:",
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/repo-map.md`,
		"",
		"Return only JSON with this exact shape:",
		`{\n  "version": 1,\n  "task": "...",\n  "currentSliceId": "S1",\n  "slices": [{"id":"S1","title":"...","status":"pending","evidence":[],"remaining":["..."]}],\n  "acceptanceCriteria": [{"id":"AC1","description":"...","status":"pending","evidence":[]}],\n  "frontierRecheckTriggers": [{"id":"FR1","description":"...","active":false,"evidence":""}],\n  "testObservations": [],\n  "blockers": [],\n  "nextAction": "..."\n}`,
		"",
		"Guidance:",
		"- Slices must be small, sequential, and verifiable.",
		"- Acceptance criteria must be concrete and testable.",
		"- Frontier re-check triggers are conditions where local implementation must not silently continue, e.g. design contradiction, public API change, security/auth change, data migration, or impossible acceptance criteria.",
	].join("\n");
	const result = await runPiOnce({
		cwd,
		model: config.localReviewerModel,
		prompt,
		tools: ["read", "grep", "find", "ls"],
		timeoutMs: 10 * 60_000,
		liveLabel: "progress-plan",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	const progress = normalizeProgress(
		extractJsonObject<Partial<HarnessProgress>>(result.text),
		task,
	);
	writeArtifact(
		cwd,
		config,
		state,
		"implementation-plan.json",
		JSON.stringify(progress, null, "\t"),
	);
	writeProgress(cwd, config, state, progress);
	return progress;
}

async function updateProgressAfterIteration(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	task: string,
	iteration: string,
	workerOutput: string,
	testObservation: HarnessProgress["testObservations"][number] | undefined,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<HarnessProgress> {
	notify?.(`Hybrid progress: assessing iteration ${iteration}...`, "info");
	const current = readProgress(cwd, config, task);
	const interactivePolicy = interactiveRuntimePolicyApplies(cwd, config, task);
	const steering = hybridSteeringMarkdown(cwd, config);
	if (steering) markHybridSteeringConsumed(cwd, config, `progress-${iteration}`);
	const prompt = [
		"You are the LOCAL PROGRESS ASSESSOR for a hybrid coding harness.",
		"Update structured progress after one implementation/test iteration. Do not modify files.",
		"Return only the full updated JSON object with the same schema as the input progress.",
		"",
		`Task: ${task}`,
		`Iteration: ${iteration}`,
		...(steering ? ["", steering] : []),
		"",
		"Current progress JSON:",
		"```json",
		JSON.stringify(current, null, 2),
		"```",
		"",
		"Worker output:",
		"```markdown",
		truncateMiddle(workerOutput, 20_000),
		"```",
		"",
		"Test observation:",
		"```json",
		JSON.stringify(
			testObservation ?? {
				iteration,
				ok: false,
				failureKind: "unknown",
				summary: "No configured deterministic test command was run.",
			},
			null,
			2,
		),
		"```",
		"",
		"Git summary:",
		"```markdown",
		truncateMiddle(gitSummary(cwd, config), 25_000),
		"```",
		"",
		"Assessment rules:",
		"- Mark a slice done only when changed files and verification evidence support it.",
		"- Mark acceptance criteria satisfied only with explicit evidence.",
		interactivePolicy
			? "- STRICT INTERACTIVE POLICY ACTIVE: for browser/UI/gameplay/runtime tasks, do not mark runtime acceptance criteria satisfied from syntax checks, HTTP 200 checks, screenshots without assertions, or worker self-reports. Require a configured passing deterministic test command or objective runtime assertions recorded as test evidence. If missing, keep relevant criteria pending/failed and add a blocker."
			: "- Runtime validation policy: not active for this task.",
		"- If tests fail, choose a precise failureKind and set nextAction to the targeted repair strategy.",
		"- Activate frontierRecheckTriggers when implementation deviates from design, requires new architecture, affects auth/security/data migration/public APIs, or acceptance criteria conflict with repo truth.",
		"- Preserve prior testObservations and append the new one.",
	].join("\n");
	const result = await runPiOnce({
		cwd,
		model: config.localReviewerModel,
		prompt,
		tools: ["read", "grep", "find", "ls", "bash"],
		timeoutMs: 12 * 60_000,
		liveLabel: `progress-${iteration}`,
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	const parsed = normalizeProgress(
		extractJsonObject<Partial<HarnessProgress>>(result.text),
		task,
	);
	if (interactivePolicy && !hasPassingConfiguredTest(parsed)) {
		const blocker =
			"Interactive/runtime task lacks a passing configured deterministic test command; worker self-reports, screenshots, syntax checks, and HTTP 200 checks are insufficient for approval.";
		if (!parsed.blockers.includes(blocker)) parsed.blockers.push(blocker);
		parsed.acceptanceCriteria = parsed.acceptanceCriteria.map((criterion) =>
			criterion.status === "satisfied"
				? { ...criterion, status: "unknown" }
				: criterion,
		);
		parsed.nextAction =
			"Add or configure deterministic runtime validation for the interactive behavior, then rerun the hybrid loop.";
	}
	if (
		testObservation &&
		!parsed.testObservations.some(
			(t) => t.iteration === testObservation.iteration,
		)
	) {
		parsed.testObservations.push(testObservation);
	}
	writeProgress(cwd, config, state, parsed);
	return parsed;
}

function syncHarnessArtifacts(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
): void {
	for (const name of [
		"task.md",
		"repo-map.md",
		"frontier-design.md",
		"orchestration-brief.md",
		"user-clarifications.md",
		"steering.jsonl",
		"implementation-plan.json",
		"progress.json",
		"progress.md",
		"local-log.md",
		"local-review.md",
		"final-review.md",
		"test-evidence.md",
		"verification-summary.json",
		"verification-summary.md",
		"git-summary.md",
		"usage-summary.md",
		"run-summary.md",
	]) {
		const filePath = artifactPath(cwd, config, name);
		if (fs.existsSync(filePath)) state.artifacts[name] = path.relative(cwd, filePath);
	}
}

function reconcileHybridCompletion(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	summary: VerificationSummary,
	task: string,
): HarnessProgress {
	writeArtifact(cwd, config, state, "git-summary.md", gitSummary(cwd, config));
	let progress = readProgress(cwd, config, task);
	const interactivePolicy = interactiveRuntimePolicyApplies(cwd, config, task);
	const deterministicEvidenceOk =
		summary.allPassed ||
		hasPassingConfiguredTest(progress) ||
		(!interactivePolicy && summary.commands.length === 0);
	progress.testObservations = [
		...progress.testObservations.filter((test) => test.iteration !== "finish"),
		...summary.commands.map((test) => ({
			iteration: "finish",
			command: test.command,
			ok: test.ok,
			failureKind: test.ok ? "none" : test.failureKind,
			summary: test.summary,
		})),
	];
	if (deterministicEvidenceOk) {
		progress.slices = progress.slices.map((slice) =>
			slice.status !== "blocked" &&
			slice.evidence.length > 0 &&
			slice.remaining.length === 0
				? { ...slice, status: "done" }
				: slice,
		);
		progress.acceptanceCriteria = progress.acceptanceCriteria.map(
			(criterion) =>
				criterion.status !== "failed" && criterion.evidence.length > 0
					? { ...criterion, status: "satisfied" }
					: criterion,
		);
	}
	if (!isGitRepository(cwd)) {
		const description =
			"Reviewer rejects manifest-based review due to missing .git directory";
		if (config.allowManifestReviewWhenNoGit) {
			progress.frontierRecheckTriggers = progress.frontierRecheckTriggers.map(
				(trigger) =>
					/missing \.git|manifest-based|diff-based|not a git repository/i.test(
						`${trigger.id} ${trigger.description}`,
					)
						? {
								...trigger,
								active: false,
								evidence:
									"Non-git workspace accepted by allowManifestReviewWhenNoGit=true; git-summary.md contains manifest fallback.",
							}
						: trigger,
			);
		} else if (
			!progress.frontierRecheckTriggers.some((trigger) =>
				/missing \.git|manifest-based|not a git repository/i.test(
					trigger.description,
				),
			)
		) {
			progress.frontierRecheckTriggers.push({
				id: `FR${progress.frontierRecheckTriggers.length + 1}`,
				description,
				active: true,
				evidence:
					"Workspace is not a git repository and allowManifestReviewWhenNoGit=false.",
			});
		}
	}
	const activeTriggers = progress.frontierRecheckTriggers.filter(
		(trigger) => trigger.active,
	);
	const doneSlices = progress.slices.filter((slice) => slice.status === "done");
	const satisfiedCriteria = progress.acceptanceCriteria.filter(
		(criterion) => criterion.status === "satisfied",
	);
	progress.nextAction =
		activeTriggers.length === 0 &&
		doneSlices.length === progress.slices.length &&
		satisfiedCriteria.length === progress.acceptanceCriteria.length
			? "Ready for frontier final review."
			: "Resolve remaining pending slices, acceptance criteria, failed verification, or active frontier triggers.";
	writeProgress(cwd, config, state, progress);
	syncHarnessArtifacts(cwd, config, state);
	state.phase = "implemented";
	state.lastRun = nowIso();
	saveState(cwd, config, state);
	return progress;
}

function finishHybridArtifacts(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	task: string,
	notify?: Notify,
): { summary: VerificationSummary; progress: HarnessProgress } {
	const summary = runVerificationSummary(cwd, config, state, notify);
	const progress = reconcileHybridCompletion(cwd, config, state, summary, task);
	return { summary, progress };
}

async function runHybridStart(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	task: string,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<void> {
	state.task = task;
	state.createdAt ||= nowIso();
	state.localWorkerModel = config.localWorkerModel;
	state.localReviewerModel = config.localReviewerModel;
	state.frontierModel = config.frontierModel;
	state.frontierThinking = config.frontierThinking;
	writeArtifact(cwd, config, state, "task.md", `# Task\n\n${task}\n`);
	saveState(cwd, config, state);

	notify?.("Hybrid start: running local scout...", "info");
	const scoutSteering = hybridSteeringMarkdown(cwd, config);
	if (scoutSteering) markHybridSteeringConsumed(cwd, config, "scout");
	const scoutPrompt = [
		"You are the LOCAL SCOUT in a hybrid coding harness.",
		"Explore the repository with read-only tools and produce a compact, high-signal repo map for a frontier architect.",
		"Do not modify files.",
		"",
		`Task: ${task}`,
		...(scoutSteering ? ["", scoutSteering] : []),
		"",
		"Output markdown with these sections:",
		"1. Task interpretation and unknowns",
		"2. Relevant files and why they matter",
		"3. Existing tests and likely verification commands",
		"4. Current architecture/conventions",
		"5. Risks, edge cases, and places the implementer must not break",
		"6. Suggested implementation slices",
	].join("\n");
	const scout = await runPiOnce({
		cwd,
		model: config.localWorkerModel,
		prompt: scoutPrompt,
		tools: ["read", "grep", "find", "ls", "bash"],
		timeoutMs: 15 * 60_000,
		liveLabel: "scout",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	writeArtifact(
		cwd,
		config,
		state,
		"repo-map.md",
		`# Local Scout Repo Map\n\n${scout.text || "(no output)"}\n\n---\n\n## Scout run\n\n- ok: ${scout.ok}\n- exitCode: ${scout.exitCode}\n- usage: ${formatUsage(scout)}\n\n\`\`\`stderr\n${truncateMiddle(scout.stderr, 4000)}\n\`\`\`\n`,
	);
	state.phase = "scouted";
	saveState(cwd, config, state);

	notify?.("Hybrid start: running frontier architect...", "info");
	const architectSteering = hybridSteeringMarkdown(cwd, config);
	if (architectSteering)
		markHybridSteeringConsumed(cwd, config, "frontier-architect");
	const architectPrompt = [
		"You are the FRONTIER ARCHITECT in a hybrid coding harness.",
		"Your job is to spend frontier reasoning only where it matters: clarify the target design, constraints, risks, and acceptance criteria so a local Qwen worker can implement with minimal drift.",
		"Do not implement. Do not ask to inspect the entire repository unless the scout map is insufficient. Produce a concise implementation package.",
		"",
		`Task: ${task}`,
		...(architectSteering ? ["", architectSteering] : []),
		"",
		"Local scout map:",
		"```markdown",
		truncateMiddle(scout.text, 60_000),
		"```",
		"",
		"Output markdown with exactly these sections:",
		"1. Decision summary",
		"2. Non-goals",
		"3. Implementation plan by small slices",
		"4. File-level guidance",
		"5. Acceptance criteria",
		"6. Verification commands",
		"7. Risks and frontier re-check triggers",
		"8. Local worker prompt notes",
	].join("\n");
	const architect = await runPiOnce({
		cwd,
		model: config.frontierModel,
		thinking: config.frontierThinking,
		prompt: architectPrompt,
		tools: ["read", "grep", "find", "ls"],
		timeoutMs: 20 * 60_000,
		liveLabel: "frontier-architect",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	writeArtifact(
		cwd,
		config,
		state,
		"frontier-design.md",
		`# Frontier Design Package\n\n${architect.text || "(no output)"}\n\n---\n\n## Architect run\n\n- ok: ${architect.ok}\n- exitCode: ${architect.exitCode}\n- usage: ${formatUsage(architect)}\n\n\`\`\`stderr\n${truncateMiddle(architect.stderr, 4000)}\n\`\`\`\n`,
	);
	state.phase = "designed";
	state.lastRun = nowIso();
	saveState(cwd, config, state);
	await createProgressFromDesign(cwd, config, state, task, notify, liveLog);
}

async function runLocalLoop(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	task: string,
	loops: number,
	notify?: Notify,
	label = "",
	liveLog?: LiveLog,
): Promise<boolean> {
	if (!readArtifact(cwd, config, "progress.json")) {
		writeProgress(cwd, config, state, fallbackProgress(task));
	}
	const logParts: string[] = [
		readArtifact(cwd, config, "local-log.md") ||
			`# Local Implementation Log\n\nTask: ${task}\n`,
	];
	const testEvidenceParts: string[] = [
		readArtifact(cwd, config, "test-evidence.md") ||
			`# Test Evidence\n\nTask: ${task}\n`,
	];
	let testPassed = false;
	for (let i = 1; i <= loops; i++) {
		const iterationLabel = label ? `${label}.${i}` : `${i}`;
		notify?.(`Hybrid loop ${iterationLabel}: local worker running...`, "info");
		const result = await runPiOnce({
			cwd,
			model: config.localWorkerModel,
			prompt: localWorkerPrompt(
				task,
				config,
				Number.parseInt(iterationLabel.replace(/\D/g, ""), 10) || i,
				cwd,
			),
			timeoutMs: 30 * 60_000,
			liveLabel: `worker-${iterationLabel}`,
			rawEventPath: artifactPath(cwd, config, "events.jsonl"),
			onLog: liveLog,
		});
		logParts.push(
			`\n## Iteration ${iterationLabel}`,
			"",
			result.text || "(no output)",
			"",
			`- ok: ${result.ok}`,
			`- exitCode: ${result.exitCode}`,
			`- usage: ${formatUsage(result)}`,
			"",
			"```stderr",
			truncateMiddle(result.stderr, 6000),
			"```",
			"",
		);
		let observation: HarnessProgress["testObservations"][number] | undefined;
		if (config.testCommand) {
			notify?.(
				`Hybrid loop ${iterationLabel}: running configured tests...`,
				"info",
			);
			const test = runCommand(cwd, config.testCommand, 10 * 60_000);
			const failureKind = classifyTestFailure(test.output, test.ok, test.code);
			observation = {
				iteration: iterationLabel,
				command: config.testCommand,
				ok: test.ok,
				failureKind,
				summary: test.ok
					? "Configured test command passed."
					: truncateMiddle(test.output.replace(/\s+/g, " ").trim(), 500),
			};
			logParts.push(
				`### Configured test command`,
				"",
				`\`${config.testCommand}\``,
				"",
				`- ok: ${test.ok}`,
				`- code: ${test.code}`,
				`- failureKind: ${failureKind}`,
				"",
				"```",
				truncateMiddle(test.output, 20_000),
				"```",
				"",
			);
			testEvidenceParts.push(
				`\n## ${iterationLabel} — ${config.testCommand}`,
				"",
				`- ok: ${test.ok}`,
				`- code: ${test.code}`,
				`- failureKind: ${failureKind}`,
				"",
				"```",
				truncateMiddle(test.output, 20_000),
				"```",
				"",
			);
			if (test.ok) testPassed = true;
		} else {
			const interactivePolicy = interactiveRuntimePolicyApplies(
				cwd,
				config,
				task,
			);
			observation = {
				iteration: iterationLabel,
				ok: false,
				failureKind: interactivePolicy ? "missing_test" : "unknown",
				summary: interactivePolicy
					? "No configured deterministic test command was run for an interactive/runtime task. Worker-inferred checks and screenshots are advisory only; objective runtime assertions are required before approval."
					: "No configured deterministic test command was run. Worker may have run inferred checks; see local-log.md.",
			};
		}
		writeArtifact(cwd, config, state, "local-log.md", logParts.join("\n"));
		writeArtifact(
			cwd,
			config,
			state,
			"test-evidence.md",
			testEvidenceParts.join("\n"),
		);
		writeArtifact(cwd, config, state, "git-summary.md", gitSummary(cwd, config));
		const progress = await updateProgressAfterIteration(
			cwd,
			config,
			state,
			task,
			iterationLabel,
			result.text,
			observation,
			notify,
			liveLog,
		);
		if (progress.frontierRecheckTriggers.some((trigger) => trigger.active))
			break;
		if (testPassed) break;
	}
	writeArtifact(cwd, config, state, "local-log.md", logParts.join("\n"));
	writeArtifact(
		cwd,
		config,
		state,
		"test-evidence.md",
		testEvidenceParts.join("\n"),
	);
	writeArtifact(cwd, config, state, "git-summary.md", gitSummary(cwd, config));
	state.phase = "implemented";
	state.lastRun = nowIso();
	saveState(cwd, config, state);
	return testPassed;
}

async function runLocalReview(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<{
	verdict: ReturnType<typeof parseLocalVerdict>;
	result: PiRunResult;
}> {
	const task = state.task || "(task missing)";
	writeArtifact(cwd, config, state, "git-summary.md", gitSummary(cwd, config));
	const progress = readProgress(cwd, config, task);
	const interactivePolicy = interactiveRuntimePolicyApplies(cwd, config, task);
	const steering = hybridSteeringMarkdown(cwd, config);
	if (steering) markHybridSteeringConsumed(cwd, config, "local-review");
	const prompt = [
		"You are the LOCAL REVIEWER in a hybrid coding harness.",
		"Review the implementation against the frontier design. You are read-only. Do not modify files.",
		"Be strict about test evidence, regressions, edge cases, and design drift.",
		"",
		`Task: ${task}`,
		...(steering ? ["", steering] : []),
		"",
		"Read these artifacts first:",
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/progress.md and ${config.stateDir}/progress.json`,
		`- ${config.stateDir}/test-evidence.md`,
		`- ${config.stateDir}/verification-summary.json`,
		`- ${config.stateDir}/local-log.md`,
		`- ${config.stateDir}/git-summary.md`,
		"",
		"Output a fenced JSON object first, then optional markdown details. JSON schema:",
		`{"verdict":"PASS|PASS_WITH_CONCERNS|FAIL","blockingIssues":["..."],"nonBlockingConcerns":["..."],"missingEvidence":["..."],"nextAction":"..."}`,
		"Verdict meanings:",
		"- PASS: implementation satisfies the design and evidence is adequate.",
		"- PASS_WITH_CONCERNS: no known blocker, but evidence/risk remains.",
		"- FAIL: local repair is required before final approval.",
		interactivePolicy
			? "Strict interactive/runtime policy is ACTIVE: if there is no passing configured deterministic test command or equivalent objective runtime assertion in test-evidence.md, you MUST return FAIL. Do not accept syntax checks, HTTP 200 checks, screenshots without assertions, or worker self-reported smoke tests as sufficient for browser/UI/game/gameplay behavior."
			: "Strict interactive/runtime policy is not active for this task.",
	].join("\n");
	notify?.("Hybrid local reviewer running...", "info");
	const review = await runPiOnce({
		cwd,
		model: config.localReviewerModel,
		prompt,
		tools: ["read", "grep", "find", "ls", "bash"],
		timeoutMs: 20 * 60_000,
		liveLabel: "local-review",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	const policyOverride =
		interactivePolicy && !deterministicVerificationPassed(cwd, config, progress)
			? "\n\n## Harness policy override\n\nFAIL: interactive/runtime task has no passing configured deterministic test command. Worker self-reports, screenshots, syntax checks, and HTTP 200 checks are insufficient for approval.\n"
			: "";
	writeArtifact(
		cwd,
		config,
		state,
		"local-review.md",
		`# Local Review\n\n${review.text || "(no output)"}${policyOverride}\n\n---\n\n- ok: ${review.ok}\n- exitCode: ${review.exitCode}\n- usage: ${formatUsage(review)}\n\n\`\`\`stderr\n${truncateMiddle(review.stderr, 4000)}\n\`\`\`\n`,
	);
	state.phase = "local-reviewed";
	state.lastRun = nowIso();
	saveState(cwd, config, state);
	let verdict = parseLocalVerdict(review.text);
	if (interactivePolicy && !deterministicVerificationPassed(cwd, config, progress)) {
		verdict = "FAIL";
	}
	return { verdict, result: review };
}

async function runFrontierFinal(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<{
	verdict: ReturnType<typeof parseFrontierVerdict>;
	result: PiRunResult;
}> {
	const task = state.task || "(task missing)";
	const git = gitSummary(cwd, config);
	writeArtifact(cwd, config, state, "git-summary.md", git);
	const progress = readProgress(cwd, config, task);
	const interactivePolicy = interactiveRuntimePolicyApplies(cwd, config, task);
	const steering = hybridSteeringMarkdown(cwd, config);
	if (steering) markHybridSteeringConsumed(cwd, config, "frontier-final");
	const prompt = [
		"You are the FRONTIER FINAL GATE for a hybrid coding harness.",
		"Spend frontier reasoning only on correctness, design drift, hidden risks, and whether this should ship.",
		"Do not make code changes. Review the artifact pack and issue a concise gate verdict.",
		"",
		`Task: ${task}`,
		...(steering ? ["", steering] : []),
		"",
		"## Frontier design package",
		truncateMiddle(readArtifact(cwd, config, "frontier-design.md"), 40_000),
		"",
		"## Structured progress",
		truncateMiddle(readArtifact(cwd, config, "progress.md"), 30_000),
		"",
		"## Test evidence",
		truncateMiddle(readArtifact(cwd, config, "test-evidence.md"), 30_000),
		"",
		"## Structured verification summary",
		truncateMiddle(readArtifact(cwd, config, "verification-summary.json"), 20_000),
		"",
		"## Local implementation log",
		truncateMiddle(readArtifact(cwd, config, "local-log.md"), 30_000),
		"",
		"## Local review",
		truncateMiddle(readArtifact(cwd, config, "local-review.md"), 30_000),
		"",
		"## Orchestration brief and user clarifications",
		truncateMiddle(
			`${readArtifact(cwd, config, "orchestration-brief.md")}\n\n${readArtifact(cwd, config, "user-clarifications.md")}`,
			20_000,
		),
		"",
		"## Git diff pack",
		truncateMiddle(git, 80_000),
		"",
		"Output a fenced JSON object first, then optional markdown details. JSON schema:",
		`{"verdict":"APPROVE|REQUEST_CHANGES|ESCALATE_TO_USER","blockingIssues":["..."],"requiredFixes":["..."],"testEvidenceAssessment":"...","residualRisks":["..."],"anotherFrontierPassNecessary":false}`,
		"Verdict meanings:",
		"- APPROVE: changes are acceptable to ship/commit.",
		"- REQUEST_CHANGES: local worker should fix concrete issues.",
		"- ESCALATE_TO_USER: requirement/design ambiguity or risk requires user decision.",
		"Final-gate evidence rules:",
		"- For EACH acceptance criterion, map it to concrete evidence from test-evidence.md, local-log.md command output, or git diff. If any acceptance criterion lacks evidence, REQUEST_CHANGES.",
		interactivePolicy
			? "- STRICT INTERACTIVE POLICY ACTIVE: this is a browser/UI/gameplay/runtime task. APPROVE is forbidden unless there is a passing configured deterministic test command or objective runtime assertions in test-evidence.md. Syntax checks, HTTP 200 checks, screenshots without assertions, and worker self-reported smoke-test summaries are not sufficient."
			: "- Strict interactive/runtime policy is not active for this task.",
	].join("\n");
	notify?.("Hybrid frontier final gate running...", "info");
	const final = await runPiOnce({
		cwd,
		model: config.frontierModel,
		thinking: config.frontierThinking,
		prompt,
		noTools: true,
		timeoutMs: 20 * 60_000,
		liveLabel: "frontier-final",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	const policyOverride =
		interactivePolicy && !deterministicVerificationPassed(cwd, config, progress)
			? "\n\n## Harness policy override\n\nREQUEST_CHANGES: interactive/runtime task has no passing configured deterministic test command. Worker self-reports, screenshots, syntax checks, and HTTP 200 checks are insufficient for final approval.\n"
			: "";
	writeArtifact(
		cwd,
		config,
		state,
		"final-review.md",
		`# Frontier Final Review\n\n${final.text || "(no output)"}${policyOverride}\n\n---\n\n- ok: ${final.ok}\n- exitCode: ${final.exitCode}\n- usage: ${formatUsage(final)}\n\n\`\`\`stderr\n${truncateMiddle(final.stderr, 4000)}\n\`\`\`\n`,
	);
	state.phase = "frontier-reviewed";
	state.lastRun = nowIso();
	saveState(cwd, config, state);
	let verdict = parseFrontierVerdict(final.text);
	if (interactivePolicy && !deterministicVerificationPassed(cwd, config, progress)) {
		verdict = "REQUEST_CHANGES";
	}
	return { verdict, result: final };
}

async function runHybridOrchestration(options: {
	cwd: string;
	ctx?: any;
	args: string;
	configOverrides?: Partial<HarnessConfig>;
	mode?: HybridRunDetails["mode"];
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<HybridRunDetails>) => void;
}): Promise<HybridRunDetails> {
	const config = loadConfig(options.cwd, options.configOverrides ?? {});
	ensureStateDir(options.cwd, config);
	const eventsLogPath = artifactPath(options.cwd, config, "events.jsonl");
	try {
		fs.writeFileSync(eventsLogPath, "", "utf8");
	} catch {
		// ignore logging failures
	}

	let state = loadState(options.cwd, config);
	const explicitTask = options.args.trim();
	const task = requireTask(explicitTask, state);
	if (explicitTask && explicitTask !== state.task) {
		cleanRunArtifacts(options.cwd, config);
		state = {
			version: 1,
			phase: "idle",
			updatedAt: nowIso(),
			task,
			createdAt: nowIso(),
			localWorkerModel: config.localWorkerModel,
			localReviewerModel: config.localReviewerModel,
			frontierModel: config.frontierModel,
			frontierThinking: config.frontierThinking,
			artifacts: {},
		};
		saveState(options.cwd, config, state);
	}
	const mode =
		options.mode ??
		(config.maxFrontierPasses <= 1
			? "fast"
			: config.maxFrontierPasses >= 2
				? "thorough"
				: "default");
	const runState = loadHybridRunState(options.cwd, config, task, mode);
	if (explicitTask) {
		runState.startedAt = nowIso();
		runState.currentStage = undefined;
		runState.lastCompletedStage = undefined;
		runState.frontierPass = 1;
		runState.repairCycle = 1;
		runState.completedStages = {};
	}
	runState.status = "running";
	runState.lastError = undefined;
	saveHybridRunState(options.cwd, config, state, runState);
	const details = createHybridRunDetails(task, mode, config);
	const reporter = createHybridReporter(details, options.onUpdate, options.ctx);
	const notify: Notify = (message, type = "info") => {
		options.ctx?.ui?.notify?.(message, type);
		reporter.log(`[notice] ${message}`);
	};
		const baseLiveLog = createLiveLogger(options.cwd, config, state, options.ctx);
	const liveLog: LiveLog = (line) => {
		baseLiveLog(line);
		reporter.log(line);
	};
	(liveLog as any).onEvent = (label: string, event: any) =>
		reporter.childEvent(label, event);
	(liveLog as any).signal = options.signal ?? options.ctx?.signal;
	liveLog(
		`hybrid_run_start task=${JSON.stringify(task)} maxFrontierPasses=${config.maxFrontierPasses}`,
	);

	const summary: string[] = [
		"# Hybrid Run Summary",
		"",
		`- Started: ${details.startedAt}`,
		`- Task: ${task}`,
		`- Local worker: ${config.localWorkerModel}`,
		`- Local reviewer: ${config.localReviewerModel}`,
		`- Frontier: ${config.frontierModel} (${config.frontierThinking})`,
		`- maxLocalLoops: ${config.maxLocalLoops}`,
		`- maxReviewRepairCycles: ${config.maxReviewRepairCycles}`,
		`- maxFrontierPasses: ${config.maxFrontierPasses}`,
		"",
	];

	try {
		reporter.stage(
			"checkpoint",
			"running",
			"Creating git checkpoint before edits",
		);
		markHybridRunStage(
			options.cwd,
			config,
			state,
			runState,
			"checkpoint",
			"running",
		);
		const preRunCheckpoint = createGitCheckpoint(
			options.cwd,
			config,
			`pre-run-${task.slice(0, 40)}`,
		);
		summary.push(
			`- Pre-run checkpoint: ${preRunCheckpoint ?? "not a git repository or unavailable"}`,
			"",
		);
		reporter.stage(
			"checkpoint",
			"done",
			preRunCheckpoint ?? "Skipped: not a git repository or unavailable",
		);
		markHybridRunStage(
			options.cwd,
			config,
			state,
			runState,
			"checkpoint",
			"done",
		);

		if (
			!explicitTask &&
			shouldSkipHybridStage(options.cwd, config, runState, "design")
		) {
			summary.push(
				"## Stage 1 — Resume",
				"",
				"- Reusing existing frontier-design.md. Pass a new task to /hybrid-run to restart.",
				"",
			);
			reporter.stage(
				"design",
				"skipped",
				"Reusing existing frontier-design.md",
			);
			markHybridRunStage(
				options.cwd,
				config,
				state,
				runState,
				"design",
				"skipped",
			);
			reporter.setProgress(readProgress(options.cwd, config, task));
		} else {
			summary.push("## Stage 1 — Scout + frontier design", "");
			reporter.stage(
				"design",
				"running",
				"Local scout, frontier architecture package, progress plan",
			);
			markHybridRunStage(
				options.cwd,
				config,
				state,
				runState,
				"design",
				"running",
			);
			await runHybridStart(options.cwd, config, state, task, notify, liveLog);
			summary.push("- Completed scout/design stage.", "");
			reporter.stage(
				"design",
				"done",
				"frontier-design.md and progress.json written",
			);
			markHybridRunStage(
				options.cwd,
				config,
				state,
				runState,
				"design",
				"done",
			);
			reporter.setProgress(readProgress(options.cwd, config, task));
		}

		if (config.briefBeforeImplementation) {
			if (shouldSkipHybridStage(options.cwd, config, runState, "brief")) {
				summary.push(
					"## Orchestration brief",
					"",
					"- Reusing existing orchestration-brief.md.",
					"",
				);
				reporter.stage("brief", "skipped", "Reusing orchestration-brief.md");
				markHybridRunStage(
					options.cwd,
					config,
					state,
					runState,
					"brief",
					"skipped",
				);
			} else {
				reporter.stage(
					"brief",
					"running",
					"Summarizing plan and checking ambiguity",
				);
				markHybridRunStage(
					options.cwd,
					config,
					state,
					runState,
					"brief",
					"running",
				);
				const brief = await createOrchestrationBrief(
					options.cwd,
					config,
					state,
					task,
					notify,
					liveLog,
				);
				summary.push(
					"## Orchestration brief",
					"",
					`- Risk: ${brief.taskRisk}`,
					`- Recommended action: ${brief.recommendedAction}`,
					`- Blocking questions: ${brief.blockingQuestions.length}`,
					"",
				);
				reporter.stage(
					"brief",
					brief.recommendedAction === "stop" ? "failed" : "done",
					`${brief.taskRisk} risk; ${brief.blockingQuestions.length} blocking question(s)`,
				);
				markHybridRunStage(
					options.cwd,
					config,
					state,
					runState,
					"brief",
					brief.recommendedAction === "stop" ? "failed" : "done",
					undefined,
					undefined,
					brief.recommendedAction === "stop"
						? "Orchestration brief recommended stop."
						: undefined,
				);
				if (
					(brief.recommendedAction === "ask_user" ||
						brief.recommendedAction === "stop") &&
					brief.blockingQuestions.length > 0 &&
					config.askUserOnAmbiguity &&
					options.ctx?.hasUI
				) {
					const prefill = [
						`# Hybrid clarification request`,
						"",
						"The harness found ambiguity that may materially change implementation.",
						"",
						...brief.blockingQuestions.map((q, i) => `${i + 1}. ${q}`),
						"",
						"## Your answers",
						"",
						"",
					].join("\n");
					const answers = await options.ctx.ui.editor?.(
						"Hybrid clarification",
						prefill,
					);
					if (typeof answers === "string" && answers.trim()) {
						writeArtifact(
							options.cwd,
							config,
							state,
							"user-clarifications.md",
							answers,
						);
						summary.push(
							"- User clarifications captured in user-clarifications.md",
							"",
						);
					} else {
						const proceed = await options.ctx.ui.confirm?.(
							"Proceed without clarification?",
							brief.blockingQuestions.join("\n"),
						);
						if (!proceed)
							throw new Error(
								"Hybrid run stopped for user clarification. See .pi-harness/orchestration-brief.md",
							);
						summary.push(
							"- User chose to proceed without additional clarification.",
							"",
						);
					}
				} else if (brief.recommendedAction === "stop") {
					throw new Error(
						"Hybrid orchestration brief recommended stop. See .pi-harness/orchestration-brief.md",
					);
				}
			}
		} else {
			reporter.stage("brief", "skipped", "briefBeforeImplementation=false");
			markHybridRunStage(
				options.cwd,
				config,
				state,
				runState,
				"brief",
				"skipped",
			);
		}

		let finalVerdict: ReturnType<typeof parseFrontierVerdict> = "UNKNOWN";
		let localVerdict: ReturnType<typeof parseLocalVerdict> = "UNKNOWN";

		for (
			let frontierPass = 1;
			frontierPass <= config.maxFrontierPasses;
			frontierPass++
		) {
			summary.push(
				`## Frontier pass ${frontierPass}/${config.maxFrontierPasses}`,
				"",
			);

			for (
				let repairCycle = 1;
				repairCycle <= config.maxReviewRepairCycles;
				repairCycle++
			) {
				summary.push(
					`### Local implementation/repair cycle ${repairCycle}/${config.maxReviewRepairCycles}`,
					"",
				);
				let testPassed = false;
				if (
					shouldSkipHybridStage(
						options.cwd,
						config,
						runState,
						"local-loop",
						frontierPass,
						repairCycle,
					)
				) {
					const loopProgress = readProgress(options.cwd, config, task);
					testPassed = hasPassingConfiguredTest(loopProgress);
					reporter.stage(
						"local-loop",
						"skipped",
						`frontier pass ${frontierPass}, repair cycle ${repairCycle}`,
					);
					markHybridRunStage(
						options.cwd,
						config,
						state,
						runState,
						"local-loop",
						"skipped",
						frontierPass,
						repairCycle,
					);
				} else {
					reporter.stage(
						"local-loop",
						"running",
						`frontier pass ${frontierPass}, repair cycle ${repairCycle}`,
					);
					markHybridRunStage(
						options.cwd,
						config,
						state,
						runState,
						"local-loop",
						"running",
						frontierPass,
						repairCycle,
					);
					testPassed = await runLocalLoop(
						options.cwd,
						config,
						state,
						task,
						config.maxLocalLoops,
						notify,
						`F${frontierPass}R${repairCycle}`,
						liveLog,
					);
					reporter.stage(
						"local-loop",
						"done",
						`tests=${testPassed ? "passed" : config.testCommand ? "not passed" : "not configured"}`,
					);
					markHybridRunStage(
						options.cwd,
						config,
						state,
						runState,
						"local-loop",
						"done",
						frontierPass,
						repairCycle,
					);
				}
				summary.push(
					`- Local loop complete. Configured tests passed: ${testPassed ? "yes" : config.testCommand ? "no" : "not configured"}`,
				);
				let finish: { summary: VerificationSummary; progress: HarnessProgress };
				if (
					shouldSkipHybridStage(
						options.cwd,
						config,
						runState,
						"finish",
						frontierPass,
						repairCycle,
					)
				) {
					const existingSummary =
						readJsonFile<VerificationSummary>(
							artifactPath(options.cwd, config, "verification-summary.json"),
						) ?? {
							version: 1,
							updatedAt: nowIso(),
							commands: [],
							allPassed: false,
						};
					finish = {
						summary: existingSummary,
						progress: readProgress(options.cwd, config, task),
					};
					reporter.stage(
						"finish",
						"skipped",
						"Reusing deterministic verification artifacts",
					);
					markHybridRunStage(
						options.cwd,
						config,
						state,
						runState,
						"finish",
						"skipped",
						frontierPass,
						repairCycle,
					);
				} else {
					reporter.stage(
						"finish",
						"running",
						"Running deterministic verification and reconciling artifacts",
					);
					markHybridRunStage(
						options.cwd,
						config,
						state,
						runState,
						"finish",
						"running",
						frontierPass,
						repairCycle,
					);
					finish = finishHybridArtifacts(
						options.cwd,
						config,
						state,
						task,
						notify,
					);
					reporter.stage(
						"finish",
						finish.summary.commands.length === 0 || finish.summary.allPassed
							? "done"
							: "failed",
						`verification=${finish.summary.allPassed ? "passed" : finish.summary.commands.length ? "failed" : "not configured"}`,
					);
					markHybridRunStage(
						options.cwd,
						config,
						state,
						runState,
						"finish",
						"done",
						frontierPass,
						repairCycle,
					);
				}
				summary.push(
					`- Deterministic verification: ${finish.summary.commands.length ? finish.summary.commands.map((command) => `${command.command}=${command.ok ? "pass" : "fail"}`).join(", ") : "no commands inferred"}`,
				);
				reporter.setProgress(finish.progress);

				if (
					shouldSkipHybridStage(
						options.cwd,
						config,
						runState,
						"local-review",
						frontierPass,
						repairCycle,
					)
				) {
					localVerdict = parseLocalVerdict(readArtifact(options.cwd, config, "local-review.md"));
					reporter.stage(
						"local-review",
						"skipped",
						`verdict=${localVerdict}`,
					);
					markHybridRunStage(
						options.cwd,
						config,
						state,
						runState,
						"local-review",
						"skipped",
						frontierPass,
						repairCycle,
					);
				} else {
					reporter.stage(
						"local-review",
						"running",
						`frontier pass ${frontierPass}, repair cycle ${repairCycle}`,
					);
					markHybridRunStage(
						options.cwd,
						config,
						state,
						runState,
						"local-review",
						"running",
						frontierPass,
						repairCycle,
					);
					const review = await runLocalReview(
						options.cwd,
						config,
						state,
						notify,
						liveLog,
					);
					localVerdict = review.verdict;
					reporter.stage(
						"local-review",
						localVerdict === "FAIL" ? "failed" : "done",
						`verdict=${localVerdict}`,
					);
					markHybridRunStage(
						options.cwd,
						config,
						state,
						runState,
						"local-review",
						"done",
						frontierPass,
						repairCycle,
					);
				}
				details.localVerdict = localVerdict;
				const progress = readProgress(options.cwd, config, task);
				reporter.setProgress(progress);
				const activeTriggers = progress.frontierRecheckTriggers.filter(
					(trigger) => trigger.active,
				);
				const doneSlices = progress.slices.filter(
					(slice) => slice.status === "done",
				).length;
				const satisfiedCriteria = progress.acceptanceCriteria.filter(
					(criterion) => criterion.status === "satisfied",
				).length;
				summary.push(`- Local review verdict: ${localVerdict}`);
				summary.push(
					`- Slice progress: ${doneSlices}/${progress.slices.length} done; current=${progress.currentSliceId ?? "none"}`,
				);
				summary.push(
					`- Acceptance criteria: ${satisfiedCriteria}/${progress.acceptanceCriteria.length} satisfied`,
				);
				if (activeTriggers.length > 0) {
					summary.push(
						`- Frontier re-check triggers active: ${activeTriggers.map((t) => `${t.id} ${t.description}`).join("; ")}`,
					);
					break;
				}

				if (localVerdict !== "FAIL") break;
				if (repairCycle < config.maxReviewRepairCycles) {
					summary.push(
						"- Local review failed; running another local repair cycle before spending frontier tokens.",
						"",
					);
				} else {
					summary.push(
						"- Local review still failed after max repair cycles; escalating to frontier final gate for adjudication.",
						"",
					);
				}
			}

			if (
				shouldSkipHybridStage(
					options.cwd,
					config,
					runState,
					"frontier-final",
					frontierPass,
				)
			) {
				finalVerdict = parseFrontierVerdict(readArtifact(options.cwd, config, "final-review.md"));
				reporter.stage(
					"frontier-final",
					"skipped",
					`verdict=${finalVerdict}`,
				);
				markHybridRunStage(
					options.cwd,
					config,
					state,
					runState,
					"frontier-final",
					"skipped",
					frontierPass,
				);
			} else {
				reporter.stage(
					"frontier-final",
					"running",
					`frontier pass ${frontierPass}/${config.maxFrontierPasses}`,
				);
				markHybridRunStage(
					options.cwd,
					config,
					state,
					runState,
					"frontier-final",
					"running",
					frontierPass,
				);
				const final = await runFrontierFinal(
					options.cwd,
					config,
					state,
					notify,
					liveLog,
				);
				finalVerdict = final.verdict;
				reporter.stage(
					"frontier-final",
					finalVerdict === "REQUEST_CHANGES" ? "failed" : "done",
					`verdict=${finalVerdict}`,
				);
				markHybridRunStage(
					options.cwd,
					config,
					state,
					runState,
					"frontier-final",
					"done",
					frontierPass,
				);
			}
			details.frontierVerdict = finalVerdict;
			summary.push(`- Frontier final verdict: ${finalVerdict}`, "");

			if (finalVerdict === "APPROVE" || finalVerdict === "ESCALATE_TO_USER")
				break;
			if (
				finalVerdict === "REQUEST_CHANGES" &&
				frontierPass < config.maxFrontierPasses
			) {
				summary.push(
					"- Frontier requested changes; feeding final-review.md back into the local worker for another pass.",
					"",
				);
			}
		}

		summary.push(
			"## Result",
			"",
			`- Local verdict: ${localVerdict}`,
			`- Frontier verdict: ${finalVerdict}`,
			`- Finished: ${nowIso()}`,
			"",
		);
		details.localVerdict = localVerdict;
		details.frontierVerdict = finalVerdict;
		details.status = "done";
		details.finishedAt = nowIso();
		details.usageSummary = usageSummaryMarkdown(options.cwd, config);
		reporter.stage(
			"summary",
			"running",
			"Writing run-summary.md and usage-summary.md",
		);
		markHybridRunStage(
			options.cwd,
			config,
			state,
			runState,
			"summary",
			"running",
		);
		writeArtifact(
			options.cwd,
			config,
			state,
			"usage-summary.md",
			details.usageSummary,
		);
		writeArtifact(
			options.cwd,
			config,
			state,
			"run-summary.md",
			summary.join("\n"),
		);
		details.artifacts = { ...state.artifacts };
		saveState(options.cwd, config, state);
		reporter.stage("summary", "done", "Artifacts written");
		markHybridRunStage(
			options.cwd,
			config,
			state,
			runState,
			"summary",
			"done",
		);
		reporter.emit(`Hybrid run complete: ${finalVerdict}`);
		setStatusWidget(options.ctx, statusMarkdown(options.cwd, config, state));
		const notifyType =
			finalVerdict === "APPROVE"
				? "info"
				: finalVerdict === "ESCALATE_TO_USER"
					? "error"
					: "warning";
		options.ctx?.ui?.notify?.(
			`Hybrid run complete: ${finalVerdict}`,
			notifyType,
		);
		return details;
	} catch (error) {
		details.status = "failed";
		details.finishedAt = nowIso();
		details.error = String(
			error instanceof Error ? error.stack || error.message : error,
		);
		details.artifacts = { ...state.artifacts };
		const current = details.currentStage
			? details.stages.find((stage) => stage.id === details.currentStage)
			: undefined;
		if (current?.status === "running") current.status = "failed";
		summary.push("## Error", "", details.error);
		writeArtifact(
			options.cwd,
			config,
			state,
			"run-summary.md",
			summary.join("\n"),
		);
		markHybridRunFailure(options.cwd, config, state, runState, error);
		saveState(options.cwd, config, state);
		reporter.emit(
			`Hybrid run failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		options.ctx?.ui?.notify?.(
			`Hybrid run failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return details;
	}
}

export default async function hybridHarness(pi: ExtensionAPI) {
	const startupConfig = loadConfig(process.cwd());

	try {
		const models = await fetchLocalModels(startupConfig);
		pi.registerProvider(startupConfig.localProvider, {
			name: "Local Qwen (llama.cpp)",
			baseUrl: startupConfig.localBaseUrl,
			api: "openai-completions",
			apiKey: startupConfig.localApiKey,
			models: models.map((model) => ({
				id: model.id,
				name: model.name ?? model.id,
				reasoning: false,
				input: ["text"],
				contextWindow: inferContextWindow(model),
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: LOCAL_OPENAI_COMPAT,
			})),
		});
	} catch {
		pi.registerProvider(startupConfig.localProvider, {
			name: "Local Qwen (llama.cpp)",
			baseUrl: startupConfig.localBaseUrl,
			api: "openai-completions",
			apiKey: startupConfig.localApiKey,
			models: [
				{
					id: "qwen36-27b-mtp-iq4xs",
					name: "Qwen3.6-27B MTP IQ4_XS",
					reasoning: false,
					input: ["text"],
					contextWindow: 131_000,
					maxTokens: 16_384,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					compat: LOCAL_OPENAI_COMPAT,
				},
				{
					id: "qwen36-35b-a3b-iq4xs",
					name: "Qwen3.6-35B-A3B MTP UD-IQ4_XS",
					reasoning: false,
					input: ["text"],
					contextWindow: 200_000,
					maxTokens: 16_384,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					compat: LOCAL_OPENAI_COMPAT,
				},
			],
		});
	}

	pi.registerMessageRenderer<
		HybridRunDetails | { liveId: string; fallback?: HybridRunDetails }
	>(
		HYBRID_RUN_MESSAGE_TYPE,
		(message: any, options: { expanded?: boolean }, theme: any) => {
			const details = message.details as
				| HybridRunDetails
				| { liveId?: string; fallback?: HybridRunDetails }
				| undefined;
			if (!details) return undefined;
			if ("liveId" in details && details.liveId) {
				return new HybridLiveMessageComponent(
					details.liveId,
					details.fallback,
					Boolean(options.expanded),
					theme,
				);
			}
			return renderHybridRunResult(
				{
					content: [{ type: "text", text: String(message.content ?? "") }],
					details: details as HybridRunDetails,
				},
				options,
				theme,
			);
		},
	);

	pi.registerMessageRenderer<{ title?: string; markdown?: string }>(
		HYBRID_REPORT_MESSAGE_TYPE,
		(message: any, options: { expanded?: boolean }, theme: any) => {
			const details = message.details as
				| { title?: string; markdown?: string }
				| undefined;
			const title = details?.title || "Hybrid report";
			const markdown = details?.markdown || String(message.content ?? "");
			const allLines = markdown.split("\n");
			const body = options.expanded
				? markdown
				: allLines.slice(0, 24).join("\n");
			const suffix =
				!options.expanded && allLines.length > 24
					? `\n\n${keyHint("app.tools.expand", "full report")}`
					: "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold(title))}\n${body}${suffix}`,
				0,
				0,
			);
		},
	);

		const showReport = async (title: string, markdown: string, ctx?: any) => {
			if (ctx?.hasUI && ctx?.ui?.custom) {
			await ctx.ui.custom(
				(tui: TUI, theme: any, _keybindings: unknown, done: () => void) =>
					new HybridReportOverlayComponent(tui, title, markdown, theme, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "90%",
						minWidth: 70,
						maxHeight: "80%",
					},
				},
			);
			return;
		}
		pi.sendMessage({
			customType: HYBRID_REPORT_MESSAGE_TYPE,
			content: title,
			display: true,
			details: { title, markdown },
		});
	};

	let activeHybridMonitorClose: (() => void) | undefined;
	async function openHybridMonitor(ctx: any, liveId?: string): Promise<void> {
		if (activeHybridMonitorClose) {
			activeHybridMonitorClose();
			return;
		}

		const targetLiveId = liveId ?? getLastHybridLiveId();
		if (!targetLiveId) {
			ctx?.ui?.notify?.("No hybrid run to monitor yet.", "warning");
			return;
		}

		if (!ctx?.hasUI || !ctx?.ui?.custom) {
			const snapshot = getHybridLiveStore().get(targetLiveId);
			pi.sendMessage({
				customType: HYBRID_RUN_MESSAGE_TYPE,
				content: "Hybrid monitor",
				display: true,
				details: snapshot?.details ?? { liveId: targetLiveId },
			});
			ctx?.ui?.notify?.("Hybrid monitor is only available in interactive Pi.", "warning");
			return;
		}

		try {
			await ctx.ui.custom(
				(tui: TUI, theme: any, _keybindings: unknown, done: () => void) => {
					const component = new HybridMonitorOverlayComponent(
						tui,
						theme,
						targetLiveId,
						ctx.cwd,
						done,
					);
					activeHybridMonitorClose = () => component.close();
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "90%",
						minWidth: 70,
						maxHeight: "80%",
					},
				},
			);
		} finally {
			activeHybridMonitorClose = undefined;
		}
	}

	pi.on("tool_call", async (event: any, ctx: any) => {
		const config = loadConfig(ctx.cwd);
		if (!config.enableSafetyGuards) return;

		if (
			(event.toolName === "write" || event.toolName === "edit") &&
			event.input
		) {
			const candidate = event.input.path || event.input.file_path;
			if (typeof candidate === "string") {
				const matched = isProtectedPath(ctx.cwd, config, candidate);
				if (matched) {
					return {
						block: true,
						reason: `Hybrid safety guard blocked ${event.toolName} to protected path ${candidate} (matched ${matched}).`,
					};
				}
			}
		}

		if (
			event.toolName === "bash" &&
			event.input?.command &&
			!config.allowDestructiveBash
		) {
			const reason = isDestructiveCommand(String(event.input.command));
			if (reason) {
				return {
					block: true,
					reason: `Hybrid safety guard blocked destructive bash command (${reason}). Set allowDestructiveBash=true in .pi-harness/config.json only if intentional.`,
				};
			}
		}
	});

	pi.registerTool({
		name: "hybrid_run",
		label: "Hybrid Run",
		description:
			"Run the hybrid harness: local Qwen scout/worker/reviewer loops, minimal frontier architecture/final gates, artifact-backed progress, and live compact/expanded output.",
		promptSnippet:
			"Run artifact-backed hybrid coding orchestration with local Qwen loops and frontier gates",
		promptGuidelines: [
			"Use hybrid_run when the user explicitly asks to run the hybrid harness or wants token-saving local implementation with frontier gates.",
			"Do not use hybrid_run for tiny direct edits unless the user asks for the harness workflow.",
		],
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "Implementation/review goal for the hybrid harness",
				},
				mode: {
					type: "string",
					enum: ["fast", "default", "thorough"],
					description: "fast=1 frontier pass, thorough=2 frontier passes",
				},
				maxFrontierPasses: {
					type: "number",
					description: "Override frontier final-gate pass count",
				},
				resume: {
					type: "boolean",
					description: "Reuse existing design/progress artifacts when possible",
				},
				background: {
					type: "boolean",
					description:
						"Start in the background and return immediately; set false to wait for final details",
				},
			},
			required: [],
			additionalProperties: false,
		} as any,
			async execute(
				_toolCallId: string,
				params: HybridRunParams & { task?: string; background?: boolean },
				signal: AbortSignal,
				onUpdate:
					| ((result: AgentToolResult<HybridRunDetails>) => void)
					| undefined,
				ctx: any,
			) {
				const liveId = makeHybridLiveId();
				setLastHybridLiveId(liveId);
				const store = getHybridLiveStore();
				let version = 0;
				const overrides: Partial<HarnessConfig> = {};
				const mode =
					params.mode ??
				(params.maxFrontierPasses === 1
					? "fast"
					: params.maxFrontierPasses && params.maxFrontierPasses >= 2
						? "thorough"
						: "default");
			if (mode === "fast") overrides.maxFrontierPasses = 1;
			if (mode === "thorough") overrides.maxFrontierPasses = 2;
			if (params.maxFrontierPasses !== undefined)
				overrides.maxFrontierPasses = Math.max(
					1,
					Math.floor(params.maxFrontierPasses),
				);
			let details: HybridRunDetails;
			let responseText = "";
			if (params.background !== false) {
				const started = startHybridBackgroundRun({
					pi,
					cwd: ctx.cwd,
					ctx,
					args: params.resume === true ? "" : (params.task ?? ""),
					configOverrides: overrides,
					mode,
					signal,
					onUpdate,
				});
				details = started.details;
				responseText =
					"Hybrid run started in background. Use /hybrid-monitor, /hybrid-steer, or /hybrid-cancel.";
			} else {
				details = await runHybridOrchestration({
					cwd: ctx.cwd,
					ctx,
					args: params.resume === true ? "" : (params.task ?? ""),
					configOverrides: overrides,
						mode,
						signal,
						onUpdate: (result) => {
							if (result.details)
								store.set(liveId, { version: ++version, details: result.details });
							onUpdate?.(result);
							ctx.ui.requestRender?.();
						},
					});
				store.set(liveId, { version: ++version, details });
				ctx.ui.requestRender?.();
				responseText = hybridDetailsToMarkdown(details, true);
			}
			return {
				content: [
					{ type: "text", text: responseText },
				],
				details,
				isError: details.status === "failed",
			};
		},
			renderCall(args: unknown, theme: any) {
				const params = args as Partial<HybridRunParams>;
				const w = getTermWidth() - 4;
				const mode = params.mode
					? ` ${theme.fg("dim", `[${params.mode}]`)}`
					: "";
				const taskPreview = truncateMiddle(
					params.task ?? "",
					Math.max(20, w - 30),
				);
				return new Text(
					`${theme.fg("toolTitle", theme.bold("hybrid_run"))}${mode} ${theme.fg("accent", taskPreview)}`,
					0,
				0,
			);
		},
		renderResult(
			result: AgentToolResult<HybridRunDetails>,
			options: { expanded?: boolean; isPartial?: boolean },
			theme: any,
		) {
			return renderHybridRunResult(result, options, theme);
		},
	});

	pi.registerCommand("hybrid-monitor", {
		description: "Toggle the live hybrid child-session output modal",
		handler: async (_args, ctx) => openHybridMonitor(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("h"), {
		description: "Toggle hybrid live output modal",
		handler: async (ctx) => openHybridMonitor(ctx),
	});

	pi.registerShortcut(Key.f8, {
		description: "Toggle hybrid live output modal",
		handler: async (ctx) => openHybridMonitor(ctx),
	});

	pi.registerCommand("hybrid-doctor", {
		description:
			"Check hybrid harness, local Qwen endpoint, git, and Pi subprocess readiness",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			ensureStateDir(ctx.cwd, config);
			const checks: string[] = [];

			checks.push(`cwd: ${ctx.cwd}`);
			checks.push(`stateDir: ${config.stateDir}`);
			checks.push(`localBaseUrl: ${config.localBaseUrl}`);
			checks.push(`localWorkerModel: ${config.localWorkerModel}`);
			checks.push(`localReviewerModel: ${config.localReviewerModel}`);
			checks.push(
				`frontierModel: ${config.frontierModel} (${config.frontierThinking})`,
			);

			const piVersion = spawnSync(
				process.env.PI_BINARY || "pi",
				["--version"],
				{ encoding: "utf8" },
			);
			const piVersionText =
				`${piVersion.stdout ?? ""}${piVersion.stderr ?? ""}`.trim();
			checks.push(
				piVersion.status === 0
					? `pi: OK ${piVersionText}`
					: `pi: FAIL ${piVersionText}`,
			);

			const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
				cwd: ctx.cwd,
				encoding: "utf8",
			});
			checks.push(
				git.status === 0
					? `git: OK ${git.stdout.trim()}`
					: "git: WARN not a git repository",
			);

			try {
				const models = await fetchLocalModels(config);
				checks.push(`local /models: OK ${models.map((m) => m.id).join(", ")}`);
			} catch (error) {
				checks.push(
					`local /models: FAIL ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			const smoke = await runPiOnce({
				cwd: ctx.cwd,
				model: config.localWorkerModel,
				prompt: "Reply with exactly LOCAL-OK.",
				noTools: true,
				timeoutMs: 120_000,
			});
			checks.push(
				smoke.ok && smoke.text.includes("LOCAL-OK")
					? `local Pi smoke: OK ${formatUsage(smoke)}`
					: `local Pi smoke: FAIL exit=${smoke.exitCode} text=${JSON.stringify(smoke.text)} stderr=${truncateMiddle(smoke.stderr, 1000)}`,
			);

			const toolSmoke = await runPiOnce({
				cwd: ctx.cwd,
				model: config.localWorkerModel,
				prompt:
					"Use the ls tool to list the current directory, then reply with exactly TOOL-OK.",
				tools: ["ls"],
				timeoutMs: 90_000,
			});
			checks.push(
				toolSmoke.ok &&
					toolSmoke.usage.toolCalls > 0 &&
					toolSmoke.text.includes("TOOL-OK")
					? `local tool smoke: OK ${formatUsage(toolSmoke)}`
					: `local tool smoke: WARN exit=${toolSmoke.exitCode} tools=${toolSmoke.usage.toolCalls} text=${JSON.stringify(toolSmoke.text)} stderr=${truncateMiddle(toolSmoke.stderr, 1000)}`,
			);

			const report = [
				`# Hybrid Doctor`,
				"",
				...checks.map((c) => `- ${c}`),
			].join("\n");
			const state = loadState(ctx.cwd, config);
			writeArtifact(ctx.cwd, config, state, "doctor.md", report);
			saveState(ctx.cwd, config, state);
			setStatusWidget(ctx, report);
			ctx.ui.notify(
				`Hybrid doctor complete. See ${config.stateDir}/doctor.md`,
				smoke.ok ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("hybrid-status", {
		description: "Show current hybrid harness state and artifacts",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const report = statusMarkdown(ctx.cwd, config, state);
			setStatusWidget(ctx, report);
			await showReport("Hybrid Status", report, ctx);
			ctx.ui.notify(`Hybrid phase: ${state.phase}`, "info");
		},
	});

	pi.registerCommand("hybrid-usage", {
		description:
			"Show local vs frontier recorded token/cost usage for hybrid artifacts",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const report = usageSummaryMarkdown(ctx.cwd, config);
			writeArtifact(ctx.cwd, config, state, "usage-summary.md", report);
			saveState(ctx.cwd, config, state);
			await showReport("Hybrid Usage", report, ctx);
			ctx.ui.notify("Hybrid usage summary generated.", "info");
		},
	});

	pi.registerCommand("hybrid-progress", {
		description:
			"Show structured slice, acceptance-criteria, trigger, and test progress",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const task = state.task || "(task missing)";
			const progress = readProgress(ctx.cwd, config, task);
			writeProgress(ctx.cwd, config, state, progress);
			const report = progressToMarkdown(progress);
			setStatusWidget(ctx, report);
			await showReport("Hybrid Progress", report, ctx);
			ctx.ui.notify(
				`Hybrid progress: ${progress.currentSliceId ?? "no current slice"}`,
				"info",
			);
		},
	});

	async function handleHybridRun(
		args: string,
		ctx: any,
		configOverrides: Partial<HarnessConfig> = {},
		mode?: HybridRunDetails["mode"],
	) {
		const { liveId } = startHybridBackgroundRun({
			pi,
			cwd: ctx.cwd,
			ctx,
			args,
			configOverrides,
			mode,
		});
		ctx.ui.notify(
			`Hybrid run started in background (${liveId}). Use /hybrid-monitor, /hybrid-steer, or /hybrid-cancel.`,
			"info",
		);
		ctx.ui.requestRender?.();
	}

	pi.registerCommand("hybrid-run", {
		description:
			"Run full hybrid orchestration with configured frontier pass count (default 2)",
		handler: async (args, ctx) => handleHybridRun(args, ctx, {}, "default"),
	});

	pi.registerCommand("hybrid-run-fast", {
		description:
			"Run hybrid orchestration with maxFrontierPasses forced to 1 for token saving",
		handler: async (args, ctx) =>
			handleHybridRun(args, ctx, { maxFrontierPasses: 1 }, "fast"),
	});

	pi.registerCommand("hybrid-run-thorough", {
		description:
			"Run hybrid orchestration with maxFrontierPasses forced to 2 for one frontier repair/recheck cycle",
		handler: async (args, ctx) =>
			handleHybridRun(args, ctx, { maxFrontierPasses: 2 }, "thorough"),
	});

	pi.registerCommand("hybrid-retry", {
		description:
			"Clear one completed hybrid stage checkpoint so /hybrid-run reruns it",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const removed = clearHybridStageCheckpoint(ctx.cwd, config, state, args.trim());
			ctx.ui.notify(
				`Hybrid stage ${args.trim()} reset (${removed.length} artifact(s) cleared). Run /hybrid-run to continue.`,
				"info",
			);
		},
	});

	pi.registerCommand("hybrid-resume-from", {
		description:
			"Clear a stage and downstream checkpoints, then resume the active task in the background",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const removed = clearHybridStageFrom(ctx.cwd, config, state, args.trim());
			const { liveId } = startHybridBackgroundRun({
				pi,
				cwd: ctx.cwd,
				ctx,
				args: "",
			});
			ctx.ui.notify(
				`Hybrid resumed from ${args.trim()} (${removed.length} artifact(s) cleared, ${liveId}).`,
				"info",
			);
		},
	});

	pi.registerCommand("hybrid-steer", {
		description:
			"Queue a parent steering note for the next hybrid child session/stage boundary",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const entry = appendHybridSteering(ctx.cwd, config, state, args, "command");
			ctx.ui.notify(
				`Hybrid steering queued for next child session (${entry.id}).`,
				"info",
			);
		},
	});

	pi.registerCommand("hybrid-steering", {
		description: "Show queued and consumed hybrid parent steering notes",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const entries = readHybridSteering(ctx.cwd, config);
			const lines = [
				"# Hybrid Steering",
				"",
				`- queued: ${entries.filter((entry) => !entry.consumedAt && !entry.clearedAt).length}`,
				`- consumed: ${entries.filter((entry) => entry.consumedAt).length}`,
				"",
				...entries.map((entry) =>
					[
						`## ${entry.id}`,
						"",
						`- created: ${entry.createdAt}`,
						`- source: ${entry.source}`,
						`- consumed: ${entry.consumedAt ? `${entry.consumedAt} (${entry.consumedStage ?? "unknown"})` : "no"}`,
						"",
						entry.message,
						"",
					].join("\n"),
				),
			];
			await showReport("Hybrid Steering", lines.join("\n"), ctx);
		},
	});

	pi.registerCommand("hybrid-steer-clear", {
		description: "Clear all queued and consumed hybrid parent steering notes",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const cleared = clearHybridSteering(ctx.cwd, config);
			ctx.ui.notify(`Hybrid steering cleared (${cleared} entr${cleared === 1 ? "y" : "ies"}).`, "info");
		},
	});

	pi.registerCommand("hybrid-cancel", {
		description: "Cancel the active background hybrid run and its current child session",
		handler: async (_args, ctx) => {
			const cancelled = abortHybridActiveRun(ctx.cwd);
			ctx.ui.notify(
				cancelled
					? "Hybrid cancel requested; active child session will be terminated."
					: "No active background hybrid run in this workspace.",
				cancelled ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("hybrid-config", {
		description:
			"Create or show .pi-harness/config.json for the hybrid harness",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			ensureStateDir(ctx.cwd, config);
			const configFile = artifactPath(ctx.cwd, config, "config.json");
			if (!fs.existsSync(configFile)) {
				writeJsonFile(configFile, {
					testCommand: config.testCommand ?? "",
					maxLocalLoops: config.maxLocalLoops,
					maxReviewRepairCycles: config.maxReviewRepairCycles,
					maxFrontierPasses: config.maxFrontierPasses,
					verificationCommands: config.verificationCommands,
					allowManifestReviewWhenNoGit: config.allowManifestReviewWhenNoGit,
					requireDeterministicTestsForInteractive:
						config.requireDeterministicTestsForInteractive,
					enableSafetyGuards: config.enableSafetyGuards,
					allowDestructiveBash: config.allowDestructiveBash,
					protectedPaths: config.protectedPaths,
					maxDiffCharsBeforeFrontier: config.maxDiffCharsBeforeFrontier,
					verboseChildOutput: config.verboseChildOutput,
					liveLogMaxWidgetLines: config.liveLogMaxWidgetLines,
					briefBeforeImplementation: config.briefBeforeImplementation,
					askUserOnAmbiguity: config.askUserOnAmbiguity,
					frontierModel: config.frontierModel,
					frontierThinking: config.frontierThinking,
					frontierInputCostPerMTok: config.frontierInputCostPerMTok,
					frontierOutputCostPerMTok: config.frontierOutputCostPerMTok,
					localBaseUrl: config.localBaseUrl,
					localWorkerModel: config.localWorkerModel,
					localReviewerModel: config.localReviewerModel,
				});
			}
			const content = fs.readFileSync(configFile, "utf8");
			await showReport(
				"Hybrid Config",
				[
					"# Hybrid Config",
					"",
					`Config: \`${configFile}\``,
					"",
					"```json",
					content.trimEnd(),
					"```",
				].join("\n"),
				ctx,
			);
			ctx.ui.notify(`Hybrid config: ${configFile}`, "info");
		},
	});

	pi.registerCommand("hybrid-models", {
		description:
			"Pick local worker, local reviewer, or frontier model from Pi's available models",
		handler: async (_args, ctx) => {
			if (!ctx.ui?.custom || !ctx.modelRegistry?.getAvailable) {
				ctx.ui?.notify?.("Hybrid model picker requires interactive Pi UI.", "warning");
				return;
			}

			const config = loadConfig(ctx.cwd);
			const roleItems: SelectItem[] = HYBRID_MODEL_CONFIG_KEYS.map((role) => ({
				value: role.key,
				label: role.label,
				description: `${role.description} · current: ${config[role.key]}`,
			}));
			const role = (await selectHybridItem(
				ctx,
				"Select Hybrid Model Role",
				roleItems,
			)) as HybridModelConfigKey | null;
			if (!role) {
				ctx.ui.notify("Hybrid model selection cancelled.", "info");
				return;
			}

			const models = ctx.modelRegistry
				.getAvailable()
				.filter((model: any) => model.input?.includes("text"));
			if (models.length === 0) {
				ctx.ui.notify("No available text models found in Pi.", "warning");
				return;
			}

			const currentModel = config[role];
			const modelItems: SelectItem[] = models
				.map((model: any) => {
					const fullId = hybridModelFullId(model);
					return {
						value: fullId,
						label: fullId === currentModel ? `${fullId} (current)` : fullId,
						description: hybridModelDescription(model),
					};
				})
				.sort((a, b) => a.value.localeCompare(b.value));
			const selectedModel = await selectHybridItem(
				ctx,
				`Select ${HYBRID_MODEL_CONFIG_KEYS.find((item) => item.key === role)?.label ?? role} Model`,
				modelItems,
			);
			if (!selectedModel) {
				ctx.ui.notify("Hybrid model selection cancelled.", "info");
				return;
			}

			const configFile = updateConfigFile(ctx.cwd, config, {
				[role]: selectedModel,
			} as Partial<HarnessConfig>);
			await showReport(
				"Hybrid Models",
				[
					"# Hybrid Models",
					"",
					`- Updated: \`${role}\``,
					`- Previous: \`${currentModel}\``,
					`- Selected: \`${selectedModel}\``,
					`- Config: \`${configFile}\``,
				].join("\n"),
				ctx,
			);
			ctx.ui.notify(`Hybrid ${role} set to ${selectedModel}`, "info");
		},
	});

	pi.registerCommand("hybrid-install-companions", {
		description:
			"Install recommended companion Pi packages: pi-show-diffs and pi-subagents; remove legacy pi-subagentura if present",
		handler: async (_args, ctx) => {
			const lines = [
				"# Hybrid Companion Install",
				"",
				"Target companions:",
				"- npm:pi-show-diffs@0.2.13",
				"- npm:pi-subagents",
				"",
				"Legacy package checked for removal:",
				"- npm:pi-subagentura@1.0.12",
				"",
			];
			const removals = ["npm:pi-subagentura@1.0.12", "npm:pi-subagentura"];
			for (const pkg of removals) {
				ctx.ui.notify(`Removing legacy ${pkg} if present...`, "info");
				const result = spawnSync(
					process.env.PI_BINARY || "pi",
					["remove", "-l", pkg],
					{
						cwd: ctx.cwd,
						encoding: "utf8",
						maxBuffer: 2 * 1024 * 1024,
					},
				);
				lines.push(
					`## remove ${pkg}`,
					"",
					`- exit: ${result.status}`,
					"",
					"```",
					`${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
					"```",
					"",
				);
			}
			for (const pkg of ["npm:pi-show-diffs@0.2.13", "npm:pi-subagents"]) {
				ctx.ui.notify(`Installing ${pkg}...`, "info");
				const result = spawnSync(
					process.env.PI_BINARY || "pi",
					["install", "-l", pkg],
					{
						cwd: ctx.cwd,
						encoding: "utf8",
						maxBuffer: 2 * 1024 * 1024,
					},
				);
				lines.push(
					`## install ${pkg}`,
					"",
					`- exit: ${result.status}`,
					"",
					"```",
					`${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
					"```",
					"",
				);
			}
			await showReport("Hybrid Companion Install", lines.join("\n"), ctx);
			ctx.ui.notify(
				"Companion install attempted. Run /reload if packages changed.",
				"info",
			);
		},
	});

	pi.registerCommand("hybrid-checkpoint", {
		description: "Create a git patch checkpoint under .pi-harness/checkpoints",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const rel = createGitCheckpoint(ctx.cwd, config, args.trim() || "manual");
			if (!rel) {
				ctx.ui.notify("Not a git repository; checkpoint skipped.", "warning");
				return;
			}
			ctx.ui.notify(`Hybrid checkpoint created: ${rel}`, "info");
		},
	});

	pi.registerCommand("hybrid-rollback", {
		description:
			"Reverse-apply the latest hybrid tracked worktree checkpoint patch",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const dir = latestCheckpointDir(ctx.cwd, config);
			if (!dir) {
				ctx.ui.notify("No hybrid checkpoint found.", "warning");
				return;
			}
			const patchPath = path.join(dir, "worktree.patch");
			const patch = fs.existsSync(patchPath)
				? fs.readFileSync(patchPath, "utf8")
				: "";
			if (!patch.trim()) {
				ctx.ui.notify(
					"Latest checkpoint has an empty tracked worktree patch; nothing to reverse-apply.",
					"warning",
				);
				return;
			}
			const ok = ctx.hasUI
				? await ctx.ui.confirm(
						"Rollback latest hybrid checkpoint?",
						`Reverse-apply tracked patch from:\n${dir}\n\nUntracked files will not be deleted.`,
					)
				: false;
			if (!ok) return;
			const result = spawnSync(
				"git",
				["apply", "--reverse", "--whitespace=nowarn", patchPath],
				{ cwd: ctx.cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
			);
			await showReport(
				"Hybrid Rollback",
				[
					"# Hybrid Rollback",
					"",
					`Checkpoint: ${dir}`,
					`Exit: ${result.status}`,
					"",
					"```",
					`${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
					"```",
				].join("\n"),
				ctx,
			);
			ctx.ui.notify(
				result.status === 0
					? "Hybrid rollback applied."
					: "Hybrid rollback failed; see editor output.",
				result.status === 0 ? "info" : "error",
			);
		},
	});

	pi.registerCommand("hybrid-reset", {
		description:
			"Clear current .pi-harness run artifacts but keep config.json and doctor.md",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			cleanRunArtifacts(ctx.cwd, config);
			const state = loadState(ctx.cwd, config);
			saveState(ctx.cwd, config, state);
			setStatusWidget(ctx, statusMarkdown(ctx.cwd, config, state));
			ctx.ui.notify("Hybrid run artifacts reset.", "info");
		},
	});

	pi.registerCommand("hybrid-start", {
		description:
			"Start a hybrid run: local scout then frontier architecture package",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			ensureStateDir(ctx.cwd, config);
			const state = loadState(ctx.cwd, config);
			const task = requireTask(args, state);
			state.task = task;
			state.createdAt ||= nowIso();
			state.localWorkerModel = config.localWorkerModel;
			state.localReviewerModel = config.localReviewerModel;
			state.frontierModel = config.frontierModel;
			state.frontierThinking = config.frontierThinking;
			writeArtifact(ctx.cwd, config, state, "task.md", `# Task\n\n${task}\n`);
			saveState(ctx.cwd, config, state);

			ctx.ui.notify("Hybrid start: running local scout...", "info");
			const scoutSteering = hybridSteeringMarkdown(ctx.cwd, config);
			if (scoutSteering)
				markHybridSteeringConsumed(ctx.cwd, config, "scout");
			const scoutPrompt = [
				"You are the LOCAL SCOUT in a hybrid coding harness.",
				"Explore the repository with read-only tools and produce a compact, high-signal repo map for a frontier architect.",
				"Do not modify files.",
				"",
				`Task: ${task}`,
				...(scoutSteering ? ["", scoutSteering] : []),
				"",
				"Output markdown with these sections:",
				"1. Task interpretation and unknowns",
				"2. Relevant files and why they matter",
				"3. Existing tests and likely verification commands",
				"4. Current architecture/conventions",
				"5. Risks, edge cases, and places the implementer must not break",
				"6. Suggested implementation slices",
			].join("\n");
			const scout = await runPiOnce({
				cwd: ctx.cwd,
				model: config.localWorkerModel,
				prompt: scoutPrompt,
				tools: ["read", "grep", "find", "ls", "bash"],
				timeoutMs: 15 * 60_000,
			});
			writeArtifact(
				ctx.cwd,
				config,
				state,
				"repo-map.md",
				`# Local Scout Repo Map\n\n${scout.text || "(no output)"}\n\n---\n\n## Scout run\n\n- ok: ${scout.ok}\n- exitCode: ${scout.exitCode}\n- usage: ${formatUsage(scout)}\n\n\`\`\`stderr\n${truncateMiddle(scout.stderr, 4000)}\n\`\`\`\n`,
			);
			state.phase = "scouted";
			saveState(ctx.cwd, config, state);

			ctx.ui.notify("Hybrid start: running frontier architect...", "info");
			const architectSteering = hybridSteeringMarkdown(ctx.cwd, config);
			if (architectSteering)
				markHybridSteeringConsumed(ctx.cwd, config, "frontier-architect");
			const architectPrompt = [
				"You are the FRONTIER ARCHITECT in a hybrid coding harness.",
				"Your job is to spend frontier reasoning only where it matters: clarify the target design, constraints, risks, and acceptance criteria so a local Qwen worker can implement with minimal drift.",
				"Do not implement. Do not ask to inspect the entire repository unless the scout map is insufficient. Produce a concise implementation package.",
				"",
				`Task: ${task}`,
				...(architectSteering ? ["", architectSteering] : []),
				"",
				"Local scout map:",
				"```markdown",
				truncateMiddle(scout.text, 60_000),
				"```",
				"",
				"Output markdown with exactly these sections:",
				"1. Decision summary",
				"2. Non-goals",
				"3. Implementation plan by small slices",
				"4. File-level guidance",
				"5. Acceptance criteria",
				"6. Verification commands",
				"7. Risks and frontier re-check triggers",
				"8. Local worker prompt notes",
			].join("\n");
			const architect = await runPiOnce({
				cwd: ctx.cwd,
				model: config.frontierModel,
				thinking: config.frontierThinking,
				prompt: architectPrompt,
				tools: ["read", "grep", "find", "ls"],
				timeoutMs: 20 * 60_000,
			});
			writeArtifact(
				ctx.cwd,
				config,
				state,
				"frontier-design.md",
				`# Frontier Design Package\n\n${architect.text || "(no output)"}\n\n---\n\n## Architect run\n\n- ok: ${architect.ok}\n- exitCode: ${architect.exitCode}\n- usage: ${formatUsage(architect)}\n\n\`\`\`stderr\n${truncateMiddle(architect.stderr, 4000)}\n\`\`\`\n`,
			);
			state.phase = "designed";
			state.lastRun = nowIso();
			saveState(ctx.cwd, config, state);
			setStatusWidget(ctx, statusMarkdown(ctx.cwd, config, state));
			ctx.ui.notify(
				`Hybrid design complete. Next: /hybrid-loop`,
				architect.ok ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("hybrid-loop", {
		description:
			"Run local Qwen implementation/test loop from the frontier design package",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const task = requireTask(args, state);
			if (!readArtifact(ctx.cwd, config, "frontier-design.md")) {
				ctx.ui.notify(
					"Missing frontier-design.md. Run /hybrid-start first.",
					"warning",
				);
				return;
			}
			const loops = Math.max(
				1,
				Math.min(
					config.maxLocalLoops,
					Number(args.trim()) || config.maxLocalLoops,
				),
			);
			const logParts: string[] = [
				`# Local Implementation Log`,
				"",
				`Task: ${task}`,
				"",
			];

			for (let i = 1; i <= loops; i++) {
				ctx.ui.notify(
					`Hybrid loop ${i}/${loops}: local worker running...`,
					"info",
				);
				const result = await runPiOnce({
					cwd: ctx.cwd,
					model: config.localWorkerModel,
					prompt: localWorkerPrompt(task, config, i, ctx.cwd),
					timeoutMs: 30 * 60_000,
				});
				logParts.push(
					`## Iteration ${i}`,
					"",
					result.text || "(no output)",
					"",
					`- ok: ${result.ok}`,
					`- exitCode: ${result.exitCode}`,
					`- usage: ${formatUsage(result)}`,
					"",
					"```stderr",
					truncateMiddle(result.stderr, 6000),
					"```",
					"",
				);

				if (config.testCommand) {
					ctx.ui.notify(
						`Hybrid loop ${i}/${loops}: running configured tests...`,
						"info",
					);
					const test = runCommand(ctx.cwd, config.testCommand, 10 * 60_000);
					logParts.push(
						`### Configured test command`,
						"",
						`\`${config.testCommand}\``,
						"",
						`- ok: ${test.ok}`,
						`- code: ${test.code}`,
						"",
						"```",
						truncateMiddle(test.output, 20_000),
						"```",
						"",
					);
					if (test.ok) break;
				}
			}

			writeArtifact(
				ctx.cwd,
				config,
				state,
				"local-log.md",
				logParts.join("\n"),
			);
			writeArtifact(
				ctx.cwd,
				config,
				state,
				"git-summary.md",
				gitSummary(ctx.cwd, config),
			);
			const finish = finishHybridArtifacts(
				ctx.cwd,
				config,
				state,
				task,
				(message, type = "info") => ctx.ui.notify(message, type),
			);
			setStatusWidget(ctx, statusMarkdown(ctx.cwd, config, state));
			ctx.ui.notify(
				`Hybrid local loop complete. Verification: ${finish.summary.allPassed ? "passed" : finish.summary.commands.length ? "failed" : "not configured"}. Next: /hybrid-review`,
				finish.summary.allPassed || finish.summary.commands.length === 0
					? "info"
					: "warning",
			);
		},
	});

	pi.registerCommand("hybrid-review", {
		description:
			"Run local read-only review/audit of the implementation diff and evidence",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const review = await runLocalReview(
				ctx.cwd,
				config,
				state,
				(message, type = "info") => ctx.ui.notify(message, type),
			);
			setStatusWidget(ctx, statusMarkdown(ctx.cwd, config, state));
			ctx.ui.notify(
				`Hybrid local review complete: ${review.verdict}. Next: /hybrid-final`,
				review.result.ok ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("hybrid-final", {
		description:
			"Run frontier final gate over design, diff, local evidence, and local review",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			finishHybridArtifacts(
				ctx.cwd,
				config,
				state,
				state.task || "(task missing)",
				(message, type = "info") => ctx.ui.notify(message, type),
			);
			const final = await runFrontierFinal(
				ctx.cwd,
				config,
				state,
				(message, type = "info") => ctx.ui.notify(message, type),
			);
			setStatusWidget(ctx, statusMarkdown(ctx.cwd, config, state));
			await showReport(
				"Hybrid Final Review",
				readArtifact(ctx.cwd, config, "final-review.md"),
				ctx,
			);
			ctx.ui.notify(
				`Hybrid final review complete: ${final.verdict}. See .pi-harness/final-review.md`,
				final.result.ok ? "info" : "warning",
			);
		},
	});
}
