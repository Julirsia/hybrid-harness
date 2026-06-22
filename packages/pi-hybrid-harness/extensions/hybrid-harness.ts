import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
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
import type {
	CriterionStatus,
	EvidenceType,
	SliceStatus,
	TestFailureKind,
} from "../src/types.ts";
import {
	estimateRoughTokenCount,
	formatBytes,
	inferContextWindow,
	safeSessionIdPart,
	stripAnsiCodes,
	truncateMiddle,
} from "../src/text.ts";
import {
	extractJsonObject,
	isUsableChildResult,
	parseFrontierVerdict,
	parseLocalVerdict,
} from "../src/verdicts.ts";
import {
	globToRegExp,
	isDestructiveCommand,
	isProtectedPath,
	normalizeRelativePath,
} from "../src/safety.ts";
import {
	classifyTestFailure,
	fatalVerificationSignals,
	verificationCommandPassed,
} from "../src/verification.ts";
import {
	normalizeCriterionStatus,
	normalizeEvidenceType,
	normalizeSliceStatus,
	normalizeStringArray,
} from "../src/progress-status.ts";
import {
	assessConvergence,
	convergenceDirective,
	isBehavioralTestCommand,
	isFallbackProgress,
	type Convergence,
} from "../src/orchestration-signals.ts";
import {
	EDITABLE_CONFIG_KEYS,
	coerceConfigValue,
} from "../src/config-set.ts";

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
	persistentWriterSession: boolean;
	writerSessionDir: string;
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
	/**
	 * When true, a multi-lane handoff with NO executable integration gate hard-fails the run.
	 * When false (default), a missing gate does not crash the run: it finishes with a loud
	 * "seam UNVERIFIED" concern (localVerdict PASS_WITH_CONCERNS) instead. A gate that exists
	 * but FAILS always fails the run regardless of this flag.
	 */
	requireIntegrationGate: boolean;
	/**
	 * When true, register an agent-callable `hybrid_final` tool so an autonomous parent
	 * orchestrator can invoke the frontier final gate itself. Default false: the frontier
	 * final gate is reached only via the `/hybrid-final` slash command (human-triggered).
	 */
	enableHybridFinalTool: boolean;
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

type PlanReviewVerdict = "READY" | "NEEDS_REVISION" | "ESCALATE_TO_USER";

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
		verificationContracts?: string[];
		evidenceType?: EvidenceType;
		sourceEvidence?: string[];
		runtimeEvidence?: string[];
		adversarialProbes?: string[];
		reentryProbes?: string[];
		residualGaps?: string[];
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

interface ClaimEvidenceRow {
	claim: string;
	evidenceCommand: string;
	evidenceType: EvidenceType;
	whatWouldFailIfBroken: string;
	residualGap: string;
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
	| "plan-review"
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
	writerSessionId: string;
	writerSessionDir: string;
	lastError?: string;
	// Parent-driven (hybrid_exec) convergence tracking across packages, so a repeated
	// no-progress verdict can be detected and surfaced to the orchestrator.
	lastPackageId?: string;
	lastPackageVerdict?: string;
	lastPackageConvergence?: string;
	repeatedNonProgressCount?: number;
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
	model?: string;
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
	mode: "fast" | "default" | "thorough" | "handoff";
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
		currentSliceId?: string;
		currentSliceTitle?: string;
		currentSliceStatus?: SliceStatus;
		currentSliceRemaining?: string;
		nextAction?: string;
	};
	localVerdict?: ReturnType<typeof parseLocalVerdict>;
	frontierVerdict?: ReturnType<typeof parseFrontierVerdict>;
	// Parent-driven (hybrid_exec) convergence signal, surfaced in the card/monitor/status
	// so a stalled or test-blocked loop is visible without opening run-summary.md.
	convergence?: Convergence;
	repeatedNonProgress?: number;
	frontierInputCostPerMTok?: number;
	frontierOutputCostPerMTok?: number;
	writerSessionId?: string;
	writerSessionDir?: string;
	artifacts: Record<string, string>;
	usageSummary?: string;
	error?: string;
}

interface HybridRunParams {
	task?: string;
	mode?: "fast" | "default" | "thorough" | "handoff";
	maxFrontierPasses?: number;
	resume?: boolean;
	background?: boolean;
}

interface HybridExecParams {
	task?: string;
	packageId?: string;
	executionPackage: string;
	loops?: number;
	debug?: boolean;
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

interface PlanReview {
	planArchitectVerdict: PlanReviewVerdict;
	planCriticVerdict: PlanReviewVerdict;
	verdict: PlanReviewVerdict;
	blockingIssues: string[];
	requiredRevisions: string[];
	reviewedValidationContracts: string[];
	residualRisks: string[];
	nextAction: string;
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
	localWorkerModel: "local-qwen/qwen36-27b-mtp-q5kxl",
	localReviewerModel: "local-qwen/qwen36-27b-mtp-q5kxl",
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
	persistentWriterSession: true,
	writerSessionDir: "sessions",
	verificationCommands: [],
	allowManifestReviewWhenNoGit: true,
	requireDeterministicTestsForInteractive: true,
	requireIntegrationGate: false,
	enableHybridFinalTool: false,
};

function nowIso(): string {
	return new Date().toISOString();
}

function newHybridWriterSessionId(task: string): string {
	return `hybrid-writer-${safeSessionIdPart(task)}-${Date.now().toString(36)}`;
}

function hybridWriterSessionDir(
	cwd: string,
	config: HarnessConfig,
	writerSessionDir = config.writerSessionDir,
): string {
	return path.isAbsolute(writerSessionDir)
		? writerSessionDir
		: artifactPath(cwd, config, writerSessionDir);
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
	// Environment overrides sit above the packaged defaults but below project config
	// files, so a new user can point the harness at their own local endpoint/models
	// without editing the shipped defaults, while a project's config.json still wins.
	const envConfig: Partial<HarnessConfig> = {};
	if (process.env.HYBRID_LOCAL_BASE_URL)
		envConfig.localBaseUrl = process.env.HYBRID_LOCAL_BASE_URL;
	if (process.env.HYBRID_LOCAL_PROVIDER)
		envConfig.localProvider = process.env.HYBRID_LOCAL_PROVIDER;
	if (process.env.HYBRID_LOCAL_WORKER_MODEL)
		envConfig.localWorkerModel = process.env.HYBRID_LOCAL_WORKER_MODEL;
	if (process.env.HYBRID_LOCAL_REVIEWER_MODEL)
		envConfig.localReviewerModel = process.env.HYBRID_LOCAL_REVIEWER_MODEL;
	if (process.env.HYBRID_FRONTIER_MODEL)
		envConfig.frontierModel = process.env.HYBRID_FRONTIER_MODEL;
	const merged = {
		...DEFAULT_CONFIG,
		...envConfig,
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
	if (!merged.writerSessionDir) merged.writerSessionDir = "sessions";
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
			lock.mode === "fast" || lock.mode === "thorough" || lock.mode === "handoff"
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
	const defaultWriterSessionId = newHybridWriterSessionId(task);
	const defaultWriterSessionDir = config.writerSessionDir || "sessions";
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
			writerSessionId:
				typeof existing.writerSessionId === "string" && existing.writerSessionId.trim()
					? existing.writerSessionId
					: defaultWriterSessionId,
			writerSessionDir:
				typeof existing.writerSessionDir === "string" && existing.writerSessionDir.trim()
					? existing.writerSessionDir
					: defaultWriterSessionDir,
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
		writerSessionId: defaultWriterSessionId,
		writerSessionDir: defaultWriterSessionDir,
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

function parsePlanReviewChildOk(text: string): boolean | undefined {
	const match = text.match(/-\s*ok:\s*(true|false)/i);
	if (match?.[1]?.toLowerCase() === "true") return true;
	if (match?.[1]?.toLowerCase() === "false") return false;
	return undefined;
}

function planReviewArtifactReady(cwd: string, config: HarnessConfig): boolean {
	const text = readArtifact(cwd, config, "plan-review.md");
	return (
		artifactReady(cwd, config, "plan-review.md") &&
		parsePlanReviewVerdict(text) === "READY" &&
		parsePlanReviewChildOk(text) === true
	);
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
	if (stage === "plan-review")
		return planReviewArtifactReady(cwd, config);
	if (stage === "local-loop")
		return (
			artifactReady(cwd, config, "local-log.md") &&
			artifactReady(cwd, config, "progress.json")
		);
	if (stage === "finish")
		return (
			artifactReady(cwd, config, "verification-summary.json") &&
			artifactReady(cwd, config, "claim-evidence-matrix.md") &&
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
	"plan-review",
	"local-loop",
	"finish",
	"local-review",
	"frontier-final",
	"summary",
];

function hybridStageDescriptionKo(stage: HybridRunStageId): string {
	switch (stage) {
		case "checkpoint":
			return "git/작업공간 사전 확인";
		case "design":
			return "로컬 저장소 조사와 frontier 설계/슬라이스 계획";
		case "brief":
			return "구현 전 모호성 확인과 사용자 clarification 게이트";
		case "plan-review":
			return "구현 시작 전 실행 계획 검증";
		case "local-loop":
			return "로컬 구현, 테스트, repair 루프";
		case "finish":
			return "결과 정리, 결정적 검증, evidence 정리";
		case "local-review":
			return "frontier가 구현 결과를 리뷰";
		case "frontier-final":
			return "최종 frontier 승인/변경요청 게이트";
		case "summary":
			return "run summary와 usage summary 생성";
	}
}

function hybridStageReferenceMarkdown(): string {
	return [
		"## 재개 가능한 단계",
		"",
		"그냥 이어가려면 `/hybrid-resume`을 사용하세요.",
		"",
		"`/hybrid-resume-from <stage>`에 아래 stage ID를 사용할 수 있습니다.",
		"",
		...HYBRID_STAGE_ORDER.map(
			(stage) =>
				`- \`${stage}\` - ${hybridStageLabelKo(stage)}: ${hybridStageDescriptionKo(stage)}`,
		),
		"",
		"예: `/hybrid-resume-from brief`",
	].join("\n");
}

function normalizeHybridRunStageId(value: string): HybridRunStageId {
	const normalized = value.trim() as HybridRunStageId;
	if (!HYBRID_STAGE_ORDER.includes(normalized)) {
		throw new Error(
			`Unknown hybrid stage "${value}". Expected one of: ${HYBRID_STAGE_ORDER.join(", ")}. Run /hybrid-stages to see descriptions.`,
		);
	}
	return normalized;
}

function hybridStageArtifactNames(stage: HybridRunStageId): string[] {
	if (stage === "design")
		return ["repo-map.md", "frontier-design.md", "implementation-plan.json"];
	if (stage === "brief") return ["orchestration-brief.md"];
	if (stage === "plan-review") return ["plan-review.md"];
	if (stage === "local-loop")
		return ["local-log.md", "test-evidence.md", "git-summary.md"];
	if (stage === "finish")
		return [
			"verification-summary.json",
			"verification-summary.md",
			"claim-evidence-matrix.md",
		];
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

const HYBRID_RUN_ARTIFACTS = [
	"state.json",
	"task.md",
	"repo-map.md",
	"frontier-design.md",
	"implementation-plan.json",
	"progress.json",
	"progress.md",
	"test-evidence.md",
	"claim-evidence-matrix.md",
	"plan-review.md",
	"requirements.md",
	"design-grill.md",
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
] as const;

function archiveHybridRunArtifacts(cwd: string, config: HarnessConfig): string | undefined {
	const existing = HYBRID_RUN_ARTIFACTS.filter((name) =>
		fs.existsSync(artifactPath(cwd, config, name)),
	);
	if (!existing.length) return undefined;
	const archiveId = nowIso().replace(/[:.]/g, "-");
	const archiveDir = path.join(cwd, config.stateDir, "runs", archiveId);
	fs.mkdirSync(archiveDir, { recursive: true });
	for (const name of existing) {
		fs.copyFileSync(artifactPath(cwd, config, name), path.join(archiveDir, name));
	}
	fs.writeFileSync(
		path.join(archiveDir, "archive-manifest.json"),
		`${JSON.stringify({ version: 1, archivedAt: nowIso(), files: existing }, null, "\t")}\n`,
		"utf8",
	);
	return path.relative(cwd, archiveDir);
}

function cleanRunArtifacts(cwd: string, config: HarnessConfig): void {
	for (const name of HYBRID_RUN_ARTIFACTS) {
		try {
			fs.rmSync(artifactPath(cwd, config, name), { force: true });
		} catch {
			// ignore
		}
	}
}

function startNewHybridTask(
	cwd: string,
	config: HarnessConfig,
	task: string,
): { state: HarnessState; archive?: string } {
	const archive = archiveHybridRunArtifacts(cwd, config);
	cleanRunArtifacts(cwd, config);
	const state = loadState(cwd, config);
	if (task) {
		state.task = task;
		writeArtifact(cwd, config, state, "task.md", `# Task\n\n${task}\n`);
	}
	saveState(cwd, config, state);
	return { state, archive };
}

function hybridRequirementsContext(
	cwd: string,
	config: HarnessConfig,
	maxChars = 40_000,
): string[] {
	const requirements = readArtifact(cwd, config, "requirements.md").trim();
	if (!requirements) return [];
	return [
		"",
		"Requirements interview artifact (authoritative when present):",
		`- Source: ${config.stateDir}/requirements.md`,
		"- Use this artifact as the product requirements source for design, planning, implementation, and review.",
		"- Do not create or treat root REQUIREMENTS.md as a substitute for this harness artifact unless the task explicitly asks for a root requirements file.",
		"```markdown",
		truncateMiddle(requirements, maxChars),
		"```",
	];
}

function progressToMarkdown(progress: HarnessProgress): string {
	const doneSlices = progress.slices.filter((slice) => slice.status === "done").length;
	const satisfiedCriteria = progress.acceptanceCriteria.filter(
		(criterion) => criterion.status === "satisfied",
	).length;
	const activeTriggers = progress.frontierRecheckTriggers.filter(
		(trigger) => trigger.active,
	).length;
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
			[
				`- [${criterion.status === "satisfied" ? "x" : " "}] ${criterion.id}: ${criterion.description} (${criterion.status})${criterion.evidence.length ? ` — ${criterion.evidence.join("; ")}` : ""}`,
				`  - verification contracts: ${criterion.verificationContracts?.length ? criterion.verificationContracts.join("; ") : "none"}`,
				`  - evidence type: ${criterion.evidenceType ?? "unspecified"}`,
				`  - source evidence: ${criterion.sourceEvidence?.length ? criterion.sourceEvidence.join("; ") : "none"}`,
				`  - runtime evidence: ${criterion.runtimeEvidence?.length ? criterion.runtimeEvidence.join("; ") : "none"}`,
				`  - adversarial probes: ${criterion.adversarialProbes?.length ? criterion.adversarialProbes.join("; ") : "none"}`,
				`  - reentry/idempotency probes: ${criterion.reentryProbes?.length ? criterion.reentryProbes.join("; ") : "none"}`,
				`  - residual gaps: ${criterion.residualGaps?.length ? criterion.residualGaps.join("; ") : "none"}`,
			].join("\n"),
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
		"## 한국어 요약",
		"",
		`- 작업: ${progress.task}`,
		`- 현재 단계: ${progress.currentSliceId ?? "없음"}`,
		`- 완료된 조각: ${doneSlices}/${progress.slices.length}`,
		`- 충족된 승인 기준: ${satisfiedCriteria}/${progress.acceptanceCriteria.length}`,
		`- 활성 frontier 재확인 항목: ${activeTriggers}`,
		`- 다음 행동: ${progress.nextAction}`,
		`- 차단 사유: ${progress.blockers.length ? progress.blockers.join("; ") : "없음"}`,
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
				verificationContracts: [
					"Define a reproducible command, script, or manual procedure before accepting this criterion.",
				],
				evidenceType: "manual",
				sourceEvidence: [],
				runtimeEvidence: [],
				adversarialProbes: [],
				reentryProbes: [],
				residualGaps: ["No executable verification contract has been extracted yet."],
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
						evidence: normalizeStringArray(c.evidence),
						verificationContracts: normalizeStringArray(
							c.verificationContracts,
						),
						evidenceType: normalizeEvidenceType(c.evidenceType),
						sourceEvidence: normalizeStringArray(c.sourceEvidence),
						runtimeEvidence: normalizeStringArray(c.runtimeEvidence),
						adversarialProbes: normalizeStringArray(c.adversarialProbes),
						reentryProbes: normalizeStringArray(c.reentryProbes),
						residualGaps: normalizeStringArray(c.residualGaps),
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
	if (scripts.lint) {
		commands.push("npm run lint");
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

function claimEvidenceRows(
	progress: HarnessProgress,
	summary: VerificationSummary,
): ClaimEvidenceRow[] {
	const passedCommands = summary.commands
		.filter((command) => command.ok)
		.map((command) => command.command);
	return progress.acceptanceCriteria.map((criterion) => {
		const evidenceCommand =
			criterion.verificationContracts?.[0] ??
			passedCommands[0] ??
			"No executable verification contract recorded";
		const evidenceType =
			criterion.evidenceType ??
			(criterion.runtimeEvidence?.length ? "integration" : "static");
		const residualGap =
			criterion.residualGaps?.join("; ") ||
			(criterion.status === "satisfied"
				? "none recorded"
				: "criterion is not satisfied");
		return {
			claim: `${criterion.id}: ${criterion.description}`,
			evidenceCommand,
			evidenceType,
			whatWouldFailIfBroken:
				criterion.runtimeEvidence?.[0] ??
				criterion.sourceEvidence?.[0] ??
				criterion.evidence[0] ??
				"missing evidence would leave this claim unsupported",
			residualGap,
		};
	});
}

function claimEvidenceMatrixMarkdown(
	progress: HarnessProgress,
	summary: VerificationSummary,
): string {
	const rows = claimEvidenceRows(progress, summary);
	const escapeCell = (value: string) => value.replace(/\|/g, "\\|").trim();
	return [
		"# Claim-Evidence Matrix",
		"",
		"| Claim | Evidence command | Evidence type | What would fail if broken | Residual gap |",
		"| --- | --- | --- | --- | --- |",
		...(rows.length
			? rows.map(
					(row) =>
						`| ${escapeCell(row.claim)} | ${escapeCell(row.evidenceCommand)} | ${row.evidenceType} | ${escapeCell(row.whatWouldFailIfBroken)} | ${escapeCell(row.residualGap)} |`,
				)
			: ["| none | none | static | no acceptance criteria recorded | none |"]),
		"",
		"Source-level evidence is not runtime evidence; behavioral claims need runtime, unit, integration, e2e, or manual proof.",
		"Smoke evidence cannot satisfy behavioral acceptance criteria without behavioral proof.",
	].join("\n");
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
	const progress = readProgress(cwd, config, state.task ?? "(task missing)");
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
		const evaluated = verificationCommandPassed(test);
		const failureKind: TestFailureKind = evaluated.ok
			? "none"
			: classifyTestFailure(test.output, false, test.code);
		const compactOutput = test.output.replace(/\s+/g, " ").trim();
		const summary = evaluated.ok
			? "Command passed."
			: evaluated.fatalSignals.length
				? `Command emitted fatal runtime signal(s): ${evaluated.fatalSignals.join(", ")}.`
				: truncateMiddle(compactOutput || "Command failed without output.", 500);
		results.push({
			command,
			ok: evaluated.ok,
			code: test.code,
			failureKind,
			summary,
		});
		evidenceLines.push(
			`### ${command}`,
			"",
			`- ok: ${evaluated.ok}`,
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
	const matrixColumnContract =
		"Evidence type | What would fail if broken | Residual gap";
	const matrixMarkdown = `${claimEvidenceMatrixMarkdown(progress, summary)}\n\nMatrix columns: ${matrixColumnContract}\n`;
	writeArtifact(
		cwd,
		config,
		state,
		"claim-evidence-matrix.md",
		matrixMarkdown,
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

// Content-independent signature of the editable workspace (source files only), used
// to detect when a writer iteration/package made no changes. Works with or without
// git. Excludes build output, deps, and harness state so a verification build that
// writes dist/ does not register as a source change.
function workspaceSignature(cwd: string, config: HarnessConfig): string {
	const ignored = new Set([
		".git",
		"node_modules",
		".DS_Store",
		".next",
		".nuxt",
		".cache",
		"coverage",
		"dist",
		"build",
		config.stateDir,
	]);
	const parts: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (ignored.has(entry.name)) continue;
			if (entry.isSymbolicLink()) continue;
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const stat = fs.statSync(absolute);
				const rel = path.relative(cwd, absolute).replace(/\\/g, "/");
				parts.push(`${rel}:${stat.size}:${Math.round(stat.mtimeMs)}`);
			} catch {
				// ignore unreadable entries
			}
		}
	};
	walk(cwd);
	parts.sort();
	return crypto.createHash("sha1").update(parts.join("\n")).digest("hex");
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
	sessionPolicy?: "ephemeral" | "persistent";
	sessionId?: string;
	sessionDir?: string;
}): Promise<PiRunResult> {
	const tmp = await writeTempPrompt(options.prompt);
	const args = ["--mode", "json", "-p"];
	if (options.sessionPolicy === "persistent" && options.sessionId) {
		if (options.sessionDir) {
			fs.mkdirSync(options.sessionDir, { recursive: true });
			args.push("--session-dir", options.sessionDir);
		}
		args.push("--session-id", options.sessionId);
	} else {
		args.push("--no-session");
	}
	args.push("--model", options.model);
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
					model: options.model,
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
			if (childEvent && options.liveLabel) {
				childEvent(options.liveLabel, {
					type: "child_start",
					model: options.model,
				});
			}
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
		{ name: "local-review.md", bucket: "frontier" },
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

function findWriterSessionFiles(
	sessionDir: string,
	sessionId: string | undefined,
	limit = 12,
): Array<{ file: string; size: number }> {
	if (!sessionId || !fs.existsSync(sessionDir)) return [];
	const matches: Array<{ file: string; size: number; mtimeMs: number }> = [];
	const queue = [sessionDir];
	let visited = 0;
	while (queue.length && visited < 300) {
		const dir = queue.shift()!;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			visited++;
			const filePath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (queue.length < 40) queue.push(filePath);
				continue;
			}
			if (!entry.name.includes(sessionId)) continue;
			try {
				const stat = fs.statSync(filePath);
				matches.push({ file: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
			} catch {
				// ignore disappearing files
			}
			if (matches.length >= limit * 2) break;
		}
	}
	return matches
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, limit)
		.map(({ file, size }) => ({ file, size }));
}

function hybridWriterSessionInfo(cwd: string, config: HarnessConfig): {
	id?: string;
	dir: string;
	absDir: string;
	files: Array<{ file: string; size: number }>;
} {
	const runState = readJsonFile<Partial<HybridRunState>>(
		artifactPath(cwd, config, "run-state.json"),
	);
	const writerSessionDir =
		typeof runState?.writerSessionDir === "string" && runState.writerSessionDir.trim()
			? runState.writerSessionDir
			: config.writerSessionDir;
	const absDir = hybridWriterSessionDir(cwd, config, writerSessionDir);
	const id =
		typeof runState?.writerSessionId === "string" && runState.writerSessionId.trim()
			? runState.writerSessionId
			: undefined;
	return {
		id,
		dir: path.relative(cwd, absDir) || absDir,
		absDir,
		files: findWriterSessionFiles(absDir, id),
	};
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
	const writerSession = hybridWriterSessionInfo(cwd, config);
	const writerSessionLines = writerSession.id
		? [
				`- id: \`${writerSession.id}\``,
				`- dir: \`${writerSession.dir}\``,
				`- files: ${writerSession.files.length ? writerSession.files.map((entry) => `\`${path.relative(cwd, entry.file) || entry.file}\` (${formatBytes(entry.size)})`).join(", ") : "not found yet"}`,
				"- note: monitor shows live output in memory; this command does not copy or expand the saved transcript.",
			].join("\n")
		: [
				`- id: not created yet`,
				`- dir: \`${writerSession.dir}\``,
				"- note: a writer session is created when the first local implementation/repair package runs.",
			].join("\n");
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
	const runStateRaw = readJsonFile<HybridRunState>(
		artifactPath(cwd, config, "run-state.json"),
	);
	const convergence = runStateRaw?.lastPackageConvergence;
	const repeatedNonProgress = runStateRaw?.repeatedNonProgressCount ?? 0;
	const convergenceSummaryKo = (() => {
		if (!convergence) return "기록 없음 (hybrid_exec 실행 시 갱신)";
		const known = ["complete", "progressing", "stalled", "blocked-no-tests"].includes(
			convergence,
		);
		const label = known
			? hybridConvergenceKo(convergence as Convergence).label
			: convergence;
		return `${label}${repeatedNonProgress >= 2 ? ` (무진전 ${repeatedNonProgress}회)` : ""}`;
	})();
	// Glanceable dynamic summary first: setStatusWidget only shows the first ~18 lines,
	// so phase/task/active-run/convergence must lead. Static reference + verbose config
	// go to the bottom of the full document.
	return [
		"# Hybrid Harness Status",
		"",
		"## 한국어 요약",
		"",
		`- 현재 상태: ${state.phase}`,
		`- 작업: ${state.task ?? "아직 설정되지 않음"}`,
		`- 실행 중인 백그라운드 작업: ${activeLock ? `${activeLock.currentStage ?? "unknown"} (${activeLock.liveId})${activeLock.cancelRequestedAt ? " · 취소 요청됨" : ""}${isHybridRunLockStale(activeLock) ? " · stale" : ""}` : "없음"}`,
		`- 수렴 상태: ${convergenceSummaryKo}`,
		`- 대기 중인 steering 메모: ${queuedSteering}개`,
		`- writer 세션: ${writerSession.id ?? "아직 생성되지 않음"}`,
		`- 상태 디렉터리: \`${path.relative(cwd, path.join(cwd, config.stateDir)) || config.stateDir}\``,
		`- 사람이 확인할 주요 문서: ${config.stateDir}/run-summary.md, ${config.stateDir}/progress.md, ${config.stateDir}/requirements.md`,
		`- 업데이트: ${state.updatedAt}`,
		"",
		"## Active Run",
		activeRunLines,
		"",
		"## Persistent Writer Session",
		writerSessionLines,
		"",
		"## Configuration",
		`- Local worker: \`${config.localWorkerModel}\``,
		`- Local reviewer: \`${config.localReviewerModel}\``,
		`- Frontier: \`${config.frontierModel}\` (${config.frontierThinking})`,
		`- Frontier cost rates: input=$${config.frontierInputCostPerMTok}/MTok output=$${config.frontierOutputCostPerMTok}/MTok`,
		`- Verification commands: ${config.verificationCommands.length ? config.verificationCommands.map((command) => `\`${command}\``).join(", ") : config.testCommand ? `\`${config.testCommand}\`` : "auto-detect"}`,
		`- Test command: ${config.testCommand ? `\`${config.testCommand}\`` : "not configured"}`,
		`- Interactive deterministic-test policy: ${config.requireDeterministicTestsForInteractive ? "on" : "off"}`,
		`- Non-git manifest review: ${config.allowManifestReviewWhenNoGit ? "allowed" : "blocked"}`,
		`- Live child output: ${config.verboseChildOutput ? "on" : "off"}`,
		`- Safety guards: ${config.enableSafetyGuards ? "on" : "off"}; destructive bash: ${config.allowDestructiveBash ? "allowed" : "blocked"}`,
		`- Loops: local=${config.maxLocalLoops} · review repair=${config.maxReviewRepairCycles} · frontier passes=${config.maxFrontierPasses}`,
		"",
		"## Artifacts",
		artifactLines || "(none)",
		"",
		...hybridStageReferenceMarkdown().split("\n"),
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
	const requirementsContext = cwd ? hybridRequirementsContext(cwd, config) : [];
	return [
		"You are the PERSISTENT SINGLE WRITER in a hybrid Pi coding harness.",
		"Continue from your prior writer-session context when present; keep one coherent implementation thread across implementation, repair, and debug loops.",
		"The frontier model already prepared the design. Follow it closely; do not redesign unless the repo proves it impossible.",
		"",
		"Rules:",
		"- Make surgical, minimal changes.",
		"- Prefer existing project conventions.",
		"- You are the only writer. Do not behave like an independent fresh implementer; preserve previous batch decisions unless the artifacts explicitly supersede them.",
		"- Implement or repair only the current necessary slice/batch. Do not start unrelated future work.",
		"- Run relevant tests or checks. If no test command is configured, infer the smallest safe verification command.",
		"- smoke evidence cannot satisfy behavioral acceptance criteria; build passed, HTTP 200, server responds, and import succeeds are baseline only.",
		"- A cross-component seam (your code calling another lane/module/service, or a client calling a server) is only proven by an executable end-to-end check that drives the consumer against the real producer. Passing your own unit tests plus a build does not prove the seam: verify your call site's verb/path/arguments match the producer's actual contract, and that any shared semantics (e.g. the meaning of now/today, units, rounding) agree on both sides.",
		"- Before starting the next slice, re-check at least one critical claim from the previous completed slice before relying on it.",
		"- Cover more than the happy path: normal path, invalid input, boundary values, resource limits, state reentry, and restart/retry/idempotency when applicable.",
		"- If blocked, write a clear blocker report instead of inventing broad rewrites.",
		"- Do not modify .pi-harness except when explicitly asked.",
		"",
		`Task: ${task}`,
		`Iteration: ${iteration}`,
		...(steering ? ["", steering] : []),
		...requirementsContext,
		config.testCommand
			? `Configured test command: ${config.testCommand}`
			: "Configured test command: none; infer from repository.",
		"",
		"Read these artifacts first:",
		`- ${config.stateDir}/requirements.md if present`,
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/repo-map.md`,
		`- ${config.stateDir}/progress.md and ${config.stateDir}/progress.json`,
		`- ${config.stateDir}/orchestrator-package.md if present; this is the parent Pi orchestrator's current executable package and overrides broad next-slice guessing`,
		`- ${config.stateDir}/orchestration-brief.md and ${config.stateDir}/user-clarifications.md if present`,
		`- ${config.stateDir}/local-review.md if present`,
		`- ${config.stateDir}/final-review.md if present`,
		"",
		"If requirements.md is present in the harness state, do not create or use root REQUIREMENTS.md as a substitute requirements source.",
		readArtifact(cwd ?? "", config, "orchestrator-package.md").trim()
			? [
				"",
				"## Current Parent-Orchestrator Execution Package",
				truncateMiddle(readArtifact(cwd ?? "", config, "orchestrator-package.md"), 30_000),
			].join("\n")
			: "",
		"If local-review.md or final-review.md requests changes, prioritize those fixes without broad redesign.",
		...interactiveValidationGuidance(task, config),
		"Implement the next necessary slice, verify it, then summarize:",
		"1. Files changed",
		"2. Verification commands and results, including source evidence vs runtime evidence",
		"3. Any adversarial probe or reentry/idempotency probe run",
		"4. Remaining work or blockers",
	].join("\n");
}

interface HandoffValidationCommand {
	cwd?: string;
	command: string;
	expected_exit?: number;
	proves?: string;
}

interface HandoffLane {
	id: string;
	name: string;
	objective: string;
	summary?: string;
	promptPath: string;
	prompt: string;
	validationCommands: HandoffValidationCommand[];
	criteria: Array<{ requirement?: string; description?: string; evidence?: string }>;
	boundaries: Array<{ case?: string; expected?: string; evidence?: string }>;
}

interface HandoffManifest {
	version: 1;
	rootDir: string;
	createdAt: string;
	taskName: string;
	objective: string;
	specPath?: string;
	readmePath?: string;
	integrationPath?: string;
	lanes: HandoffLane[];
	// Executable end-to-end gate that drives the consumer against the real producer
	// (the cross-lane seam). Per-lane unit tests + build do not prove the seam.
	integrationCommands: HandoffValidationCommand[];
}

function handoffManifestPath(cwd: string, config: HarnessConfig): string {
	return artifactPath(cwd, config, "handoff-manifest.json");
}

function readHandoffManifest(cwd: string, config: HarnessConfig): HandoffManifest | undefined {
	return readJsonFile<HandoffManifest>(handoffManifestPath(cwd, config));
}

function laneNumberFromName(name: string, fallback: number): number {
	const match = name.match(/^(\d+)/);
	return match ? Number.parseInt(match[1], 10) : fallback;
}

function normalizeHandoffCommand(value: any): HandoffValidationCommand | undefined {
	if (!value) return undefined;
	if (typeof value === "string") return { command: value };
	if (typeof value.command !== "string" || !value.command.trim()) return undefined;
	return {
		cwd: typeof value.cwd === "string" ? value.cwd : undefined,
		command: value.command,
		expected_exit: typeof value.expected_exit === "number" ? value.expected_exit : undefined,
		proves: typeof value.proves === "string" ? value.proves : undefined,
	};
}

function findHandoffSpecPath(rootDir: string): string | undefined {
	const directCandidates = [
		path.join(rootDir, "manual-handoff-spec.json"),
		path.join(rootDir, "spec.json"),
	];
	for (const candidate of directCandidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	const parentDir = path.dirname(rootDir);
	const rootBase = path.basename(rootDir);
	const siblingBases = [
		rootBase.replace(/-handoff$/i, "-spec.json"),
		`${rootBase}-spec.json`,
	];
	for (const base of siblingBases) {
		const candidate = path.join(parentDir, base);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) return undefined;
	const siblingSpecs = fs.readdirSync(parentDir)
		.filter((entry) => /(?:^manual-handoff-spec|-spec)\.json$/i.test(entry))
		.map((entry) => path.join(parentDir, entry))
		.filter((candidate) => fs.statSync(candidate).isFile());
	return siblingSpecs.length === 1 ? siblingSpecs[0] : undefined;
}

function parseHandoffValidationCommandsFromPrompt(prompt: string): HandoffValidationCommand[] {
	const sectionMatch = prompt.match(/## Validation Commands\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i);
	if (!sectionMatch) return [];
	const section = sectionMatch[1];
	const chunks = section.split(/\n(?=-\s+Working directory:)/i).filter((chunk) => chunk.trim());
	const commands: HandoffValidationCommand[] = [];
	for (const chunk of chunks) {
		const codeMatch = chunk.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/i);
		if (!codeMatch?.[1]?.trim()) continue;
		const cwd = chunk.match(/Working directory:\s*`([^`]+)`/i)?.[1];
		const expectedExitRaw = chunk.match(/Expected exit:\s*`?(\d+)`?/i)?.[1];
		const proves = chunk.match(/Proves:\s*([^\n]+)/i)?.[1]?.trim();
		commands.push({
			cwd,
			command: codeMatch[1].trim(),
			expected_exit: expectedExitRaw ? Number.parseInt(expectedExitRaw, 10) : undefined,
			proves,
		});
	}
	return commands;
}

// Parse the executable end-to-end gate out of integration-handoff.md (the "Executable
// Integration Gate" / "End-to-End" section the composer renders from spec.integration_e2e).
function parseIntegrationGateCommands(markdown: string): HandoffValidationCommand[] {
	const sectionMatch = markdown.match(
		/##\s+(?:Executable Integration Gate|End[- ]to[- ]End|Seam (?:Verification|Gate))[^\n]*\n([\s\S]*?)(?=\n##\s|\s*$)/i,
	);
	if (!sectionMatch) return [];
	const section = sectionMatch[1];
	const chunks = section.split(/\n(?=-\s+Working directory:)/i).filter((chunk) => chunk.trim());
	const commands: HandoffValidationCommand[] = [];
	for (const chunk of chunks) {
		const codeMatch = chunk.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/i);
		if (!codeMatch?.[1]?.trim()) continue;
		const cwd = chunk.match(/Working directory:\s*`([^`]+)`/i)?.[1];
		const expectedExitRaw = chunk.match(/Expected exit:\s*`?(\d+)`?/i)?.[1];
		const proves = chunk.match(/Proves:\s*([^\n]+)/i)?.[1]?.trim();
		commands.push({
			cwd,
			command: codeMatch[1].trim(),
			expected_exit: expectedExitRaw ? Number.parseInt(expectedExitRaw, 10) : undefined,
			proves,
		});
	}
	return commands;
}

function discoverHandoff(inputDir: string, cwd: string): HandoffManifest {
	const rootDir = path.resolve(cwd, inputDir || ".");
	if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
		throw new Error(`Handoff directory not found: ${rootDir}`);
	}
	const specPath = findHandoffSpecPath(rootDir);
	const readmePath = path.join(rootDir, "README.md");
	const integrationPath = path.join(rootDir, "integration-handoff.md");
	const spec = specPath ? readJsonFile<any>(specPath) : undefined;
	const specLanes = Array.isArray(spec?.lanes) ? spec.lanes : [];
	const promptFiles: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name === "05-worker-prompt.md") promptFiles.push(full);
		}
	};
	walk(rootDir);
	promptFiles.sort((a, b) => {
		const an = laneNumberFromName(path.basename(path.dirname(a)), Number.MAX_SAFE_INTEGER);
		const bn = laneNumberFromName(path.basename(path.dirname(b)), Number.MAX_SAFE_INTEGER);
		if (an !== bn) return an - bn;
		return a.localeCompare(b);
	});
	const lanes: HandoffLane[] = promptFiles.map((promptPath, index) => {
		const dirName = path.basename(path.dirname(promptPath));
		const laneIndex = laneNumberFromName(dirName, index + 1);
		const specLane = specLanes.find((lane: any, i: number) => {
			const name = String(lane?.name ?? "");
			return laneNumberFromName(name, i + 1) === laneIndex || dirName.includes(name);
		}) ?? specLanes[index] ?? {};
		const prompt = fs.readFileSync(promptPath, "utf8");
		const specValidationCommands = Array.isArray(specLane.validation_commands)
			? specLane.validation_commands.map(normalizeHandoffCommand).filter(Boolean)
			: [];
		return {
			id: String(laneIndex).padStart(2, "0"),
			name: String(specLane.name || dirName),
			objective: String(specLane.objective || specLane.summary || dirName),
			summary: typeof specLane.summary === "string" ? specLane.summary : undefined,
			promptPath,
			prompt,
			validationCommands: specValidationCommands.length ? specValidationCommands : parseHandoffValidationCommandsFromPrompt(prompt),
			criteria: Array.isArray(specLane.criteria) ? specLane.criteria : [],
			boundaries: Array.isArray(specLane.boundaries) ? specLane.boundaries : [],
		};
	});
	if (lanes.length === 0) {
		throw new Error(`No lanes/**/05-worker-prompt.md files found under ${rootDir}`);
	}
	// The cross-lane seam is verified by an executable end-to-end gate, preferred from the
	// spec's integration_e2e, otherwise parsed from integration-handoff.md. If neither exists
	// for a multi-lane handoff, the seam is left UNVERIFIED and the run fails at the gate stage.
	const integrationE2e = Array.isArray(spec?.integration_e2e)
		? spec.integration_e2e.map(normalizeHandoffCommand).filter(Boolean) as HandoffValidationCommand[]
		: [];
	const integrationCommands = integrationE2e.length
		? integrationE2e
		: (fs.existsSync(integrationPath)
			? parseIntegrationGateCommands(fs.readFileSync(integrationPath, "utf8"))
			: []);
	return {
		version: 1,
		rootDir,
		createdAt: nowIso(),
		taskName: String(spec?.task_name || path.basename(rootDir)),
		objective: String(spec?.objective || spec?.scope_breadth || "External handoff implementation"),
		specPath,
		readmePath: fs.existsSync(readmePath) ? readmePath : undefined,
		integrationPath: fs.existsSync(integrationPath) ? integrationPath : undefined,
		lanes,
		integrationCommands,
	};
}

function handoffDesignMarkdown(manifest: HandoffManifest): string {
	const readMaybe = (file: string | undefined, max: number) => {
		if (!file || !fs.existsSync(file)) return "";
		return truncateMiddle(fs.readFileSync(file, "utf8"), max);
	};
	return [
		"# External Handoff Design Package",
		"",
		"This artifact was imported from externally prepared handoff documents. Frontier scout/design stages are intentionally skipped; the local harness must implement, validate, review, and repair each lane in order.",
		"",
		`- Handoff root: ${manifest.rootDir}`,
		`- Task: ${manifest.taskName}`,
		`- Objective: ${manifest.objective}`,
		"",
		"## Lane order",
		...manifest.lanes.map((lane) => `- ${lane.id} ${lane.name}: ${lane.objective}`),
		"",
		manifest.specPath ? "## manual-handoff-spec.json" : "",
		readMaybe(manifest.specPath, 60_000),
		manifest.readmePath ? "## README.md" : "",
		readMaybe(manifest.readmePath, 20_000),
		manifest.integrationPath ? "## integration-handoff.md" : "",
		readMaybe(manifest.integrationPath, 30_000),
	].filter((line) => line !== "").join("\n");
}

function progressFromHandoff(manifest: HandoffManifest): HarnessProgress {
	const criteria = manifest.lanes.flatMap((lane) => {
		const laneCriteria = lane.criteria.length
			? lane.criteria
			: [{ requirement: lane.objective, evidence: "Complete lane validation commands and review." }];
		return laneCriteria.map((criterion, index) => ({
			id: `L${lane.id}-AC${index + 1}`,
			description: String(criterion.requirement || criterion.description || lane.objective),
			status: "pending" as CriterionStatus,
			evidence: [],
			verificationContracts: [
				String(criterion.evidence || lane.validationCommands.map((cmd) => cmd.command).join(" && ") || "Manual review of lane output and changed files."),
			],
			evidenceType: lane.validationCommands.length ? "integration" as EvidenceType : "manual" as EvidenceType,
			sourceEvidence: [],
			runtimeEvidence: [],
			adversarialProbes: lane.boundaries.map((b) => String(b.case || b.expected || "boundary probe")).filter(Boolean),
			reentryProbes: [],
			residualGaps: [],
		}));
	});
	return {
		version: 1,
		updatedAt: nowIso(),
		task: manifest.objective,
		currentSliceId: `L${manifest.lanes[0]?.id ?? "01"}`,
		slices: manifest.lanes.map((lane) => ({
			id: `L${lane.id}`,
			title: lane.name,
			status: "pending" as SliceStatus,
			evidence: [],
			remaining: [lane.objective],
		})),
		acceptanceCriteria: criteria,
		frontierRecheckTriggers: [
			{
				id: "HF1",
				description: "A lane cannot be implemented without changing externally supplied acceptance criteria, forbidden paths, or dependency order.",
				active: false,
				evidence: "",
			},
		],
		testObservations: [],
		blockers: [],
		nextAction: `Implement lane ${manifest.lanes[0]?.id ?? "01"} from its 05-worker-prompt.md.`,
	};
}

function importHandoffArtifacts(cwd: string, config: HarnessConfig, state: HarnessState, manifest: HandoffManifest): void {
	ensureStateDir(cwd, config);
	state.task = manifest.objective;
	state.phase = "designed";
	state.createdAt ||= nowIso();
	state.localWorkerModel = config.localWorkerModel;
	state.localReviewerModel = config.localReviewerModel;
	state.frontierModel = config.frontierModel;
	state.frontierThinking = config.frontierThinking;
	writeArtifact(cwd, config, state, "task.md", `# Task\n\n${manifest.objective}\n`);
	writeArtifact(cwd, config, state, "requirements.md", handoffDesignMarkdown(manifest));
	writeArtifact(cwd, config, state, "frontier-design.md", handoffDesignMarkdown(manifest));
	writeArtifact(cwd, config, state, "handoff-manifest.json", JSON.stringify(manifest, null, "\t"));
	writeArtifact(cwd, config, state, "implementation-plan.json", JSON.stringify(progressFromHandoff(manifest), null, "\t"));
	writeProgress(cwd, config, state, progressFromHandoff(manifest));
	saveState(cwd, config, state);
}

function handoffWorkerPrompt(manifest: HandoffManifest, lane: HandoffLane, attempt: number, config: HarnessConfig): string {
	const repairContext = attempt > 1
		? [
			"",
			"## Repair context",
			`This is repair attempt ${attempt}. Read ${config.stateDir}/local-review.md, ${config.stateDir}/verification-summary.md, ${config.stateDir}/progress.md, and fix only the concrete lane blockers before re-running validation.`,
		]
		: [];
	return [
		"You are the LOCAL IMPLEMENTER consuming an externally prepared handoff.",
		"Run this lane in a fresh Pi child session. Do not edit handoff source files under outputs/** or the handoff directory. Implement only in the repository paths allowed by the worker prompt.",
		"Before relying on previous lanes, verify their accepted outputs from the current repo. Do not invent APIs or files that are not present.",
		"When finished, report changed files, validation commands/results, adversarial or reentry probes, and remaining blockers.",
		"",
		`Handoff root: ${manifest.rootDir}`,
		`Task: ${manifest.taskName}`,
		`Lane ${lane.id}: ${lane.name}`,
		`Objective: ${lane.objective}`,
		...repairContext,
		"",
		"## Worker prompt",
		lane.prompt,
	].join("\n");
}

function handoffReviewPrompt(manifest: HandoffManifest, lane: HandoffLane, config: HarnessConfig): string {
	return [
		"You are the LOCAL REVIEWER for an externally prepared handoff lane. Review only; do not modify files.",
		"Be strict about validation evidence, path constraints, cross-lane dependencies, and whether the lane's 05-worker-prompt.md was actually satisfied.",
		"You may run read-only inspection and validation commands with bash, but do not edit files.",
		"",
		`Task: ${manifest.taskName}`,
		`Lane ${lane.id}: ${lane.name}`,
		`Objective: ${lane.objective}`,
		"",
		"Read these artifacts:",
		`- ${config.stateDir}/requirements.md`,
		`- ${config.stateDir}/progress.md and ${config.stateDir}/progress.json`,
		`- ${config.stateDir}/test-evidence.md`,
		`- ${config.stateDir}/verification-summary.md`,
		`- ${config.stateDir}/local-log.md`,
		`- ${config.stateDir}/git-summary.md`,
		"",
		"Output a fenced JSON object first, then optional markdown details. JSON schema:",
		`{"verdict":"PASS|PASS_WITH_CONCERNS|FAIL","blockingIssues":["..."],"missingEvidence":["..."],"nonBlockingConcerns":["..."],"requiredFixes":["..."],"nextAction":"..."}`,
		"Rules:",
		"- PASS only when the lane is implemented, the relevant validation actually ran and passed (recorded in test-evidence.md/verification-summary.md), and no path/dependency violation is visible.",
		"- FAIL if validation failed, evidence is missing, outputs/** or handoff files were edited, another user's accepted previous-lane behavior was broken, or the implementation skipped required behavior.",
		"- An acceptance criterion whose only evidence is an un-executed manual audit (no recorded command output) is UNVERIFIED, not satisfied. A manual-validation gap on a behavioral criterion is blocking: if a required behavioral criterion is UNVERIFIED, return FAIL and name it in missingEvidence. Do not let 'manual audit required' or 'no automated test configured' pass the lane.",
		"- Cross-component seam criteria (this lane's code calling another lane's interface, e.g. a client calling a server route) require integration/e2e evidence that exercises the real interface end to end; this lane's own unit tests plus a build are smoke for the seam. Confirm the consumer's verb/path/arguments match the producer's contract and that shared semantics (e.g. the meaning of now/today) agree on both sides. A PATCH vs PUT mismatch or a divergent date anchor passes each lane in isolation while the integrated app is broken.",
		"- PASS_WITH_CONCERNS is allowed only for genuinely non-blocking documentation gaps -- never for an un-executed manual audit of behavioral acceptance, nor for an unverified cross-component seam.",
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
		{ id: "plan-review", label: "Serious task plan validation", status: "pending" },
		{ id: "local-loop", label: "Local worker/test loops", status: "pending" },
		{ id: "finish", label: "Deterministic finish/reconcile", status: "pending" },
		{ id: "local-review", label: "Frontier implementation review", status: "pending" },
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
	const currentSlice =
		progress.slices.find((slice) => slice.id === progress.currentSliceId) ??
		progress.slices.find((slice) => slice.status === "in_progress") ??
		progress.slices.find((slice) => slice.status === "pending");
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
		currentSliceId: currentSlice?.id ?? progress.currentSliceId,
		currentSliceTitle: currentSlice?.title,
		currentSliceStatus: currentSlice?.status,
		currentSliceRemaining: currentSlice?.remaining[0],
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

function childModelText(child: HybridChildStats): string | undefined {
	if (!child.model) return undefined;
	return `모델 ${child.model}`;
}

function ratioBar(done: number, total: number, width = 12): string {
	const safeTotal = Math.max(0, total);
	const safeDone = Math.max(0, Math.min(done, safeTotal));
	if (safeTotal <= 0) return "░".repeat(width);
	const filled = Math.round((safeDone / safeTotal) * width);
	return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function statusBadge(theme: any, label: string, tone: string): string {
	return theme.fg(tone, `[ ${label} ]`);
}

function hybridStageLabelKo(stage: HybridRunStage | string | undefined): string {
	const id = typeof stage === "string" ? stage : stage?.id;
	const label = typeof stage === "string" ? stage : stage?.label;
	switch (id) {
		case "checkpoint":
			return "사전 체크";
		case "design":
			return "저장소 조사 및 frontier 설계";
		case "brief":
			return "오케스트레이션 브리핑";
		case "plan-review":
			return "실행 계획 검증";
		case "local-loop":
			return "로컬 구현/테스트 루프";
		case "finish":
			return "결과 정리 및 검증";
		case "local-review":
			return "frontier 구현 리뷰";
		case "frontier-final":
			return "frontier 최종 게이트";
		case "summary":
			return "아티팩트 요약";
		default:
			return label ?? id ?? "알 수 없음";
	}
}

function hybridStatusKo(status: HybridRunDetails["status"]): string {
	if (status === "running") return "실행 중";
	if (status === "failed") return "실패";
	return "완료";
}

function hybridConvergenceKo(convergence: Convergence): {
	label: string;
	tone: string;
	hint?: string;
} {
	switch (convergence) {
		case "complete":
			return { label: "완료", tone: "success" };
		case "progressing":
			return { label: "진행 중", tone: "accent" };
		case "stalled":
			return {
				label: "교착 — 변경 없음",
				tone: "warning",
				hint: "같은 패키지 재전송 금지. 블로커를 타겟하거나 escalate.",
			};
		case "blocked-no-tests":
			return {
				label: "막힘 — 행동 테스트 없음",
				tone: "error",
				hint: "런타임/e2e 테스트를 추가하거나 escalate. 구현/디버그 패키지 추가 금지.",
			};
	}
}

function hybridStageStatusKo(status: HybridStageStatus): string {
	if (status === "running") return "진행 중";
	if (status === "done") return "완료";
	if (status === "failed") return "실패";
	if (status === "skipped") return "건너뜀";
	return "대기";
}

function hybridSliceStatusKo(status: SliceStatus | undefined): string {
	if (status === "in_progress") return "구현 중";
	if (status === "done") return "완료";
	if (status === "blocked") return "차단";
	return "대기";
}

function verdictLabelKo(verdict: string): string {
	if (verdict === "FAIL") return "판정: FAIL";
	if (verdict === "PASS_WITH_CONCERNS") return "판정: PASS_WITH_CONCERNS";
	if (verdict === "PASS") return "판정: PASS";
	return `판정: ${verdict}`;
}

function stageSummaryKo(summary: string | undefined): string {
	if (!summary) return "";
	const fields = Object.fromEntries(
		summary
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const [key, ...rest] = part.split("=");
				return [key.trim(), rest.join("=").trim()];
			})
			.filter(([key, value]) => key && value),
	);
	const parts: string[] = [];
	if (fields.verdict) parts.push(verdictLabelKo(fields.verdict));
	if (fields.reason) parts.push(`이유: ${fields.reason}`);
	if (fields.next) parts.push(`다음: ${fields.next}`);
	if (fields.child) parts.push(`하위 실행: ${fields.child}`);
	if (!parts.length) return summary;
	return parts.join(" · ");
}

function koreanHybridRunOverviewLines(
	details: HybridRunDetails,
	theme: any,
	now = Date.now(),
): string[] {
	const fg = (name: string, text: string) => theme.fg(name, text);
	const lines: string[] = [];
	const statusColor =
		details.status === "failed"
			? "error"
			: details.status === "done"
				? "success"
				: "accent";
	const runningStage = details.stages.find((stage) => stage.status === "running");
	const lastDoneStage = [...details.stages].reverse().find((stage) => stage.status === "done");
	const currentStage = runningStage ?? lastDoneStage ?? details.stages.find((stage) => stage.status !== "pending");
	const currentChild = details.currentChild
		? details.children[details.currentChild]
		: Object.values(details.children).find((child) => child.status === "running");
	const currentChildModel = currentChild ? childModelText(currentChild) : undefined;
	const currentFacts = [
		currentStage ? `${hybridStageLabelKo(currentStage)}(${hybridStageStatusKo(currentStage.status)})` : "",
		currentChild
			? `${currentChild.label}${currentChildModel ? ` · ${currentChildModel}` : ""} ${hybridStageStatusKo(currentChild.status)}`
			: "",
		details.currentTool ? `도구 ${details.currentTool}` : "",
	].filter(Boolean);

	lines.push(
		`${fg("accent", "현재 상황")} ${statusBadge(theme, hybridStatusKo(details.status), statusColor)} ${statusBadge(theme, details.mode, "dim")}`,
	);
	lines.push(`${fg("dim", "작업")} ${truncateMiddle(details.task, 140)}`);
	if (details.writerSessionId) {
		const sessionParts = [
			truncateMiddle(details.writerSessionId, 80),
			details.writerSessionDir ? truncateMiddle(details.writerSessionDir, 80) : undefined,
		].filter(Boolean);
		lines.push(`${fg("dim", "writer 세션")} ${sessionParts.join(" · ")}`);
	}
	lines.push(
		`${fg("dim", "현재 실행")} ${currentFacts.length ? currentFacts.join(" · ") : "대기 중"}`,
	);
	if (details.progress) {
		const p = details.progress;
		if (p.currentSliceId || p.currentSliceTitle) {
			const sliceParts = [
				p.currentSliceId,
				p.currentSliceTitle,
				hybridSliceStatusKo(p.currentSliceStatus),
			].filter(Boolean);
			const remaining = p.currentSliceRemaining
				? ` · 남은 작업 ${truncateMiddle(p.currentSliceRemaining, 120)}`
				: "";
			lines.push(`${fg("dim", "현재 슬라이스")} ${sliceParts.join(" · ")}${remaining}`);
		}
		const progressParts = [
			`tasks/조각 ${fg("success", ratioBar(p.slicesDone, p.slicesTotal))} 완료 ${p.slicesDone}/${p.slicesTotal}`,
			`승인 기준 ${fg("success", ratioBar(p.acceptanceSatisfied, p.acceptanceTotal))} ${p.acceptanceSatisfied}/${p.acceptanceTotal}`,
			`frontier 재확인 ${p.activeFrontierTriggers}`,
		];
		lines.push(`${fg("dim", "진행률")} ${progressParts.join(" · ")}`);
		if (p.nextAction) {
			lines.push(`${fg("dim", "다음 행동")} ${truncateMiddle(p.nextAction, 180)}`);
		}
	}
	if (details.convergence) {
		const cv = hybridConvergenceKo(details.convergence);
		const repeat =
			details.repeatedNonProgress && details.repeatedNonProgress >= 2
				? ` · 무진전 ${details.repeatedNonProgress}회`
				: "";
		lines.push(`${fg("dim", "수렴")} ${statusBadge(theme, cv.label, cv.tone)}${repeat}`);
		if (cv.hint) lines.push(`${fg(cv.tone, "→")} ${cv.hint}`);
	}
	if (currentChild) {
		lines.push(`${fg("dim", "최근 활동")} ${childActivity(currentChild, now)}`);
	}
	return lines;
}

function hybridStageFlowLine(details: HybridRunDetails, theme: any): string {
	const parts = details.stages.map((stage) => {
		const tone =
			stage.status === "failed"
				? "error"
				: stage.status === "running"
					? "accent"
					: stage.status === "done"
						? "success"
						: "dim";
		const summary = stageSummaryKo(stage.summary);
		return `${theme.fg(tone, hybridStageIcon(stage.status))} ${hybridStageLabelKo(stage)}${summary ? ` (${summary})` : ""}`;
	});
	return `${theme.fg("accent", "단계 흐름")} ${parts.join("  ")}`;
}

function compactHybridLiveOutput(lines: string[]): string[] {
	const compacted: string[] = [];
	let inProgress = false;
	const seenProgress = new Set<string>();
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "# Hybrid Progress") {
			inProgress = true;
			if (!seenProgress.has("progress-start")) {
				compacted.push("progress.md 갱신됨");
				seenProgress.add("progress-start");
			}
			continue;
		}
		if (inProgress) {
			if (/^#\s+/.test(line) && line !== "# Hybrid Progress") {
				inProgress = false;
			} else {
				const keep = line.match(/^- (현재 단계|완료된 조각|충족된 승인 기준|다음 행동|차단 사유):\s*(.+)$/);
				if (keep?.[1] && keep[2]) {
					const summary = `progress: ${keep[1]} ${keep[2]}`;
					if (!seenProgress.has(summary)) {
						compacted.push(summary);
						seenProgress.add(summary);
					}
				}
				continue;
			}
		}
		if (!line) continue;
		compacted.push(raw);
	}
	return compacted;
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
		value.mode === "fast" || value.mode === "thorough" || value.mode === "handoff"
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
		model: typeof child.model === "string" ? child.model : undefined,
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
	let lastRenderRequestAt = 0;
	let pendingRenderRequest: ReturnType<typeof setTimeout> | undefined;
	const requestRenderThrottled = () => {
		if (!ctx?.ui?.requestRender) return;
		const now = Date.now();
		const minIntervalMs = 250;
		const elapsed = now - lastRenderRequestAt;
		if (elapsed >= minIntervalMs) {
			lastRenderRequestAt = now;
			ctx.ui.requestRender();
			return;
		}
		if (pendingRenderRequest) return;
		pendingRenderRequest = setTimeout(() => {
			pendingRenderRequest = undefined;
			lastRenderRequestAt = Date.now();
			ctx.ui.requestRender?.();
		}, minIntervalMs - elapsed);
		pendingRenderRequest.unref?.();
	};
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
		requestRenderThrottled();
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
			if (typeof event.model === "string" && event.model.trim()) {
				child.model = event.model.trim();
			}
			child.updatedAt = timestamp;
			details.currentChild = label;
			if (event.type === "child_start") {
				child.status = "running";
			} else if (event.type === "tool_execution_start") {
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

	for (const line of koreanHybridRunOverviewLines(details, theme, now)) {
		c.addChild(new Text(fit(line), 0, 0));
	}
	c.addChild(new Text(fit(hybridStageFlowLine(details, theme)), 0, 0));
	c.addChild(new Spacer(1));

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
	c.addChild(new Text(fit(theme.fg("accent", themeBold(theme, "단계 흐름"))), 0, 0));
	for (const stage of details.stages) {
		const icon = stageIcon(stage.status, theme, stageIdx === 0 && isRunning ? runningStageSeed : undefined);
		const suffix = stage.summary
			? ` — ${truncateMiddle(stage.summary, expanded ? 240 : 120)}`
			: "";
		c.addChild(new Text(fit(`${icon} ${themeBold(theme, hybridStageLabelKo(stage))}${suffix}`), 0, 0));
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

			const model = childModelText(child);
			const header = `${cs} ${themeBold(theme, child.label)}${model ? ` · ${theme.fg("dim", model)}` : ""} · ${statJoin(theme, parts)}`;
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
	if (details.writerSessionId) {
		lines.push(
			`Writer session: ${details.writerSessionId}${details.writerSessionDir ? ` (${details.writerSessionDir})` : ""}`,
		);
	}
	if (details.progress) {
		lines.push(
			`Progress: tasks/slices completed ${details.progress.slicesDone}/${details.progress.slicesTotal} · AC ${details.progress.acceptanceSatisfied}/${details.progress.acceptanceTotal} · active frontier triggers ${details.progress.activeFrontierTriggers}`,
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
	if (details.convergence) {
		const repeat =
			details.repeatedNonProgress && details.repeatedNonProgress >= 2
				? ` (no progress x${details.repeatedNonProgress})`
				: "";
		lines.push(`Convergence: ${details.convergence}${repeat}`);
		if (
			details.convergence === "stalled" ||
			details.convergence === "blocked-no-tests"
		) {
			lines.push(`  → ${truncateMiddle(convergenceDirective(details.convergence), 200)}`);
		}
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
			const model = childModelText(child) ? ` · ${childModelText(child)}` : "";
			lines.push(
				`${status} ${child.label}${model}${tool} · ${child.toolCalls} tools · ${formatApproxTokenCount(tokenTotal, childHasEstimatedTokens(child))} tok · ${duration}`,
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
		label: "Local control reviewer",
		description: "Local progress extraction, repair checks, and bookkeeping",
	},
	{
		key: "frontierModel",
		label: "Frontier",
		description: "Design, plan review, implementation review, and final approval gates",
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

type HybridGateAction =
	| { kind: "answer"; text: string }
	| { kind: "edit" }
	| { kind: "run" }
	| { kind: "grill" }
	| { kind: "close" };

interface HybridGateChoice {
	label: string;
	value: string;
	description?: string;
	marker?: string;
}

interface HybridReportOverlayOptions {
	choices?: HybridGateChoice[];
	ready?: boolean;
	allowGrill?: boolean;
	showEditChoice?: boolean;
	editLabel?: string;
	editDescription?: string;
	runLabel?: string;
	runDescription?: string;
	pickerTitle?: string;
}

class HybridReportOverlayComponent implements Component {
	private scrollOffset = Number.MAX_SAFE_INTEGER;
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	private selectList?: SelectList;
	private readonly gateItems: SelectItem[];
	private selectedGateIndex = 0;

	constructor(
		private readonly tui: TUI,
		private readonly title: string,
		private readonly markdown: string,
		private readonly theme: any,
		private readonly done: (result?: HybridGateAction) => void,
		private readonly options: HybridReportOverlayOptions = {},
	) {
		this.gateItems = this.buildGateItems();
		this.selectList = this.gateItems.length ? this.makeSelectList() : undefined;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
		this.selectList?.invalidate();
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, Key.f8) ||
			data === "q" ||
			data === "Q"
		) {
			this.done({ kind: "close" });
			return;
		}
		if (data === "e" || data === "E") {
			this.done({ kind: "edit" });
			return;
		}
		if (this.options.ready && (data === "r" || data === "R")) {
			this.done({ kind: "run" });
			return;
		}
		if (
			this.options.ready &&
			this.options.allowGrill &&
			(data === "g" || data === "G")
		) {
			this.done({ kind: "grill" });
			return;
		}
		const numeric = Number.parseInt(data, 10);
		if (
			Number.isInteger(numeric) &&
			numeric >= 1 &&
			numeric <= this.gateItems.length
		) {
			this.selectGateItem(this.gateItems[numeric - 1]);
			return;
		}
		const alphaIndex = data.length === 1
			? data.toUpperCase().charCodeAt(0) - "A".charCodeAt(0)
			: -1;
		if (
			alphaIndex >= 0 &&
			alphaIndex < (this.options.choices?.length ?? 0)
		) {
			this.selectGateItem(this.gateItems[alphaIndex]);
			return;
		}
		if (this.gateItems.length && matchesKey(data, Key.enter)) {
			this.selectGateItem(this.gateItems[this.selectedGateIndex]);
			this.tui.requestRender();
			return;
		}
		if (this.gateItems.length && (
			matchesKey(data, Key.left) ||
			matchesKey(data, Key.right)
		)) {
			this.moveGateSelection(matchesKey(data, Key.left) ? -1 : 1);
			this.tui.requestRender();
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

	private buildGateItems(): SelectItem[] {
		const items: SelectItem[] = [];
		for (const [index, choice] of (this.options.choices ?? []).entries()) {
			const marker = choice.marker ?? String(index + 1);
			items.push({
				value: `answer:${choice.value}`,
				label: `${marker}. ${choice.label}`,
				description: choice.description,
			});
		}
		if (this.options.showEditChoice) {
			items.push({
				value: "edit",
				label: this.options.editLabel ?? "e. 직접 입력",
				description:
					this.options.editDescription ?? "선택지와 다른 내용을 직접 입력합니다.",
			});
		}
		if (this.options.ready) {
			items.push({
				value: "run",
				label: this.options.runLabel ?? "r. 이 내용으로 run 실행",
				description:
					this.options.runDescription ??
					"현재 확정 내용을 승인하고 /hybrid-run을 시작합니다.",
			});
			if (this.options.allowGrill) {
				items.push({
					value: "grill",
					label: "g. 그래도 grill로 설계 검토 먼저",
					description: "구현 전에 /hybrid-grill로 리스크와 설계를 압박 검토합니다.",
				});
			}
		}
		return items;
	}

	private makeSelectList(): SelectList {
		const list = new SelectList(this.gateItems, Math.min(this.gateItems.length, 8), {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("warning", text),
		});
		list.onSelect = (item) => this.selectGateItem(item);
		list.onCancel = () => this.done({ kind: "close" });
		return list;
	}

	private moveGateSelection(delta: number): void {
		if (!this.gateItems.length) return;
		this.selectedGateIndex =
			(this.selectedGateIndex + delta + this.gateItems.length) %
			this.gateItems.length;
		this.selectList?.setSelectedIndex(this.selectedGateIndex);
	}

	private selectGateItem(item: SelectItem): void {
		if (item.value === "edit") {
			this.done({ kind: "edit" });
			return;
		}
		if (item.value === "run") {
			this.done({ kind: "run" });
			return;
		}
		if (item.value === "grill") {
			this.done({ kind: "grill" });
			return;
		}
		if (item.value.startsWith("answer:")) {
			this.done({ kind: "answer", text: item.value.slice("answer:".length) });
		}
	}

	private renderGateItem(item: SelectItem, index: number, width: number): string {
		const selected = index === this.selectedGateIndex;
		const prefix = selected ? "▶ " : "  ";
		const text = `${prefix}${item.label}${item.description ? ` — ${item.description}` : ""}`;
		const styled = selected ? this.theme.fg("accent", text) : text;
		return truncateToWidth(normalizeTuiText(styled), width, "…", true);
	}

	render(width: number): string[] {
		const panelWidth = Math.max(60, Math.min(width, 120));
		const innerW = panelWidth - 2;
		const bodyW = Math.max(20, innerW - 2);
		const pickerLinesHeight = this.selectList
			? Math.min(this.gateItems.length, 8) + (this.gateItems.length > 8 ? 1 : 0)
			: 0;
		const pickerHeight = this.selectList ? pickerLinesHeight + 2 : 0;
		const bodyHeight = Math.max(14, 28 - pickerHeight);
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
		for (let i = visible.length; i < bodyHeight; i++)
			lines.push(row(""));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		if (this.selectList) {
			const pickerTitle = this.options.pickerTitle ?? (this.options.ready
				? " 선택하세요: run 실행 / grill 먼저 / 직접 입력"
				: " 선택지를 고르거나 e로 직접 입력하세요");
			lines.push(row(th.fg("dim", pickerTitle)));
			const pickerStart = Math.min(
				Math.max(0, this.selectedGateIndex - pickerLinesHeight + 1),
				Math.max(0, this.gateItems.length - pickerLinesHeight),
			);
			for (let i = 0; i < pickerLinesHeight; i++)
				lines.push(
					row(` ${this.gateItems[pickerStart + i] ? this.renderGateItem(this.gateItems[pickerStart + i], pickerStart + i, bodyW) : ""}`),
				);
			lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		}
		const scroll = this.cachedLines.length > bodyHeight
			? ` ${start + 1}-${end}/${this.cachedLines.length}`
			: "";
		const actionHint = this.options.ready
			? `↑↓/j/k scroll · ←/→ picker · Enter 선택 · r run${this.options.allowGrill ? " · g grill" : ""} · e 직접 입력 · q/Esc 닫기${scroll}`
			: `↑↓/j/k scroll · Enter/A/B/C/숫자 선택 · ←/→ picker · e 직접 입력 · q/Esc 닫기${scroll}`;
		lines.push(row(` ${th.fg("dim", actionHint)}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}
}

class HybridGateLoadingOverlayComponent implements Component {
	private closed = false;
	private frameIndex = 0;
	private readonly frames = ["-", "\\", "|", "/"];
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly title: string,
		private readonly message: string,
		private readonly detail: string,
		private readonly theme: any,
		private readonly done: () => void,
	) {
		this.timer = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % this.frames.length;
			this.tui.requestRender();
		}, 120);
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

	handleInput(_data: string): void {}

	render(width: number): string[] {
		const panelWidth = Math.max(60, Math.min(width, 96));
		const innerW = panelWidth - 2;
		const th = this.theme;
		const row = (content = "") =>
			`${th.fg("border", "│")}${truncateToWidth(normalizeTuiText(content), innerW, "…", true)}${th.fg("border", "│")}`;
		const frame = this.frames[this.frameIndex] ?? "-";
		return [
			th.fg("border", `╭${"─".repeat(innerW)}╮`),
			row(` ${th.fg("accent", themeBold(th, this.title))}`),
			th.fg("border", `├${"─".repeat(innerW)}┤`),
			row(` ${th.fg("accent", frame)} ${this.message}`),
			row(` ${th.fg("dim", this.detail)}`),
			row(` ${th.fg("dim", "완료되면 다음 모달이 열립니다.")}`),
			th.fg("border", `╰${"─".repeat(innerW)}╯`),
		];
	}
}

function stripHybridArtifactFooter(text: string): string {
	return text.split(/^## stderr\s*$/m)[0] ?? text;
}

function cleanHybridChoiceText(text: string): string {
	return text
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.;。]\s*$/, "");
}

function extractHybridGateChoices(markdown: string): HybridGateChoice[] {
	const lines = stripHybridArtifactFooter(markdown).split("\n");
	const choices: HybridGateChoice[] = [];
	let inChoiceSection = false;
	let choiceContextLines = 0;
	let recommended: string | undefined;
	const seen = new Set<string>();
	const push = (value: string, label = value, description?: string, marker?: string) => {
		const cleanValue = cleanHybridChoiceText(value);
		if (!cleanValue || cleanValue.length < 2 || seen.has(cleanValue)) return;
		seen.add(cleanValue);
		choices.push({
			value: cleanValue,
			label: cleanHybridChoiceText(label).slice(0, 110),
			description,
			marker,
		});
	};
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^(#{1,6}\s*)?(choices?|options?|선택지|답변\s*선택지|후보\s*답변|recommended answer|추천\s*답변|권장\s*답변)\b/i.test(line)) {
			inChoiceSection = true;
			choiceContextLines = 6;
			const afterColon = line.split(/[:：]/).slice(1).join(":").trim();
			if (afterColon) {
				recommended = afterColon;
				push(afterColon, `${afterColon} (recommended)`, "추천 답변");
			}
			continue;
		}
		const recommendedMatch = line.match(/^(?:[-*]\s*)?(?:recommended answer|추천\s*답변|권장\s*답변)\s*[:：]\s*(.+)$/i);
		if (recommendedMatch?.[1]) {
			recommended = recommendedMatch[1];
			push(recommended, `${recommended} (recommended)`, "추천 답변");
			inChoiceSection = true;
			choiceContextLines = 6;
			continue;
		}
		if (/(next question|choose|select|answer with|recommended|다음\s*질문|고르|선택|답변|추천|확정할까요|할까요)/i.test(line)) {
			choiceContextLines = 6;
		}
		const choiceMatch = line.match(/^(?:[-*]\s*)?(?:(?:option|choice)\s*)?([0-9]{1,2}|[A-Ca-c]|[가-다])[\.)、:：]\s+(.+)$/i);
		const bulletChoiceMatch = inChoiceSection
			? line.match(/^[-*]\s+(.+)$/)
			: undefined;
		const optionPrefixed = /^(?:[-*]\s*)?(?:option|choice)\s+/i.test(line);
		const marker = choiceMatch?.[1];
		const markerIndex = marker && /^[A-Ca-c]$/.test(marker)
			? marker.toUpperCase().charCodeAt(0) - "A".charCodeAt(0)
			: -1;
		const value =
			(choiceMatch && (inChoiceSection || choiceContextLines > 0 || optionPrefixed || markerIndex >= 0)
				? choiceMatch[2]
				: undefined) ?? bulletChoiceMatch?.[1];
		if (value) {
			const suffix = recommended && cleanHybridChoiceText(value) === cleanHybridChoiceText(recommended)
				? " (recommended)"
				: "";
			push(value, `${value}${suffix}`, undefined, marker);
		} else if (inChoiceSection && /^#{1,6}\s+/.test(line)) {
			inChoiceSection = false;
		}
		if (choiceContextLines > 0) choiceContextLines--;
		if (choices.length >= 6) break;
	}
	return choices;
}

function extractHybridInterviewAnswerDraft(text: string): string {
	const answerMatch = /^## Answer\s*$/m.exec(text);
	if (!answerMatch) return text.trim();
	const start = answerMatch.index + answerMatch[0].length;
	const rest = text.slice(start);
	const referenceMatch = /^## Current interview\s*$/m.exec(rest);
	const answer = referenceMatch ? rest.slice(0, referenceMatch.index) : rest;
	return answer.trim();
}

function frontierGateReadyForHybridRun(
	kind: "interview" | "grill",
	text: string,
): boolean {
	const lower = text.toLowerCase();
	if (!text.trim() || lower.includes("(no output)")) return false;
	if (kind === "interview") {
		const hasHandoff =
			lower.includes("implementation-ready") ||
			(lower.includes("source request") &&
				lower.includes("desired outcome") &&
				lower.includes("acceptance criteria") &&
				lower.includes("verification contracts"));
		return hasHandoff;
	}
	const waitingForAnswer =
		lower.includes("next question") ||
		lower.includes("ask exactly one") ||
		text.includes("다음 질문") ||
		text.includes("답변해");
	return !waitingForAnswer;
}

function hybridGateApprovalSummaryKo(
	kind: "interview" | "grill",
	report: string,
): string {
	const body = stripHybridArtifactFooter(report)
		.split("\n")
		.filter((line) => !/^- (model|thinking|ok|exitCode|usage):/i.test(line.trim()))
		.join("\n")
		.trim();
	const title = kind === "interview"
		? "Interview 결과: 구현에 들어갈 수 있는 수준입니다"
		: "Grill 결과: 이 내용으로 구현에 들어갈 수 있는 수준입니다";
	const action = kind === "interview"
		? "이대로 충분합니다. run 할까요? 그래도 grill을 먼저 할까요?"
		: "이제 충분합니다. 이 내용으로 run 할까요?";
	return [
		`# ${title}`,
		"",
		"## 한국어 확인",
		"",
		"- 아래 내용은 현재까지 확정된 요구사항/설계 판단입니다.",
		"- 자동으로 run을 시작하지 않습니다. 사용자가 승인 키를 눌러야 진행합니다.",
		`- ${action}`,
		"",
		"## 현재까지 확정된 내용",
		"",
		truncateMiddle(body || report, 18_000),
	].join("\n");
}

function extractHybridGateTask(report: string): string {
	const body = stripHybridArtifactFooter(report);
	const sourceRequest = body.match(
		/^#{1,6}\s+Source Request\s*\n([\s\S]*?)(?=^#{1,6}\s+|\s*$)/im,
	)?.[1];
	const candidate =
		sourceRequest
			?.split("\n")
			.map((line) => line.replace(/^[-*]\s*/, "").trim())
			.find(Boolean) ??
		body
			.split("\n")
			.map((line) => line.replace(/^#{1,6}\s*/, "").trim())
			.find((line) => line && !/^[-*]\s*(model|thinking|ok|exitCode|usage):/i.test(line));
	return truncateMiddle(candidate ?? "", 500).trim();
}

function ensureHybridGateTaskForRun(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	report: string,
): string {
	const taskArtifact = readArtifact(cwd, config, "task.md")
		.replace(/^# Task\s*/i, "")
		.trim();
	const task = state.task?.trim() || taskArtifact || extractHybridGateTask(report);
	if (!task) {
		throw new Error(
			"Hybrid gate is ready, but no task is recorded. Run /hybrid-interview or /hybrid-grill with the task text first.",
		);
	}
	state.task = task;
	if (!taskArtifact) {
		writeArtifact(cwd, config, state, "task.md", `# Task\n\n${task}\n`);
	}
	saveState(cwd, config, state);
	return task;
}

function showHybridGateLoading(
	ctx: any,
	title: string,
	message: string,
	detail: string,
): (() => Promise<void>) | undefined {
	if (!(ctx?.hasUI && ctx?.ui?.custom)) return undefined;
	let closed = false;
	let component: HybridGateLoadingOverlayComponent | undefined;
	const overlay = ctx.ui.custom(
		(tui: TUI, theme: any, _keybindings: unknown, done: () => void) => {
			component = new HybridGateLoadingOverlayComponent(
				tui,
				title,
				message,
				detail,
				theme,
				done,
			);
			if (closed) queueMicrotask(() => component?.close());
			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "80%",
				minWidth: 60,
				maxHeight: "40%",
			},
		},
	).catch(() => undefined);
	return async () => {
		if (closed) return;
		closed = true;
		component?.close();
		await overlay;
	};
}

async function runWithHybridGateLoading<T>(
	ctx: any,
	title: string,
	message: string,
	detail: string,
	operation: () => Promise<T>,
): Promise<T> {
	const closeLoading = showHybridGateLoading(ctx, title, message, detail);
	try {
		return await operation();
	} finally {
		await closeLoading?.();
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
			// createHybridReporter and the monitor overlay throttle render requests;
			// avoid an extra full-screen repaint for every child event here.
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

function startHandoffBackgroundRun(options: {
	pi: ExtensionAPI;
	cwd: string;
	ctx?: any;
	handoffDir?: string;
	resume?: boolean;
	configOverrides?: Partial<HarnessConfig>;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<HybridRunDetails>) => void;
}): { liveId: string; details: HybridRunDetails; promise: Promise<HybridRunDetails> } {
	const existing = getHybridActiveRun();
	if (existing) throw new Error(`Hybrid run already active (${existing.liveId}). Use /hybrid-monitor or /hybrid-cancel.`);
	const config = loadConfig(options.cwd, options.configOverrides ?? {});
	const existingLock = readHybridRunLock(options.cwd, config);
	if (existingLock && !isHybridRunLockStale(existingLock)) {
		throw new Error(`Hybrid run already active (${existingLock.liveId}). Use /hybrid-monitor or /hybrid-cancel.`);
	}
	if (existingLock && isHybridRunLockStale(existingLock)) clearHybridRunLock(options.cwd, config, existingLock.liveId);
	const taskPreview = options.resume
		? readHandoffManifest(options.cwd, config)?.objective || "resume imported handoff"
		: `handoff ${options.handoffDir || ""}`.trim();
	const liveId = makeHybridLiveId();
	const controller = new AbortController();
	const store = getHybridLiveStore();
	let version = 0;
	const details = createHybridRunDetails(taskPreview, "handoff", config);
	details.currentStage = "background";
	details.recentOutput.push("Hybrid handoff run is running in the background. Use /hybrid-monitor, /hybrid-steer, or /hybrid-cancel.");
	store.set(liveId, { version: ++version, details });
	setLastHybridLiveId(liveId);
	options.pi.sendMessage({
		customType: HYBRID_RUN_MESSAGE_TYPE,
		content: `Hybrid handoff run starting: ${taskPreview}`,
		display: true,
		details: { liveId, fallback: details },
	});
	writeHybridRunLock(options.cwd, config, {
		version: 1,
		liveId,
		pid: process.pid,
		cwd: options.cwd,
		task: taskPreview,
		mode: "handoff",
		status: "running",
		startedAt: nowIso(),
		updatedAt: nowIso(),
		currentStage: details.currentStage,
	});
	const parentAbort = () => controller.abort();
	options.signal?.addEventListener("abort", parentAbort, { once: true });
	const heartbeat = setInterval(() => {
		const lock = heartbeatHybridRunLock(options.cwd, config, liveId, details.currentStage);
		if (lock?.cancelRequestedAt) controller.abort();
	}, 5000);
	heartbeat.unref?.();
	const promise = runHandoffOrchestration({
		cwd: options.cwd,
		ctx: options.ctx,
		handoffDir: options.handoffDir,
		resume: options.resume,
		configOverrides: options.configOverrides,
		signal: controller.signal,
		onUpdate: (result) => {
			if (result.details) {
				details.currentStage = result.details.currentStage;
				store.set(liveId, { version: ++version, details: result.details });
				heartbeatHybridRunLock(options.cwd, config, liveId, result.details.currentStage);
			}
			options.onUpdate?.(result);
			// createHybridReporter and the monitor overlay throttle render requests;
			// avoid an extra full-screen repaint for every child event here.
		},
	})
		.then((finalDetails) => {
			store.set(liveId, { version: ++version, details: finalDetails });
			options.onUpdate?.({ content: [{ type: "text", text: hybridDetailsToMarkdown(finalDetails, true) }], details: finalDetails, isError: finalDetails.status === "failed" });
			options.ctx?.ui?.requestRender?.();
			options.ctx?.ui?.notify?.(`Hybrid handoff run ${finalDetails.status}: ${finalDetails.localVerdict ?? finalDetails.error ?? "see monitor"}`, finalDetails.status === "failed" ? "error" : "info");
			return finalDetails;
		})
		.catch((error) => {
			const failed = createHybridRunDetails(taskPreview, "handoff", config);
			failed.status = "failed";
			failed.finishedAt = nowIso();
			failed.error = String(error instanceof Error ? error.message : error);
			store.set(liveId, { version: ++version, details: failed });
			options.onUpdate?.({ content: [{ type: "text", text: hybridDetailsToMarkdown(failed, true) }], details: failed, isError: true });
			options.ctx?.ui?.requestRender?.();
			options.ctx?.ui?.notify?.(`Hybrid handoff run failed: ${failed.error}`, "error");
			return failed;
		})
		.finally(() => {
			options.signal?.removeEventListener("abort", parentAbort);
			clearInterval(heartbeat);
			clearHybridRunLock(options.cwd, config, liveId);
			clearHybridActiveRun(liveId);
		});
	setHybridActiveRun({ liveId, cwd: options.cwd, startedAt: nowIso(), controller, promise, heartbeat });
	return { liveId, details, promise };
}

class HybridMonitorOverlayComponent implements Component {
	private scrollOffset = 0;
	private followTail = true;
	private cancelArmed = false;
	private closed = false;
	private lastObservedVersion = -1;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly liveId: string,
		private readonly cwd: string,
		private readonly done: () => void,
	) {
		this.timer = setInterval(() => {
			const snapshot = getHybridLiveStore().get(this.liveId);
			const version = snapshot?.version ?? -1;
			// Avoid repainting the whole overlay on a fixed cadence. Repaint only
			// when the live store changes; child output updates already bump version.
			if (version !== this.lastObservedVersion) {
				this.tui.requestRender();
			}
		}, 1000);
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
		this.lastObservedVersion = snapshot?.version ?? -1;
		const details = snapshot?.details;
		const panelWidth = Math.max(60, Math.min(width, 120));
		const innerW = panelWidth - 2;
		const th = this.theme;
		const now = Date.now();
		const lines: string[] = [];
		const row = (content = "") => {
			// Monitor rows often contain ANSI styling. Avoid cutting escape
			// sequences while truncating; then pad by visible width so borders stay
			// aligned with Korean/wide glyphs and color codes.
			const normalized = normalizeTuiText(content).replace(/\n/g, " ");
			const clipped = truncLine(normalized, innerW);
			const padding = Math.max(0, innerW - visibleWidth(clipped));
			return `${th.fg("border", "│")}${clipped}${" ".repeat(padding)}${th.fg("border", "│")}`;
		};
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

		for (const line of koreanHybridRunOverviewLines(details, th, now)) {
			lines.push(row(` ${line}`));
		}
		lines.push(row(` ${hybridStageFlowLine(details, th)}`));
		if (details.localVerdict || details.frontierVerdict) {
			lines.push(row(` Verdicts: ${th.fg("dim", `local=${details.localVerdict ?? "pending"} · frontier=${details.frontierVerdict ?? "pending"}`)}`));
		}
		for (const line of formatTokenRoutingLines(th, details)) {
			lines.push(row(` ${line}`));
		}
		separator();

		const liveOutput = details.liveOutput ?? [];
		const rawLog = liveOutput.length > 0 ? liveOutput : details.recentOutput;
		const compactLog = compactHybridLiveOutput(rawLog);
		const bodyWidth = Math.max(20, innerW - 2);
		const bodyLines = compactLog.flatMap((line) =>
			wrapTextWithAnsi(normalizeTuiText(line), bodyWidth).map((wrapped) => ` ${wrapped}`),
		);
		const terminalRows = process.stdout.rows || 40;
		const bodyHeight = Math.max(6, Math.min(24, Math.floor(terminalRows * 0.8) - lines.length - 5));
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

		lines.push(row(` ${th.fg("accent", themeBold(th, "실시간 로그"))} ${th.fg("dim", "최근 이벤트만 압축 표시")}`));
		let bodyRowsWritten = 0;
		if (visibleBody.length === 0) {
			lines.push(row(` ${th.fg("dim", "아직 표시할 하위 작업 출력이 없습니다.")}`));
			bodyRowsWritten = 1;
		} else {
			for (const line of visibleBody) {
				lines.push(row(line));
				bodyRowsWritten++;
			}
		}

		for (let i = bodyRowsWritten; i < bodyHeight; i++) {
			lines.push(row(""));
		}

		separator();
		const follow = this.followTail ? th.fg("success", "follow:on") : th.fg("warning", "follow:off");
		const scroll = bodyLines.length > bodyHeight
			? th.fg("dim", ` ${start + 1}-${end}/${bodyLines.length}`)
			: "";
		const cancelHint = this.cancelArmed
			? th.fg("warning", " 실행 취소하려면 x를 한 번 더 누르세요")
			: th.fg("dim", " · x/Ctrl-C 취소");
		lines.push(row(` ${follow}${scroll} ${th.fg("dim", "↑↓/j/k 스크롤 · PgUp/PgDn · f 따라가기 · F8/q/Esc 닫기")}${cancelHint}`));
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

function summaryValue(text: string | undefined, max = 140): string | undefined {
	const normalized = text?.replace(/\s+/g, " ").replace(/;/g, ",").trim();
	return normalized ? truncateMiddle(normalized, max) : undefined;
}

function firstSummaryItem(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		return value.find((item) => typeof item === "string" && item.trim());
	}
	return typeof value === "string" && value.trim() ? value : undefined;
}

function localReviewSummary(
	verdict: ReturnType<typeof parseLocalVerdict>,
	text: string,
): string {
	const json = extractJsonObject<{
		highRiskResidualBlockers?: unknown;
		blockingIssues?: unknown;
		missingEvidence?: unknown;
		nonBlockingConcerns?: unknown;
		nextAction?: unknown;
	}>(text);
	const policyFailure = text.match(/FAIL:\s*([^\n]+)/i)?.[1];
	const reason =
		firstSummaryItem(json?.highRiskResidualBlockers) ??
		firstSummaryItem(json?.blockingIssues) ??
		firstSummaryItem(json?.missingEvidence) ??
		(verdict === "PASS_WITH_CONCERNS"
			? firstSummaryItem(json?.nonBlockingConcerns)
			: undefined) ??
		policyFailure ??
		(verdict === "FAIL"
			? "frontier 구현 리뷰가 수정 필요로 판정"
			: verdict === "PASS_WITH_CONCERNS"
				? "통과했지만 남은 우려가 있음"
				: verdict === "PASS"
					? "검토 통과"
					: "리뷰 판정 확인 필요");
	const next =
		typeof json?.nextAction === "string" && json.nextAction.trim()
			? json.nextAction
			: undefined;
	const parts = [`verdict=${verdict}`];
	const conciseReason = summaryValue(reason);
	const conciseNext = summaryValue(next);
	if (conciseReason) parts.push(`reason=${conciseReason}`);
	if (conciseNext) parts.push(`next=${conciseNext}`);
	return parts.join("; ");
}

function stringifyBriefItem(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (value === undefined || value === null) return "";
	if (typeof value !== "object") return String(value).trim();
	const record = value as Record<string, unknown>;
	const main = [
		record.question,
		record.prompt,
		record.text,
		record.title,
		record.summary,
	].find((part) => typeof part === "string" && part.trim());
	const recommended = [
		record.recommendedAnswer,
		record.recommended,
		record.suggestedAnswer,
		record.default,
	].find((part) => typeof part === "string" && part.trim());
	const rawOptions = Array.isArray(record.options)
		? record.options
		: Array.isArray(record.choices)
			? record.choices
			: [];
	const options = rawOptions.map(stringifyBriefItem).filter(Boolean);
	const parts = [
		typeof main === "string" ? main.trim() : undefined,
		typeof recommended === "string"
			? `추천: ${recommended.trim()}`
			: undefined,
		options.length ? `선택지: ${options.join(" / ")}` : undefined,
	].filter(Boolean);
	if (parts.length) return parts.join(" · ");
	try {
		return JSON.stringify(value);
	} catch {
		return String(value).trim();
	}
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
			? value.executionStrategy.map(stringifyBriefItem).filter(Boolean)
			: [],
		assumptions: Array.isArray(value?.assumptions)
			? value.assumptions.map(stringifyBriefItem).filter(Boolean)
			: [],
		ambiguities: Array.isArray(value?.ambiguities)
			? value.ambiguities.map(stringifyBriefItem).filter(Boolean)
			: [],
		blockingQuestions: Array.isArray(value?.blockingQuestions)
			? value.blockingQuestions.map(stringifyBriefItem).filter(Boolean)
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

function clarificationGateMarkdown(brief: OrchestrationBrief): string {
	return [
		"# 실행 전 확인 필요",
		"",
		"오케스트레이션 브리프가 구현 결과를 바꿀 수 있는 결정을 찾았습니다.",
		"",
		`- 위험도: ${brief.taskRisk}`,
		`- 권장 동작: ${brief.recommendedAction}`,
		"",
		"## 확인할 질문",
		"",
		...brief.blockingQuestions.map((q, i) => `${i + 1}. ${q}`),
		"",
		"## 현재 계획 요약",
		"",
		brief.planSummary,
		"",
		"## 진행 방식",
		"",
		"- `e` 또는 Enter: 답변/진행 프롬프트 입력",
		"- `r`: 답변 없이 계속 진행",
	].join("\n");
}

async function showHybridClarificationGate(
	ctx: any,
	brief: OrchestrationBrief,
): Promise<HybridGateAction> {
	if (!(ctx?.hasUI && ctx?.ui?.custom)) return { kind: "edit" };
	return await ctx.ui.custom(
		(
			tui: TUI,
			theme: any,
			_keybindings: unknown,
			done: (result?: HybridGateAction) => void,
		) =>
			new HybridReportOverlayComponent(
				tui,
				"Hybrid Clarification",
				clarificationGateMarkdown(brief),
				theme,
				done,
				{
					showEditChoice: true,
					ready: true,
					editLabel: "e. 답변/진행 프롬프트 입력",
					editDescription:
						"질문에 답하거나 구현 진행 방향을 직접 지시합니다.",
					runLabel: "r. 답변 없이 계속 진행",
					runDescription: "현재 설계와 기본 가정대로 구현을 계속합니다.",
					pickerTitle:
						" 실행 전 확인: 답변을 입력하거나 현재 설계대로 진행하세요",
				},
			),
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
}

function readOrchestrationBriefArtifact(
	cwd: string,
	config: HarnessConfig,
): OrchestrationBrief | undefined {
	const text = readArtifact(cwd, config, "orchestration-brief.md");
	if (!text.trim()) return undefined;
	const taskRisk = text.match(/-\s*Risk:\s*(low|medium|high)/i)?.[1];
	const recommendedAction = text.match(
		/-\s*Recommended action:\s*(proceed|ask_user|stop)/i,
	)?.[1];
	const planSummary =
		text.match(/## Plan summary\s+([\s\S]*?)(?:\n## |\n---|$)/i)?.[1]?.trim() ||
		"Reusing existing orchestration brief.";
	const blockingBlock = text.match(
		/## Blocking questions\s+([\s\S]*?)(?:\n## |\n---|$)/i,
	)?.[1];
	const blockingQuestions = blockingBlock
		? blockingBlock
				.split("\n")
				.map((line) => line.replace(/^-\s*/, "").trim())
				.filter((line) => line && line !== "none")
		: [];
	return normalizeBrief({
		planSummary,
		taskRisk: taskRisk as OrchestrationBrief["taskRisk"] | undefined,
		recommendedAction:
			recommendedAction as OrchestrationBrief["recommendedAction"] | undefined,
		blockingQuestions,
	});
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
	const requirementsContext = hybridRequirementsContext(cwd, config, 30_000);
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
		...requirementsContext,
		"Read these artifacts:",
		`- ${config.stateDir}/requirements.md if present`,
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

function normalizePlanReviewVerdict(value: unknown): PlanReviewVerdict {
	if (value === "READY") return "READY";
	if (value === "NEEDS_REVISION") return "NEEDS_REVISION";
	if (value === "ESCALATE_TO_USER") return "ESCALATE_TO_USER";
	const normalized = String(value ?? "").toUpperCase();
	if (normalized === "READY") return "READY";
	if (normalized === "NEEDS_REVISION") return "NEEDS_REVISION";
	if (normalized === "ESCALATE_TO_USER") return "ESCALATE_TO_USER";
	return "NEEDS_REVISION";
}

function normalizePlanReview(value: Partial<PlanReview> | undefined): PlanReview {
	const planArchitectVerdict = normalizePlanReviewVerdict(
		value?.planArchitectVerdict,
	);
	const planCriticVerdict = normalizePlanReviewVerdict(value?.planCriticVerdict);
	let verdict = normalizePlanReviewVerdict(value?.verdict);
	if (
		planArchitectVerdict === "ESCALATE_TO_USER" ||
		planCriticVerdict === "ESCALATE_TO_USER" ||
		verdict === "ESCALATE_TO_USER"
	) {
		verdict = "ESCALATE_TO_USER";
	} else if (
		planArchitectVerdict !== "READY" ||
		planCriticVerdict !== "READY" ||
		verdict !== "READY"
	) {
		verdict = "NEEDS_REVISION";
	}
	return {
		planArchitectVerdict,
		planCriticVerdict,
		verdict,
		blockingIssues: normalizeStringArray(value?.blockingIssues),
		requiredRevisions: normalizeStringArray(value?.requiredRevisions),
		reviewedValidationContracts: normalizeStringArray(
			value?.reviewedValidationContracts,
		),
		residualRisks: normalizeStringArray(value?.residualRisks),
		nextAction: String(
			value?.nextAction ||
				(verdict === "READY"
					? "Proceed to local implementation."
					: "Revise the plan review output."),
		),
	};
}

function planReviewToMarkdown(review: PlanReview, result: PiRunResult): string {
	const section = (title: string, items: string[]) => [
		`## ${title}`,
		"",
		...(items.length ? items.map((item) => `- ${item}`) : ["- none"]),
		"",
	];
	return [
		"# Hybrid Plan Review",
		"",
		`- Verdict: ${review.verdict}`,
		`- plan_architect: ${review.planArchitectVerdict}`,
		`- plan_critic: ${review.planCriticVerdict}`,
		`- Next action: ${review.nextAction}`,
		"",
		"```json",
		JSON.stringify(review, null, "\t"),
		"```",
		"",
		...section("Blocking issues", review.blockingIssues),
		...section("Required revisions", review.requiredRevisions),
		...section(
			"Reviewed validation contracts",
			review.reviewedValidationContracts,
		),
		...section("Residual risks", review.residualRisks),
		"## Raw run metadata",
		"",
		`- ok: ${result.ok}`,
		`- exitCode: ${result.exitCode}`,
		`- usage: ${formatUsage(result)}`,
		"",
		"```stderr",
		truncateMiddle(result.stderr, 4000),
		"```",
		"",
		"```text",
		truncateMiddle(result.text, 20_000),
		"```",
	].join("\n");
}

function seriousTaskPolicyApplies(brief: OrchestrationBrief): boolean {
	return brief.taskRisk === "medium" || brief.taskRisk === "high";
}

function parsePlanReviewVerdict(text: string): PlanReviewVerdict {
	return normalizePlanReview(
		extractJsonObject<Partial<PlanReview>>(text),
	).verdict;
}

async function runPlanReview(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	task: string,
	brief: OrchestrationBrief,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<{ review: PlanReview; result: PiRunResult }> {
	notify?.("Hybrid plan review: validating serious-task execution plan...", "info");
	const progress = readProgress(cwd, config, task);
	const requirementsContext = hybridRequirementsContext(cwd, config, 30_000);
	const prompt = [
		"You are the FRONTIER PLAN REVIEWER for a hybrid coding harness.",
		"This gate is CWS-compatible and not CWS-dependent: use the rubric names below, but do not assume Codex native subagents exist.",
		"Do not modify files. Decide whether local implementation may start.",
		"",
		`Task: ${task}`,
		...requirementsContext,
		"",
		"Read these artifacts and compare them against the current progress snapshot:",
		`- ${config.stateDir}/requirements.md if present`,
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/implementation-plan.json`,
		`- ${config.stateDir}/orchestration-brief.md`,
		`- ${config.stateDir}/user-clarifications.md if present`,
		`- ${config.stateDir}/repo-map.md`,
		`- ${config.stateDir}/progress.json`,
		`- ${config.stateDir}/progress.md`,
		"",
		"Orchestration brief:",
		"```json",
		JSON.stringify(brief, null, 2),
		"```",
		"",
		"Current progress snapshot:",
		"```json",
		JSON.stringify(progress, null, 2),
		"```",
		"",
		"plan_architect rubric:",
		"- Check architecture fit, boundaries, simpler alternatives, compatibility, scope, rollback/retry impact, and stage ordering.",
		"- Confirm validation contracts preserve sourceEvidence and runtimeEvidence rather than downgrading runtime proof to source presence.",
		"",
		"plan_critic rubric:",
		"- Check executable acceptance criteria, file ownership, verification commands, hard stops, stage sequencing, and whether implementation can proceed without guessing.",
		"- Block if the plan relies on smoke evidence for behavioral acceptance criteria, lacks a counterexample probe, lacks state reentry/idempotency checks where relevant, or has missing verificationContracts.",
		"",
		"Return only JSON with this exact shape:",
		`{"planArchitectVerdict":"READY|NEEDS_REVISION|ESCALATE_TO_USER","planCriticVerdict":"READY|NEEDS_REVISION|ESCALATE_TO_USER","verdict":"READY|NEEDS_REVISION|ESCALATE_TO_USER","blockingIssues":["..."],"requiredRevisions":["..."],"reviewedValidationContracts":["..."],"residualRisks":["..."],"nextAction":"..."}`,
		"",
		"Rules:",
		"- Only READY for both plan_architect and plan_critic plus final verdict allows local implementation.",
		"- Any NEEDS_REVISION blocks implementation.",
		"- Any ESCALATE_TO_USER blocks implementation and asks for user decision.",
		"- reviewedValidationContracts must name which verificationContracts, sourceEvidence, runtimeEvidence, adversarialProbes, and reentryProbes were reviewed.",
	].join("\n");
	const result = await runPiOnce({
		cwd,
		model: config.frontierModel,
		thinking: config.frontierThinking,
		prompt,
		tools: ["read", "grep", "find", "ls"],
		timeoutMs: 10 * 60_000,
		liveLabel: "plan-review",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	const review = normalizePlanReview(
		extractJsonObject<Partial<PlanReview>>(result.text),
	);
	writeArtifact(
		cwd,
		config,
		state,
		"plan-review.md",
		planReviewToMarkdown(review, result),
	);
	return { review, result };
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
	const requirementsContext = hybridRequirementsContext(cwd, config, 30_000);
	const prompt = [
		"You are the LOCAL CONTROL-PLANE PLANNER for a hybrid coding harness.",
		"Convert the frontier design package into strict JSON progress state. Do not modify files.",
		"",
		`Task: ${task}`,
		...(steering ? ["", steering] : []),
		...requirementsContext,
		"",
		"Read these artifacts:",
		`- ${config.stateDir}/requirements.md if present`,
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/repo-map.md`,
		"",
		"Return only JSON with this exact shape:",
		`{\n  "version": 1,\n  "task": "...",\n  "currentSliceId": "S1",\n  "slices": [{"id":"S1","title":"...","status":"pending","evidence":[],"remaining":["..."]}],\n  "acceptanceCriteria": [{"id":"AC1","description":"...","status":"pending","evidence":[],"verificationContracts":["sample input + command/script/manual procedure + expected output/diff"],"evidenceType":"unit|integration|e2e|manual|static|smoke","sourceEvidence":[],"runtimeEvidence":[],"adversarialProbes":[],"reentryProbes":[],"residualGaps":[]}],\n  "frontierRecheckTriggers": [{"id":"FR1","description":"...","active":false,"evidence":""}],\n  "testObservations": [],\n  "blockers": [],\n  "nextAction": "..."\n}`,
		"",
		"Guidance:",
		"- Slices must be small, sequential, and verifiable.",
		"- Acceptance criteria must be concrete and testable with executable verification contracts.",
		"- Track source evidence separately from runtime evidence; source-level evidence is not runtime evidence.",
		"- Mark smoke evidence as smoke only; smoke evidence cannot satisfy behavioral acceptance criteria.",
		"- Include at least one adversarial probe and a reentry/idempotency probe when state, retries, resume, or persistence are involved.",
		"- For any acceptance criterion that spans a consumer<->producer boundary (client/server, or one module calling another module's public contract across slices/lanes), add an integration or e2e verification contract that exercises the real interface end to end; unit tests on each side plus a build are insufficient because they pass while the seam (HTTP verb/path, function signature, shared semantics) diverges. Pin the shared interface as a single contract both sides reference.",
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
		"- A criterion whose only evidence is an un-executed manual audit (no recorded command output) is UNVERIFIED, not satisfied: keep it pending and add a blocker rather than marking it satisfied. 'Manual audit required' / 'no automated test configured' must not roll up to a satisfied criterion.",
		"- Cross-component seam criteria (consumer calling a producer across slices/lanes/modules, e.g. a client calling a server route) need integration/e2e evidence that exercises the real interface; per-component unit tests plus a build are smoke for the seam. Confirm the consumer's verb/path/arguments match the producer's contract and that shared semantics (e.g. the meaning of now/today) agree on both sides.",
		"- Preserve verificationContracts, evidenceType, sourceEvidence, runtimeEvidence, adversarialProbes, reentryProbes, and residualGaps for every acceptance criterion.",
		"- Do not treat source-level evidence as runtime evidence.",
		"- smoke evidence cannot satisfy behavioral acceptance criteria; build passed, HTTP 200, server responds, and import succeeds are baseline only.",
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
		"orchestrator-package.md",
		"plan-review.md",
		"requirements.md",
		"design-grill.md",
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

async function runFrontierInterview(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	input: string,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<PiRunResult> {
	const requestOrAnswer = input.trim();
	const task =
		state.task ||
		readArtifact(cwd, config, "task.md").trim() ||
		requestOrAnswer ||
		"(task missing)";
	if (!state.task && requestOrAnswer) state.task = requestOrAnswer;
	if (state.task && !readArtifact(cwd, config, "task.md").trim()) {
		writeArtifact(cwd, config, state, "task.md", `# Task\n\n${state.task}\n`);
	}
	const steering = hybridSteeringMarkdown(cwd, config);
	if (steering) markHybridSteeringConsumed(cwd, config, "frontier-interview");
	notify?.("Hybrid interview: frontier requirements gate running...", "info");
	const prompt = [
		"You are the FRONTIER REQUIREMENTS INTERVIEWER for a hybrid coding harness.",
		"The frontier owns design/requirements judgment. local/Qwen may provide repo facts, but must not implement during this command.",
		"You must not implement, edit files, or start coding. Produce requirements clarity only.",
		"",
		`Task: ${task}`,
		`Latest user request or answer: ${requestOrAnswer || "(none provided)"}`,
		...(steering ? ["", steering] : []),
		"",
		"Existing artifacts to consider if present:",
		`- ${config.stateDir}/task.md`,
		`- ${config.stateDir}/requirements.md`,
		`- ${config.stateDir}/design-grill.md`,
		`- ${config.stateDir}/repo-map.md`,
		`- ${config.stateDir}/orchestration-brief.md`,
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/user-clarifications.md`,
		"",
		"Current requirements artifact:",
		"```markdown",
		truncateMiddle(readArtifact(cwd, config, "requirements.md"), 20_000),
		"```",
		"",
		"Rules:",
		"- If requirements are not ready, ask exactly one next question and include a recommended answer or 2-3 concrete choices.",
		"- If requirements are ready, produce an implementation-ready handoff.",
		"- The handoff must include Source Request, Desired Outcome, In Scope, Non-Goals, Decision Boundaries, Acceptance Criteria, Verification Contracts, Constraints, Assumptions, Open Questions, Likely Touchpoints, and Stop Conditions.",
		"- Acceptance Criteria must be executable or paired with an explicit manual procedure.",
		"- Do not assign implementation to Qwen until this gate is ready.",
	].join("\n");
	const result = await runPiOnce({
		cwd,
		model: config.frontierModel,
		thinking: config.frontierThinking,
		prompt,
		tools: ["read", "grep", "find", "ls"],
		timeoutMs: 15 * 60_000,
		liveLabel: "frontier-interview",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	writeArtifact(
		cwd,
		config,
		state,
		"requirements.md",
		[
			"# Frontier Requirements Interview",
			"",
			`- model: ${config.frontierModel}`,
			`- thinking: ${config.frontierThinking}`,
			`- ok: ${result.ok}`,
			`- exitCode: ${result.exitCode}`,
			`- usage: ${formatUsage(result)}`,
			"",
			result.text || "(no output)",
			"",
			"## stderr",
			"",
			"```stderr",
			truncateMiddle(result.stderr, 4000),
			"```",
		].join("\n"),
	);
	state.frontierModel = config.frontierModel;
	state.frontierThinking = config.frontierThinking;
	state.lastRun = nowIso();
	saveState(cwd, config, state);
	return result;
}

async function runFrontierGrill(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	input: string,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<PiRunResult> {
	const planOrDesign = input.trim();
	const task =
		state.task ||
		readArtifact(cwd, config, "task.md").trim() ||
		planOrDesign ||
		"(task missing)";
	if (!state.task && planOrDesign) state.task = planOrDesign;
	if (state.task && !readArtifact(cwd, config, "task.md").trim()) {
		writeArtifact(cwd, config, state, "task.md", `# Task\n\n${state.task}\n`);
	}
	const steering = hybridSteeringMarkdown(cwd, config);
	if (steering) markHybridSteeringConsumed(cwd, config, "frontier-grill");
	notify?.("Hybrid grill: frontier design stress test running...", "info");
	const prompt = [
		"You are the FRONTIER DESIGN GRILL for a hybrid coding harness.",
		"The frontier owns design/requirements judgment. local/Qwen may provide repo facts, but must not implement during this command.",
		"You must not implement, edit files, or start coding. Stress-test the design only.",
		"",
		`Task: ${task}`,
		`Latest plan or design text: ${planOrDesign || "(none provided)"}`,
		...(steering ? ["", steering] : []),
		"",
		"Existing artifacts to consider if present:",
		`- ${config.stateDir}/requirements.md`,
		`- ${config.stateDir}/design-grill.md`,
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/orchestration-brief.md`,
		`- ${config.stateDir}/repo-map.md`,
		`- ${config.stateDir}/progress.md`,
		"",
		"Requirements artifact:",
		"```markdown",
		truncateMiddle(readArtifact(cwd, config, "requirements.md"), 20_000),
		"```",
		"",
		"Rules:",
		"- Grill broad product, architecture, workflow, and domain decisions before implementation.",
		"- Cover design branches, rejected alternatives, failure modes, compatibility, rollout, rollback, state ownership, data integrity, and user-visible behavior.",
		"- If a blocking decision remains unresolved, ask exactly one next question and include a recommended answer.",
		"- If the design is ready, return a concise verdict, required revisions if any, accepted design, rejected alternatives, failure modes, verification implications, and handoff notes for later Qwen implementation.",
		"- Do not let local/Qwen implementation start from an unresolved design branch.",
	].join("\n");
	const result = await runPiOnce({
		cwd,
		model: config.frontierModel,
		thinking: config.frontierThinking,
		prompt,
		tools: ["read", "grep", "find", "ls"],
		timeoutMs: 15 * 60_000,
		liveLabel: "frontier-grill",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	writeArtifact(
		cwd,
		config,
		state,
		"design-grill.md",
		[
			"# Frontier Design Grill",
			"",
			`- model: ${config.frontierModel}`,
			`- thinking: ${config.frontierThinking}`,
			`- ok: ${result.ok}`,
			`- exitCode: ${result.exitCode}`,
			`- usage: ${formatUsage(result)}`,
			"",
			result.text || "(no output)",
			"",
			"## stderr",
			"",
			"```stderr",
			truncateMiddle(result.stderr, 4000),
			"```",
		].join("\n"),
	);
	state.frontierModel = config.frontierModel;
	state.frontierThinking = config.frontierThinking;
	state.lastRun = nowIso();
	saveState(cwd, config, state);
	return result;
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
	const requirementsContext = hybridRequirementsContext(cwd, config);
	const scoutPrompt = [
		"You are the LOCAL SCOUT in a hybrid coding harness.",
		"Explore the repository with read-only tools and produce a compact, high-signal repo map for a frontier architect.",
		"Do not modify files.",
		"",
		`Task: ${task}`,
		...(scoutSteering ? ["", scoutSteering] : []),
		...requirementsContext,
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

	// A timed-out, crashed, stuck-loop-guarded, or empty scout run must not be silently
	// captured as a usable repo map and fed to the architect. Fail the design stage so it
	// is not marked complete and a later /hybrid-run resume re-runs it.
	if (!isUsableChildResult(scout)) {
		throw new Error(
			`Hybrid scout produced no usable repo map (ok=${scout.ok}, exitCode=${scout.exitCode}). See ${config.stateDir}/repo-map.md. Re-run /hybrid-run to retry the design stage.`,
		);
	}

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
		...requirementsContext,
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
		"",
		"Verification design requirements:",
		"- Each acceptance criterion needs an executable verification contract: sample input, command/script/manual procedure, and expected output or diff.",
		"- Separate source evidence from runtime evidence.",
		"- Identify at least one adversarial probe and any state reentry/idempotency probe needed.",
		"- Treat build passed, HTTP 200, server responds, import succeeds, and smoke checks as baseline only.",
		"- For any consumer<->producer seam (client/server or cross-module/cross-slice public contract), design an executable end-to-end gate that drives the consumer against the real producer, and pin the shared interface (HTTP method+path, function signature, shared semantics like the meaning of now/today) as one contract both sides reference. Per-component unit tests plus a build do not cover the seam.",
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
	// Guard before createProgressFromDesign writes progress.json: an unusable architect run
	// leaves a "(no output)" design that would otherwise pass the design-stage readiness check
	// (frontier-design.md + progress.json present) and be skipped on resume. Throwing here
	// keeps progress.json unwritten, so design readiness stays false and the stage re-runs.
	if (!isUsableChildResult(architect)) {
		throw new Error(
			`Hybrid frontier architect produced no usable design (ok=${architect.ok}, exitCode=${architect.exitCode}). See ${config.stateDir}/frontier-design.md. The design stage was not completed; re-run /hybrid-run to retry.`,
		);
	}
	state.phase = "designed";
	state.lastRun = nowIso();
	saveState(cwd, config, state);
	await createProgressFromDesign(cwd, config, state, task, notify, liveLog);
}

async function runLocalLoop(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	runState: HybridRunState,
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
		const signatureBefore = workspaceSignature(cwd, config);
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
			sessionPolicy: config.persistentWriterSession ? "persistent" : "ephemeral",
			sessionId: runState.writerSessionId,
			sessionDir: hybridWriterSessionDir(cwd, config, runState.writerSessionDir),
		});
		// Capture the signature right after the writer, before the verification/test
		// command runs, so a test or build that writes files cannot mask a no-op writer.
		const signatureAfterWriter = workspaceSignature(cwd, config);
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
		// If the writer changed nothing this iteration, repeating it with the same
		// context will not help. Break early instead of burning the remaining loops on
		// no-op iterations (the DEBUG-1.2..4 "No changes made" failure mode).
		if (i < loops && signatureAfterWriter === signatureBefore) {
			const noopNote = `Writer made no workspace changes in iteration ${iterationLabel}; ending the local loop early instead of repeating no-op iterations.`;
			notify?.(noopNote, "warning");
			logParts.push("", `> ${noopNote}`, "");
			writeArtifact(cwd, config, state, "local-log.md", logParts.join("\n"));
			break;
		}
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

interface ImplementationReviewer {
	model: string;
	thinking?: string;
	roleLabel: string;
	artifactTitle: string;
}

// Default reviewer is the frontier model: used by /hybrid-run's auto loop and the
// manual /hybrid-review command, where a frontier implementation review is intended.
// hybrid_exec (parent-driven skill mode) overrides this with the local reviewer so
// frontier tokens are reserved for the explicit /hybrid-final gate.
function frontierImplementationReviewer(config: HarnessConfig): ImplementationReviewer {
	return {
		model: config.frontierModel,
		thinking: config.frontierThinking,
		roleLabel: "FRONTIER IMPLEMENTATION REVIEWER",
		artifactTitle: "Frontier Implementation Review",
	};
}

function localImplementationReviewer(config: HarnessConfig): ImplementationReviewer {
	return {
		model: config.localReviewerModel,
		thinking: undefined,
		roleLabel: "LOCAL IMPLEMENTATION REVIEWER",
		artifactTitle: "Local Implementation Review",
	};
}

async function runLocalReview(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	notify?: Notify,
	liveLog?: LiveLog,
	reviewer: ImplementationReviewer = frontierImplementationReviewer(config),
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
	const requirementsContext = hybridRequirementsContext(cwd, config, 30_000);
	const prompt = [
		`You are the ${reviewer.roleLabel} in a hybrid coding harness.`,
		"Review the implementation against the frontier design. You are read-only. Do not modify files.",
		"Be strict about test evidence, regressions, edge cases, and design drift.",
		"",
		`Task: ${task}`,
		...(steering ? ["", steering] : []),
		...requirementsContext,
		"",
		"Read these artifacts first:",
		`- ${config.stateDir}/requirements.md if present`,
		`- ${config.stateDir}/frontier-design.md`,
		`- ${config.stateDir}/progress.md and ${config.stateDir}/progress.json`,
		`- ${config.stateDir}/test-evidence.md`,
		`- ${config.stateDir}/claim-evidence-matrix.md`,
		`- ${config.stateDir}/verification-summary.json`,
		`- ${config.stateDir}/local-log.md`,
		`- ${config.stateDir}/git-summary.md`,
		"",
		"Output a fenced JSON object first, then optional markdown details. JSON schema:",
		`{"verdict":"PASS|PASS_WITH_CONCERNS|FAIL","implementationClaims":["..."],"claimEvidenceMatrix":[{"claim":"...","evidenceCommand":"...","evidenceType":"unit|integration|e2e|manual|static|smoke","whatWouldFailIfBroken":"...","residualGap":"..."}],"testAssertionQuality":"...","independentAdversarialProbe":"...","highRiskResidualBlockers":["..."],"blockingIssues":["..."],"nonBlockingConcerns":["..."],"missingEvidence":["..."],"nextAction":"..."}`,
		"Verdict meanings:",
		"- PASS: implementation satisfies the design AND every required behavioral acceptance criterion has executed evidence (not manual-only, not smoke-only).",
		"- PASS_WITH_CONCERNS: no known blocker, but evidence/risk remains.",
		"- FAIL: local repair is required before final approval.",
		"Evidence rules:",
		"- Extract implementationClaims from the worker output, diff, and changed files.",
		"- For every claim, require evidence in the claimEvidenceMatrix.",
		"- source-level evidence is not runtime evidence; source-only proof cannot satisfy behavioral claims.",
		"- An acceptance criterion whose only evidence is an un-executed manual audit (no recorded command output or runtime assertion in test-evidence.md) is UNVERIFIED, not satisfied. Do not let 'manual audit required' or 'no automated test configured' roll up to PASS: if any required behavioral criterion is UNVERIFIED, return FAIL (or PASS_WITH_CONCERNS only when the unverified criterion is non-behavioral), and list it in missingEvidence.",
		"- Cross-component seam criteria (a consumer calling a producer across slices/lanes/modules — e.g. a client calling a server route, or module A calling module B's public contract) require integration or e2e evidence that exercises the real interface end to end. Per-component unit tests plus a successful build are smoke for the seam: treat them as smoke, not integration. Verify the consumer's actual call (verb/path/arguments) matches the producer's registered contract, and that shared semantics (e.g. the meaning of now/today) agree on both sides; a verb/path mismatch (PATCH vs PUT) or a divergent date anchor passes both sides in isolation while the running app is broken.",
		"- Review testAssertionQuality: assertions must check postconditions, avoid shortcut mocks, and avoid bypassing the real user/API path.",
		"- Run or specify an independentAdversarialProbe such as a minimum one counterexample, edge case, alternate call order, invalid input, or retry path.",
		"- For public API, data integrity, authentication, payment, migration, or long-lived state, residual gaps must be highRiskResidualBlockers and force FAIL.",
		interactivePolicy
			? "Strict interactive/runtime policy is ACTIVE: if there is no passing configured deterministic test command or equivalent objective runtime assertion in test-evidence.md, you MUST return FAIL. Do not accept syntax checks, HTTP 200 checks, screenshots without assertions, or worker self-reported smoke tests as sufficient for browser/UI/game/gameplay behavior."
			: "Strict interactive/runtime policy is not active for this task.",
	].join("\n");
	notify?.(`Hybrid ${reviewer.roleLabel.toLowerCase()} running...`, "info");
	const review = await runPiOnce({
		cwd,
		model: reviewer.model,
		thinking: reviewer.thinking,
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
		`# ${reviewer.artifactTitle}\n\n${review.text || "(no output)"}${policyOverride}\n\n---\n\n- model: ${reviewer.model}\n- ok: ${review.ok}\n- exitCode: ${review.exitCode}\n- usage: ${formatUsage(review)}\n\n\`\`\`stderr\n${truncateMiddle(review.stderr, 4000)}\n\`\`\`\n`,
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

function canonicalTaskTrackingMarkdown(cwd: string): string {
	const specsDir = path.join(cwd, "specs");
	if (!fs.existsSync(specsDir)) return "No canonical specs/**/tasks.md files found.";
	const taskFiles: string[] = [];
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(fullPath);
			else if (entry.isFile() && entry.name === "tasks.md") taskFiles.push(fullPath);
		}
	};
	try {
		visit(specsDir);
	} catch (error) {
		return `Unable to inspect canonical task tracking: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (taskFiles.length === 0) return "No canonical specs/**/tasks.md files found.";
	const lines = ["Canonical task tracking is authoritative when the objective references its task IDs or checklist completion.", ""];
	for (const taskFile of taskFiles.sort()) {
		const taskLines = fs.readFileSync(taskFile, "utf8").split(/\r?\n/);
		const tasks = taskLines.flatMap((line) => {
			const match = line.match(/^\s*-\s*\[([ xX])\]\s+(T\d+)\b/);
			return match ? [{ id: match[2], complete: match[1].toLowerCase() === "x" }] : [];
		});
		const unchecked = tasks.filter((task) => !task.complete).map((task) => task.id);
		lines.push(
			`- ${path.relative(cwd, taskFile)}: ${tasks.length - unchecked.length}/${tasks.length} checked`,
			`  - unchecked required task IDs: ${unchecked.length ? unchecked.join(", ") : "none"}`,
		);
	}
	return lines.join("\n");
}

// True when canonical specs/**/tasks.md exists with at least one unchecked required
// task ID. Used to warn the orchestrator that the task tracker is not yet complete.
function hasUncheckedCanonicalTasks(cwd: string): boolean {
	const specsDir = path.join(cwd, "specs");
	if (!fs.existsSync(specsDir)) return false;
	let unchecked = false;
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (unchecked) return;
			if (entry.isSymbolicLink()) continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
			} else if (entry.isFile() && entry.name === "tasks.md") {
				const text = fs.readFileSync(fullPath, "utf8");
				if (/^\s*-\s*\[ \]\s+T\d+\b/m.test(text)) unchecked = true;
			}
		}
	};
	try {
		visit(specsDir);
	} catch {
		return false;
	}
	return unchecked;
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
	const requirementsContext = hybridRequirementsContext(cwd, config, 30_000);
	const prompt = [
		"You are the FRONTIER FINAL GATE for a hybrid coding harness.",
		"Spend frontier reasoning only on correctness, design drift, hidden risks, and whether this should ship.",
		"Do not make code changes. Review the artifact pack and issue a concise gate verdict.",
		"",
		`Task: ${task}`,
		...(steering ? ["", steering] : []),
		...requirementsContext,
		"",
		"## Frontier design package",
		truncateMiddle(readArtifact(cwd, config, "frontier-design.md"), 40_000),
		"",
		"## Structured progress",
		truncateMiddle(readArtifact(cwd, config, "progress.md"), 30_000),
		"",
		"## Canonical task tracking",
		canonicalTaskTrackingMarkdown(cwd),
		"",
		"## Test evidence",
		truncateMiddle(readArtifact(cwd, config, "test-evidence.md"), 30_000),
		"",
		"## Claim-evidence matrix",
		truncateMiddle(readArtifact(cwd, config, "claim-evidence-matrix.md"), 20_000),
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
		`{"verdict":"APPROVE|REQUEST_CHANGES|ESCALATE_TO_USER","claimEvidenceMatrix":[{"claim":"...","evidenceCommand":"...","evidenceType":"unit|integration|e2e|manual|static|smoke","whatWouldFailIfBroken":"...","residualGap":"..."}],"blockingIssues":["..."],"requiredFixes":["..."],"testEvidenceAssessment":"...","testAssertionQuality":"...","independentAdversarialProbe":"...","stateReentryIdempotencyAssessment":"...","highRiskResidualBlockers":["..."],"residualRisks":["..."],"anotherFrontierPassNecessary":false}`,
		"Verdict meanings:",
		"- APPROVE: changes are acceptable to ship/commit.",
		"- REQUEST_CHANGES: local worker should fix concrete issues.",
		"- ESCALATE_TO_USER: requirement/design ambiguity or risk requires user decision.",
		"Final-gate evidence rules:",
		"- If the objective claims explicit task IDs or checklist completion, any unchecked required task is blocking unless the task document explicitly marks it optional or superseded.",
		"- For EACH acceptance criterion, map it to concrete evidence from test-evidence.md, local-log.md command output, or git diff. If any acceptance criterion lacks evidence, REQUEST_CHANGES.",
		"- An acceptance criterion whose only evidence is an un-executed manual audit (no recorded command output) is UNVERIFIED, not satisfied: 'manual audit required' or 'no automated test configured' must not roll up to APPROVE. If any required behavioral criterion is UNVERIFIED, REQUEST_CHANGES (or ESCALATE_TO_USER) and name it in missing evidence.",
		"- Cross-component seam criteria (a consumer calling a producer across slices/lanes/modules, e.g. a client calling a server route) require integration or e2e evidence that exercises the real interface end to end; per-component unit tests plus a build are smoke for the seam. Confirm the consumer's verb/path/arguments match the producer's registered contract and that shared semantics (e.g. the meaning of now/today) agree on both sides; a PATCH vs PUT or divergent date anchor passes both sides in isolation while the running app is broken.",
		"- Review the claimEvidenceMatrix columns: Claim, Evidence command, Evidence type, What would fail if broken, Residual gap.",
		"- Require minimum one counterexample or edge-case probe that is independent of the implementer's happy path.",
		"- Require state reentry/idempotency assessment for stateful, resumable, retry, restart, or persistence behavior.",
		"- Residual gaps are approval blockers for public API, data integrity, authentication, payment, migration, or long-lived state.",
		"- Build passed, HTTP 200, server responds, import succeeds, and smoke checks are baseline only; smoke evidence cannot satisfy behavioral acceptance criteria.",
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

async function runLocalHandoffReview(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	manifest: HandoffManifest,
	lane: HandoffLane,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<{ verdict: ReturnType<typeof parseLocalVerdict>; result: PiRunResult }> {
	notify?.(`Handoff lane ${lane.id}: local review running...`, "info");
	writeArtifact(cwd, config, state, "git-summary.md", gitSummary(cwd, config));
	const result = await runPiOnce({
		cwd,
		model: config.localReviewerModel,
		prompt: handoffReviewPrompt(manifest, lane, config),
		tools: ["read", "grep", "find", "ls", "bash"],
		timeoutMs: 15 * 60_000,
		liveLabel: `handoff-review-${lane.id}`,
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	const verdict = parseLocalVerdict(result.text);
	const report = `# Local Handoff Review — Lane ${lane.id} ${lane.name}\n\n${result.text || "(no output)"}\n\n---\n\n- ok: ${result.ok}\n- exitCode: ${result.exitCode}\n- usage: ${formatUsage(result)}\n\n\`\`\`stderr\n${truncateMiddle(result.stderr, 4000)}\n\`\`\`\n`;
	writeArtifact(cwd, config, state, `handoff-review-${lane.id}.md`, report);
	writeArtifact(cwd, config, state, "local-review.md", report);
	state.phase = "local-reviewed";
	state.lastRun = nowIso();
	saveState(cwd, config, state);
	return { verdict, result };
}

function runHandoffValidation(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	lane: HandoffLane,
	notify?: Notify,
): VerificationSummary {
	const commands: HandoffValidationCommand[] = lane.validationCommands.length
		? lane.validationCommands
		: verificationCommands(cwd, config).map((command) => ({ command }));
	const results: VerificationSummary["commands"] = [];
	const evidenceLines = [
		readArtifact(cwd, config, "test-evidence.md") || `# Test Evidence\n\nTask: ${state.task ?? "(task missing)"}\n`,
		"",
		`## Handoff Lane ${lane.id} Validation`,
		"",
		`Generated: ${nowIso()}`,
		"",
	];
	for (const command of commands) {
		const commandCwd = command.cwd ? path.resolve(cwd, command.cwd) : cwd;
		notify?.(`Handoff lane ${lane.id}: running ${command.command}...`, "info");
		const test = runCommand(commandCwd, command.command, 10 * 60_000);
		const expected = command.expected_exit ?? 0;
		const evaluated = verificationCommandPassed(test, expected);
		const ok = evaluated.ok;
		const failureKind: TestFailureKind = ok ? "none" : classifyTestFailure(test.output, false, test.code);
		const compactOutput = test.output.replace(/\s+/g, " ").trim();
		const summary = ok
			? command.proves || "Command matched expected exit code."
			: evaluated.fatalSignals.length
				? `Command emitted fatal runtime signal(s): ${evaluated.fatalSignals.join(", ")}.`
				: truncateMiddle(compactOutput || `Command exited ${test.code}, expected ${expected}.`, 500);
		results.push({ command: command.command, ok, code: test.code, failureKind, summary });
		evidenceLines.push(
			`### ${command.command}`,
			"",
			`- cwd: ${commandCwd}`,
			`- ok: ${ok}`,
			`- code: ${test.code ?? "null"}`,
			`- expected_exit: ${expected}`,
			`- failureKind: ${failureKind}`,
			command.proves ? `- proves: ${command.proves}` : "",
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
	writeArtifact(cwd, config, state, "verification-summary.json", JSON.stringify(summary, null, "\t"));
	writeArtifact(cwd, config, state, "verification-summary.md", verificationSummaryMarkdown(summary));
	writeArtifact(cwd, config, state, "test-evidence.md", evidenceLines.filter(Boolean).join("\n"));
	const progress = readProgress(cwd, config, state.task ?? "(task missing)");
	writeArtifact(cwd, config, state, "claim-evidence-matrix.md", `${claimEvidenceMatrixMarkdown(progress, summary)}\n\nMatrix columns: Evidence type | What would fail if broken | Residual gap\n`);
	return summary;
}

// Execute the cross-lane seam end to end (the consumer driving the real producer). This is the
// one check that catches divergences which pass every lane in isolation -- e.g. a client calling
// PATCH while the server only implements PUT, or two endpoints anchoring "today" differently.
function runHandoffIntegrationGate(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	manifest: HandoffManifest,
	notify?: Notify,
): { ran: boolean; allPassed: boolean; commandCount: number } {
	const commands = manifest.integrationCommands ?? [];
	const evidenceLines = [
		readArtifact(cwd, config, "test-evidence.md") || `# Test Evidence\n\nTask: ${state.task ?? "(task missing)"}\n`,
		"",
		"## Handoff Integration Gate (consumer -> producer seam)",
		"",
		`Generated: ${nowIso()}`,
		"",
	];
	if (commands.length === 0) {
		evidenceLines.push(
			"- NO executable integration gate was provided by this handoff. The cross-lane seam (the consumer calling the producer end to end) is UNVERIFIED: per-lane unit tests plus a build do not prove it. Add an Executable Integration Gate (spec.integration_e2e) to the integration handoff.",
			"",
		);
		writeArtifact(cwd, config, state, "test-evidence.md", evidenceLines.filter(Boolean).join("\n"));
		return { ran: false, allPassed: false, commandCount: 0 };
	}
	const results: VerificationSummary["commands"] = [];
	for (const command of commands) {
		const commandCwd = command.cwd ? path.resolve(cwd, command.cwd) : cwd;
		notify?.(`Handoff integration gate: running ${command.command}...`, "info");
		const test = runCommand(commandCwd, command.command, 15 * 60_000);
		const expected = command.expected_exit ?? 0;
		const evaluated = verificationCommandPassed(test, expected);
		const ok = evaluated.ok;
		const failureKind: TestFailureKind = ok ? "none" : classifyTestFailure(test.output, false, test.code);
		const compactOutput = test.output.replace(/\s+/g, " ").trim();
		results.push({
			command: command.command,
			ok,
			code: test.code,
			failureKind,
			summary: ok
				? command.proves || "Integration gate passed."
				: evaluated.fatalSignals.length
					? `Command emitted fatal runtime signal(s): ${evaluated.fatalSignals.join(", ")}.`
					: truncateMiddle(compactOutput || `Command exited ${test.code}, expected ${expected}.`, 500),
		});
		evidenceLines.push(
			`### ${command.command}`,
			"",
			`- cwd: ${commandCwd}`,
			`- ok: ${ok}`,
			`- code: ${test.code ?? "null"}`,
			`- expected_exit: ${expected}`,
			`- failureKind: ${failureKind}`,
			command.proves ? `- proves: ${command.proves}` : "",
			"",
			"```",
			truncateMiddle(test.output.trim(), 20_000),
			"```",
			"",
		);
	}
	writeArtifact(cwd, config, state, "test-evidence.md", evidenceLines.filter(Boolean).join("\n"));
	return { ran: true, allPassed: results.length > 0 && results.every((result) => result.ok), commandCount: results.length };
}

function updateHandoffLaneProgress(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	lane: HandoffLane,
	status: SliceStatus,
	evidence: string,
): HarnessProgress {
	const progress = readProgress(cwd, config, state.task ?? "(task missing)");
	progress.currentSliceId = `L${lane.id}`;
	progress.slices = progress.slices.map((slice) =>
		slice.id === `L${lane.id}`
			? {
				...slice,
				status,
				evidence: uniqueStrings([...slice.evidence, evidence]),
				remaining: status === "done" ? [] : slice.remaining,
			}
			: slice,
	);
	if (status === "done") {
		progress.acceptanceCriteria = progress.acceptanceCriteria.map((criterion) =>
			criterion.id.startsWith(`L${lane.id}-`)
				? {
					...criterion,
					status: "satisfied",
					evidence: uniqueStrings([...criterion.evidence, evidence]),
					runtimeEvidence: uniqueStrings([...(criterion.runtimeEvidence ?? []), evidence]),
				}
				: criterion,
		);
		const next = progress.slices.find((slice) => slice.status === "pending" || slice.status === "blocked");
		progress.currentSliceId = next?.id ?? `L${lane.id}`;
		progress.nextAction = next ? `Implement ${next.id}: ${next.title}` : "All handoff lanes implemented; run final summary.";
	} else {
		progress.nextAction = `Continue or repair lane ${lane.id}: ${lane.name}`;
	}
	progress.updatedAt = nowIso();
	writeProgress(cwd, config, state, progress);
	return progress;
}

async function runHandoffLaneLoop(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	runState: HybridRunState,
	manifest: HandoffManifest,
	lane: HandoffLane,
	reporter: ReturnType<typeof createHybridReporter>,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<boolean> {
	const maxAttempts = Math.max(1, config.maxReviewRepairCycles + 1);
	let latestVerdict: ReturnType<typeof parseLocalVerdict> = "UNKNOWN";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		reporter.stage(`handoff-lane-${lane.id}`, "running", `attempt ${attempt}/${maxAttempts}`);
		notify?.(`Handoff lane ${lane.id}: local worker attempt ${attempt}/${maxAttempts}...`, "info");
		updateHandoffLaneProgress(cwd, config, state, lane, "in_progress", `attempt ${attempt} started`);
		const worker = await runPiOnce({
			cwd,
			model: config.localWorkerModel,
			prompt: handoffWorkerPrompt(manifest, lane, attempt, config),
			timeoutMs: 30 * 60_000,
			liveLabel: `handoff-worker-${lane.id}.${attempt}`,
			rawEventPath: artifactPath(cwd, config, "events.jsonl"),
			onLog: liveLog,
			sessionPolicy: config.persistentWriterSession ? "persistent" : "ephemeral",
			sessionId: runState.writerSessionId,
			sessionDir: hybridWriterSessionDir(cwd, config, runState.writerSessionDir),
		});
		const existingLog = readArtifact(cwd, config, "local-log.md") || `# Local Implementation Log\n\nTask: ${manifest.objective}\n`;
		writeArtifact(
			cwd,
			config,
			state,
			"local-log.md",
			`${existingLog}\n\n## Handoff lane ${lane.id} attempt ${attempt}\n\n${worker.text || "(no output)"}\n\n- ok: ${worker.ok}\n- exitCode: ${worker.exitCode}\n- usage: ${formatUsage(worker)}\n\n\`\`\`stderr\n${truncateMiddle(worker.stderr, 6000)}\n\`\`\`\n`,
		);
		writeArtifact(cwd, config, state, "git-summary.md", gitSummary(cwd, config));
		const verification = runHandoffValidation(cwd, config, state, lane, notify);
		await updateProgressAfterIteration(
			cwd,
			config,
			state,
			manifest.objective,
			`handoff-${lane.id}.${attempt}`,
			worker.text,
			{
				iteration: `handoff-${lane.id}.${attempt}`,
				command: lane.validationCommands.map((cmd) => cmd.command).join(" && ") || undefined,
				ok: verification.allPassed,
				failureKind: verification.allPassed ? "none" : (verification.commands.find((cmd) => !cmd.ok)?.failureKind ?? "unknown"),
				summary: verification.allPassed ? "Lane validation passed." : "One or more lane validation commands failed.",
			},
			notify,
			liveLog,
		);
		const review = await runLocalHandoffReview(cwd, config, state, manifest, lane, notify, liveLog);
		latestVerdict = review.verdict;
		if (verification.allPassed && (latestVerdict === "PASS" || latestVerdict === "PASS_WITH_CONCERNS")) {
			updateHandoffLaneProgress(cwd, config, state, lane, "done", `lane ${lane.id} validation passed and review=${latestVerdict}`);
			reporter.stage(`handoff-lane-${lane.id}`, "done", `review=${latestVerdict}`);
			reporter.setProgress(readProgress(cwd, config, manifest.objective));
			return true;
		}
		reporter.stage(`handoff-review-${lane.id}`, "failed", `review=${latestVerdict}; validation=${verification.allPassed ? "pass" : "fail"}`);
		updateHandoffLaneProgress(cwd, config, state, lane, "blocked", `attempt ${attempt} review=${latestVerdict}; validation=${verification.allPassed ? "pass" : "fail"}`);
		reporter.setProgress(readProgress(cwd, config, manifest.objective));
	}
	reporter.stage(`handoff-lane-${lane.id}`, "failed", `review=${latestVerdict}`);
	return false;
}

async function runHandoffFinalSummary(
	cwd: string,
	config: HarnessConfig,
	state: HarnessState,
	manifest: HandoffManifest,
	notify?: Notify,
	liveLog?: LiveLog,
): Promise<PiRunResult> {
	notify?.("Handoff final local summary running...", "info");
	const prompt = [
		"You are the LOCAL FINAL SUMMARIZER for an externally supplied handoff run.",
		"Do not modify files. Summarize completion state, validation evidence, residual gaps, and next manual checks.",
		"",
		`Task: ${manifest.taskName}`,
		`Objective: ${manifest.objective}`,
		"",
		"## Progress",
		truncateMiddle(readArtifact(cwd, config, "progress.md"), 30_000),
		"",
		"## Test evidence",
		truncateMiddle(readArtifact(cwd, config, "test-evidence.md"), 30_000),
		"",
		"## Reviews",
		truncateMiddle(manifest.lanes.map((lane) => readArtifact(cwd, config, `handoff-review-${lane.id}.md`)).join("\n\n"), 40_000),
		"",
		"Return markdown with verdict-style summary: completed lanes, validation passed/failed, changed file areas, blockers, and recommended next command.",
	].join("\n");
	const result = await runPiOnce({
		cwd,
		model: config.localReviewerModel,
		prompt,
		noTools: true,
		timeoutMs: 8 * 60_000,
		liveLabel: "handoff-summary",
		rawEventPath: artifactPath(cwd, config, "events.jsonl"),
		onLog: liveLog,
	});
	writeArtifact(cwd, config, state, "run-summary.md", `# Handoff Run Summary\n\n${result.text || "(no output)"}\n\n---\n\n- ok: ${result.ok}\n- exitCode: ${result.exitCode}\n- usage: ${formatUsage(result)}\n`);
	return result;
}

async function runHandoffOrchestration(options: {
	cwd: string;
	ctx?: any;
	handoffDir?: string;
	resume?: boolean;
	configOverrides?: Partial<HarnessConfig>;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<HybridRunDetails>) => void;
}): Promise<HybridRunDetails> {
	const config = loadConfig(options.cwd, options.configOverrides ?? {});
	ensureStateDir(options.cwd, config);
	try { fs.writeFileSync(artifactPath(options.cwd, config, "events.jsonl"), "", "utf8"); } catch {}
	let state = loadState(options.cwd, config);
	const manifest = options.resume
		? readHandoffManifest(options.cwd, config)
		: discoverHandoff(options.handoffDir || "", options.cwd);
	if (!manifest) throw new Error("No imported handoff manifest found. Run /hybrid-handoff-run <dir> first.");
	if (!options.resume) {
		cleanRunArtifacts(options.cwd, config);
		state = {
			version: 1,
			phase: "idle",
			updatedAt: nowIso(),
			task: manifest.objective,
			createdAt: nowIso(),
			localWorkerModel: config.localWorkerModel,
			localReviewerModel: config.localReviewerModel,
			frontierModel: config.frontierModel,
			frontierThinking: config.frontierThinking,
			artifacts: {},
		};
		importHandoffArtifacts(options.cwd, config, state, manifest);
	}
	state.task = manifest.objective;
	saveState(options.cwd, config, state);
	const runState = loadHybridRunState(options.cwd, config, manifest.objective, "handoff");
	if (!options.resume) {
		runState.writerSessionId = newHybridWriterSessionId(manifest.objective);
		runState.writerSessionDir = config.writerSessionDir || "sessions";
		runState.completedStages = {};
	}
	runState.status = "running";
	runState.lastError = undefined;
	saveHybridRunState(options.cwd, config, state, runState);
	const details = createHybridRunDetails(manifest.objective, "handoff", config);
	details.writerSessionId = runState.writerSessionId;
	details.writerSessionDir = path.relative(options.cwd, hybridWriterSessionDir(options.cwd, config, runState.writerSessionDir)) || runState.writerSessionDir;
	details.stages = [
		{ id: "checkpoint", label: "Pre-run checkpoint", status: "pending" },
		{ id: "handoff-import", label: "Import external handoff", status: options.resume ? "skipped" : "pending" },
		...manifest.lanes.flatMap((lane) => [
			{ id: `handoff-lane-${lane.id}`, label: `Lane ${lane.id}: ${lane.name}`, status: "pending" as HybridStageStatus },
			{ id: `handoff-review-${lane.id}`, label: `Review ${lane.id}: ${lane.name}`, status: "pending" as HybridStageStatus },
		]),
		{ id: "handoff-integration", label: "Integration seam gate", status: "pending" },
		{ id: "handoff-verification", label: "Final deterministic verification", status: "pending" },
		{ id: "summary", label: "Local final summary", status: "pending" },
		{ id: "handoff-frontier-final", label: "Frontier final gate", status: "pending" },
	];
	const reporter = createHybridReporter(details, options.onUpdate, options.ctx);
	const notify: Notify = (message, type = "info") => {
		options.ctx?.ui?.notify?.(message, type);
		reporter.log(`[notice] ${message}`);
	};
	const baseLiveLog = createLiveLogger(options.cwd, config, state, options.ctx);
	const liveLog: LiveLog = (line) => { baseLiveLog(line); reporter.log(line); };
	(liveLog as any).onEvent = (label: string, event: any) => reporter.childEvent(label, event);
	(liveLog as any).signal = options.signal ?? options.ctx?.signal;
	try {
		reporter.stage("checkpoint", "running", "Creating git checkpoint before handoff edits");
		const checkpoint = createGitCheckpoint(options.cwd, config, `pre-handoff-${manifest.taskName.slice(0, 40)}`);
		reporter.stage("checkpoint", "done", checkpoint ?? "Skipped: not a git repository or unavailable");
		if (!options.resume) reporter.stage("handoff-import", "done", `${manifest.lanes.length} lane(s) imported`);
		reporter.setProgress(readProgress(options.cwd, config, manifest.objective));
		for (const lane of manifest.lanes) {
			const progress = readProgress(options.cwd, config, manifest.objective);
			const existing = progress.slices.find((slice) => slice.id === `L${lane.id}`);
			if (options.resume && existing?.status === "done") {
				reporter.stage(`handoff-lane-${lane.id}`, "skipped", "already done");
				continue;
			}
			const ok = await runHandoffLaneLoop(options.cwd, config, state, runState, manifest, lane, reporter, notify, liveLog);
			if (!ok) throw new Error(`Handoff lane ${lane.id} failed after repair loop. See ${config.stateDir}/handoff-review-${lane.id}.md`);
		}
		// Executable seam gate: per-lane green does not prove the consumer<->producer integration.
		// A multi-lane handoff should drive the consumer against the real producer end to end.
		// A MISSING gate does not crash the run (that would brick every handoff authored before
		// integration_e2e existed) -- it finishes with a loud "seam UNVERIFIED" concern unless
		// requireIntegrationGate enforces strict mode. A gate that EXISTS but FAILS always fails.
		let seamUnverified = false;
		if (manifest.lanes.length >= 2) {
			reporter.stage("handoff-integration", "running", "Running executable integration gate (consumer -> producer seam)");
			const integration = runHandoffIntegrationGate(options.cwd, config, state, manifest, notify);
			if (!integration.ran) {
				if (config.requireIntegrationGate) {
					reporter.stage("handoff-integration", "failed", "no executable integration gate; cross-lane seam UNVERIFIED (strict)");
					throw new Error(
						"Handoff has no executable integration gate, so the cross-lane seam is UNVERIFIED (per-lane unit tests + build do not prove it). Add an Executable Integration Gate (integration_e2e) that drives the consumer against the real producer, or unset requireIntegrationGate.",
					);
				}
				seamUnverified = true;
				notify?.(
					"No executable integration gate found; the cross-lane seam is UNVERIFIED. Add integration_e2e to verify it end to end (set requireIntegrationGate to enforce).",
					"warning",
				);
				reporter.stage("handoff-integration", "skipped", "no executable integration gate — cross-lane seam UNVERIFIED (add integration_e2e; requireIntegrationGate to enforce)");
			} else if (!integration.allPassed) {
				reporter.stage("handoff-integration", "failed", `integration gate failed (${integration.commandCount} command(s))`);
				throw new Error(`Handoff integration gate failed; the consumer<->producer seam is broken. See ${config.stateDir}/test-evidence.md`);
			} else {
				reporter.stage("handoff-integration", "done", `${integration.commandCount} integration command(s) passed`);
			}
		} else {
			reporter.stage("handoff-integration", "skipped", "single-lane handoff; no cross-lane seam");
		}
		reporter.stage("handoff-verification", "running", "Running final inferred test, lint, typecheck, and build commands");
		const completionVerification = runVerificationSummary(options.cwd, config, state, notify);
		if (!completionVerification.allPassed) {
			reporter.stage("handoff-verification", "failed", "one or more final verification commands failed");
			throw new Error(`Handoff final verification failed. See ${config.stateDir}/verification-summary.md`);
		}
		reporter.stage("handoff-verification", "done", `${completionVerification.commands.length} command(s) passed`);
		reporter.stage("summary", "running", "Generating local final summary");
		await runHandoffFinalSummary(options.cwd, config, state, manifest, notify, liveLog);
		reporter.stage("summary", "done", "local summary written");
		details.localVerdict = seamUnverified ? "PASS_WITH_CONCERNS" : "PASS";
		reporter.stage("handoff-frontier-final", "running", "Reviewing final artifacts and canonical task status");
		const final = await runFrontierFinal(options.cwd, config, state, notify, liveLog);
		details.frontierVerdict = final.verdict;
		if (final.verdict !== "APPROVE") {
			reporter.stage("handoff-frontier-final", "failed", `verdict=${final.verdict}`);
			const progress = readProgress(options.cwd, config, manifest.objective);
			const finalPayload = extractJsonObject<{ blockingIssues?: string[]; requiredFixes?: string[]; highRiskResidualBlockers?: string[] }>(final.result.text);
			progress.blockers = uniqueStrings([
				...progress.blockers,
				...(finalPayload?.blockingIssues ?? []),
				...(finalPayload?.requiredFixes ?? []),
				...(finalPayload?.highRiskResidualBlockers ?? []),
			]);
			progress.nextAction = `Resolve frontier final verdict ${final.verdict}, then resume the handoff run.`;
			writeProgress(options.cwd, config, state, progress);
			throw new Error(`Frontier final gate rejected handoff completion: ${final.verdict}. See ${config.stateDir}/final-review.md`);
		}
		reporter.stage("handoff-frontier-final", "done", "verdict=APPROVE");
		details.status = "done";
		details.finishedAt = nowIso();
		details.artifacts = { ...state.artifacts };
		details.usageSummary = usageSummaryMarkdown(options.cwd, config);
		writeArtifact(options.cwd, config, state, "usage-summary.md", details.usageSummary);
		saveState(options.cwd, config, state);
		reporter.setProgress(readProgress(options.cwd, config, manifest.objective));
		return details;
	} catch (error) {
		details.status = "failed";
		details.finishedAt = nowIso();
		details.error = error instanceof Error ? error.message : String(error);
		details.artifacts = { ...state.artifacts };
		details.usageSummary = usageSummaryMarkdown(options.cwd, config);
		writeArtifact(options.cwd, config, state, "usage-summary.md", details.usageSummary);
		saveState(options.cwd, config, state);
		reporter.setProgress(readProgress(options.cwd, config, manifest.objective));
		return details;
	}
}

// Whether the workspace has any deterministic behavioral test available (configured
// testCommand, configured verification command, or an inferred runtime test), as
// opposed to smoke-only checks (typecheck/build/lint).
function hasBehavioralTestCommand(cwd: string, config: HarnessConfig): boolean {
	if (config.testCommand?.trim()) return true;
	if (config.verificationCommands.length)
		return config.verificationCommands.some(isBehavioralTestCommand);
	return inferVerificationCommands(cwd).some(isBehavioralTestCommand);
}

interface ReviewBlockers {
	highRiskResidualBlockers: string[];
	blockingIssues: string[];
	missingEvidence: string[];
	nextAction?: string;
}

// Pull the structured blockers out of a review's JSON so they can be surfaced in
// run-summary.md, where the parent orchestrator cannot miss them.
function extractReviewBlockers(reviewText: string): ReviewBlockers {
	const json = extractJsonObject<{
		highRiskResidualBlockers?: unknown;
		blockingIssues?: unknown;
		missingEvidence?: unknown;
		nextAction?: unknown;
	}>(reviewText);
	return {
		highRiskResidualBlockers: normalizeStringArray(json?.highRiskResidualBlockers),
		blockingIssues: normalizeStringArray(json?.blockingIssues),
		missingEvidence: normalizeStringArray(json?.missingEvidence),
		nextAction:
			typeof json?.nextAction === "string" && json.nextAction.trim()
				? json.nextAction.trim()
				: undefined,
	};
}

// Builds the "## Orchestrator directives" block appended to run-summary.md. This is
// the machine-actionable guidance the parent reads first: convergence state, the one
// directive to follow, the blockers to target, and any setup gaps (no tests, generic
// progress) that would otherwise make the loop spin without converging.
function orchestratorDirectivesMarkdown(input: {
	convergence: Convergence;
	verdict: string;
	workspaceChanged: boolean;
	interactivePolicyActive: boolean;
	hasDeterministicTest: boolean;
	fallbackProgress: boolean;
	uncheckedCanonicalTasks: boolean;
	repeatedNonProgressCount: number;
	blockers: ReviewBlockers;
}): string {
	const lines = [
		"## Orchestrator directives",
		"",
		`- convergence: ${input.convergence}`,
		`- workspaceChanged: ${input.workspaceChanged}`,
		`- interactiveRuntimePolicy: ${input.interactivePolicyActive ? "active" : "inactive"}`,
		`- deterministicBehavioralTest: ${input.hasDeterministicTest ? "present" : "MISSING"}`,
		`- repeatedNonProgressPackages: ${input.repeatedNonProgressCount}`,
		"",
		`Directive: ${convergenceDirective(input.convergence)}`,
	];
	if (input.repeatedNonProgressCount >= 2) {
		lines.push(
			"",
			`WARNING: ${input.repeatedNonProgressCount} consecutive packages made no real progress. Stop repeating packages — change strategy or escalate to the user.`,
		);
	}
	// Only nag about decomposition when the package did not complete: a finished
	// one-off package legitimately keeps the generic single-slice progress.
	if (input.fallbackProgress && input.convergence !== "complete") {
		lines.push(
			"",
			"SETUP GAP: progress.json is still the generic single-slice fallback. Populate it with real slices and acceptance criteria (decompose tasks.md if using spec-kit), and keep tasks.md checkboxes in sync.",
		);
	}
	if (input.uncheckedCanonicalTasks) {
		lines.push(
			"",
			"NOTE: canonical specs/**/tasks.md has unchecked required tasks. Completion claims must reconcile against that tracker.",
		);
	}
	const blockerLines: string[] = [];
	for (const b of input.blockers.highRiskResidualBlockers)
		blockerLines.push(`- [high-risk] ${b}`);
	for (const b of input.blockers.blockingIssues) blockerLines.push(`- [blocking] ${b}`);
	for (const b of input.blockers.missingEvidence)
		blockerLines.push(`- [missing-evidence] ${b}`);
	if (blockerLines.length) {
		lines.push(
			"",
			"Target these review findings in the next package (highest risk first):",
			...blockerLines,
		);
	}
	if (input.blockers.nextAction) {
		lines.push("", `Reviewer next action: ${input.blockers.nextAction}`);
	}
	return lines.join("\n");
}

async function runHybridExecutionPackage(options: {
	cwd: string;
	ctx?: any;
	task?: string;
	packageId?: string;
	executionPackage: string;
	loops?: number;
	debug?: boolean;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<HybridRunDetails>) => void;
}): Promise<HybridRunDetails> {
	const config = loadConfig(options.cwd);
	ensureStateDir(options.cwd, config);
	let state = loadState(options.cwd, config);
	const task = (options.task ?? state.task ?? readArtifact(options.cwd, config, "task.md").replace(/^# Task\s*/i, "").trim()).trim();
	if (!task) throw new Error("hybrid_exec requires a task or existing hybrid task state");
	if (!state.task) {
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
		writeArtifact(options.cwd, config, state, "task.md", `# Task\n\n${task}\n`);
		saveState(options.cwd, config, state);
	}
	const runState = loadHybridRunState(options.cwd, config, task, "default");
	runState.status = "running";
	runState.lastError = undefined;
	saveHybridRunState(options.cwd, config, state, runState);
	const packageId = options.packageId?.trim() || `package-${Date.now().toString(36)}`;
	const packageMarkdown = [
		"# Parent Orchestrator Execution Package",
		"",
		`- packageId: ${packageId}`,
		`- task: ${task}`,
		`- debug: ${options.debug === true}`,
		`- createdAt: ${nowIso()}`,
		`- writerSessionId: ${runState.writerSessionId}`,
		"",
		"## Contract",
		"",
		"This package was produced by the active parent Pi orchestrator session. The harness should execute it with the persistent single-writer session, collect evidence, run focused verification, and return artifacts for the parent orchestrator to decide the next package.",
		"",
		"## Package",
		"",
		options.executionPackage.trim(),
		"",
	].join("\n");
	writeArtifact(options.cwd, config, state, "orchestrator-package.md", packageMarkdown);
	if (!readArtifact(options.cwd, config, "progress.json").trim()) {
		writeProgress(options.cwd, config, state, fallbackProgress(task));
	}
	const details = createHybridRunDetails(task, "default", config);
	details.writerSessionId = runState.writerSessionId;
	details.writerSessionDir = path.relative(options.cwd, hybridWriterSessionDir(options.cwd, config, runState.writerSessionDir)) || runState.writerSessionDir;
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
	(liveLog as any).onEvent = (label: string, event: any) => reporter.childEvent(label, event);
	(liveLog as any).signal = options.signal ?? options.ctx?.signal;
	reporter.setProgress(readProgress(options.cwd, config, task));
	const packageSignatureBefore = workspaceSignature(options.cwd, config);
	try {
		reporter.stage("local-loop", "running", `parent package ${packageId}`);
		const testPassed = await runLocalLoop(
			options.cwd,
			config,
			state,
			runState,
			task,
			Math.max(1, Math.floor(options.loops ?? (options.debug ? config.maxLocalLoops : 1))),
			notify,
			packageId,
			liveLog,
		);
		reporter.stage("local-loop", "done", `package=${packageId}; tests=${testPassed ? "passed" : config.testCommand ? "not passed" : "not configured"}`);
		const finish = finishHybridArtifacts(options.cwd, config, state, task, notify);
		reporter.setProgress(finish.progress);
		reporter.stage("finish", "done", `verification=${finish.summary.allPassed ? "passed" : finish.summary.commands.length ? "failed" : "not configured"}`);
		// Parent-driven mode: keep per-package review on the local reviewer so frontier
		// tokens are spent only on the explicit /hybrid-final gate. Deterministic
		// verification (above) still runs every package. The parent orchestrator (itself
		// frontier) reads these artifacts and decides the next package.
		const review = await runLocalReview(
			options.cwd,
			config,
			state,
			notify,
			liveLog,
			localImplementationReviewer(config),
		);
		details.localVerdict = review.verdict;
		reporter.stage("local-review", review.verdict === "FAIL" ? "failed" : "done", localReviewSummary(review.verdict, readArtifact(options.cwd, config, "local-review.md")));

		// Convergence assessment: turn this package's outcome into a machine-actionable
		// signal so the parent cannot silently spin on no-progress packages.
		const workspaceChanged =
			workspaceSignature(options.cwd, config) !== packageSignatureBefore;
		const interactivePolicyActive = interactiveRuntimePolicyApplies(
			options.cwd,
			config,
			task,
		);
		const hasDeterministicTest = hasBehavioralTestCommand(options.cwd, config);
		// If verification commands ran, they must pass. If none were applicable, don't
		// block completion on verification for a non-interactive task (review is the gate);
		// interactive tasks are still gated by hasDeterministicTest in assessConvergence.
		const verificationPassed =
			finish.summary.commands.length > 0
				? finish.summary.allPassed
				: !interactivePolicyActive;
		const convergence = assessConvergence({
			verdict: review.verdict,
			verificationPassed,
			workspaceChanged,
			interactivePolicyActive,
			hasDeterministicTest,
		});
		const nonProgress = convergence === "stalled" || convergence === "blocked-no-tests";
		const repeatedNonProgressCount = nonProgress
			? (runState.repeatedNonProgressCount ?? 0) + 1
			: 0;
		runState.lastPackageId = packageId;
		runState.lastPackageVerdict = review.verdict;
		runState.lastPackageConvergence = convergence;
		runState.repeatedNonProgressCount = repeatedNonProgressCount;
		saveHybridRunState(options.cwd, config, state, runState);
		details.convergence = convergence;
		details.repeatedNonProgress = repeatedNonProgressCount;

		const directives = orchestratorDirectivesMarkdown({
			convergence,
			verdict: review.verdict,
			workspaceChanged,
			interactivePolicyActive,
			hasDeterministicTest,
			fallbackProgress: isFallbackProgress(finish.progress),
			uncheckedCanonicalTasks: hasUncheckedCanonicalTasks(options.cwd),
			repeatedNonProgressCount,
			blockers: extractReviewBlockers(
				readArtifact(options.cwd, config, "local-review.md"),
			),
		});

		writeArtifact(options.cwd, config, state, "usage-summary.md", usageSummaryMarkdown(options.cwd, config));
		writeArtifact(
			options.cwd,
			config,
			state,
			"run-summary.md",
			[
				"# Hybrid Exec Package Summary",
				"",
				`- packageId: ${packageId}`,
				`- task: ${task}`,
				`- writerSessionId: ${runState.writerSessionId}`,
				`- configuredTestsPassed: ${testPassed}`,
				`- verificationAllPassed: ${finish.summary.allPassed}`,
				`- reviewer: ${config.localReviewerModel} (local)`,
				`- localReviewVerdict: ${review.verdict}`,
				`- convergence: ${convergence}`,
				`- workspaceChanged: ${workspaceChanged}`,
				`- finishedAt: ${nowIso()}`,
				"",
				directives,
				"",
				"The parent Pi orchestrator should inspect orchestrator-package.md, progress.json, local-log.md, test-evidence.md, git-summary.md, verification-summary.json, and local-review.md before deciding the next package.",
				"Per-package review uses the local reviewer; deterministic verification runs every package. Reserve the frontier model for the final ship decision: run /hybrid-final once the whole feature is complete.",
			].join("\n"),
		);
		syncHarnessArtifacts(options.cwd, config, state);
		details.status = "done";
		details.finishedAt = nowIso();
		details.usageSummary = usageSummaryMarkdown(options.cwd, config);
		details.artifacts = { ...state.artifacts };
		reporter.stage("summary", "done", `package ${packageId}: convergence=${convergence}${repeatedNonProgressCount >= 2 ? ` (no progress x${repeatedNonProgressCount})` : ""}`);
		return details;
	} catch (error) {
		details.status = "failed";
		details.finishedAt = nowIso();
		details.error = String(error instanceof Error ? error.stack || error.message : error);
		details.artifacts = { ...state.artifacts };
		markHybridRunFailure(options.cwd, config, state, runState, error);
		return details;
	}
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
		runState.writerSessionId = newHybridWriterSessionId(task);
		runState.writerSessionDir = config.writerSessionDir || "sessions";
	}
	runState.status = "running";
	runState.lastError = undefined;
	saveHybridRunState(options.cwd, config, state, runState);
	const details = createHybridRunDetails(task, mode, config);
	details.writerSessionId = runState.writerSessionId;
	details.writerSessionDir = path.relative(options.cwd, hybridWriterSessionDir(options.cwd, config, runState.writerSessionDir)) || runState.writerSessionDir;
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
		`- writerSession: ${config.persistentWriterSession ? runState.writerSessionId : "ephemeral"}`,
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

		let brief: OrchestrationBrief | undefined;
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
				brief = readOrchestrationBriefArtifact(options.cwd, config);
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
				brief = await createOrchestrationBrief(
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
					const action = await showHybridClarificationGate(options.ctx, brief);
					if (action.kind === "run") {
						const decision = [
							"# Hybrid clarification decision",
							"",
							"사용자가 추가 답변 없이 현재 설계와 기본 가정대로 계속 진행하도록 승인했습니다.",
							"",
						].join("\n");
						writeArtifact(
							options.cwd,
							config,
							state,
							"user-clarifications.md",
							decision,
						);
						brief.assumptions.push(
							"User approved proceeding without additional clarification.",
						);
						summary.push(
							"- User chose to proceed without additional clarification.",
							"",
						);
					} else if (action.kind === "edit" || action.kind === "answer") {
						const prefill = [
							`# Hybrid clarification request`,
							"",
							"구현 결과를 바꿀 수 있는 질문입니다. 질문에 답하거나 진행 방식을 직접 지시하세요.",
							"",
							...brief.blockingQuestions.map((q, i) => `${i + 1}. ${q}`),
							"",
							"## 답변/진행 프롬프트",
							"",
							action.kind === "answer" ? action.text : "",
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
							brief.assumptions.push(
								`User clarification: ${truncateMiddle(answers.trim(), 1000)}`,
							);
							summary.push(
								"- User clarifications captured in user-clarifications.md",
								"",
							);
						} else {
							throw new Error(
								"Hybrid run stopped for user clarification. See .pi-harness/orchestration-brief.md",
							);
						}
					} else {
						throw new Error(
							"Hybrid run stopped for user clarification. See .pi-harness/orchestration-brief.md",
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

		if (
			!explicitTask &&
			shouldSkipHybridStage(options.cwd, config, runState, "plan-review")
		) {
			const planReviewVerdict = parsePlanReviewVerdict(
				readArtifact(options.cwd, config, "plan-review.md"),
			);
			summary.push(
				"## Plan review",
				"",
				`- Reusing existing plan-review.md. Verdict: ${planReviewVerdict}`,
				"",
			);
			reporter.stage(
				"plan-review",
				"skipped",
				`Reusing plan-review.md verdict=${planReviewVerdict}`,
			);
			markHybridRunStage(
				options.cwd,
				config,
				state,
				runState,
				"plan-review",
				"skipped",
			);
			if (planReviewVerdict !== "READY") {
				throw new Error(
					"Hybrid plan review blocked implementation. See .pi-harness/plan-review.md",
				);
			}
		} else {
			if (!brief) {
				notify?.(
					config.briefBeforeImplementation
						? "Plan review needs orchestration brief; regenerating risk summary from artifacts."
						: "Plan review needs orchestration brief even when briefBeforeImplementation=false.",
					"info",
				);
				reporter.stage(
					"brief",
					"running",
					config.briefBeforeImplementation
						? "Regenerating risk summary for plan review"
						: "briefBeforeImplementation=false; creating one-off risk brief for plan review",
				);
				brief = await createOrchestrationBrief(
					options.cwd,
					config,
					state,
					task,
					notify,
					liveLog,
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
				if (brief.recommendedAction === "stop") {
					throw new Error(
						"Hybrid orchestration brief recommended stop. See .pi-harness/orchestration-brief.md",
					);
				}
			}
			if (seriousTaskPolicyApplies(brief)) {
				reporter.stage(
					"plan-review",
					"running",
					`validating ${brief.taskRisk} risk plan before local-loop`,
				);
				markHybridRunStage(
					options.cwd,
					config,
					state,
					runState,
					"plan-review",
					"running",
				);
				const { review: planReview, result: planReviewResult } = await runPlanReview(
					options.cwd,
					config,
					state,
					task,
					brief,
					notify,
					liveLog,
				);
				const planReviewReady =
					planReview.verdict === "READY" && planReviewResult.ok === true;
				summary.push(
					"## Plan review",
					"",
					`- Verdict: ${planReview.verdict}`,
					`- plan_architect: ${planReview.planArchitectVerdict}`,
					`- plan_critic: ${planReview.planCriticVerdict}`,
					`- child execution: ${planReviewResult.ok ? "ok" : "failed"}`,
					"",
				);
				reporter.stage(
					"plan-review",
					planReviewReady ? "done" : "failed",
					`verdict=${planReview.verdict}; child=${planReviewResult.ok ? "ok" : "failed"}`,
				);
				markHybridRunStage(
					options.cwd,
					config,
					state,
					runState,
					"plan-review",
					planReviewReady ? "done" : "failed",
					undefined,
					undefined,
					!planReviewReady
						? planReviewResult.ok
							? "Plan review blocked local implementation."
							: "Plan review child execution failed."
						: undefined,
				);
				if (!planReviewReady) {
					throw new Error(
						planReviewResult.ok
							? "Hybrid plan review blocked implementation. See .pi-harness/plan-review.md"
							: "Hybrid plan review blocked implementation because the plan review child execution failed. See .pi-harness/plan-review.md",
					);
				}
			} else {
				summary.push(
					"## Plan review",
					"",
					`- Skipped: ${brief.taskRisk} risk task.`,
					"",
				);
				reporter.stage(
					"plan-review",
					"skipped",
					`${brief.taskRisk} risk; serious-task gate not required`,
				);
				markHybridRunStage(
					options.cwd,
					config,
					state,
					runState,
					"plan-review",
					"skipped",
				);
			}
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
						runState,
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
					const reviewText = readArtifact(options.cwd, config, "local-review.md");
					localVerdict = parseLocalVerdict(reviewText);
					reporter.stage(
						"local-review",
						"skipped",
						localReviewSummary(localVerdict, reviewText),
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
					const reviewText = readArtifact(options.cwd, config, "local-review.md");
					reporter.stage(
						"local-review",
						localVerdict === "FAIL" ? "failed" : "done",
						localReviewSummary(localVerdict, reviewText),
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
					finalVerdict === "APPROVE" ? "done" : "failed",
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

		const frontierApproved = finalVerdict === "APPROVE";
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
		details.status = frontierApproved ? "done" : "failed";
		if (!frontierApproved) details.error = `Frontier final gate did not approve completion: ${finalVerdict}`;
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
		reporter.stage("summary", frontierApproved ? "done" : "failed", frontierApproved ? "Artifacts written" : details.error);
		markHybridRunStage(
			options.cwd,
			config,
			state,
			runState,
			"summary",
			frontierApproved ? "done" : "failed",
		);
		reporter.emit(`Hybrid run ${frontierApproved ? "complete" : "rejected"}: ${finalVerdict}`);
		setStatusWidget(options.ctx, statusMarkdown(options.cwd, config, state));
		const notifyType =
			finalVerdict === "APPROVE"
				? "info"
				: finalVerdict === "ESCALATE_TO_USER"
					? "error"
					: "warning";
		options.ctx?.ui?.notify?.(
			`Hybrid run ${frontierApproved ? "complete" : "rejected"}: ${finalVerdict}`,
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
					id: "qwen36-27b-mtp-q5kxl",
					name: "Qwen3.6-27B MTP Q5_K_XL",
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

	const startHybridRunAfterGate = (
		kind: "interview" | "grill",
		report: string,
		config: HarnessConfig,
		state: HarnessState,
		ctx: any,
	): boolean => {
		if (!frontierGateReadyForHybridRun(kind, report)) {
			ctx.ui.notify(
				`Hybrid ${kind} is not ready for run yet. Answer the remaining gate question first.`,
				"warning",
			);
			return false;
		}
		try {
			ensureHybridGateTaskForRun(ctx.cwd, config, state, report);
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
			return false;
		}
		const { liveId } = startHybridBackgroundRun({
			pi,
			cwd: ctx.cwd,
			ctx,
			args: "",
			mode: "default",
		});
		ctx.ui.notify(
			`Hybrid ${kind} ready; /hybrid-run started in background (${liveId}). Use /hybrid-monitor to follow progress.`,
			"info",
		);
		setStatusWidget(ctx, statusMarkdown(ctx.cwd, config, state));
		return true;
	};

	const showHybridInterview = async (
		initialResult: PiRunResult,
		config: HarnessConfig,
		state: HarnessState,
		ctx: any,
	) => {
		let result = initialResult;
		while (true) {
			const report = readArtifact(ctx.cwd, config, "requirements.md");
			const ready = frontierGateReadyForHybridRun("interview", report);
			const displayReport = ready
				? hybridGateApprovalSummaryKo("interview", report)
				: report;
			setStatusWidget(ctx, displayReport);
			const action = ctx?.hasUI && ctx?.ui?.custom
				? await ctx.ui.custom(
					(tui: TUI, theme: any, _keybindings: unknown, done: (result?: HybridGateAction) => void) =>
						new HybridReportOverlayComponent(tui, "Hybrid Interview", displayReport, theme, done, {
							choices: ready ? [] : extractHybridGateChoices(report),
							ready,
							allowGrill: ready,
						}),
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "90%",
							minWidth: 70,
							maxHeight: "80%",
						},
					},
					)
				: { kind: "close" } as HybridGateAction;
			if (!(ctx?.hasUI && ctx?.ui?.custom)) {
				pi.sendMessage({
					customType: HYBRID_REPORT_MESSAGE_TYPE,
					content: "Hybrid Interview",
					display: true,
					details: { title: "Hybrid Interview", markdown: displayReport },
				});
			}
			ctx.ui.notify(
				`Hybrid interview ${result.ok ? "complete" : "failed"}. See ${config.stateDir}/requirements.md.`,
				result.ok ? "info" : "warning",
			);
			if (action.kind === "run") {
				startHybridRunAfterGate("interview", report, config, state, ctx);
				return;
			}
			if (action.kind === "grill") {
				const grill = await runWithHybridGateLoading(
					ctx,
					"Hybrid Grill",
					"grill 검토를 준비하고 있습니다",
					"frontier가 현재 interview 내용을 바탕으로 설계 리스크를 검토 중입니다.",
					() => runFrontierGrill(
						ctx.cwd,
						config,
						state,
						report,
						(message, type = "info") => ctx.ui.notify(message, type),
					),
				);
				await showHybridGrill(grill, config, state, ctx);
				return;
			}
			if (action.kind === "answer") {
				result = await runWithHybridGateLoading(
					ctx,
					"Hybrid Interview",
					"다음 질문을 준비하고 있습니다",
					"frontier가 선택한 답변을 반영해 다음 질문 또는 구현 handoff를 작성 중입니다.",
					() => runFrontierInterview(
						ctx.cwd,
						config,
						state,
						action.text,
						(message, type = "info") => ctx.ui.notify(message, type),
					),
				);
				continue;
			}
			if (action.kind !== "edit") return;

			const answer = await ctx.ui.editor?.(
				"Hybrid interview answer",
				[
					"# Hybrid interview answer",
					"",
					"Write your answer below. Save and close to submit it to the interview.",
					"",
					"## Answer",
					"",
					"",
					"## Current interview",
					"",
					report,
					"",
				].join("\n"),
			);
			if (typeof answer !== "string") continue;
			const draft = extractHybridInterviewAnswerDraft(answer);
			if (!draft.trim()) continue;
			result = await runWithHybridGateLoading(
				ctx,
				"Hybrid Interview",
				"다음 질문을 준비하고 있습니다",
				"frontier가 직접 입력한 답변을 반영해 다음 질문 또는 구현 handoff를 작성 중입니다.",
				() => runFrontierInterview(
					ctx.cwd,
					config,
					state,
					draft,
					(message, type = "info") => ctx.ui.notify(message, type),
				),
			);
		}
	};

	const showHybridGrill = async (
		initialResult: PiRunResult,
		config: HarnessConfig,
		state: HarnessState,
		ctx: any,
	) => {
		let result = initialResult;
		while (true) {
			const report = readArtifact(ctx.cwd, config, "design-grill.md");
			const ready = frontierGateReadyForHybridRun("grill", report);
			const displayReport = ready
				? hybridGateApprovalSummaryKo("grill", report)
				: report;
			setStatusWidget(ctx, displayReport);
			const action = ctx?.hasUI && ctx?.ui?.custom
				? await ctx.ui.custom(
					(tui: TUI, theme: any, _keybindings: unknown, done: (result?: HybridGateAction) => void) =>
						new HybridReportOverlayComponent(tui, "Hybrid Grill", displayReport, theme, done, {
							choices: ready ? [] : extractHybridGateChoices(report),
							ready,
						}),
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "90%",
							minWidth: 70,
							maxHeight: "80%",
						},
					},
				)
				: { kind: "close" } as HybridGateAction;
			if (!(ctx?.hasUI && ctx?.ui?.custom)) {
				pi.sendMessage({
					customType: HYBRID_REPORT_MESSAGE_TYPE,
					content: "Hybrid Grill",
					display: true,
					details: { title: "Hybrid Grill", markdown: displayReport },
				});
			}
			ctx.ui.notify(
				`Hybrid grill ${result.ok ? "complete" : "failed"}. See ${config.stateDir}/design-grill.md.`,
				result.ok ? "info" : "warning",
			);
			if (action.kind === "run") {
				startHybridRunAfterGate("grill", report, config, state, ctx);
				return;
			}
			if (action.kind === "answer") {
				result = await runWithHybridGateLoading(
					ctx,
					"Hybrid Grill",
					"다음 grill 응답을 준비하고 있습니다",
					"frontier가 선택한 답변을 반영해 추가 질문 또는 최종 검토 내용을 작성 중입니다.",
					() => runFrontierGrill(
						ctx.cwd,
						config,
						state,
						action.text,
						(message, type = "info") => ctx.ui.notify(message, type),
					),
				);
				continue;
			}
			if (action.kind !== "edit") return;

			const answer = await ctx.ui.editor?.(
				"Hybrid grill answer",
				[
					"# Hybrid grill answer",
					"",
					"Write your answer or design revision below. Save and close to submit it to the grill.",
					"",
					"## Answer",
					"",
					"",
					"## Current grill",
					"",
					report,
					"",
				].join("\n"),
			);
			if (typeof answer !== "string") continue;
			const draft = extractHybridInterviewAnswerDraft(answer);
			if (!draft.trim()) continue;
			result = await runWithHybridGateLoading(
				ctx,
				"Hybrid Grill",
				"다음 grill 응답을 준비하고 있습니다",
				"frontier가 직접 입력한 답변을 반영해 추가 질문 또는 최종 검토 내용을 작성 중입니다.",
				() => runFrontierGrill(
					ctx.cwd,
					config,
					state,
					draft,
					(message, type = "info") => ctx.ui.notify(message, type),
				),
			);
		}
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
				const manifest = readHandoffManifest(ctx.cwd, config);
				if (manifest?.rootDir) {
					const target = path.resolve(ctx.cwd, candidate);
					const root = path.resolve(manifest.rootDir);
					if (target === root || target.startsWith(`${root}${path.sep}`)) {
						return {
							block: true,
							reason: `Hybrid handoff safety guard blocked ${event.toolName} to handoff source path ${candidate}. Handoff documents are read-only inputs.`,
						};
					}
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
					enum: ["fast", "default", "thorough", "handoff"],
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


	pi.registerTool({
		name: "hybrid_exec",
		label: "Hybrid Exec Package",
		description:
			"Execute one parent-orchestrator package with the persistent single-writer session, then return review, verification, diff/evidence artifacts for the active Pi orchestrator session to decide the next package.",
		promptSnippet:
			"Execute the current spec-kit/orchestrator implementation package through the hybrid writer loop",
		promptGuidelines: [
			"Use hybrid_exec from an active parent Pi orchestrator session after spec-kit tasks are ready and you have decided the next bounded batch/package.",
			"Pass a concrete executionPackage. The tool runs implementation/repair/debug in the persistent writer session and returns artifacts; the parent orchestrator must inspect results and decide the next package.",
		],
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "Overall feature/task goal; optional if an active hybrid task exists",
				},
				packageId: {
					type: "string",
					description: "Stable ID for this orchestrator package/batch, e.g. T003 or B02-repair",
				},
				executionPackage: {
					type: "string",
					description: "The bounded implementation/repair/debug package produced by the parent Pi orchestrator",
				},
				loops: {
					type: "number",
					description: "Maximum local writer loops for this package; defaults to 1, or maxLocalLoops for debug=true",
				},
				debug: {
					type: "boolean",
					description: "Treat package as a debug/failure-cluster loop and allow the configured local loop count by default",
				},
			},
			required: ["executionPackage"],
			additionalProperties: false,
		} as any,
		async execute(
			_toolCallId: string,
			params: HybridExecParams,
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
			const preview = createHybridRunDetails(
				params.task ?? "parent orchestrator package",
				"default",
				loadConfig(ctx.cwd),
			);
			preview.currentStage = "local-loop";
			preview.recentOutput.push(
				`hybrid_exec package ${params.packageId ?? "package"} starting. Use /hybrid-monitor for live worker output.`,
			);
			store.set(liveId, { version: ++version, details: preview });
			const details = await runHybridExecutionPackage({
				cwd: ctx.cwd,
				ctx,
				task: params.task,
				packageId: params.packageId,
				executionPackage: params.executionPackage,
				loops: params.loops,
				debug: params.debug,
				signal,
				onUpdate: (result) => {
					if (result.details) {
						store.set(liveId, { version: ++version, details: result.details });
					}
					onUpdate?.(result);
					ctx.ui?.requestRender?.();
				},
			});
			store.set(liveId, { version: ++version, details });
			ctx.ui?.requestRender?.();
			return {
				content: [
					{
						type: "text",
						text: hybridDetailsToMarkdown(details, true),
					},
				],
				details,
				isError: details.status === "failed",
			};
		},
		renderCall(args: unknown, theme: any) {
			const params = args as Partial<HybridExecParams>;
			const w = getTermWidth() - 4;
			const packageId = params.packageId ? ` ${theme.fg("dim", `[${params.packageId}]`)}` : "";
			const taskPreview = truncateMiddle(
				params.task ?? params.executionPackage ?? "",
				Math.max(20, w - 36),
			);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("hybrid_exec"))}${packageId} ${theme.fg("accent", taskPreview)}`,
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

	pi.registerTool({
		name: "hybrid_final",
		label: "Hybrid Final Gate",
		description:
			"Run the frontier final gate over the accumulated artifacts (design, diff, evidence, reviews) and return APPROVE / REQUEST_CHANGES / ESCALATE_TO_USER. Disabled unless enableHybridFinalTool is set.",
		promptSnippet:
			"Run the frontier final ship-decision gate over the current hybrid artifacts",
		promptGuidelines: [
			"Use hybrid_final only after all packages are complete and per-package verification is clean — this is the single frontier-model gate in parent-driven mode.",
			"Do not call hybrid_final to review a single in-progress package; that is what the local per-package review already does.",
		],
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "Overall feature/task goal; optional if an active hybrid task exists",
				},
			},
			required: [],
			additionalProperties: false,
		} as any,
		async execute(
			_toolCallId: string,
			params: { task?: string },
			signal: AbortSignal,
			_onUpdate:
				| ((result: AgentToolResult<HybridRunDetails>) => void)
				| undefined,
			ctx: any,
		) {
			const config = loadConfig(ctx.cwd);
			if (!config.enableHybridFinalTool) {
				return {
					content: [
						{
							type: "text",
							text: "hybrid_final is disabled. Enable it with `/hybrid-set enableHybridFinalTool true` (or set \"enableHybridFinalTool\": true in .pi-harness/config.json), then retry. Otherwise a human can run the /hybrid-final slash command.",
						},
					],
					isError: true,
				};
			}
			ensureStateDir(ctx.cwd, config);
			const state = loadState(ctx.cwd, config);
			const task = (params.task ?? state.task ?? readArtifact(ctx.cwd, config, "task.md").replace(/^# Task\s*/i, "").trim()).trim();
			if (!task) {
				return {
					content: [{ type: "text", text: "hybrid_final requires an existing hybrid task (run hybrid_exec or /hybrid-run first)." }],
					isError: true,
				};
			}
			const notify: Notify = (message, type = "info") => ctx.ui?.notify?.(message, type);
			const liveId = makeHybridLiveId();
			setLastHybridLiveId(liveId);
			const store = getHybridLiveStore();
			const details = createHybridRunDetails(task, "default", config);
			details.currentStage = "frontier-final";
			details.stages = details.stages.filter((stage) => stage.id === "frontier-final" || stage.id === "finish" || stage.id === "summary");
			store.set(liveId, { version: 1, details });
			try {
				finishHybridArtifacts(ctx.cwd, config, state, task, notify);
				const final = await runFrontierFinal(
					ctx.cwd,
					config,
					state,
					notify,
					(line) => {
						const snap = store.get(liveId);
						if (snap) {
							snap.details.recentOutput.push(line);
							store.set(liveId, { version: snap.version + 1, details: snap.details });
							ctx.ui?.requestRender?.();
						}
					},
				);
				details.frontierVerdict = final.verdict;
				details.status = final.verdict === "APPROVE" ? "done" : "failed";
				details.finishedAt = nowIso();
				details.usageSummary = usageSummaryMarkdown(ctx.cwd, config);
				details.artifacts = { ...state.artifacts };
				for (const stage of details.stages) {
					if (stage.id === "frontier-final")
						stage.status = final.verdict === "APPROVE" ? "done" : "failed";
				}
				store.set(liveId, { version: 99, details });
				setStatusWidget(ctx, statusMarkdown(ctx.cwd, config, state));
				return {
					content: [
						{
							type: "text",
							text: `Frontier final gate: ${final.verdict}\n\n${truncateMiddle(readArtifact(ctx.cwd, config, "final-review.md"), 4000)}`,
						},
					],
					details,
					isError: final.verdict !== "APPROVE",
				};
			} catch (error) {
				details.status = "failed";
				details.error = String(error instanceof Error ? error.message : error);
				return {
					content: [{ type: "text", text: `hybrid_final failed: ${details.error}` }],
					details,
					isError: true,
				};
			}
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

	pi.registerCommand("hybrid-writer-session", {
		description: "Show the persistent writer session id, storage location, and bounded transcript file metadata",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			ensureStateDir(ctx.cwd, config);
			const info = hybridWriterSessionInfo(ctx.cwd, config);
			const lines = [
				"# Hybrid Persistent Writer Session",
				"",
				`- id: ${info.id ? `\`${info.id}\`` : "not created yet"}`,
				`- dir: \`${info.dir}\``,
				`- persistent writer enabled: ${config.persistentWriterSession}`,
				"",
				"## Transcript files",
				"",
				...(info.files.length
					? info.files.map((entry) => `- \`${path.relative(ctx.cwd, entry.file) || entry.file}\` (${formatBytes(entry.size)})`)
					: ["- none found yet"]),
				"",
				"## Logging policy",
				"",
				"- `/hybrid-monitor` shows live worker output from memory and does not append raw stream output to disk.",
				"- This command reports metadata only; it does not copy, expand, or duplicate the saved Pi session transcript.",
				"- Durable harness artifacts are compact/truncated summaries such as local-log.md, test-evidence.md, verification-summary.json, and run-summary.md.",
			].join("\n");
			await showReport("Hybrid Writer Session", lines, ctx);
		},
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

			const failedChecks = checks.filter((c) => /\bFAIL\b/.test(c));
			const endpointTrouble = checks.some(
				(c) => /local \/models: FAIL|local Pi smoke: FAIL/.test(c),
			);
			const reportLines = [
				`# Hybrid Doctor`,
				"",
				...checks.map((c) => `- ${c}`),
			];
			if (endpointTrouble) {
				reportLines.push(
					"",
					"## How to fix",
					"",
					`The local model endpoint (\`${config.localBaseUrl}\`) is not reachable or did not respond. The packaged default points at the author's LAN — set your own:`,
					"",
					"1. Make sure your local llama.cpp / OpenAI-compatible server is running and reachable.",
					"2. Point the harness at it (no need to edit shipped defaults):",
					"   - Env: `export HYBRID_LOCAL_BASE_URL=http://<host>:<port>/v1` then `/reload`.",
					`   - Or project config: add \`"localBaseUrl": "http://<host>:<port>/v1"\` to \`${config.stateDir}/config.json\` (\`/hybrid-config\`).`,
					"3. Pick worker/reviewer/frontier models with `/hybrid-models`.",
					"4. Re-run `/hybrid-doctor` to confirm.",
				);
			}
			const report = reportLines.join("\n");
			const state = loadState(ctx.cwd, config);
			writeArtifact(ctx.cwd, config, state, "doctor.md", report);
			saveState(ctx.cwd, config, state);
			setStatusWidget(ctx, report);
			if (ctx?.hasUI) await showReport("Hybrid Doctor", report, ctx);
			ctx.ui.notify(
				failedChecks.length
					? `Hybrid doctor: ${failedChecks.length} check(s) failed${endpointTrouble ? " — see 'How to fix' in the report" : ""}. ${config.stateDir}/doctor.md`
					: `Hybrid doctor: all checks passed. ${config.stateDir}/doctor.md`,
				failedChecks.length ? "warning" : "info",
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

	pi.registerCommand("hybrid-stages", {
		description: "Show stage IDs usable with /hybrid-resume-from",
		handler: async (_args, ctx) => {
			const report = [
				"# Hybrid Stages",
				"",
				...hybridStageReferenceMarkdown().split("\n"),
			].join("\n");
			setStatusWidget(ctx, report);
			await showReport("Hybrid Stages", report, ctx);
			ctx.ui.notify("Hybrid stage IDs listed.", "info");
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

	pi.registerCommand("hybrid-resume", {
		description:
			"Resume the current hybrid task from the last incomplete stage",
		handler: async (_args, ctx) => handleHybridRun("", ctx, {}, "default"),
	});

	pi.registerCommand("hybrid-handoff-run", {
		description:
			"Import externally prepared handoff docs and run local-only lane implementation/review/repair loops",
		handler: async (args, ctx) => {
			const handoffDir = args.trim();
			if (!handoffDir) {
				ctx.ui.notify("Usage: /hybrid-handoff-run <handoff-dir>", "warning");
				return;
			}
			try {
				const { liveId } = startHandoffBackgroundRun({ pi, cwd: ctx.cwd, ctx, handoffDir });
				ctx.ui.notify(
					`Hybrid handoff run started in background (${liveId}). Use /hybrid-monitor, /hybrid-handoff-status, or /hybrid-cancel.`,
					"info",
				);
				ctx.ui.requestRender?.();
			} catch (error) {
				ctx.ui.notify(`Hybrid handoff run failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("hybrid-handoff-resume", {
		description: "Resume the imported handoff run from unfinished lanes",
		handler: async (_args, ctx) => {
			try {
				const { liveId } = startHandoffBackgroundRun({ pi, cwd: ctx.cwd, ctx, resume: true });
				ctx.ui.notify(
					`Hybrid handoff resume started in background (${liveId}). Use /hybrid-monitor or /hybrid-cancel.`,
					"info",
				);
				ctx.ui.requestRender?.();
			} catch (error) {
				ctx.ui.notify(`Hybrid handoff resume failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("hybrid-handoff-status", {
		description: "Show imported handoff manifest, lane progress, and active run state",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const manifest = readHandoffManifest(ctx.cwd, config);
			const progress = readProgress(ctx.cwd, config, state.task ?? manifest?.objective ?? "(task missing)");
			const activeLock = readHybridRunLock(ctx.cwd, config);
			const report = [
				"# Hybrid Handoff Status",
				"",
				manifest ? `- Handoff root: \`${manifest.rootDir}\`` : "- Handoff root: not imported",
				manifest ? `- Task: ${manifest.taskName}` : "",
				manifest ? `- Lanes: ${manifest.lanes.length}` : "",
				activeLock ? `- Active run: ${activeLock.liveId} stage=${activeLock.currentStage ?? "unknown"}` : "- Active run: none",
				"",
				"## Lanes",
				...(manifest?.lanes.length
					? manifest.lanes.map((lane) => {
						const slice = progress.slices.find((candidate) => candidate.id === `L${lane.id}`);
						return `- ${lane.id} ${lane.name}: ${slice?.status ?? "pending"}`;
					})
					: ["- none"]),
				"",
				"## Progress",
				progressToMarkdown(progress),
			].filter(Boolean).join("\n");
			setStatusWidget(ctx, report);
			await showReport("Hybrid Handoff Status", report, ctx);
			ctx.ui.notify("Hybrid handoff status generated.", "info");
		},
	});

	pi.registerCommand("hybrid-new", {
		description:
			"Archive the current hybrid run artifacts and start a fresh task boundary",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const active = getHybridActiveRun();
			const lock = readHybridRunLock(ctx.cwd, config);
			if (active || (lock && !isHybridRunLockStale(lock))) {
				ctx.ui.notify(
					"Hybrid run is active. Finish, cancel, or wait before starting /hybrid-new.",
					"error",
				);
				return;
			}
			if (lock && isHybridRunLockStale(lock)) {
				clearHybridRunLock(ctx.cwd, config, lock.liveId);
			}
			const task = args.trim();
			const { archive } = startNewHybridTask(ctx.cwd, config, task);
			const report = [
				"# Hybrid New Task",
				"",
				archive ? `- Archived previous run: \`${archive}\`` : "- Previous run: nothing to archive",
				task
					? `- New task: ${task}`
					: "- New task: not set yet. Run /hybrid-interview <task> or /hybrid-grill <task> next.",
				"",
				"Next:",
				"- /hybrid-new <next task>",
				"- /hybrid-interview <next task>",
				"- /hybrid-grill <next task>",
				"- then approve run from the gate modal",
			].join("\n");
			setStatusWidget(ctx, report);
			await showReport("Hybrid New Task", report, ctx);
			ctx.ui.notify(
				task
					? "Hybrid new task boundary created."
					: "Hybrid reset for a new task. Use /hybrid-interview <task> or /hybrid-grill <task>.",
				"info",
			);
		},
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
			const stageArg = args.trim();
			if (!stageArg) {
				const report = [
					"# Hybrid Resume From",
					"",
					"재개할 stage ID가 필요합니다.",
					"",
					...hybridStageReferenceMarkdown().split("\n"),
				].join("\n");
				await showReport("Hybrid Resume From", report, ctx);
				ctx.ui.notify(
					"Usage: /hybrid-resume-from <stage>. Run /hybrid-stages for the list.",
					"warning",
				);
				return;
			}
			let removed: string[];
			try {
				removed = clearHybridStageFrom(ctx.cwd, config, state, stageArg);
			} catch (error) {
				const report = [
					"# Hybrid Resume From",
					"",
					String(error instanceof Error ? error.message : error),
					"",
					...hybridStageReferenceMarkdown().split("\n"),
				].join("\n");
				await showReport("Hybrid Resume From", report, ctx);
				ctx.ui.notify("Unknown hybrid stage. Run /hybrid-stages.", "error");
				return;
			}
			const { liveId } = startHybridBackgroundRun({
				pi,
				cwd: ctx.cwd,
				ctx,
				args: "",
			});
			ctx.ui.notify(
				`Hybrid resumed from ${stageArg} (${removed.length} artifact(s) cleared, ${liveId}).`,
				"info",
			);
		},
	});

	pi.registerCommand("hybrid-interview", {
		description:
			"Run a frontier-owned requirements interview and write requirements.md",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const result = await runWithHybridGateLoading(
				ctx,
				"Hybrid Interview",
				"첫 질문을 준비하고 있습니다",
				"frontier가 requirements interview를 시작 중입니다.",
				() => runFrontierInterview(
					ctx.cwd,
					config,
					state,
					args,
					(message, type = "info") => ctx.ui.notify(message, type),
				),
			);
			await showHybridInterview(result, config, state, ctx);
		},
	});

	pi.registerCommand("hybrid-grill", {
		description:
			"Run a frontier-owned design grill and write design-grill.md",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const state = loadState(ctx.cwd, config);
			const result = await runWithHybridGateLoading(
				ctx,
				"Hybrid Grill",
				"첫 grill 응답을 준비하고 있습니다",
				"frontier가 설계 grill을 시작 중입니다.",
				() => runFrontierGrill(
					ctx.cwd,
					config,
					state,
					args,
					(message, type = "info") => ctx.ui.notify(message, type),
				),
			);
			await showHybridGrill(result, config, state, ctx);
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

	pi.registerCommand("hybrid-set", {
		description:
			"Set a hybrid config value: /hybrid-set <key> <value>. No args lists editable keys and current values.",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const raw = (args ?? "").trim();
			const editableKeys = Object.keys(EDITABLE_CONFIG_KEYS).sort();
			if (!raw) {
				const lines = [
					"# Hybrid Settings",
					"",
					`Usage: \`/hybrid-set <key> <value>\` (writes \`${config.stateDir}/config.json\`).`,
					"Array keys (protectedPaths, verificationCommands) are edited directly in config.json.",
					"",
					"| Key | Type | Current |",
					"|-----|------|---------|",
					...editableKeys.map((key) => {
						const value = (config as unknown as Record<string, unknown>)[key];
						const shown = value === undefined || value === "" ? "(unset)" : String(value);
						return `| \`${key}\` | ${EDITABLE_CONFIG_KEYS[key]} | ${shown} |`;
					}),
				].join("\n");
				await showReport("Hybrid Settings", lines, ctx);
				ctx.ui.notify("Hybrid settings listed. Use /hybrid-set <key> <value> to change one.", "info");
				return;
			}
			const spaceIdx = raw.search(/\s/);
			const key = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
			const valueRaw = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1);
			const type = EDITABLE_CONFIG_KEYS[key];
			if (!type) {
				ctx.ui.notify(
					`Unknown or non-editable key "${key}". Run /hybrid-set with no args to list editable keys.`,
					"error",
				);
				return;
			}
			if (spaceIdx === -1) {
				ctx.ui.notify(`Usage: /hybrid-set ${key} <value> (${type}).`, "warning");
				return;
			}
			const coerced = coerceConfigValue(type, valueRaw);
			if (!coerced.ok) {
				ctx.ui.notify(`Cannot set ${key}: ${coerced.error}.`, "error");
				return;
			}
			const configFile = updateConfigFile(ctx.cwd, config, {
				[key]: coerced.value,
			} as Partial<HarnessConfig>);
			const updated = loadState(ctx.cwd, config);
			setStatusWidget(ctx, statusMarkdown(ctx.cwd, loadConfig(ctx.cwd), updated));
			ctx.ui.notify(
				`Set ${key} = ${String(coerced.value)} in ${path.relative(ctx.cwd, configFile) || configFile}.`,
				"info",
			);
		},
	});

	pi.registerCommand("hybrid-models", {
		description:
			"Pick local worker, local control reviewer, or frontier model from Pi's available models",
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
			const requirementsContext = hybridRequirementsContext(ctx.cwd, config);
			const scoutPrompt = [
				"You are the LOCAL SCOUT in a hybrid coding harness.",
				"Explore the repository with read-only tools and produce a compact, high-signal repo map for a frontier architect.",
				"Do not modify files.",
				"",
				`Task: ${task}`,
				...(scoutSteering ? ["", scoutSteering] : []),
				...requirementsContext,
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
				...requirementsContext,
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
				"",
				"Verification design requirements:",
				"- Each acceptance criterion needs an executable verification contract: sample input, command/script/manual procedure, and expected output or diff.",
				"- Separate source evidence from runtime evidence.",
				"- Identify at least one adversarial probe and any state reentry/idempotency probe needed.",
				"- Treat build passed, HTTP 200, server responds, import succeeds, and smoke checks as baseline only.",
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
			"Run frontier read-only review/audit of the implementation diff and evidence",
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
				`Hybrid frontier implementation review complete: ${review.verdict}. Next: /hybrid-final`,
				review.result.ok ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("hybrid-final", {
		description:
			"Run frontier final gate over design, diff, local evidence, and implementation review",
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
