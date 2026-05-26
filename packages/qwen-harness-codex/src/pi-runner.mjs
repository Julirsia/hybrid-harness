import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CANONICAL_STATE_DIR,
  artifactPaths,
  createCodexHarnessTask,
} from "./taskpack.mjs";

export function buildPiPrompt(options = {}) {
  const phase = options.phase ?? "full";
  const taskId = options.taskId ?? "codex-harness-task";
  const title = options.title ?? taskId;
  const task = options.task ?? title;

  return `# Codex Qwen Harness Prompt

Codex is the frontier orchestrator and final verifier.
Pi/local Qwen handles high-token repository exploration, implementation, testing, repair loops, and compact evidence collection.

## Local Phase: ${phase}

${phase === "scout" ? "Scout-only runs are read-only. Do not edit files during scout mode." : "Stay inside the task scope and write compact evidence for Codex review."}

Use \`${CANONICAL_STATE_DIR}/\` as the durable harness state directory. Do not create any Codex-specific harness state directory.

## Task

- Task ID: ${taskId}
- Title: ${title}

${task}

## Return Format

Return concise Markdown with:
- relevant files
- commands/tests run
- changed files, if any
- blockers
- verification evidence
- residual risks
`;
}

export function delegateToPi(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const phase = options.phase ?? "full";
  const task = options.task ?? options.title;
  const created = createCodexHarnessTask({ ...options, cwd, task });
  const paths = artifactPaths({ cwd, taskId: created.taskId, runId: created.runId });
  const prompt = buildPiPrompt({
    phase,
    taskId: created.taskId,
    title: options.title ?? created.taskId,
    task,
  });
  const piBinary = options.piBinary ?? "pi";
  const model = options.model ?? "local-qwen/qwen36-27b-mtp-iq4xs";
  const timeoutMs = Number(options.timeoutMs ?? 600000);
  const piCommand = {
    runner: "pi",
    mode: options.live ? "live" : "dry-run",
    phase,
    cwd,
    argv: [
      piBinary,
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      model,
      prompt,
    ],
    model,
    timeoutMs,
    shell: false,
  };

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.prompt, prompt, "utf8");

  if (!options.live) {
    writeFileSync(paths.piCommand, `${JSON.stringify(piCommand, null, 2)}\n`, "utf8");
    return {
      ok: true,
      status: "dry-run",
      stateDir: CANONICAL_STATE_DIR,
      taskId: created.taskId,
      runId: created.runId,
      phase,
      piCommand,
      artifacts: paths,
    };
  }

  const runtime = preparePiRuntime({
    model,
    piAgentDir: options.piAgentDir,
    startLocalProxy: options.startLocalProxy,
  });
  if (runtime.proxy) {
    piCommand.proxy = runtime.proxy;
  }
  if (runtime.env.PI_CODING_AGENT_DIR) {
    piCommand.env = { PI_CODING_AGENT_DIR: runtime.env.PI_CODING_AGENT_DIR };
  }
  writeFileSync(paths.piCommand, `${JSON.stringify(piCommand, null, 2)}\n`, "utf8");

  let result;
  try {
    result = spawnSync(piBinary, piCommand.argv.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      shell: false,
      env: runtime.env,
    });
  } finally {
    runtime.cleanup();
  }
  writeFileSync(paths.stdout, result.stdout ?? "", "utf8");
  writeFileSync(paths.stderr, result.stderr ?? "", "utf8");

  const exitCode = result.status ?? (result.error ? 1 : 0);
  const transcriptError = detectPiTranscriptError(result.stdout ?? "");
  const ok = exitCode === 0 && !transcriptError;
  return {
    ok,
    status: ok ? "complete" : "blocked",
    stopReason: ok ? null : transcriptError ?? result.error?.message ?? `pi_exit_${exitCode}`,
    stateDir: CANONICAL_STATE_DIR,
    taskId: created.taskId,
    runId: created.runId,
    phase,
    exitCode,
    artifacts: paths,
  };
}

function preparePiRuntime(options) {
  const baseEnv = { ...process.env };
  const modelParts = splitProviderModel(options.model);
  if (!modelParts) return directPiRuntime(baseEnv);

  const sourceAgentDir = resolve(
    options.piAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, ".pi", "agent"),
  );
  const modelsPath = join(sourceAgentDir, "models.json");
  const modelsConfig = readJson(modelsPath);
  const provider = modelsConfig?.providers?.[modelParts.provider];
  const targetBaseUrl = provider?.baseUrl;
  const target = parseProxyableBaseUrl(targetBaseUrl);
  if (!target) return directPiRuntime(baseEnv);

  let proxy;
  try {
    const startLocalProxy = options.startLocalProxy ?? startRubyTcpProxy;
    proxy = startLocalProxy({
      targetBaseUrl,
      targetHost: target.host,
      targetPort: target.port,
    });
  } catch (error) {
    return directPiRuntime(baseEnv, {
      attempted: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const tempAgentDir = mkdtempSync(join(tmpdir(), "qwen-harness-codex-pi-agent-"));
  const proxiedModelsConfig = JSON.parse(JSON.stringify(modelsConfig));
  proxiedModelsConfig.providers[modelParts.provider].baseUrl = proxy.localBaseUrl;
  writeFileSync(join(tempAgentDir, "models.json"), `${JSON.stringify(proxiedModelsConfig, null, 2)}\n`, "utf8");
  writeFileSync(
    join(tempAgentDir, "settings.json"),
    `${JSON.stringify(buildProxySettings({ sourceAgentDir, modelParts }), null, 2)}\n`,
    "utf8",
  );

  return {
    env: { ...baseEnv, PI_CODING_AGENT_DIR: tempAgentDir },
    proxy: {
      mode: "localhost-tcp",
      targetBaseUrl,
      localBaseUrl: proxy.localBaseUrl,
      piAgentDir: tempAgentDir,
    },
    cleanup: () => {
      try {
        proxy.stop?.();
      } finally {
        rmSync(tempAgentDir, { recursive: true, force: true });
      }
    },
  };
}

function directPiRuntime(env, proxy) {
  return {
    env,
    proxy,
    cleanup: () => {},
  };
}

function buildProxySettings({ sourceAgentDir, modelParts }) {
  const sourceSettings = readJson(join(sourceAgentDir, "settings.json")) ?? {};
  return omitUndefined({
    defaultProvider: modelParts.provider,
    defaultModel: modelParts.model,
    enabledModels: [`${modelParts.provider}/${modelParts.model}`],
    retry: sourceSettings.retry,
    httpIdleTimeoutMs: sourceSettings.httpIdleTimeoutMs,
    transport: sourceSettings.transport,
  });
}

function splitProviderModel(model) {
  const index = String(model).indexOf("/");
  if (index <= 0 || index === model.length - 1) return undefined;
  return {
    provider: model.slice(0, index),
    model: model.slice(index + 1),
  };
}

function parseProxyableBaseUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return undefined;
    if (isLoopbackHost(url.hostname)) return undefined;
    return {
      host: url.hostname,
      port: Number(url.port || 80),
    };
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function startRubyTcpProxy({ targetBaseUrl, targetHost, targetPort }) {
  const rubyCheck = spawnSync("ruby", ["-v"], { encoding: "utf8", shell: false });
  if (rubyCheck.error) {
    throw new Error(`ruby_unavailable: ${rubyCheck.error.message}`);
  }

  const proxyDir = mkdtempSync(join(tmpdir(), "qwen-harness-codex-proxy-"));
  const proxyScript = join(proxyDir, "proxy.rb");
  const portFile = join(proxyDir, "port");
  writeFileSync(proxyScript, RUBY_TCP_PROXY, "utf8");

  const child = spawn("ruby", [
    proxyScript,
    "127.0.0.1",
    "0",
    targetHost,
    String(targetPort),
    portFile,
  ], {
    stdio: "ignore",
  });
  const port = waitForPortFile(portFile, 3000);
  return {
    localBaseUrl: rewriteBaseUrlToLocalhost(targetBaseUrl, port),
    stop: () => {
      child.kill("SIGTERM");
      rmSync(proxyDir, { recursive: true, force: true });
    },
  };
}

function waitForPortFile(portFile, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8").trim());
      if (Number.isInteger(port) && port > 0) return port;
    }
    sleepMs(25);
  }
  throw new Error("local_proxy_start_timeout");
}

function rewriteBaseUrlToLocalhost(baseUrl, port) {
  const url = new URL(baseUrl);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.toString().replace(/\/$/, "");
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function detectPiTranscriptError(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const message = event?.message;
      if (message?.stopReason === "error") {
        return message.errorMessage || "pi_transcript_error";
      }
      if (typeof message?.errorMessage === "string" && message.errorMessage.length > 0) {
        return message.errorMessage;
      }
      if (typeof event?.finalError === "string" && event.finalError.length > 0) {
        return event.finalError;
      }
    } catch {
      continue;
    }
  }
  return "";
}

const RUBY_TCP_PROXY = `require 'socket'

listen_host = ARGV.fetch(0)
listen_port = Integer(ARGV.fetch(1))
target_host = ARGV.fetch(2)
target_port = Integer(ARGV.fetch(3))
port_file = ARGV.fetch(4)

server = TCPServer.new(listen_host, listen_port)
File.write(port_file, server.addr[1].to_s)

trap('TERM') do
  server.close rescue nil
  exit 0
end

loop do
  client = server.accept
  Thread.new(client) do |downstream|
    upstream = nil
    begin
      upstream = TCPSocket.new(target_host, target_port)
      copy_up = Thread.new do
        begin
          IO.copy_stream(downstream, upstream)
        rescue IOError, SystemCallError
        ensure
          upstream.close_write rescue nil
        end
      end
      copy_down = Thread.new do
        begin
          IO.copy_stream(upstream, downstream)
        rescue IOError, SystemCallError
        ensure
          downstream.close_write rescue nil
        end
      end
      copy_up.join
      copy_down.join
    ensure
      downstream.close rescue nil
      upstream.close rescue nil
    end
  end
end
`;
