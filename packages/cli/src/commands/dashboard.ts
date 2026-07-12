import type { AddressInfo } from "node:net";
import { join, resolve as pathResolve } from "node:path";
import { execFile as execFileCb, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { stat, readdir, readFile as fsReadFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TaskStore,
  AutomationStore,
  CentralCore,
  AgentStore,
  PluginLoader,
  PluginStore,
  getTaskMergeBlocker,
  getEnabledPiExtensionPaths,
  isEphemeralAgent,
  DaemonTokenManager,
  GlobalSettingsStore,
  resolveGlobalDir,
  DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS,
  isWorkflowColumnsEnabled,
  isWorkspaceTask,
  resolveColumnFlags,
  BUILTIN_CODING_WORKFLOW_IR,
  mergeBuiltInGrokProviderModels,
  mergeBuiltInZaiProviderModels,
  parseWorkflowIr,
  registerBuiltInGrokProvider,
  registerBuiltInZaiProvider,
  type WorkflowIrColumn,
  type TraitFlags,
  FUSION_RESTART_EXIT_CODE,
} from "@fusion/core";
import {
  createServer,
  refreshAllCustomProviderModels,
  AttachTicketStore,
  CliInputAttributionLog,
  CliConfirmAdvanceRegistry,
  CliRelaunchRegistry,
  GitHubClient,
  createSkillsAdapter,
  getCliPackageVersion,
  getProjectSettingsPath,
  loadTlsCredentialsFromEnv,
  registerGithubTrackingHook,
  stopAllDevServers,
  type RuntimeLogger,
} from "@fusion/dashboard";
import {
  runAiMerge,
  landWorkspaceTask,
  MissionAutopilot,
  MissionExecutionLoop,
  HeartbeatMonitor,
  HeartbeatTriggerScheduler,
  type WakeContext,
  ProjectEngineManager,
  PeerExchangeService,
  HybridExecutor,
  shouldUseHybridExecutor,
  setHostExtensionPaths,
  createFusionAuthStorage,
} from "@fusion/engine";
import { DefaultPackageManager, ModelRegistry, SettingsManager, discoverAndLoadExtensions, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import {
  getMergeStrategy,
  getTaskBranchName,
  processPullRequestMergeTask,
  createGroupPrCallback,
  syncGroupPrCallback,
  createPrNodeGithubOps,
  createPrReconcileGithubOps,
} from "./task-lifecycle.js";
import { promptForPort } from "./port-prompt.js";
import { ensureCwdProjectRegistered } from "./ensure-project-registered.js";
import { createReadOnlyProviderSettingsView } from "./provider-settings.js";
import { wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";
import { getModelRegistryModelsPath, getPackageManagerAgentDir } from "./auth-paths.js";
import { resolveProject } from "../project-context.js";
import {
  ensureClaudeSkillsForAllProjectsOnStartup,
  maybeInstallClaudeSkillForNewProject,
} from "./claude-skills-runner.js";
import {
  getCachedClaudeCliResolution,
  resolveClaudeCliExtensionPaths,
  setCachedClaudeCliResolution,
} from "./claude-cli-extension.js";
import {
  getCachedDroidCliResolution,
  resolveDroidCliExtensionPaths,
  setCachedDroidCliResolution,
} from "./droid-cli-extension.js";
import {
  getCachedLlamaCppResolution,
  resolveLlamaCppExtensionPaths,
  setCachedLlamaCppResolution,
} from "./llama-cpp-extension.js";
import { getCachedUpdateStatus, isUpdateCheckEnabled } from "../update-cache.js";
import { resolveSelfExtension } from "./self-extension.js";
import { ensureBundledDependencyGraphPluginInstalled, ensureBundledGrokRuntimePluginInstalled, ensureBundledPluginInstalled, isBundledPluginId } from "../plugins/bundled-plugin-install.js";
import { registerCustomProviders, reregisterCustomProviders } from "./custom-provider-registry.js";
import { handleOpencodeGoApiKeySaved, syncStartupModels } from "./startup-model-sync.js";
import { DashboardTUI, DashboardLogSink, isTTYAvailable, type SystemInfo, type GitStatus, type GitCommit, type GitCommitDetail, type GitBranch, type GitWorktree, type FileEntry, type FileReadResult, type TaskStep as TUITaskStep, type TaskLogEntry as TUITaskLogEntry, type TaskDetailData, type TaskEvent } from "./dashboard-tui/index.js";
import { DASHBOARD_STARTUP_STATUS, runTuiStartupPrelude } from "./dashboard-startup-chain.js";

// Re-export for backward compatibility with tests
export { promptForPort };

let processDiagnosticsRegistered = false;
let diagnosticIntervalHandle: ReturnType<typeof setInterval> | null = null;
const DIAGNOSTIC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let diagnosticStartTime = 0;
let diagnosticDbHealthCheck: (() => boolean) | null = null;
let diagnosticStoreListenerCheck: (() => Record<string, number>) | null = null;

const STREAM_LOG_FLUSH_IDLE_MS = 100;

function formatRuntimeContext(context: Record<string, unknown> | undefined): string {
  if (context === undefined) {
    return "";
  }

  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    return ` ${String(context)}`;
  }
}

function createDashboardRuntimeLogger(logSink: DashboardLogSink, scope: string): RuntimeLogger {
  return {
    scope,
    info(message, context) {
      logSink.log(`${message}${formatRuntimeContext(context)}`, scope);
    },
    warn(message, context) {
      logSink.warn(`${message}${formatRuntimeContext(context)}`, scope);
    },
    error(message, context) {
      logSink.error(`${message}${formatRuntimeContext(context)}`, scope);
    },
    child(childScope) {
      return createDashboardRuntimeLogger(logSink, `${scope}:${childScope}`);
    },
  };
}

type StartupUpdateStatus = {
  updateAvailable: true;
  latestVersion: string;
  currentVersion: string;
};

async function resolveCachedStartupUpdateStatus(importMetaUrl: string): Promise<StartupUpdateStatus | null> {
  try {
    const updateCheckEnabled = await Promise.race<boolean>([
      isUpdateCheckEnabled(),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 3_000);
      }),
    ]);

    if (!updateCheckEnabled) {
      return null;
    }

    const currentVersion = getCliPackageVersion(importMetaUrl);
    const cachedUpdate = getCachedUpdateStatus(currentVersion);
    if (!cachedUpdate?.updateAvailable) {
      return null;
    }

    return {
      updateAvailable: true,
      currentVersion: cachedUpdate.currentVersion,
      latestVersion: cachedUpdate.latestVersion,
    };
  } catch {
    return null;
  }
}

function formatUpdateMessage(updateStatus: StartupUpdateStatus | null): string | null {
  if (!updateStatus) {
    return null;
  }

  return `⬆ Update available: v${updateStatus.latestVersion} (current: v${updateStatus.currentVersion}). Run \`fn update\` for an installed CLI, or pull the source checkout.`;
}

export class StreamedLogBuffer {
  private pending = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emitLine: (line: string) => void,
    private readonly flushIdleMs: number = STREAM_LOG_FLUSH_IDLE_MS,
  ) {}

  push(delta: string): void {
    if (!delta) return;

    this.pending += delta;
    this.flushCompletedLines();
    this.scheduleFlush();
  }

  flush(): void {
    this.clearFlushTimer();
    const trailing = this.pending.trim();
    if (trailing.length > 0) {
      this.emitLine(trailing);
    }
    this.pending = "";
  }

  dispose(): void {
    this.clearFlushTimer();
    this.pending = "";
  }

  private flushCompletedLines(): void {
    if (!this.pending.includes("\n")) {
      return;
    }

    const splitLines = this.pending.split(/\r?\n/);
    const completeLines = splitLines.slice(0, -1);
    this.pending = splitLines[splitLines.length - 1] ?? "";

    for (const line of completeLines) {
      const normalized = line.trim();
      if (normalized.length > 0) {
        this.emitLine(normalized);
      }
    }
  }

  private scheduleFlush(): void {
    this.clearFlushTimer();
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.flushIdleMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Format milliseconds to human-readable uptime string
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Get and log current process diagnostics (memory, handles, requests)
 * @param prefix - Log prefix (e.g., "dashboard", "serve")
 * @param startTime - Process start timestamp
 * @param dbHealthCheck - Optional function to check database health
 */
function logDiagnostics(logger: RuntimeLogger, prefix: string, startTime: number, dbHealthCheck?: () => boolean): void {
  const mem = process.memoryUsage();
  const uptime = Date.now() - startTime;

  // Get active handles/requests if available (Node.js internal)
  let handleCount = -1;
  let requestCount = -1;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleCount = (process as any)._getActiveHandles?.()?.length ?? -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requestCount = (process as any)._getActiveRequests?.()?.length ?? -1;
  } catch {
    // Ignore errors if these internal APIs are not available
  }

  // Check database health if provided
  let dbHealth = "unknown";
  if (dbHealthCheck) {
    try {
      dbHealth = dbHealthCheck() ? "ok" : "failed";
    } catch {
      dbHealth = "error";
    }
  }

  // Get listener counts if provided
  let listenerInfo = "";
  if (diagnosticStoreListenerCheck) {
    try {
      const counts = diagnosticStoreListenerCheck();
      const listenerEntries = Object.entries(counts)
        .map(([event, count]) => `${event}:${count}`)
        .join(",");
      listenerInfo = ` listeners=${listenerEntries}`;
    } catch {
      // Ignore errors getting listener counts
    }
  }

  const logLine = `[${prefix}] diagnostics: uptime=${formatUptime(uptime)} ` +
    `rss=${formatBytes(mem.rss)} heap=${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)} ` +
    `external=${formatBytes(mem.external)} arrayBuffers=${formatBytes(mem.arrayBuffers)} ` +
    `handles=${handleCount} requests=${requestCount} db=${dbHealth}${listenerInfo}`;

  logger.info(logLine);
}

/**
 * Register process lifecycle diagnostics for long-running process monitoring.
 * Logs memory usage, handle counts, and uptime at startup and every 30 minutes.
 * Also logs beforeExit and exit events for shutdown analysis.
 */
function ensureProcessDiagnostics(logger: RuntimeLogger): void {
  if (processDiagnosticsRegistered) {
    return;
  }
  processDiagnosticsRegistered = true;

  diagnosticStartTime = Date.now();

  // Log initial diagnostics at startup (before store is created)
  logDiagnostics(logger, "dashboard", diagnosticStartTime);

  // Register periodic diagnostics every 30 minutes
  diagnosticIntervalHandle = setInterval(() => {
    logDiagnostics(logger, "dashboard", diagnosticStartTime, diagnosticDbHealthCheck ?? undefined);
  }, DIAGNOSTIC_INTERVAL_MS);
  diagnosticIntervalHandle.unref?.(); // Don't prevent process exit

  // Log beforeExit when event loop drains naturally
  process.on("beforeExit", (code: number) => {
    const uptime = Date.now() - diagnosticStartTime;
    let handleCount = -1;
    let requestCount = -1;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleCount = (process as any)._getActiveHandles?.()?.length ?? -1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestCount = (process as any)._getActiveRequests?.()?.length ?? -1;
    } catch {
      // Ignore
    }
    logger.info(`[dashboard] beforeExit code=${code} uptime=${formatUptime(uptime)} handles=${handleCount} requests=${requestCount}`);
  });

  // Log exit event with exit code and uptime
  process.on("exit", (code: number) => {
    const uptime = Date.now() - diagnosticStartTime;
    logger.info(`[dashboard] exit code=${code} uptime=${formatUptime(uptime)}`);
  });

  // Log uncaught exceptions
  process.on("uncaughtExceptionMonitor", (error: Error) => {
    logger.error(`[dashboard] uncaught exception pid=${process.pid}: ${error.stack || error.message}`);
  });

  // Log unhandled rejections
  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger.error(`[dashboard] unhandled rejection pid=${process.pid}: ${message}`);
  });
}

/**
 * Stop the diagnostic interval timer. Call during shutdown.
 */
function stopDiagnosticInterval(): void {
  if (diagnosticIntervalHandle) {
    clearInterval(diagnosticIntervalHandle);
    diagnosticIntervalHandle = null;
  }
}

/**
 * Set the database health check function for diagnostics.
 * Call this after the TaskStore is created.
 */
function setDiagnosticDbHealthCheck(check: () => boolean): void {
  diagnosticDbHealthCheck = check;
}

/**
 * Set the store listener count check function for diagnostics.
 * Call this after the TaskStore is created.
 */
function setDiagnosticStoreListenerCheck(check: () => Record<string, number>): void {
  diagnosticStoreListenerCheck = check;
}

const execFileAsync = promisify(execFileCb);

async function gitExec(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function buildGitStatus(projectPath: string): Promise<GitStatus> {
  const [sbOut, remoteOut] = await Promise.allSettled([
    gitExec(projectPath, ["status", "-sb", "--porcelain=v1"]),
    gitExec(projectPath, ["remote", "get-url", "origin"]),
  ]);

  const sbRaw = sbOut.status === "fulfilled" ? sbOut.value : "";
  const remoteUrl = remoteOut.status === "fulfilled" ? remoteOut.value.trim() : "";

  const lines = sbRaw.split("\n");
  const header = lines[0] ?? "";

  let branch = "HEAD";
  let detached = false;
  let ahead = 0;
  let behind = 0;

  const noCommitMatch = header.match(/^## No commits yet on (.+)$/);
  if (noCommitMatch) {
    branch = noCommitMatch[1] ?? "HEAD";
  } else {
    const branchMatch = header.match(/^## ([^.]+?)(?:\.\.\.(\S+?)(?:\s+\[ahead (\d+)(?:, behind (\d+))?\]|\s+\[behind (\d+)\])?)?$/);
    if (branchMatch) {
      branch = branchMatch[1] ?? "HEAD";
      ahead = parseInt(branchMatch[3] ?? "0", 10);
      behind = parseInt(branchMatch[4] ?? branchMatch[5] ?? "0", 10);
    } else if (header.startsWith("## HEAD (no branch)")) {
      detached = true;
      branch = "HEAD";
    }
  }

  const staged: GitStatus["staged"] = [];
  const unstaged: GitStatus["unstaged"] = [];
  const untracked: GitStatus["untracked"] = [];

  for (const line of lines.slice(1)) {
    if (line.length < 3) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const path = line.slice(3);
    if (x === "?" && y === "?") {
      untracked.push({ path });
    } else {
      if (x !== " " && x !== "?") staged.push({ status: x, path });
      if (y !== " " && y !== "?") unstaged.push({ status: y, path });
    }
  }

  let lastFetchAt: number | null = null;
  try {
    const fetchHead = await stat(`${projectPath}/.git/FETCH_HEAD`);
    lastFetchAt = fetchHead.mtimeMs;
  } catch {
    // no fetch head yet
  }

  return { branch, detached, ahead, behind, staged, unstaged, untracked, remoteUrl, lastFetchAt };
}

async function buildGitCommits(projectPath: string, limit = 15): Promise<GitCommit[]> {
  const sep = "\x1f";
  const recSep = "\x1e";
  const fmt = [`%H`, `%h`, `%s`, `%an`, `%ar`, `%aI`].join(sep);
  let out = "";
  try {
    out = await gitExec(projectPath, ["log", `--max-count=${limit}`, `--format=${fmt}${recSep}`]);
  } catch {
    return [];
  }
  return out.split(recSep).flatMap((rec) => {
    const parts = rec.trim().split(sep);
    if (parts.length < 6 || !parts[0]) return [];
    return [{
      sha: parts[0] ?? "",
      shortSha: parts[1] ?? "",
      subject: parts[2] ?? "",
      authorName: parts[3] ?? "",
      relativeTime: parts[4] ?? "",
      isoTime: parts[5] ?? "",
    }];
  });
}

async function buildGitCommitDetail(projectPath: string, sha: string): Promise<GitCommitDetail> {
  const sep = "\x1f";
  const fmt = [`%H`, `%h`, `%s`, `%an`, `%ar`, `%aI`, `%b`].join(sep);
  const [showOut, statOut] = await Promise.allSettled([
    gitExec(projectPath, ["show", `--format=${fmt}`, "--no-patch", sha]),
    gitExec(projectPath, ["show", "--stat", "--format=", sha]),
  ]);
  const raw = showOut.status === "fulfilled" ? showOut.value.trim() : "";
  const parts = raw.split(sep);
  return {
    sha: parts[0] ?? sha,
    shortSha: parts[1] ?? sha.slice(0, 7),
    subject: parts[2] ?? "",
    authorName: parts[3] ?? "",
    relativeTime: parts[4] ?? "",
    isoTime: parts[5] ?? "",
    body: (parts[6] ?? "").trim(),
    stat: statOut.status === "fulfilled" ? statOut.value.trim() : "",
  };
}

async function buildGitBranches(projectPath: string): Promise<GitBranch[]> {
  let out = "";
  try {
    out = await gitExec(projectPath, [
      "for-each-ref",
      "--sort=-committerdate",
      "refs/heads",
      "--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)|%(upstream:track)|%(HEAD)",
    ]);
  } catch {
    return [];
  }
  return out.trim().split("\n").flatMap((line) => {
    if (!line) return [];
    const parts = line.split("|");
    return [{
      name: parts[0] ?? "",
      shortSha: parts[1] ?? "",
      relativeTime: parts[2] ?? "",
      upstreamTrack: parts[3] ?? "",
      isCurrent: (parts[4] ?? "") === "*",
    }];
  });
}

async function buildGitWorktrees(projectPath: string): Promise<GitWorktree[]> {
  let out = "";
  try {
    out = await gitExec(projectPath, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> & { rawPath?: string } = {};
  let isFirst = true;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.rawPath) {
        worktrees.push({
          path: current.rawPath,
          branch: current.branch ?? "HEAD",
          sha: current.sha ?? "",
          isCurrent: current.isCurrent ?? false,
          isLocked: current.isLocked ?? false,
        });
      }
      current = { rawPath: line.slice(9), isCurrent: isFirst };
      isFirst = false;
    } else if (line.startsWith("HEAD ")) {
      current.sha = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "locked") {
      current.isLocked = true;
    } else if (line.startsWith("locked ")) {
      current.isLocked = true;
    }
  }
  if (current.rawPath) {
    worktrees.push({
      path: current.rawPath,
      branch: current.branch ?? "HEAD",
      sha: current.sha ?? "",
      isCurrent: current.isCurrent ?? false,
      isLocked: current.isLocked ?? false,
    });
  }
  return worktrees;
}

// Standard denylist applied to both listing and reads (defence-in-depth).
const FILES_DENYLIST = new Set(["node_modules", ".git", "dist", ".next", "target", "build"]);
const FILE_SIZE_LIMIT = 1024 * 1024; // 1 MB
const BINARY_CHECK_BYTES = 8 * 1024; // 8 KB
const MAX_PREVIEW_LINES = 2000;

function guardRelativePath(projectPath: string, relativePath: string): string {
  // Prevent path traversal: the resolved absolute path must start with projectPath.
  const resolved = pathResolve(projectPath, relativePath);
  const base = projectPath.endsWith("/") ? projectPath : projectPath + "/";
  if (resolved !== projectPath && !resolved.startsWith(base)) {
    throw new Error(`Path traversal denied: ${relativePath}`);
  }
  return resolved;
}

async function buildFileListDirectory(projectPath: string, relativePath: string): Promise<FileEntry[]> {
  const absDir = guardRelativePath(projectPath, relativePath);
  const dirents = await readdir(absDir, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const d of dirents) {
    if (FILES_DENYLIST.has(d.name)) continue;
    const entryRelPath = relativePath ? `${relativePath}/${d.name}` : d.name;
    let size = 0;
    let modifiedAt = new Date(0).toISOString();
    try {
      const s = await stat(join(absDir, d.name));
      size = d.isDirectory() ? 0 : s.size;
      modifiedAt = s.mtime.toISOString();
    } catch {
      // Silently skip entries we can't stat (permission errors, broken symlinks)
    }
    entries.push({
      name: d.name,
      path: entryRelPath,
      isDirectory: d.isDirectory(),
      size,
      modifiedAt,
    });
  }
  // Sort: directories first, alphabetical within each group
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

async function buildFileReadFile(projectPath: string, relativePath: string): Promise<FileReadResult> {
  const absFile = guardRelativePath(projectPath, relativePath);
  const s = await stat(absFile);
  const modifiedAt = s.mtime.toISOString();
  const size = s.size;

  if (size > FILE_SIZE_LIMIT) {
    return { content: null, isBinary: false, tooLarge: true, size, modifiedAt, lineCount: 0 };
  }

  const buf = await fsReadFile(absFile);

  // Binary heuristic: look for null byte in the first BINARY_CHECK_BYTES
  const checkLen = Math.min(buf.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) {
      return { content: null, isBinary: true, tooLarge: false, size, modifiedAt, lineCount: 0 };
    }
  }

  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const lineCount = lines.length;
  const content = lineCount > MAX_PREVIEW_LINES
    ? lines.slice(0, MAX_PREVIEW_LINES).join("\n")
    : text;

  return { content, isBinary: false, tooLarge: false, size, modifiedAt, lineCount };
}

async function resolveRuntimeProjectPath(): Promise<string> {
  try {
    return (await resolveProject(undefined)).projectPath;
  } catch {
    return process.cwd();
  }
}

async function resolveDashboardAuthToken(opts: { noAuth?: boolean; token?: string }): Promise<string | undefined> {
  if (opts.noAuth) {
    return undefined;
  }

  const explicitToken = opts.token
    ?? process.env.FUSION_DASHBOARD_TOKEN
    ?? process.env.FUSION_DAEMON_TOKEN;

  if (explicitToken) {
    return explicitToken;
  }

  const globalDir = resolveGlobalDir();
  const settingsStore = new GlobalSettingsStore(globalDir);
  const tokenManager = new DaemonTokenManager(settingsStore);

  if (typeof tokenManager.getOrCreateToken === "function") {
    return tokenManager.getOrCreateToken();
  }

  const existingToken = await tokenManager.getToken();
  if (existingToken) {
    return existingToken;
  }
  return tokenManager.generateToken();
}

export async function runDashboard(port: number, opts: { paused?: boolean; dev?: boolean; noEngine?: boolean; interactive?: boolean; open?: boolean; host?: string; noAuth?: boolean; token?: string; lang?: string } = {}) {
  // Default to localhost so the dashboard (and its shell-capable terminal API)
  // is not exposed on the LAN. Pass --host 0.0.0.0 explicitly to opt-in.
  const selectedHost = opts.host ?? "127.0.0.1";

  // ── Bearer-token auth ────────────────────────────────────────────────
  //
  // By default the dashboard API is gated by a bearer token so that when the
  // server is bound to a non-localhost interface (e.g. `pnpm dev dashboard`
  // which injects --host 0.0.0.0 for LAN testing) nearby users can't hit the
  // terminal or exec endpoints uninvited. Precedence:
  //   1. `opts.token`             — explicit override (mostly for tests)
  //   2. `FUSION_DASHBOARD_TOKEN` — user-provided env
  //   3. `FUSION_DAEMON_TOKEN`    — back-compat with daemon mode
  //   4. stored token in ~/.fusion/settings.json
  //   5. newly generated persisted token (first authenticated run only)
  // `--no-auth` skips the middleware entirely. The token is embedded in the
  // launch URL (as `?token=...`) so the user can click once and the browser
  // stores it to localStorage for subsequent loads.
  const dashboardAuthToken = await resolveDashboardAuthToken(opts);

  // Single sink/logger pair for all dashboard command diagnostics.
  // In TTY mode this routes to DashboardTUI; in non-TTY mode it falls back to console.*.
  const logSink = new DashboardLogSink();
  const runtimeLogger = createDashboardRuntimeLogger(logSink, "dashboard");

  // Handle interactive port selection
  let selectedPort = port;
  if (opts.interactive) {
    try {
      selectedPort = await promptForPort(port);
    } catch (err) {
      if (err instanceof Error && err.message === "Interactive prompt cancelled") {
        console.log("Cancelled — exiting");
        process.exit(0);
      }
      throw err;
    }
  }
  const cwd = await resolveRuntimeProjectPath();

  // ── TTY Detection & TUI Initialization ─────────────────────────────
  //
  // When both stdout and stdin are TTY, we activate the interactive TUI
  // instead of plain console output. The TUI provides 5 sections:
  // system, logs, utilities, stats, settings with keyboard navigation.
  //
  // In non-TTY mode (CI, piped output), we fall back to plain console
  // output to maintain compatibility with automated workflows.
  //
  const isTTY = isTTYAvailable();
  let tui: DashboardTUI | undefined;
  const dashboardStartedAt = Date.now();
  const startupUpdateStatusPromise = resolveCachedStartupUpdateStatus(import.meta.url);

  // Declare store and agentStore early so callbacks can safely reference them
  // (they're assigned after initialization, but the variables exist from the start).
  // prefer-const disabled: callbacks close over these identifiers before the
  // single assignment below, which requires `let` even though no reassignment occurs.
  // eslint-disable-next-line prefer-const
  let store: TaskStore | undefined;
  // eslint-disable-next-line prefer-const
  let agentStore: AgentStore | undefined;

  if (isTTY) {
    tui = new DashboardTUI();
    tui.lang = opts.lang;
    void startupUpdateStatusPromise.then((updateStatus) => {
      tui?.setUpdateStatus(updateStatus);
    });
    // Set up callbacks for utility actions
    tui.setCallbacks({
      onRefreshStats: async () => {
        if (store && agentStore) {
          const tasks = await store.listTasks({ slim: true, includeArchived: false });
          const counts = new Map<string, number>();
          for (const task of tasks) {
            counts.set(task.column, (counts.get(task.column) ?? 0) + 1);
          }
          const active = tasks.filter((task) =>
            task.column === "in-progress" || task.column === "in-review"
          ).length;
          const agents = await agentStore.listAgents();
          const agentStats = { idle: 0, active: 0, running: 0, error: 0 };
          for (const agent of agents) {
            const state = agent.state as keyof typeof agentStats;
            if (state in agentStats) {
              agentStats[state]++;
            }
          }
          tui!.setTaskStats({
            total: tasks.length,
            byColumn: Object.fromEntries(counts),
            active,
            agents: agentStats,
          });
        }
      },
      onClearLogs: () => {
        // Logs are already cleared in TUI, this is for external notification
      },
      onTogglePause: async (paused: boolean) => {
        if (store) {
          await store.updateSettings({ enginePaused: paused });
          tui!.log(`Engine ${paused ? "paused" : "resumed"}`);
          const fullSettings = await store.getSettings();
          // Return SettingsValues subset for TUI
          return {
            maxConcurrent: fullSettings.maxConcurrent ?? 1,
            maxWorktrees: fullSettings.maxWorktrees ?? 2,
            autoMerge: fullSettings.autoMerge ?? false,
            mergeStrategy: fullSettings.mergeStrategy ?? "direct",
            pollIntervalMs: fullSettings.pollIntervalMs ?? 60_000,
            enginePaused: fullSettings.enginePaused ?? false,
            globalPause: fullSettings.globalPause ?? false,
            remoteActiveProvider: (fullSettings.remoteActiveProvider as "tailscale" | "cloudflare" | null) ?? null,
            remoteShortLivedEnabled: Boolean(fullSettings.remoteShortLivedEnabled),
            remoteShortLivedTtlMs: Number(fullSettings.remoteShortLivedTtlMs ?? 900_000),
          };
        }
        return {
          maxConcurrent: 1,
          maxWorktrees: 2,
          autoMerge: false,
          mergeStrategy: "direct",
          pollIntervalMs: 60_000,
          enginePaused: paused,
          globalPause: false,
          remoteActiveProvider: null,
          remoteShortLivedEnabled: false,
          remoteShortLivedTtlMs: 900_000,
        };
      },
      onPersistVitestKillSettings: async (partial) => {
        if (!store) return;
        const patch: Record<string, unknown> = {};
        if (typeof partial.enabled === "boolean") {
          patch.vitestAutoKillEnabled = partial.enabled;
        }
        if (typeof partial.thresholdPct === "number") {
          patch.vitestKillThresholdPct = partial.thresholdPct;
        }
        if (Object.keys(patch).length === 0) return;
        await store.getGlobalSettingsStore().updateSettings(patch);
      },
    });
    // Start the TUI and yield once so Ink can paint before init work.
    await runTuiStartupPrelude(tui);

    // Wire the TUI into the log sink so all console output routes through TUI
    logSink.setTUI(tui);
    // Capture stdlib console.* so engine/scheduler/pi/etc. log lines (which
    // go straight to console.error via createLogger in @fusion/engine) land
    // in the TUI's ring buffer instead of being overwritten by the alt screen.
    logSink.captureConsole();
  }

  // Register long-running process diagnostics after TTY sink wiring so
  // startup/runtime lines flow into the TUI log buffer when interactive.
  ensureProcessDiagnostics(runtimeLogger);

  store = new TaskStore(cwd);
  const automationStore = new AutomationStore(cwd);

  // CentralCore.init() is independent of store inits — start it early so it
  // overlaps with plugin loading and extension resolution instead of running
  // after them.
  const noEngine = opts.noEngine === true;

  const centralCoreInitPromise = !noEngine
    ? (async () => {
        const core = new CentralCore();
        try { await core.init(); } catch { /* non-fatal — fallback defaults */ }
        return core;
      })()
    : undefined;

  // Phase timing instrumentation — each step logs its wall-clock duration so
  // we can see at-a-glance which startup phase is the actual bottleneck.
  // Cheap enough (microsecond reads, one log per phase) to leave on
  // permanently; lands in the dashboard log buffer and can be diffed across
  // restarts to spot regressions.
  const phaseTime = async <T>(label: string, fn: () => Promise<T> | T): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      logSink.log(`startup phase ${label}: ${Date.now() - t0}ms`, "dashboard");
    }
  };

  // TaskStore / AutomationStore / PluginStore / AgentStore all open the SAME
  // .fusion/fusion.db file and run addColumnIfMissing migrations (a TOCTOU
  // `hasColumn` → ALTER pattern with no per-process lock). node:sqlite's
  // DatabaseSync is synchronous, so Promise.all on these gives no real
  // parallelism anyway — explicit sequencing keeps the schema-migration race
  // from triggering if any init() body ever introduces an `await` between
  // hasColumn and ALTER TABLE.
  await phaseTime("store.init", () => store.init());
  await phaseTime("automationStore.init", () => automationStore.init());
  const pluginStore = store.getPluginStore();
  await phaseTime("pluginStore.init", () => pluginStore.init());

  agentStore = new AgentStore({ rootDir: store.getFusionDir() });
  if (tui) tui.setLoadingStatus(DASHBOARD_STARTUP_STATUS.initializingAgentStore);
  await phaseTime("agentStore.init", () => agentStore!.init());
  // store.watch() is filesystem-watcher setup — no DB schema work, safe to
  // overlap with anything coming after.
  await phaseTime("store.watch", () => store.watch());
  if (tui) tui.setLoadingStatus(DASHBOARD_STARTUP_STATUS.startingAgents);

  // Set up database health check for diagnostics
  setDiagnosticDbHealthCheck(() => store.healthCheck());

  // Set up store listener count check for diagnostics
  setDiagnosticStoreListenerCheck(() => ({
    "task:created": store.listenerCount("task:created"),
    "task:moved": store.listenerCount("task:moved"),
    "task:updated": store.listenerCount("task:updated"),
    "task:deleted": store.listenerCount("task:deleted"),
    "settings:updated": store.listenerCount("settings:updated"),
    "agent:log": store.listenerCount("agent:log"),
  }));

  // ── Reactive TUI Updates ─────────────────────────────────────────────
  //
  // Subscribe to store and agent events to keep the TUI Stats/Settings
  // panels in sync without manual refresh.
  //
  let tuiRefreshPending = false;
  let tuiRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-project task stores for the BoardView's scoped stats. Shared with the
  // interactiveData wiring below so we don't re-init SQLite on each refresh.
  const projectStores = new Map<string, TaskStore>();
  async function getProjectStore(projectPath: string): Promise<TaskStore> {
    const cached = projectStores.get(projectPath);
    if (cached) return cached;
    let projectStore: TaskStore;
    if (projectPath === cwd) {
      if (!store) throw new Error("cwd TaskStore not yet initialized");
      projectStore = store;
    } else {
      projectStore = new TaskStore(projectPath);
      await projectStore.init();
    }
    projectStores.set(projectPath, projectStore);
    return projectStore;
  }

  // ── U11: resolve per-task workflow column flags for the TUI (flag-ON only) ──
  //
  // The CLI TUI degrades gracefully (R18): cards in workflow columns it can't
  // express must map by trait flags into its buckets or a read-only "other"
  // bucket, never silently disappear. The TUI is flag-blind, so when
  // `workflowColumns` is ON we enrich each slim task with its resolved column's
  // display name + merged trait flags. Self-contained: derives everything from
  // already-exposed store methods (workflow selection + definition) + the core
  // `resolveColumnFlags` export — no dependency on concurrent U9 server work.
  // Flag-OFF: returns undefineds and the TUI renders exactly as before.
  type ResolvedColumnInfo = { columnName?: string; columnFlags?: TraitFlags };
  async function resolveTaskColumnInfo(
    projectStore: TaskStore,
    flagOn: boolean,
    workflowIrCache: Map<string | undefined, WorkflowIrColumn[] | null>,
    task: { id: string; column: string },
  ): Promise<ResolvedColumnInfo> {
    if (!flagOn) return {};
    try {
      const selection = projectStore.getTaskWorkflowSelection(task.id);
      const workflowId = selection?.workflowId;
      let columns = workflowIrCache.get(workflowId);
      if (columns === undefined) {
        // Resolve the governing workflow IR. No selection → built-in default
        // (KTD-1), matching the store's own resolution order.
        const def = workflowId
          ? await projectStore.getWorkflowDefinition(workflowId)
          : undefined;
        const ir = def?.ir ?? BUILTIN_CODING_WORKFLOW_IR;
        columns = ir.version === "v2" ? ir.columns : [];
        workflowIrCache.set(workflowId, columns);
      }
      if (!columns) return {};
      // `task.column` is the IR column id (the store stores the column id).
      const column = columns.find((c) => c.id === task.column);
      if (!column) return {};
      return { columnName: column.name, columnFlags: resolveColumnFlags(column) };
    } catch {
      // Degrade silently: an unresolvable workflow must never drop a card, just
      // fall back to legacy column-id bucketing in the TUI.
      return {};
    }
  }

  /**
   * Debounced refresh of TUI stats - batches rapid task updates.
   * If the BoardView has a scoped project path set on the controller,
   * read tasks from that project's store instead of the launch cwd.
   */
  async function refreshTUIStats(): Promise<void> {
    if (!tui || !isTTY) return;
    if (!store || !agentStore) return;

    // Mark pending to prevent duplicate refreshes
    if (tuiRefreshPending) return;
    tuiRefreshPending = true;

    try {
      const scopedPath = tui.boardScopedProjectPath;
      const taskStore = scopedPath ? await getProjectStore(scopedPath) : store;
      const tasks = await taskStore.listTasks({ slim: true, includeArchived: false });
      const counts = new Map<string, number>();
      for (const task of tasks) {
        counts.set(task.column, (counts.get(task.column) ?? 0) + 1);
      }
      const active = tasks.filter((task) =>
        task.column === "in-progress" || task.column === "in-review"
      ).length;
      const agents = await agentStore.listAgents();
      const agentStats = { idle: 0, active: 0, running: 0, error: 0 };
      for (const agent of agents) {
        const state = agent.state as keyof typeof agentStats;
        if (state in agentStats) {
          agentStats[state]++;
        }
      }
      tui.setTaskStats({
        total: tasks.length,
        byColumn: Object.fromEntries(counts),
        active,
        agents: agentStats,
      });
    } finally {
      tuiRefreshPending = false;
    }
  }

  /**
   * Debounced settings refresh
   */
  async function refreshTUISettings(): Promise<void> {
    if (!tui || !isTTY) return;
    if (!store) return;

    try {
      const settings = await store.getSettings();
      tui.setSettings({
        maxConcurrent: settings.maxConcurrent ?? 1,
        maxWorktrees: settings.maxWorktrees ?? 2,
        autoMerge: settings.autoMerge ?? false,
        mergeStrategy: settings.mergeStrategy ?? "direct",
        pollIntervalMs: settings.pollIntervalMs ?? 60_000,
        enginePaused: settings.enginePaused ?? false,
        globalPause: settings.globalPause ?? false,
        remoteActiveProvider: (settings.remoteActiveProvider as "tailscale" | "cloudflare" | null) ?? null,
        remoteShortLivedEnabled: Boolean(settings.remoteShortLivedEnabled),
        remoteShortLivedTtlMs: Number(settings.remoteShortLivedTtlMs ?? 900_000),
      });
    } catch {
      // Ignore errors refreshing settings
    }
  }

  /**
   * Schedule a debounced stats refresh (batches rapid changes)
   */
  function scheduleStatsRefresh(): void {
    if (tuiRefreshDebounceTimer) {
      clearTimeout(tuiRefreshDebounceTimer);
    }
    tuiRefreshDebounceTimer = setTimeout(() => {
      void refreshTUIStats();
    }, 500); // 500ms debounce
  }

  // Refresh stats immediately when the BoardView changes its selected project
  // (so the Stats panel reflects the new project without waiting for an event).
  if (tui) {
    tui.onBoardScopeChange(() => {
      void refreshTUIStats();
    });
  }

  const handlers: Array<{
    target: NodeJS.EventEmitter;
    event: string | symbol;
    handler: (...args: any[]) => void;
  }> = [];
  const disposeCallbacks: Array<() => void> = [];
  let disposed = false;
  let shutdownInProgress = false;

  /*
  FNXC:SystemPanel 2026-07-12-11:00:
  In-place restart support for the dashboard System panel. A restart request
  flips the shutdown exit code from 0 to FUSION_RESTART_EXIT_CODE so the
  graceful-shutdown path (including the hard-exit watchdog and second-signal
  escape hatch) exits with the restart code and a supervising parent
  (`--supervise` loop or scripts/dev-with-memory.mjs) respawns the process.
  `requestSelfRestart` is late-bound because createServer options are built
  before the shutdown closure exists.
  */
  let shutdownExitCode = 0;
  // Coalesce concurrent restart requests: without this, a second /system/restart
  // arriving inside the 300ms flush delay would return success and schedule a
  // second shutdown() whose timer hits the shutdownInProgress fast-path and
  // process.exit(86)s before the first (graceful) teardown finishes.
  let restartScheduled = false;
  let requestSelfRestart: ((reason: string) => boolean) | null = null;
  const systemControlForServer = {
    supervised: process.env.FUSION_RESTART_SUPERVISED === "1",
    requestRestart: (reason: string) => (requestSelfRestart ? requestSelfRestart(reason) : false),
    sourceWorkspaceRoot: resolveFusionSourceWorkspaceRoot(),
  };
  // Built once and spread into both createServer() call sites (engine-mode and
  // UI-only) so the System panel log surface stays a single definition.
  const systemLogsForServer = {
    getRecent: (limit?: number) => logSink.getRecentEntries(limit),
    subscribe: (listener: (entry: import("./dashboard-tui/log-ring-buffer.js").LogEntry) => void) => logSink.subscribeEntries(listener),
  };

  /*
   * FNXC:DashboardShutdown 2026-06-27-10:32:
   * Pressing `q`/Ctrl+C in the TUI routes through SIGINT so the graceful shutdown
   * runs (kills dev-server process groups, engines, mesh, central-core). That
   * shutdown awaits several teardown steps with no timeout, so a single hung step
   * (a dev-server child that won't die, an in-flight engine merge, a stuck
   * central-core close) left `process.exit(0)` unreachable: the process never
   * exited, and because the alt-screen was already restored the still-alive
   * dashboard kept writing output onto the user's shell ("the TUI keeps rendering
   * what happened"). The `shutdownInProgress` guard also swallowed repeat signals,
   * so mashing `q` could not escape.
   *
   * Guarantee exit two ways: (1) arm a hard-exit watchdog the moment shutdown
   * begins so any hung teardown step still force-exits within the grace window,
   * and (2) let a second signal force an immediate exit. The watchdog is unref'd
   * so it never itself keeps the process alive.
   *
   * Instrumentation: each teardown step runs through timeShutdownStep, which
   * records the in-flight step name in `currentShutdownStep`. A hang leaves that
   * step's name set (its await never resolves), so the watchdog names the exact
   * culprit on stderr before force-exiting — pinpointing the stall without a
   * repro. Per-step timings are written to stderr when FUSION_DEBUG_SHUTDOWN is
   * set; otherwise only steps slower than SHUTDOWN_STEP_SLOW_MS are surfaced.
   * stderr is used (not logSink) so the lines are visible on the restored shell
   * after the TUI has been torn down.
   */
  const SHUTDOWN_HARD_EXIT_GRACE_MS = 3000;
  const SHUTDOWN_STEP_SLOW_MS = 1000;
  let currentShutdownStep: string | null = null;
  function armHardExitWatchdog(): void {
    setTimeout(() => {
      // Only surface the stall on stderr under FUSION_DEBUG_SHUTDOWN — by this
      // point tui.stop() has restored the user's shell, so an unconditional
      // write would itself paint the recovered prompt. The force-exit always
      // happens regardless of the flag.
      if (currentShutdownStep && process.env.FUSION_DEBUG_SHUTDOWN) {
        process.stderr.write(
          `fusion: graceful shutdown stalled on "${currentShutdownStep}" after ${SHUTDOWN_HARD_EXIT_GRACE_MS}ms — forcing exit\n`,
        );
      }
      process.exit(shutdownExitCode);
    }, SHUTDOWN_HARD_EXIT_GRACE_MS).unref();
  }
  async function timeShutdownStep(label: string, fn: () => Promise<void> | void): Promise<void> {
    currentShutdownStep = label;
    const startedAt = Date.now();
    const debug = !!process.env.FUSION_DEBUG_SHUTDOWN;
    if (debug) process.stderr.write(`fusion: shutdown step: ${label}…\n`);
    try {
      await fn();
      const ms = Date.now() - startedAt;
      // Per-step timing only under the debug flag. A non-debug stderr write for
      // "slow" steps would paint the shell tui.stop() already restored; the
      // SHUTDOWN_STEP_SLOW_MS threshold only governs debug emphasis now.
      if (debug) {
        const slow = ms >= SHUTDOWN_STEP_SLOW_MS ? " (slow)" : "";
        process.stderr.write(`fusion: shutdown step: ${label} done in ${ms}ms${slow}\n`);
      }
    } catch (err) {
      // Best-effort teardown: log and continue so one failing step can't strand
      // the process. The watchdog covers the hang case; this covers the throw.
      const message = err instanceof Error ? err.message : String(err);
      logSink.warn(`Shutdown step failed: ${label} after ${Date.now() - startedAt}ms — ${message}`, "dashboard");
    } finally {
      currentShutdownStep = null;
    }
  }

  async function logShutdownDiagnostics(reason: string): Promise<void> {
    const uptimeSeconds = Math.round((Date.now() - dashboardStartedAt) / 1000);
    let taskSummary = "tasks=unknown";
    try {
      if (!store) {
        taskSummary = "tasks=unavailable (store not initialized)";
        logSink.log(`shutdown requested reason=${reason} pid=${process.pid} ppid=${process.ppid} uptime=${uptimeSeconds}s ${taskSummary}`, "dashboard");
        return;
      }
      const tasks = await store.listTasks({ slim: true, includeArchived: false });
      const counts = new Map<string, number>();
      for (const task of tasks) {
        counts.set(task.column, (counts.get(task.column) ?? 0) + 1);
      }
      const active = tasks.filter((task) =>
        task.column === "in-progress" || task.column === "in-review"
      ).length;
      taskSummary = `tasks=${tasks.length} active=${active} columns=${Array.from(counts.entries())
        .map(([column, count]) => `${column}:${count}`)
        .join(",")}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      taskSummary = `tasks=unavailable (${message})`;
    }

    logSink.log(
      `shutdown requested reason=${reason} pid=${process.pid} ppid=${process.ppid} uptime=${uptimeSeconds}s ${taskSummary}`,
      "dashboard",
    );
  }

  async function closeCentralCoreBestEffort(core: CentralCore, context: string): Promise<void> {
    try {
      await core.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSink.warn(`CentralCore.close() failed during ${context}: ${message}`, "dashboard");
    }
  }

  function registerHandler(
    target: NodeJS.EventEmitter,
    event: string | symbol,
    handler: (...args: any[]) => void,
  ): void {
    target.on(event, handler);
    handlers.push({ target, event, handler });
  }

  // automationStore already initialized in parallel phase above

  // ── AgentStore: agent lifecycle tracking ──────────────────────────
  //
  // Tracks spawned agents so they appear in the dashboard's Agents view
  // and are properly managed throughout their lifecycle (creation, state
  // transitions, termination). Passed to TaskExecutor for agent spawning.
  //
  // agentStore already initialized in parallel phase above

  // ── Reactive TUI Updates ─────────────────────────────────────────────
  //
  // Subscribe to store and agent events to keep the TUI Stats/Settings
  // panels in sync without manual refresh.
  //
  if (tui && isTTY) {
    // Subscribe to task events for reactive stats updates
    registerHandler(store, "task:created", scheduleStatsRefresh);
    registerHandler(store, "task:moved", scheduleStatsRefresh);
    registerHandler(store, "task:updated", scheduleStatsRefresh);
    registerHandler(store, "task:deleted", scheduleStatsRefresh);

    // Subscribe to settings updates
    registerHandler(store, "settings:updated", () => {
      void refreshTUISettings();
    });

    // Subscribe to agent events via agentStore
    registerHandler(agentStore, "agent:created", scheduleStatsRefresh);
    registerHandler(agentStore, "agent:updated", scheduleStatsRefresh);
    registerHandler(agentStore, "agent:deleted", scheduleStatsRefresh);
  }

  // ── PluginStore: plugin installation management ─────────────────────
  //
  // SQLite-backed plugin persistence for the Settings → Plugins experience.
  // Enables the PluginManager UI to list, install, enable, disable, and
  // configure plugins via the /api/plugins REST endpoints.
  //
  // pluginStore already initialized in parallel phase above

  // ── PluginLoader: plugin lifecycle management ───────────────────────
  //
  // Manages dynamic plugin loading, hot-reload, hook invocation, and
  // dependency resolution. The PluginLoader instance also serves as the
  // PluginRunner for the REST routes (provides getPluginRoutes and
  // reloadPlugin methods).
  //
  const pluginLoader = new PluginLoader({
    pluginStore,
    taskStore: store,
  });

  // Lazy-install hook for bundled runtime plugins (Hermes/OpenClaw/Paperclip).
  // Invoked by dashboard's PUT /api/plugins/:id/settings the first time the
  // user clicks Save in Settings. Returns true if the plugin is now registered.
  const ensureBundledPluginInstalledCallback = async (pluginId: string): Promise<boolean> => {
    if (!isBundledPluginId(pluginId)) {
      logSink.log(`ensureBundledPluginInstalled: unknown bundled plugin id "${pluginId}"`, "plugins");
      return false;
    }
    try {
      const status = await ensureBundledPluginInstalled(pluginStore, pluginLoader, pluginId);
      if (status === "missing-bundle") {
        logSink.log(`Bundled plugin "${pluginId}" was not found in this build`, "plugins");
        return false;
      }
      if (status === "installed") {
        logSink.log(`Installed bundled plugin "${pluginId}"`, "plugins");
      } else if (status === "updated") {
        logSink.log(`Updated bundled plugin "${pluginId}"`, "plugins");
      }
      return true;
    } catch (err) {
      logSink.log(
        `Failed to auto-install bundled plugin "${pluginId}": ${err instanceof Error ? err.message : err}`,
        "plugins",
      );
      throw err;
    }
  };

  // Auto-load all enabled plugins so runtime UI (NewAgentDialog, AgentDetailView)
  // can discover installed runtimes like Hermes and OpenClaw. Run as a
  // background promise so it overlaps with the heavyweight extension
  // resolution chain below — the two touch disjoint subsystems.
  const pluginLoadingPromise = (async () => {
    try {
      const installStatus = await ensureBundledDependencyGraphPluginInstalled(pluginStore, pluginLoader);
      if (installStatus === "installed") {
        logSink.log("Installed bundled Dependency Graph plugin", "plugins");
      } else if (installStatus === "missing-bundle") {
        logSink.log("Bundled Dependency Graph plugin was not found in this build", "plugins");
      }
    } catch (err) {
      logSink.log(
        `Failed to auto-install bundled Dependency Graph plugin: ${err instanceof Error ? err.message : err}`,
        "plugins",
      );
    }

    /*
     * FNXC:GrokCliRouting 2026-07-09-23:05:
     * FN-7761: packaged `fn dashboard` must make fusion-plugin-grok-runtime enabled and loadable before chat sends. Without this eager Grok-scoped bootstrap, grok-cli/no-key messages bypass the logged-in `grok` CLI and hit pi's direct endpoint missing-key path.
     */
    try {
      const installStatus = await ensureBundledGrokRuntimePluginInstalled(pluginStore, pluginLoader);
      if (installStatus === "installed") {
        logSink.log("Installed bundled Grok CLI runtime plugin", "plugins");
      } else if (installStatus === "missing-bundle") {
        logSink.log("Bundled Grok CLI runtime plugin was not found in this build", "plugins");
      }
    } catch (err) {
      logSink.log(
        `Failed to auto-install bundled Grok CLI runtime plugin: ${err instanceof Error ? err.message : err}`,
        "plugins",
      );
    }

    try {
      const { loaded, errors } = await pluginLoader.loadAllPlugins();
      logSink.log(`Loaded ${loaded} plugins (${errors} errors)`, "plugins");

      const schemaHooks = pluginLoader.getPluginSchemaInitHooks();
      if (schemaHooks.length > 0) {
        try {
          await store.getDatabase().runPluginSchemaInits(schemaHooks);
        } catch (err) {
          logSink.log(
            `Schema initialization failed: ${err instanceof Error ? err.message : err}`,
            "plugins",
          );
        }
      }
    } catch (err) {
      logSink.log(
        `Failed to load plugins: ${err instanceof Error ? err.message : err}`,
        "plugins"
      );
    }
  })();

  // ── HeartbeatMonitor + HeartbeatTriggerScheduler ──────────────────────
  //
  // In engine mode: obtained from ProjectEngine after engine.start(), which
  // delegates to InProcessRuntime's already-initialized instances. This avoids
  // running duplicate heartbeat infrastructure alongside the engine's own.
  //
  // In UI-only mode: created inline inside the noEngine block below, since the
  // engine does not start when --no-engine is passed.
  //
  // heartbeatMonitorImpl is a mutable reference. The proxy passed to
  // createServer delegates through it so routes work in both modes.
  //
  let heartbeatMonitorImpl: HeartbeatMonitor | undefined;
  let triggerScheduler: HeartbeatTriggerScheduler | undefined;

  // Set enginePaused if starting in paused mode
  if (opts.paused) {
    await store.updateSettings({ enginePaused: true });
    logSink.log("Starting in paused mode — automation disabled", "engine");
  }

  // ── onMerge: AI-powered merge ─────────────────────────────────────
  //
  // onMergeImpl is a mutable reference so createServer always gets a stable
  // wrapper function while the underlying implementation is swapped when the
  // engine starts in engine mode.
  //
  // In UI-only mode: calls runAiMerge directly (no engine, no semaphore).
  // In engine mode: replaced by engine.onMerge() after ProjectEngine starts
  // (semaphore-gated via the engine's InProcessRuntime).
  //
  // FNXC:MergerUnification 2026-06-21-19:05: master-plan U0 unified all merge
  // entry points onto runAiMerge (the FN-5633 clean-room AI merge path);
  // aiMergeTask is soft-deprecated.
  //
  const onMergeImpl = async (taskId: string) => {
    // FNXC:Workspace 2026-06-21-23:40 (Phase C U1, KTD2):
    // Dashboard merge button (UI-only mode). A workspace-mode task routes through
    // the ENGINE per-repo merge loop `landWorkspaceTask` (each sub-repo lands on its
    // own LOCAL integration ref, no push) instead of throwing — manual merge works in
    // Phase C (user decision). U0's R7 throw is replaced here by routing; the engine
    // chokepoint + store.mergeTask/aiMergeTask keep throwing as defense-in-depth.
    const mergeTask = await store.getTask(taskId).catch(() => null);
    // FNXC:Workspace 2026-06-22-09:30 (Phase C review B10): use the exported `isWorkspaceTask`
    // (the engine/CLI canonical predicate) instead of re-inlining the workspaceWorktrees check.
    const isWorkspaceMerge = !!mergeTask && isWorkspaceTask(mergeTask);
    if (isWorkspaceMerge) {
      const workspaceResult = await landWorkspaceTask(store, mergeTask!, cwd, {
        agentStore,
      });
      const latest = await store.getTask(taskId).catch(() => mergeTask!);
      // FNXC:Workspace 2026-06-22-05:10 (Phase C review B3):
      // landWorkspaceTask now finalizes the workspace task to done on allLanded (Phase C U2),
      // so the merge door must report merged=true when the workspace fully landed — mirroring
      // the engine dispatch's MergeResult. The first landed sub-repo's landedSha is the recorded
      // commitSha (same convention finalizeWorkspaceTask uses). On a partial land, merged stays
      // false and the partial-land error surfaces on the task log.
      const landedSha = workspaceResult.repos.find((r) => r.status === "landed")?.landedSha;
      return {
        task: latest ?? mergeTask!,
        branch: getTaskBranchName(taskId),
        merged: workspaceResult.allLanded,
        mergeConfirmed: workspaceResult.allLanded || undefined,
        commitSha: workspaceResult.allLanded ? landedSha : undefined,
        worktreeRemoved: false,
        branchDeleted: false,
        error: workspaceResult.allLanded ? undefined : "partial workspace land — see task log",
      };
    }

    const settings = await store.getSettings();
    if (getMergeStrategy(settings) === "pull-request") {
      const githubClient = new GitHubClient();
      const outcome = await processPullRequestMergeTask(
        store,
        cwd,
        taskId,
        githubClient,
        getTaskMergeBlocker,
      );
      const task = await store.getTask(taskId);
      return {
        task,
        branch: getTaskBranchName(taskId),
        merged: outcome === "merged",
        worktreeRemoved: false,
        branchDeleted: false,
        error: outcome === "waiting" ? "pull request not ready" : undefined,
      };
    }

    const streamedMergeLog = new StreamedLogBuffer(
      (line) => logSink.log(line, "merge"),
      STREAM_LOG_FLUSH_IDLE_MS,
    );

    try {
      return await runAiMerge(store, cwd, taskId, {
        agentStore,
        onAgentText: (delta) => streamedMergeLog.push(delta),
      });
    } finally {
      streamedMergeLog.flush();
      streamedMergeLog.dispose();
    }
  };

  const onMerge = (taskId: string) => onMergeImpl(taskId);

  // ── MissionAutopilot + MissionExecutionLoop: mission lifecycle ────
  //
  // Created inline for UI-only mode (engine doesn't start with --no-engine).
  // In engine mode, the engine is passed to createServer which derives these.
  //
  const missionAutopilotImpl: MissionAutopilot | undefined = new MissionAutopilot(store, store.getMissionStore());
  const missionExecutionLoopImpl: MissionExecutionLoop | undefined = new MissionExecutionLoop({
    taskStore: store,
    missionStore: store.getMissionStore(),
    missionAutopilot: {
      notifyValidationComplete: async (featureId: string, _status: "passed" | "failed" | "blocked" | "error") => {
        if (missionAutopilotImpl) {
          const missionStore = store.getMissionStore();
          const feature = missionStore?.getFeature(featureId);
          if (feature?.taskId) {
            await missionAutopilotImpl.handleTaskCompletion(feature.taskId);
          }
        }
      },
    },
    rootDir: cwd,
  });

  // ── Auth & model wiring ────────────────────────────────────────────
  // AuthStorage manages OAuth/API-key credentials (stored in ~/.fusion/agent/auth.json).
  // ModelRegistry discovers available models from configured providers.
  // Passing these to createServer enables the dashboard's Authentication
  // tab (login/logout) and Model selector.
  /*
  FNXC:AuthRefresh 2026-06-13-22:46:
  Dashboard status polling, model discovery, and execution-facing auth reads must share the engine auth store so expired Claude OAuth credentials refresh once and legacy Claude/Codex credentials keep working.
  */
  const authStorage = createFusionAuthStorage();
  const modelRegistry = ModelRegistry.create(authStorage, getModelRegistryModelsPath());
  registerBuiltInZaiProvider(modelRegistry, (message) => logSink.log(message, "extensions"));
  registerBuiltInGrokProvider(modelRegistry, (message) => logSink.log(message, "extensions"));
  const dashboardAuthStorage = wrapAuthStorageWithApiKeyProviders(authStorage, modelRegistry);

  // PackageManager may be used for skills adapter even if extension loading fails.
  // packageManager.resolve() walks installed npm/git/local pi packages and is
  // the slowest step in this section — show an accurate TUI status so users
  // don't think "starting agents" is stuck.
  if (tui) tui.setLoadingStatus(DASHBOARD_STARTUP_STATUS.loadingExtensions);
  let packageManager: DefaultPackageManager | undefined;
  try {
    // Resolve extension paths from pi settings packages (npm, git, local).
    // This picks up extensions like @howaboua/pi-glm-via-anthropic that
    // register custom providers (e.g. glm-5.1) via registerProvider().
    const agentDir = getPackageManagerAgentDir();
    packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: createReadOnlyProviderSettingsView(cwd, agentDir) as unknown as SettingsManager,
    });
    const resolvedPaths = await phaseTime("packageManager.resolve", () => packageManager!.resolve());
    const packageExtensionPaths = resolvedPaths.extensions
      .filter((r) => r.enabled)
      .map((r) => r.path);

    const claudeCliPaths = await (async () => {
      try {
        const globalSettings = await store.getGlobalSettingsStore().getSettings();
        const result = resolveClaudeCliExtensionPaths(globalSettings);
        setCachedClaudeCliResolution(result.resolution);
        if (result.warning) {
          console.warn(`[extensions] pi-claude-cli: ${result.warning}`);
        }
        return result.paths;
      } catch (err) {
        console.warn(
          `[extensions] Unable to evaluate useClaudeCli setting: ${err instanceof Error ? err.message : String(err)}`,
        );
        setCachedClaudeCliResolution(null);
        return [];
      }
    })();

    const droidCliPaths = await (async () => {
      try {
        const globalSettings = await store.getGlobalSettingsStore().getSettings();
        const result = resolveDroidCliExtensionPaths(globalSettings);
        setCachedDroidCliResolution(result.resolution);
        if (result.warning) {
          console.warn(`[extensions] droid-cli: ${result.warning}`);
        }
        return result.paths;
      } catch (err) {
        console.warn(
          `[extensions] Unable to evaluate useDroidCli setting: ${err instanceof Error ? err.message : String(err)}`,
        );
        setCachedDroidCliResolution(null);
        return [];
      }
    })();

    const llamaCppPaths = await (async () => {
      try {
        const globalSettings = await store.getGlobalSettingsStore().getSettings();
        const result = resolveLlamaCppExtensionPaths(globalSettings);
        setCachedLlamaCppResolution(result.resolution);
        if (result.warning) {
          console.warn(`[extensions] llama-cpp: ${result.warning}`);
        }
        return result.paths;
      } catch (err) {
        console.warn(
          `[extensions] Unable to evaluate useLlamaCpp setting: ${err instanceof Error ? err.message : String(err)}`,
        );
        setCachedLlamaCppResolution(null);
        return [];
      }
    })();

    // Always inject the cli's own extension (`@runfusion/fusion`) so its
    // `fn_*` tools register globally even when the user hasn't run
    // `pi install npm:@runfusion/fusion`. Without this, agent chat with
    // pi-claude-cli has no fn_* tools at all.
    const selfExtension = resolveSelfExtension();
    const selfExtensionPaths = selfExtension.status === "ok" ? [selfExtension.path] : [];
    if (selfExtension.status !== "ok") {
      logSink.warn(`[extensions] self: ${selfExtension.reason}`, "extensions");
    }
    // Propagate self-extension path to engine so createFnAgent sessions
    // (chat, refine, mission, etc.) also load fn_* tools, not just the
    // dashboard's extension runtime.
    setHostExtensionPaths(selfExtensionPaths);

    // Load all enabled extensions: Fusion/Pi filesystem-discovered + package-resolved.
    const extensionsResult = await phaseTime("discoverAndLoadExtensions", () => discoverAndLoadExtensions(
      [
        ...selfExtensionPaths,
        ...getEnabledPiExtensionPaths(cwd),
        ...packageExtensionPaths,
        ...claudeCliPaths,
        ...droidCliPaths,
        ...llamaCppPaths,
      ],
      cwd,
      join(cwd, ".fusion", "disabled-auto-extension-discovery"),
    ));

    for (const { path, error } of extensionsResult.errors) {
      logSink.log(`Failed to load ${path}: ${error}`, "extensions");
    }

    for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSink.log(`Failed to register provider from ${extensionPath}: ${message}`, "extensions");
      }
    }

    extensionsResult.runtime.pendingProviderRegistrations = [];
    mergeBuiltInZaiProviderModels(modelRegistry, (message) => logSink.log(message, "extensions"));
    mergeBuiltInGrokProviderModels(modelRegistry, (message) => logSink.log(message, "extensions"));
    modelRegistry.refresh();

    try {
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      registerCustomProviders(
        modelRegistry,
        globalSettings.customProviders,
        (message) => logSink.log(message, "custom-providers"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logSink.warn(`Failed to load custom providers from global settings: ${message}`, "custom-providers");
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logSink.log(`Failed to discover extensions: ${message}`, "extensions");
    createExtensionRuntime();
    modelRegistry.refresh();
  }

  void syncStartupModels({
    getSettings: () => store.getSettings(),
    authStorage: dashboardAuthStorage,
    modelRegistry,
    log: (scope, message) => logSink.log(message, scope),
  });

  registerHandler(store, "settings:updated", ({ settings, previous }) => {
    if (peerExchangeService) {
      void store.getGlobalSettingsStore().getSettings().then((globalSettings) => {
        peerExchangeService?.updateGlobalSettings(globalSettings);
      }).catch(() => undefined);
    }
    const currentProviders = settings.customProviders;
    const previousProviders = previous.customProviders;
    if (JSON.stringify(currentProviders ?? []) === JSON.stringify(previousProviders ?? [])) {
      return;
    }

    reregisterCustomProviders(
      modelRegistry,
      previousProviders,
      currentProviders,
      (message) => logSink.log(message, "custom-providers"),
    );
  });

  // ── Skills adapter for skills discovery and execution toggling ─────────────
  //
  // Create the skills adapter using the same DefaultPackageManager instance
  // that was set up earlier for extension resolution.
  const pluginSkillCache = new Map<
    string,
    { enabledKey: string; skills: ReturnType<PluginLoader["getPluginSkills"]> }
  >();
  const getProjectScopedPluginSkills = async (rootDir: string): Promise<ReturnType<PluginLoader["getPluginSkills"]>> => {
    const normalizedRootDir = pathResolve(rootDir);
    const stateStore = new PluginStore(normalizedRootDir, { centralGlobalDir: resolveGlobalDir() });
    await stateStore.init();
    try {
      const enabledPlugins = await stateStore.listPlugins({ enabled: true });
      const enabledKey = enabledPlugins
        .map((plugin) => `${plugin.id}:${plugin.updatedAt}`)
        .sort()
        .join("\0");
      const cached = pluginSkillCache.get(normalizedRootDir);
      if (cached?.enabledKey === enabledKey) {
        return cached.skills;
      }
      if (enabledPlugins.length === 0) {
        const skills: ReturnType<PluginLoader["getPluginSkills"]> = [];
        pluginSkillCache.set(normalizedRootDir, { enabledKey, skills });
        return skills;
      }

      if (!store) {
        return [];
      }
      /*
       * FNXC:PluginSkills 2026-07-10-00:00:
       * Same-root skill discovery must reuse the dashboard daemon's active PluginLoader; request-scoped loaders are only for other project roots and are stopped after metadata collection to avoid leaking plugin side effects or SQLite handles.
       */
      if (normalizedRootDir === pathResolve(store.getRootDir())) {
        const enabledIds = new Set(enabledPlugins.map((plugin) => plugin.id));
        const skills = pluginLoader.getPluginSkills().filter((entry) => enabledIds.has(entry.pluginId));
        pluginSkillCache.set(normalizedRootDir, { enabledKey, skills });
        return skills;
      }

      const scopedPluginStore = new PluginStore(normalizedRootDir, { centralGlobalDir: resolveGlobalDir() });
      const scopedTaskStore = new TaskStore(normalizedRootDir);
      const scopedPluginLoader = new PluginLoader({ pluginStore: scopedPluginStore, taskStore: scopedTaskStore });
      try {
        await scopedPluginStore.init();
        await scopedTaskStore.init();
        const { errors } = await scopedPluginLoader.loadAllPlugins();
        if (errors > 0) {
          logSink.warn(`Project-scoped plugin skill loading for ${normalizedRootDir} had ${errors} error(s)`, "plugins");
        }
        const skills = scopedPluginLoader.getPluginSkills();
        pluginSkillCache.set(normalizedRootDir, { enabledKey, skills });
        return skills;
      } finally {
        await scopedPluginLoader.stopAllPlugins();
        scopedPluginStore.close();
        scopedTaskStore.close();
      }
    } finally {
      stateStore.close();
    }
  };

  const skillsAdapter = packageManager
    ? createSkillsAdapter({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dashboard's resolve() uses a looser onMissing signature than pi's DefaultPackageManager
        packageManager: packageManager as any,
        getSettingsPath: (rootDir: string) => getProjectSettingsPath(rootDir),
        /*
         * FNXC:PluginSkills 2026-07-10-00:00:
         * `fn dashboard` can start outside the managed project whose Skills view is being served. Resolve plugin skill contributions with a PluginStore scoped to the requesting rootDir so project_plugin_states, not the daemon root, decides which plugin:<id> skills appear.
         */
        getPluginSkills: getProjectScopedPluginSkills,
      })
    : undefined;

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    // Clear pending debounce timer
    if (tuiRefreshDebounceTimer) {
      clearTimeout(tuiRefreshDebounceTimer);
      tuiRefreshDebounceTimer = null;
    }

    // Stop TUI if active
    if (tui) {
      // FNXC:DashboardShutdown 2026-06-28-00:00:
      // Silence (do NOT releaseConsole) before stopping the TUI. tui.stop()
      // leaves the alt-screen and restores the user's shell prompt; releasing
      // console here would re-point console.* at that restored shell, so the
      // engine/mesh/dev-server logs emitted during the slow teardown that
      // follows painted over the recovered prompt — the "TUI keeps rendering
      // after q" regression. We are exiting; drop teardown output instead.
      // FUSION_DEBUG_SHUTDOWN still surfaces per-step timing on stderr.
      logSink.silence();
      void tui.stop();
    }

    for (const { target, event, handler } of handlers) {
      target.off(event, handler);
    }
    handlers.length = 0;
    for (const callback of disposeCallbacks.splice(0)) {
      callback();
    }
  }

  // ── createServer: deferred until engine is conditionally started ────
  //
  // In engine mode, pass the engine so createServer derives subsystem
  // options (onMerge, automationStore, missionAutopilot, etc.) automatically.
  // In UI-only mode, no engine — pass individual proxy objects instead.
  //
  let app: ReturnType<typeof createServer>;

  // ── Mesh networking: peer exchange + mDNS discovery ──────────────────
  //
  // peerExchangeService: periodically syncs peer info with connected nodes
  // centralCoreForMesh: CentralCore for discovery/node lifecycle (may differ from centralCoreForEngine)
  // localNodeIdForMesh: tracks the local node ID for cleanup on shutdown
  //
  let peerExchangeService: PeerExchangeService | null = null;
  let centralCoreForMesh: CentralCore | null = null;
  let localNodeIdForMesh: string | undefined;

  // Start the AI engine unless the caller explicitly requested a UI-only process.
  if (tui) tui.setLoadingStatus(DASHBOARD_STARTUP_STATUS.startingEngine);
  if (!noEngine) {
    // ── ProjectEngineManager: uniform engine lifecycle for all projects ──
    //
    // Every registered project gets an identical ProjectEngine with the
    // full subsystem set (Scheduler, Triage, Executor, auto-merge, PR
    // monitor, notifier, cron, settings listeners). No project is special.
    //
    const githubClient = new GitHubClient();

    const centralCoreForEngine = await phaseTime("centralCore.init (await)", () => centralCoreInitPromise!);

    try {
      registerGithubTrackingHook?.();
    } catch {
      // Some tests partially mock @fusion/dashboard and omit this export.
    }

    const engineManager = new ProjectEngineManager(centralCoreForEngine, {
      getMergeStrategy,
      processPullRequestMerge: (s, wd, taskId, pool) =>
        processPullRequestMergeTask(s, wd, taskId, githubClient, getTaskMergeBlocker, pool),
      createGroupPr: createGroupPrCallback(githubClient),
      syncGroupPr: syncGroupPrCallback(githubClient),
      prNodeGithubOps: createPrNodeGithubOps(githubClient),
      prReconcileGithubOps: createPrReconcileGithubOps(githubClient),
      getTaskMergeBlocker,
    });

    // Start engines for all registered projects in the background. The
    // on-access fast path (server's onProjectFirstAccessed) and the
    // reconciliation loop below both cover correctness, so awaiting here
    // just blocks the TUI on the slowest project's git/state init.
    void engineManager.startAll().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logSink.warn(`Background engine startup failed: ${message}`, "dashboard");
    });

    let hybridExecutor: HybridExecutor | undefined = undefined;

    engineManager.startReconciliation();

    // Backfill Claude Code skills for all registered projects. No-op when
    // pi-claude-cli isn't configured; non-blocking to protect startup latency.
    void (async () => {
      try {
        if (!centralCoreForEngine) return;
        const projects = await centralCoreForEngine.listProjects();
        ensureClaudeSkillsForAllProjectsOnStartup(
          projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
        );
      } catch (err) {
        logSink.log(
          `Claude skill reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
          "engine",
        );
      }
    })();

    peerExchangeService = new PeerExchangeService(centralCoreForEngine);
    centralCoreForMesh = centralCoreForEngine;

    // Hybrid gate, cwd project registration, and peer exchange settings are
    // independent — run them in parallel.
    const [hybridGate, cwdRegistered] = await phaseTime("engine: hybridGate + cwdRegister + peerExchange", () => Promise.all([
      shouldUseHybridExecutor(centralCoreForEngine),
      ensureCwdProjectRegistered({
        cwd,
        central: centralCoreForEngine,
        logPrefix: "dashboard",
        /*
         * FNXC:CliProjectOnboarding 2026-07-03-03:45:
         * Bare `fusion` / `fn` / `fn dashboard` / `fusion dashboard` must NOT auto-register the CWD as
         * a project. Auto-registration silently created a project for whatever directory the dashboard
         * happened to launch from. Instead: use the CWD project only if it is ALREADY registered,
         * otherwise start with no CWD project and let the dashboard prompt the operator through
         * onboarding (ProjectOverview "Add your first project" -> SetupWizard). Operators who want the
         * CWD registered can still run `fn init`.
         */
        autoRegister: false,
      }).catch(() => undefined as Awaited<ReturnType<typeof ensureCwdProjectRegistered>> | undefined),
      (async () => {
        try {
          peerExchangeService!.start();
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          peerExchangeService!.updateGlobalSettings(globalSettings);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logSink.warn(`Failed to start peer exchange service: ${message}`, "dashboard");
        }
      })(),
    ]));

    logSink.log(
      `hybrid executor gate: enabled=${hybridGate.enabled} reason=${hybridGate.reason}`,
      "dashboard",
    );

    // HybridExecutor init: keep awaited (only runs when hybridGate.enabled,
    // which now requires multi-node — rare on local-only setups).
    if (hybridGate.enabled) {
      try {
        const he = await phaseTime("engine: HybridExecutor.initialize", async () => {
          const x = new HybridExecutor(centralCoreForEngine);
          await x.initialize();
          return x;
        });
        hybridExecutor = he;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSink.warn(`HybridExecutor initialization failed: ${message}`, "engine");
      }
    }

    // cwd engine warmup: must complete before createServer.
    //
    // server.ts derives a stack of subsystem defaults from `options.engine` —
    // onMerge, automationStore, missionAutopilot, missionExecutionLoop,
    // heartbeatMonitor, selfHealingManager, routineStore, routineRunner. These
    // defaults are captured at route-construction time (closure-bound), so we
    // cannot lazily fill them in after listen(). Unscoped HTTP/webhook traffic
    // (e.g. GitHub/Stripe routine webhooks, automation routes with scope=
    // global, mission autopilot recovery) depends on them.
    //
    // An earlier iteration race-d this against a 3s deadline; that traded
    // correctness for startup speed and meant slow cold-starts handed
    // undefined engine to createServer, silently degrading those endpoints
    // for the first multi-second window. We now await fully — the
    // duplicate-runtime issue that previously made this 7s+ is gone (see
    // hybrid-executor-gate change), so warmup typically runs in ~3-5s with
    // engineManager.startAll() already in flight in parallel.
    const cwdEngine = cwdRegistered
      ? await phaseTime("engine: ensureEngine(cwd)", () =>
          engineManager.ensureEngine(cwdRegistered.id).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            logSink.warn(`Failed to warm cwd project engine: ${message}`, "engine");
            return undefined;
          }),
        )
      : undefined;

    // Get the trigger scheduler from any running engine
    for (const engine of engineManager.getAllEngines().values()) {
      const ts = engine.getHeartbeatTriggerScheduler();
      if (ts) {
        triggerScheduler = ts;
        break;
      }
    }

    disposeCallbacks.push(async () => {
      if (hybridExecutor) {
        await hybridExecutor.shutdown();
      }
      await engineManager.stopAll();
      await closeCentralCoreBestEffort(centralCoreForEngine, "dispose cleanup");
    });

    // Ensure plugin loading has completed before pluginLoader is handed off
    // to createServer — routes derived from getPluginRoutes() rely on it.
    await phaseTime("pluginLoadingPromise (await)", () => pluginLoadingPromise);

    // ── CLI Agent Executor: hub resolver + session transport ─────────────
    //
    // The hook route validates a per-session token against the project's live
    // TelemetryHub; resolve it from that project's engine. The cli-sessions
    // transport (REST + WS attach) is supplied from the cwd project's runtime
    // (the canonical single-project surface) when the experimental flag is on.
    //
    const cliAgentHubResolver = (projectId: string | undefined, _sessionId: string) => {
      const engine = projectId ? engineManager.getEngine(projectId) : cwdEngine;
      return engine?.getCliAgentRuntime()?.bundle.hub;
    };
    const cwdCliAgentRuntime = cwdEngine?.getCliAgentRuntime();
    const cliSessionTransport = cwdCliAgentRuntime
      ? {
          manager: cwdCliAgentRuntime.bundle.manager,
          store: cwdCliAgentRuntime.bundle.store,
          ticketStore: new AttachTicketStore(),
          attributionLog: new CliInputAttributionLog(),
          confirmAdvance: new CliConfirmAdvanceRegistry(),
          relaunch: new CliRelaunchRegistry(),
        }
      : undefined;

    app = createServer(store, {
      engine: cwdEngine,
      engineManager,
      cliAgentHubResolver,
      cliSessionTransport,
      hybridExecutor,
      centralCore: centralCoreForEngine,
      authStorage: dashboardAuthStorage,
      modelRegistry,
      automationStore,
      pluginStore,
      pluginLoader,
      pluginRunner: pluginLoader,
      ensureBundledPluginInstalled: ensureBundledPluginInstalledCallback,
      onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
      onProjectRegistered: ({ path }) => {
        maybeInstallClaudeSkillForNewProject(path);
      },
      onApiKeySaved: async (providerId: string) => {
        if (providerId !== "opencode" && providerId !== "opencode-go") {
          return undefined;
        }
        return await handleOpencodeGoApiKeySaved(
          dashboardAuthStorage,
          store,
          modelRegistry,
          (scope, message) => logSink.log(message, scope),
        );
      },
      getClaudeCliExtensionStatus: () => {
        const r = getCachedClaudeCliResolution();
        if (!r) return null;
        if (r.status === "ok") {
          return { status: "ok", path: r.path, packageVersion: r.packageVersion };
        }
        if (r.status === "not-installed") {
          return { status: "not-installed" };
        }
        return { status: r.status, reason: r.reason };
      },
      getDroidCliExtensionStatus: () => {
        const r = getCachedDroidCliResolution();
        if (!r) return null;
        if (r.status === "ok") {
          return { status: "ok", path: r.path, packageVersion: r.packageVersion };
        }
        if (r.status === "not-installed") {
          return { status: "not-installed" };
        }
        return { status: r.status, reason: r.reason };
      },
      getLlamaCppExtensionStatus: () => {
        const r = getCachedLlamaCppResolution();
        if (!r) return null;
        if (r.status === "ok") {
          return { status: "ok", path: r.path, packageVersion: r.packageVersion };
        }
        if (r.status === "not-installed") {
          return { status: "not-installed" };
        }
        return { status: r.status, reason: r.reason };
      },
      onUseClaudeCliToggled: (_prev, next) => {
        if (!next) return;
        void (async () => {
          try {
            if (!centralCoreForEngine) return;
            const projects = await centralCoreForEngine.listProjects();
            ensureClaudeSkillsForAllProjectsOnStartup(
              projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
            );
          } catch (err) {
            logSink.log(
              `Claude skill backfill on toggle failed: ${err instanceof Error ? err.message : String(err)}`,
              "engine",
            );
          }
        })();
      },
      onUseDroidCliToggled: (_prev, next) => {
        if (next) {
          logSink.log("Droid CLI enabled — restart required for full effect", "extensions");
        }
      },
      skillsAdapter,
      https: loadTlsCredentialsFromEnv(),
      daemon: dashboardAuthToken ? { token: dashboardAuthToken } : undefined,
      noAuth: opts.noAuth,
      runtimeLogger,
      systemControl: systemControlForServer,
      systemLogs: systemLogsForServer,
    });

    const shutdown = async (signal: NodeJS.Signals) => {
      // Second signal (user mashing q/Ctrl+C because the first didn't exit) —
      // force an immediate exit rather than being swallowed by the guard.
      if (shutdownInProgress) process.exit(shutdownExitCode);
      shutdownInProgress = true;
      armHardExitWatchdog();

      // Log active handles at shutdown for diagnostics
      const handleTypes: Record<string, number> = {};
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handles = (process as any)._getActiveHandles?.() ?? [];
        for (const handle of handles) {
          const type = handle.constructor?.name ?? "unknown";
          handleTypes[type] = (handleTypes[type] ?? 0) + 1;
        }
        const handleSummary = Object.entries(handleTypes)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `${type}:${count}`)
          .join(", ");
        logSink.log(`active handles at shutdown: ${handleSummary}`, "dashboard");
      } catch {
        // Ignore errors getting handle types
      }

      await logShutdownDiagnostics(signal);
      dispose();
      stopDiagnosticInterval();

      // Tear down user-project dev-server children (and their process groups)
      // before exiting. server.close() is not awaited on this exit path, so
      // its `close` listener that does the same cleanup may not run in time.
      await timeShutdownStep("stopAllDevServers", () => stopAllDevServers());

      if (hybridExecutor) {
        await timeShutdownStep("hybridExecutor.shutdown", () => hybridExecutor!.shutdown());
      }

      // Stop all project engines uniformly
      await timeShutdownStep("engineManager.stopAll", () => engineManager.stopAll());

      // Stop peer exchange service
      if (peerExchangeService) {
        await timeShutdownStep("peerExchangeService.stop", () => peerExchangeService!.stop());
      }

      // Stop mDNS discovery and set local node offline
      if (centralCoreForMesh && localNodeIdForMesh) {
        await timeShutdownStep("mesh.stopDiscovery", () => {
          centralCoreForMesh!.stopDiscovery();
        });
        await timeShutdownStep("mesh.setNodeOffline", async () => {
          await centralCoreForMesh!.updateNode(localNodeIdForMesh!, { status: "offline" });
        });
      }

      await timeShutdownStep("closeCentralCore", () =>
        closeCentralCoreBestEffort(centralCoreForEngine, `shutdown (${signal})`),
      );

      store.close();
      process.exit(shutdownExitCode);
    };
    /*
    FNXC:SystemPanel 2026-07-12-11:00:
    Bind the System panel restart request to the real graceful-shutdown path.
    The short delay lets the HTTP 202 response flush before teardown starts.
    Restart is only honored when a supervising parent will respawn us.
    */
    requestSelfRestart = (reason: string) => {
      if (!systemControlForServer.supervised || shutdownInProgress || restartScheduled) return false;
      restartScheduled = true;
      logSink.log(`restart requested (${reason}) — shutting down for supervised respawn`, "dashboard");
      shutdownExitCode = FUSION_RESTART_EXIT_CODE;
      setTimeout(() => {
        void shutdown("SIGTERM");
      }, 300);
      return true;
    };
    registerHandler(process, "SIGINT", () => void shutdown("SIGINT"));
    registerHandler(process, "SIGTERM", () => void shutdown("SIGTERM"));

    // Ignore SIGHUP so the dashboard survives SSH session disconnects.
    // Without this, SIGHUP (sent when the controlling terminal closes) kills
    // the process silently — the exit handler tries to log to the now-dead
    // PTY and the write is lost.
    registerHandler(process, "SIGHUP", () => {
      logSink.log("Received SIGHUP (terminal disconnected) — ignoring", "dashboard");
    });
  } else {
    // UI-only mode: create HeartbeatMonitor + TriggerScheduler inline (engine not started)

    // ── Mesh networking for UI-only mode ─────────────────────────────────
    //
    // In UI-only mode we don't use the engine's CentralCore, so create a separate
    // instance for peer exchange and mDNS discovery.
    //
    try {
      centralCoreForMesh = new CentralCore();
      await centralCoreForMesh.init();

      peerExchangeService = new PeerExchangeService(centralCoreForMesh);
      peerExchangeService.start();
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      peerExchangeService.updateGlobalSettings(globalSettings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSink.warn(`Failed to initialize mesh networking: ${message}`, "dashboard");
    }

    try {
      heartbeatMonitorImpl = new HeartbeatMonitor({
        store: agentStore,
        agentStore,
        taskStore: store,
        rootDir: cwd,
        onMissed: (agentId, reason) => {
          logSink.warn(`Agent ${agentId} missed heartbeat: ${reason}`, "engine");
        },
        onTerminated: (agentId, reason) => {
          logSink.warn(`Agent ${agentId} terminated (unresponsive): ${reason}`, "engine");
        },
      });
      heartbeatMonitorImpl.start();

      triggerScheduler = new HeartbeatTriggerScheduler(
        agentStore,
        async (agentId, source, context: WakeContext) => {
          if (!heartbeatMonitorImpl) return;
          await heartbeatMonitorImpl.executeHeartbeat({
            agentId,
            source,
            triggerDetail: context.triggerDetail,
            taskId: typeof context.taskId === "string" ? context.taskId : undefined,
            triggeringCommentIds: Array.isArray(context.triggeringCommentIds)
              ? context.triggeringCommentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
              : undefined,
            triggeringCommentType:
              context.triggeringCommentType === "steering"
              || context.triggeringCommentType === "task"
              || context.triggeringCommentType === "pr"
                ? context.triggeringCommentType
                : undefined,
            contextSnapshot: { ...context },
          });
        },
        store,
        // UI-only scheduler: no TaskExecutor runs here (engine not started), so
        // neither `isTaskExecuting` nor the U5 reverse-direction
        // `isAgentEffectivelyExecuting` guard has a source — both stay unwired (the
        // guards simply never fire), matching the prior `isTaskExecuting` omission.
        // The real wiring is the InProcessRuntime construction site.
      );
      triggerScheduler.start();

      const agents = await agentStore.listAgents();
      const missedCatchupTargets: { agentId: string; lastHeartbeatAt: string }[] = [];
      for (const agent of agents) {
        // State is the source of truth: arm timers only for non-ephemeral,
        // heartbeat-enabled agents in tickable states. Transitions into
        // tickable states while the scheduler is already running are
        // handled by the scheduler's own lifecycle listeners.
        if (isEphemeralAgent(agent)) continue;
        if (agent.runtimeConfig?.enabled === false) continue;
        if (agent.state !== "active" && agent.state !== "running" && agent.state !== "idle") continue;
        const rc = agent.runtimeConfig;
        const intervalMs = (rc?.heartbeatIntervalMs as number | undefined) ?? DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS;
        triggerScheduler.registerAgent(
          agent.id,
          {
            enabled: rc?.enabled as boolean | undefined,
            heartbeatIntervalMs: rc?.heartbeatIntervalMs as number | undefined,
            maxConcurrentRuns: rc?.maxConcurrentRuns as number | undefined,
          },
          { lastHeartbeatAt: agent.lastHeartbeatAt },
        );

        // Per-agent opt-in: if the server was down across a scheduled tick,
        // fire one catch-up heartbeat. We require explicit lastHeartbeatAt to
        // avoid firing on agents that have never run.
        if (
          rc?.runMissedHeartbeatOnStartup === true
          && rc?.enabled !== false
          && typeof agent.lastHeartbeatAt === "string"
          && agent.lastHeartbeatAt.length > 0
        ) {
          const lastMs = Date.parse(agent.lastHeartbeatAt);
          if (Number.isFinite(lastMs) && Date.now() - lastMs > intervalMs) {
            missedCatchupTargets.push({ agentId: agent.id, lastHeartbeatAt: agent.lastHeartbeatAt });
          }
        }
      }
      if (agents.length > 0) {
        logSink.log(`Registered ${triggerScheduler.getRegisteredAgents().length} agents for heartbeat triggers`, "engine");
      }

      for (const target of missedCatchupTargets) {
        const monitor = heartbeatMonitorImpl;
        if (!monitor) break;
        logSink.log(
          `Firing catch-up heartbeat for ${target.agentId} (lastHeartbeatAt=${target.lastHeartbeatAt})`,
          "engine",
        );
        // Fire and forget; serialized per-agent inside executeHeartbeat.
        void monitor.executeHeartbeat({
          agentId: target.agentId,
          source: "timer",
          triggerDetail: "startup-missed-heartbeat-catchup",
        }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logSink.warn(`Catch-up heartbeat for ${target.agentId} failed: ${message}`, "engine");
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSink.log(`HeartbeatMonitor initialization failed (continuing without agent monitoring): ${message}`, "engine");
    }

    // Ensure plugin loading has completed before pluginLoader is handed off
    // to createServer — routes derived from getPluginRoutes() rely on it.
    await phaseTime("pluginLoadingPromise (await)", () => pluginLoadingPromise);

    // UI-only mode: no engine, pass individual proxy objects to createServer.
    //
    // FNXC:DashboardStartup 2026-06-20-23:39:
    // Dashboard development mode still needs a running engine by default; only the explicit `--no-engine` flag should produce a UI-only process so local and dev startup paths match user expectations.
    app = createServer(store, {
      onMerge,
      centralCore: centralCoreForMesh ?? undefined,
      authStorage: dashboardAuthStorage,
      modelRegistry,
      automationStore,
      missionAutopilot: {
        watchMission: (missionId: string) => missionAutopilotImpl?.watchMission(missionId),
        unwatchMission: (missionId: string) => missionAutopilotImpl?.unwatchMission(missionId),
        isWatching: (missionId: string) => missionAutopilotImpl?.isWatching(missionId) ?? false,
        getAutopilotStatus: (missionId: string) => missionAutopilotImpl!.getAutopilotStatus(missionId),
        checkAndStartMission: (missionId: string) => missionAutopilotImpl?.checkAndStartMission(missionId) ?? Promise.resolve(),
        recoverStaleMission: (missionId: string) => missionAutopilotImpl?.recoverStaleMission(missionId) ?? Promise.resolve(),
        start: () => missionAutopilotImpl?.start(),
        stop: () => missionAutopilotImpl?.stop(),
      },
      missionExecutionLoop: {
        recoverActiveMissions: () => missionExecutionLoopImpl?.recoverActiveMissions() ?? Promise.resolve({ recoveredCount: 0 }),
        isRunning: () => missionExecutionLoopImpl?.isRunning() ?? false,
      },
      heartbeatMonitor: {
        rootDir: cwd,
        startRun: (...args: Parameters<HeartbeatMonitor["startRun"]>) => heartbeatMonitorImpl!.startRun(...args),
        executeHeartbeat: (...args: Parameters<HeartbeatMonitor["executeHeartbeat"]>) => heartbeatMonitorImpl!.executeHeartbeat(...args),
        stopRun: (...args: Parameters<HeartbeatMonitor["stopRun"]>) => heartbeatMonitorImpl!.stopRun(...args),
      },
      pluginStore,
      pluginLoader,
      pluginRunner: pluginLoader,
      ensureBundledPluginInstalled: ensureBundledPluginInstalledCallback,
      onProjectRegistered: ({ path }) => {
        maybeInstallClaudeSkillForNewProject(path);
      },
      onApiKeySaved: async (providerId: string) => {
        if (providerId !== "opencode" && providerId !== "opencode-go") {
          return undefined;
        }
        return await handleOpencodeGoApiKeySaved(
          dashboardAuthStorage,
          store,
          modelRegistry,
          (scope, message) => logSink.log(message, scope),
        );
      },
      getClaudeCliExtensionStatus: () => {
        const r = getCachedClaudeCliResolution();
        if (!r) return null;
        if (r.status === "ok") {
          return { status: "ok", path: r.path, packageVersion: r.packageVersion };
        }
        if (r.status === "not-installed") {
          return { status: "not-installed" };
        }
        return { status: r.status, reason: r.reason };
      },
      getDroidCliExtensionStatus: () => {
        const r = getCachedDroidCliResolution();
        if (!r) return null;
        if (r.status === "ok") {
          return { status: "ok", path: r.path, packageVersion: r.packageVersion };
        }
        if (r.status === "not-installed") {
          return { status: "not-installed" };
        }
        return { status: r.status, reason: r.reason };
      },
      getLlamaCppExtensionStatus: () => {
        const r = getCachedLlamaCppResolution();
        if (!r) return null;
        if (r.status === "ok") {
          return { status: "ok", path: r.path, packageVersion: r.packageVersion };
        }
        if (r.status === "not-installed") {
          return { status: "not-installed" };
        }
        return { status: r.status, reason: r.reason };
      },
      onUseClaudeCliToggled: (_prev, next) => {
        if (!next) return;
        void (async () => {
          try {
            if (!centralCoreForMesh) return;
            const projects = await centralCoreForMesh.listProjects();
            ensureClaudeSkillsForAllProjectsOnStartup(
              projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
            );
          } catch (err) {
            logSink.log(
              `Claude skill backfill on toggle failed: ${err instanceof Error ? err.message : String(err)}`,
              "engine",
            );
          }
        })();
      },
      onUseDroidCliToggled: (_prev, next) => {
        if (next) {
          logSink.log("Droid CLI enabled — restart required for full effect", "extensions");
        }
      },
      skillsAdapter,
      https: loadTlsCredentialsFromEnv(),
      daemon: dashboardAuthToken ? { token: dashboardAuthToken } : undefined,
      noAuth: opts.noAuth,
      runtimeLogger,
      systemControl: systemControlForServer,
      systemLogs: systemLogsForServer,
    });
  }

  // UI-only mode: simplified shutdown handlers (no engine components)
  if (noEngine) {
    const devShutdown = async (signal: NodeJS.Signals) => {
      // Second signal (user mashing q/Ctrl+C because the first didn't exit) —
      // force an immediate exit rather than being swallowed by the guard.
      if (shutdownInProgress) process.exit(shutdownExitCode);
      shutdownInProgress = true;
      armHardExitWatchdog();

      // Log active handles at shutdown for diagnostics
      const handleTypes: Record<string, number> = {};
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handles = (process as any)._getActiveHandles?.() ?? [];
        for (const handle of handles) {
          const type = handle.constructor?.name ?? "unknown";
          handleTypes[type] = (handleTypes[type] ?? 0) + 1;
        }
        const handleSummary = Object.entries(handleTypes)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `${type}:${count}`)
          .join(", ");
        logSink.log(`active handles at shutdown: ${handleSummary}`, "dashboard");
      } catch {
        // Ignore errors getting handle types
      }

      await logShutdownDiagnostics(signal);
      dispose();
      stopDiagnosticInterval();
      if (triggerScheduler) triggerScheduler.stop();
      if (heartbeatMonitorImpl) heartbeatMonitorImpl.stop();

      // Tear down user-project dev-server children (and their process groups)
      // before exiting. process.exit below skips server.close()'s cleanup hook.
      await timeShutdownStep("stopAllDevServers", () => stopAllDevServers());

      // Stop peer exchange service
      if (peerExchangeService) {
        await timeShutdownStep("peerExchangeService.stop", () => peerExchangeService!.stop());
      }

      // Stop mDNS discovery and set local node offline
      if (centralCoreForMesh && localNodeIdForMesh) {
        await timeShutdownStep("mesh.stopDiscovery", () => {
          centralCoreForMesh!.stopDiscovery();
        });
        await timeShutdownStep("mesh.setNodeOffline", async () => {
          await centralCoreForMesh!.updateNode(localNodeIdForMesh!, { status: "offline" });
        });
      }

      if (centralCoreForMesh) {
        await timeShutdownStep("closeCentralCore", () =>
          closeCentralCoreBestEffort(centralCoreForMesh!, `dev shutdown (${signal})`),
        );
      }

      store.close();
      process.exit(shutdownExitCode);
    };
    // FNXC:SystemPanel 2026-07-12-11:00: System panel restart binding for
    // UI-only mode — same contract as the engine-mode shutdown above.
    requestSelfRestart = (reason: string) => {
      if (!systemControlForServer.supervised || shutdownInProgress || restartScheduled) return false;
      restartScheduled = true;
      logSink.log(`restart requested (${reason}) — shutting down for supervised respawn`, "dashboard");
      shutdownExitCode = FUSION_RESTART_EXIT_CODE;
      setTimeout(() => {
        void devShutdown("SIGTERM");
      }, 300);
      return true;
    };
    registerHandler(process, "SIGINT", () => void devShutdown("SIGINT"));
    registerHandler(process, "SIGTERM", () => void devShutdown("SIGTERM"));

    // Ignore SIGHUP so the dashboard survives SSH session disconnects
    registerHandler(process, "SIGHUP", () => {
      logSink.log("Received SIGHUP (terminal disconnected) — ignoring", "dashboard");
    });
  }

  // ── Event-loop lag tracer (debug aid) ──
  // Polls every 50ms and logs whenever the loop was blocked by >150ms since
  // the previous tick. Pinpoints which synchronous operation is hogging the
  // event loop during startup. Disabled unless FUSION_TRACE_EL_LAG is set
  // to a file path (writes to that file with raw timestamps so log output
  // doesn't pollute the analysis).
  if (process.env.FUSION_TRACE_EL_LAG) {
    const lagPath = process.env.FUSION_TRACE_EL_LAG;
    const fs = await import("node:fs");
    const lagStream = fs.createWriteStream(lagPath, { flags: "w" });
    const LAG_THRESHOLD_MS = 150;
    const POLL_MS = 50;
    const traceStart = performance.now();
    let last = traceStart;
    setInterval(() => {
      const now = performance.now();
      const delta = now - last - POLL_MS;
      last = now;
      if (delta > LAG_THRESHOLD_MS) {
        const tSinceStart = Math.round(now - traceStart);
        lagStream.write(`t+${tSinceStart}ms: blocked ${Math.round(delta)}ms\n`);
      }
    }, POLL_MS).unref();
  }

  const server = app.listen(selectedPort, selectedHost);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      server.listen(0, selectedHost);
    } else {
      logSink.error(`Failed to start server: ${err.message}`, "dashboard");
      process.exit(1);
    }
  });

  server.on("listening", async () => {
    const actualPort = (server.address() as AddressInfo).port;

    /*
    FNXC:CustomProviders 2026-06-30-00:00:
    Custom provider startup refresh probes user-configured endpoints and can wait on unreachable networks. Kick it off only after the HTTP server is listening so dashboard availability is not gated by per-provider /models timeouts; settings updates re-register refreshed models when the background write lands.
    */
    void refreshAllCustomProviderModels(store, (message) => logSink.log(message, "custom-providers")).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logSink.warn(`Failed to refresh custom provider models from global settings: ${message}`, "custom-providers");
    });

    if (actualPort !== selectedPort) {
      logSink.warn(`Port ${selectedPort} in use, using ${actualPort} instead`, "dashboard");
    }

    // ── mDNS discovery: broadcast presence and listen for other nodes ───────
    //
    // Advertises this node on the local network and discovers other Fusion nodes
    // without requiring manual configuration.
    //
    if (centralCoreForMesh) {
      try {
        await centralCoreForMesh.startDiscovery({
          broadcast: true,
          listen: true,
          serviceType: "_fusion._tcp",
          port: actualPort,
          staleTimeoutMs: 300_000,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSink.warn(`Failed to start mDNS discovery: ${message}`, "dashboard");
      }
    }

    // ── CentralCore: set local node online ─────────────────────────────────
    //
    // Find the local node and mark it as online now that we know the port.
    //
    if (centralCoreForMesh) {
      try {
        const nodes = await centralCoreForMesh.listNodes();
        const localNode = nodes.find((node) => node.type === "local");
        if (localNode) {
          localNodeIdForMesh = localNode.id;
          await centralCoreForMesh.updateNode(localNode.id, { status: "online" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSink.warn(`Failed to set local node online: ${message}`, "dashboard");
      }
    }

    // Compose the user-visible URL. When we're bound to a non-localhost
    // interface (LAN testing), surface the actual host so the URL is
    // usable from another device. Otherwise keep it as `localhost` for
    // the nicer click-to-open experience.
    const displayHost =
      selectedHost === "0.0.0.0" || selectedHost === "::" ? selectedHost : "localhost";
    const baseUrl = `http://${displayHost}:${actualPort}`;
    const tokenizedUrl = dashboardAuthToken
      ? `${baseUrl}/?token=${encodeURIComponent(dashboardAuthToken)}`
      : baseUrl;

    const updateMessage = formatUpdateMessage(await startupUpdateStatusPromise);

    // ── TTY Mode: Set system info on TUI ───────────────────────────────
    //
    // In TTY mode, we populate the TUI System panel instead of printing
    // the plain-text banner. The TUI provides navigation and real-time
    // log streaming.
    //
    if (isTTY && tui) {
      // Determine engine mode
      const settings = await store.getSettings();
      const engineMode = noEngine ? "no-engine" : settings.enginePaused ? "paused" : "active";
      const startupDurationMs = Date.now() - dashboardStartedAt;

      const systemInfo: SystemInfo = {
        host: displayHost,
        port: actualPort,
        baseUrl,
        authEnabled: Boolean(dashboardAuthToken),
        authToken: dashboardAuthToken,
        tokenizedUrl: dashboardAuthToken ? tokenizedUrl : undefined,
        engineMode,
        fileWatcher: true,
        startTimeMs: dashboardStartedAt,
        startupDurationMs,
      };
      tui.setSystemInfo(systemInfo);
      tui.setReady(true);
      tui.setSettings({
        maxConcurrent: settings.maxConcurrent ?? 1,
        maxWorktrees: settings.maxWorktrees ?? 2,
        autoMerge: settings.autoMerge ?? false,
        mergeStrategy: settings.mergeStrategy ?? "direct",
        pollIntervalMs: settings.pollIntervalMs ?? 60_000,
        enginePaused: settings.enginePaused ?? false,
        globalPause: settings.globalPause ?? false,
        remoteActiveProvider: (settings.remoteActiveProvider as "tailscale" | "cloudflare" | null) ?? null,
        remoteShortLivedEnabled: Boolean(settings.remoteShortLivedEnabled),
        remoteShortLivedTtlMs: Number(settings.remoteShortLivedTtlMs ?? 900_000),
      });

      // Hydrate the TUI memory guard from persisted global settings so the
      // user's previous toggle/threshold survives across dashboard restarts.
      try {
        const globalSettings = await store.getGlobalSettingsStore().getSettings();
        tui.hydrateVitestKillSettings({
          enabled: typeof globalSettings.vitestAutoKillEnabled === "boolean"
            ? globalSettings.vitestAutoKillEnabled
            : undefined,
          thresholdPct: typeof globalSettings.vitestKillThresholdPct === "number"
            ? globalSettings.vitestKillThresholdPct
            : undefined,
        });
      } catch {
        // Fall back to controller defaults if global settings can't be read.
      }

      // Populate initial stats
      const tasks = await store.listTasks({ slim: true, includeArchived: false });
      const counts = new Map<string, number>();
      for (const task of tasks) {
        counts.set(task.column, (counts.get(task.column) ?? 0) + 1);
      }
      const active = tasks.filter((task) =>
        task.column === "in-progress" || task.column === "in-review"
      ).length;
      const agents = await agentStore.listAgents();
      const agentStats = { idle: 0, active: 0, running: 0, error: 0 };
      for (const agent of agents) {
        const state = agent.state as keyof typeof agentStats;
        if (state in agentStats) {
          agentStats[state]++;
        }
      }
      tui.setTaskStats({
        total: tasks.length,
        byColumn: Object.fromEntries(counts),
        active,
        agents: agentStats,
      });

      // Wire interactive-mode data source. CentralCore is shared across
      // dev/non-dev branches via centralCoreForMesh. Per-project TaskStores
      // are cached so repeated panel switches don't re-init SQLite.
      if (centralCoreForMesh) {
        const centralCore = centralCoreForMesh;
        const buildAuthHeaders = (): Record<string, string> => {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (dashboardAuthToken) {
            headers.Authorization = `Bearer ${dashboardAuthToken}`;
          }
          return headers;
        };
        tui.setInteractiveData({
          listProjects: async () => {
            const projects = await centralCore.listProjects();
            return projects.map((p) => ({ id: p.id, name: p.name, path: p.path }));
          },
          listTasks: async (projectPath: string) => {
            const projectStore = await getProjectStore(projectPath);
            const tasks = await projectStore.listTasks({ slim: true, includeArchived: false });
            // U11 (R18): when the workflow-columns flag is ON, enrich each task
            // with its resolved column display name + trait flags so the
            // flag-blind TUI can map non-legacy columns into its buckets (or the
            // read-only "other" bucket) instead of silently dropping them. The
            // IR cache keeps this O(workflows) rather than O(tasks) DB reads.
            const settings = await projectStore.getSettings();
            const flagOn = isWorkflowColumnsEnabled(settings);
            const workflowIrCache = new Map<string | undefined, WorkflowIrColumn[] | null>();
            return Promise.all(
              tasks.map(async (t) => {
                const info = await resolveTaskColumnInfo(projectStore, flagOn, workflowIrCache, t);
                return {
                  id: t.id,
                  title: t.title,
                  description: t.description ?? "",
                  column: t.column,
                  agentState: (t as { agentState?: string }).agentState,
                  ...(info.columnName !== undefined ? { columnName: info.columnName } : {}),
                  ...(info.columnFlags !== undefined ? { columnFlags: info.columnFlags } : {}),
                };
              }),
            );
          },
          createTask: async (projectPath: string, input: { title: string; description?: string }) => {
            const projectStore = await getProjectStore(projectPath);
            const created = await projectStore.createTask({
              title: input.title,
              description: input.description ?? input.title,
            });
            return {
              id: created.id,
              title: created.title,
              description: created.description ?? "",
              column: created.column,
              agentState: (created as { agentState?: string }).agentState,
            };
          },
          listAgents: async () => {
            const list = await agentStore!.listAgents();
            return list.map((a) => ({
              id: a.id,
              name: a.name,
              state: a.state,
              role: a.role,
              taskId: a.taskId,
              lastHeartbeatAt: a.lastHeartbeatAt,
            }));
          },
          getAgentDetail: async (id: string) => {
            const d = await agentStore!.getAgentDetail(id, 10);
            if (!d) return null;
            return {
              id: d.id,
              name: d.name,
              state: d.state,
              role: d.role,
              taskId: d.taskId,
              lastHeartbeatAt: d.lastHeartbeatAt,
              title: d.title,
              capabilities: [d.role],
              recentRuns: d.completedRuns.slice(0, 10).map((r) => ({
                id: r.id,
                startedAt: r.startedAt,
                endedAt: r.endedAt,
                status: r.status,
                triggerDetail: r.triggerDetail,
                invocationSource: r.invocationSource,
                stdoutExcerpt: r.stdoutExcerpt,
                stderrExcerpt: r.stderrExcerpt,
                resultJson: r.resultJson,
              })),
            };
          },
          updateAgentState: async (id: string, state: string) => {
            await agentStore!.updateAgentState(id, state as Parameters<typeof agentStore.updateAgentState>[1]);
          },
          deleteAgent: async (id: string) => {
            await agentStore!.deleteAgent(id);
          },
          getSettings: async () => {
            const s = await store.getSettings();
            return {
              maxConcurrent: s.maxConcurrent ?? 1,
              maxWorktrees: s.maxWorktrees ?? 2,
              autoMerge: s.autoMerge ?? false,
              mergeStrategy: s.mergeStrategy ?? "direct",
              pollIntervalMs: s.pollIntervalMs ?? 60_000,
              enginePaused: s.enginePaused ?? false,
              globalPause: s.globalPause ?? false,
              remoteActiveProvider: (s.remoteActiveProvider as "tailscale" | "cloudflare" | null) ?? null,
              remoteShortLivedEnabled: Boolean(s.remoteShortLivedEnabled),
              remoteShortLivedTtlMs: Number(s.remoteShortLivedTtlMs ?? 900_000),
              remoteSettingsSnapshot: {
                activeProvider: (s.remoteActiveProvider as "tailscale" | "cloudflare" | null) ?? null,
                tailscaleEnabled: Boolean(s.remoteTailscaleEnabled),
                cloudflareEnabled: Boolean(s.remoteCloudflareEnabled),
                shortLivedEnabled: Boolean(s.remoteShortLivedEnabled),
                shortLivedTtlMs: Number(s.remoteShortLivedTtlMs ?? 900_000),
              },
            };
          },
          updateSettings: async (partial) => {
            // Map SettingsValues subset to the store's Settings type (avoid string->MergeStrategy mismatch).
            const mapped: Record<string, unknown> = {};
            if (partial.maxConcurrent !== undefined) mapped.maxConcurrent = partial.maxConcurrent;
            if (partial.maxWorktrees !== undefined) mapped.maxWorktrees = partial.maxWorktrees;
            if (partial.autoMerge !== undefined) mapped.autoMerge = partial.autoMerge;
            if (partial.mergeStrategy !== undefined) mapped.mergeStrategy = partial.mergeStrategy;
            if (partial.pollIntervalMs !== undefined) mapped.pollIntervalMs = partial.pollIntervalMs;
            if (partial.enginePaused !== undefined) mapped.enginePaused = partial.enginePaused;
            if (partial.globalPause !== undefined) mapped.globalPause = partial.globalPause;
            if (partial.remoteActiveProvider !== undefined) mapped.remoteActiveProvider = partial.remoteActiveProvider;
            if (partial.remoteShortLivedEnabled !== undefined) mapped.remoteShortLivedEnabled = partial.remoteShortLivedEnabled;
            if (partial.remoteShortLivedTtlMs !== undefined) mapped.remoteShortLivedTtlMs = partial.remoteShortLivedTtlMs;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await store.updateSettings(mapped as any);
          },
          listModels: () => {
            return modelRegistry.getAll().map((m) => ({
              id: m.id,
              name: m.name,
              provider: (m as { provider?: string }).provider ?? "unknown",
              contextWindow: m.contextWindow ?? 0,
            }));
          },
          remote: {
            getSettings: async () => {
              const response = await fetch(`${baseUrl}/api/remote/settings`, { headers: buildAuthHeaders() });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const message = payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error: unknown }).error)
                  : `Remote settings request failed: ${response.status}`;
                throw new Error(message);
              }
              const payload = await response.json();
              return {
                activeProvider: (payload?.settings?.remoteActiveProvider as "tailscale" | "cloudflare" | null) ?? null,
                tailscaleEnabled: Boolean(payload?.settings?.remoteTailscaleEnabled),
                cloudflareEnabled: Boolean(payload?.settings?.remoteCloudflareEnabled),
                shortLivedEnabled: Boolean(payload?.settings?.remoteShortLivedEnabled),
                shortLivedTtlMs: Number(payload?.settings?.remoteShortLivedTtlMs ?? 900_000),
              };
            },
            getStatus: async () => {
              const response = await fetch(`${baseUrl}/api/remote/status`, { headers: buildAuthHeaders() });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const message = payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error: unknown }).error)
                  : `Remote status request failed: ${response.status}`;
                throw new Error(message);
              }
              return await response.json();
            },
            activateProvider: async (provider: "tailscale" | "cloudflare") => {
              const response = await fetch(`${baseUrl}/api/remote/provider/activate`, {
                method: "POST",
                headers: buildAuthHeaders(),
                body: JSON.stringify({ provider }),
              });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const message = payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error: unknown }).error)
                  : `Remote provider activation failed: ${response.status}`;
                throw new Error(message);
              }
            },
            startTunnel: async () => {
              const response = await fetch(`${baseUrl}/api/remote/tunnel/start`, {
                method: "POST",
                headers: buildAuthHeaders(),
              });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const message = payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error: unknown }).error)
                  : `Remote start failed: ${response.status}`;
                throw new Error(message);
              }
            },
            stopTunnel: async () => {
              const response = await fetch(`${baseUrl}/api/remote/tunnel/stop`, {
                method: "POST",
                headers: buildAuthHeaders(),
              });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const message = payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error: unknown }).error)
                  : `Remote stop failed: ${response.status}`;
                throw new Error(message);
              }
            },
            regeneratePersistentToken: async () => {
              const response = await fetch(`${baseUrl}/api/remote/token/persistent/regenerate`, {
                method: "POST",
                headers: buildAuthHeaders(),
              });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const message = payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error: unknown }).error)
                  : `Persistent token regeneration failed: ${response.status}`;
                throw new Error(message);
              }
              const payload = await response.json();
              return {
                token: typeof payload?.token === "string" ? payload.token : undefined,
                maskedToken: typeof payload?.maskedToken === "string" ? payload.maskedToken : undefined,
                tokenType: "persistent" as const,
                expiresAt: null,
              };
            },
            generateShortLivedToken: async (ttlMs: number) => {
              const response = await fetch(`${baseUrl}/api/remote/token/short-lived/generate`, {
                method: "POST",
                headers: buildAuthHeaders(),
                body: JSON.stringify({ ttlMs }),
              });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const message = payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error: unknown }).error)
                  : `Short-lived token generation failed: ${response.status}`;
                throw new Error(message);
              }
              const payload = await response.json();
              return {
                token: typeof payload?.token === "string" ? payload.token : undefined,
                maskedToken: typeof payload?.maskedToken === "string" ? payload.maskedToken : undefined,
                tokenType: "short-lived" as const,
                expiresAt: typeof payload?.expiresAt === "string" ? payload.expiresAt : null,
              };
            },
            getRemoteUrl: async (tokenType: "persistent" | "short-lived", ttlMs?: number) => {
              const params = new URLSearchParams({ tokenType });
              if (typeof ttlMs === "number") params.set("ttlMs", String(ttlMs));
              const response = await fetch(`${baseUrl}/api/remote/url?${params.toString()}`, { headers: buildAuthHeaders() });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const message = payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error: unknown }).error)
                  : `Remote URL request failed: ${response.status}`;
                throw new Error(message);
              }
              return await response.json();
            },
            getQrPayload: async (tokenType: "persistent" | "short-lived", ttlMs?: number, format?: "text" | "terminal" | "image/svg") => {
              const params = new URLSearchParams({ tokenType });
              if (typeof ttlMs === "number") params.set("ttlMs", String(ttlMs));
              if (format) params.set("format", format);
              const response = await fetch(`${baseUrl}/api/remote/qr?${params.toString()}`, { headers: buildAuthHeaders() });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                const message = payload && typeof payload === "object" && "error" in payload
                  ? String((payload as { error: unknown }).error)
                  : `Remote QR request failed: ${response.status}`;
                throw new Error(message);
              }
              return await response.json();
            },
          },
          git: {
            getStatus: (projectPath: string) => buildGitStatus(projectPath),
            listCommits: (projectPath: string, limit?: number) => buildGitCommits(projectPath, limit),
            showCommit: (projectPath: string, sha: string) => buildGitCommitDetail(projectPath, sha),
            listBranches: (projectPath: string) => buildGitBranches(projectPath),
            listWorktrees: (projectPath: string) => buildGitWorktrees(projectPath),
            push: async (projectPath: string) => {
              try {
                const { stdout, stderr } = await execFileAsync("git", ["push"], { cwd: projectPath, maxBuffer: 4 * 1024 * 1024 });
                return { success: true, output: (stdout + stderr).trim() };
              } catch (err) {
                const msg = err instanceof Error ? (err as NodeJS.ErrnoException & { stderr?: string; stdout?: string }).stderr ?? err.message : String(err);
                return { success: false, output: msg.trim() };
              }
            },
            fetch: async (projectPath: string) => {
              try {
                const { stdout, stderr } = await execFileAsync("git", ["fetch"], { cwd: projectPath, maxBuffer: 4 * 1024 * 1024 });
                return { success: true, output: (stdout + stderr).trim() };
              } catch (err) {
                const msg = err instanceof Error ? (err as NodeJS.ErrnoException & { stderr?: string; stdout?: string }).stderr ?? err.message : String(err);
                return { success: false, output: msg.trim() };
              }
            },
          },
          files: {
            listDirectory: (projectPath: string, relativePath: string) =>
              buildFileListDirectory(projectPath, relativePath),
            readFile: (projectPath: string, relativePath: string) =>
              buildFileReadFile(projectPath, relativePath),
          },
          tasks: {
            getTaskDetail: async (projectPath: string, taskId: string): Promise<TaskDetailData | null> => {
              try {
                const projectStore = await getProjectStore(projectPath);
                // getTask loads full data: steps, log, branch, worktree.
                const t = await projectStore.getTask(taskId);
                // Map core StepStatus ("in-progress") → TUI status ("running").
                const steps: TUITaskStep[] = t.steps.map((s, idx) => ({
                  index: idx,
                  name: s.name,
                  status: s.status === "in-progress" ? "running" : (s.status as TUITaskStep["status"]),
                }));
                // Map task activity log entries (action + outcome text) → TUI log entries.
                // The core log has no severity level, so we emit them all as "info".
                const recentLogs: TUITaskLogEntry[] = t.log.slice(-200).map((entry) => ({
                  timestamp: entry.timestamp,
                  level: "info" as const,
                  text: entry.outcome ? `${entry.action} → ${entry.outcome}` : entry.action,
                  source: entry.runContext?.agentId ? "agent" : "executor",
                }));
                // Card-placed custom fields → read-only bracketed labels
                // (U13/KTD-14). Resolve the task's workflow IR, filter
                // card-placed field defs, and render any present values.
                // Best-effort: any resolution failure simply omits the chips.
                let customFields: Array<{ label: string; value: string }> | undefined;
                try {
                  const values = (t as { customFields?: Record<string, unknown> }).customFields;
                  if (values && Object.keys(values).length > 0) {
                    const selection = projectStore.getTaskWorkflowSelection(t.id);
                    const def = selection?.workflowId
                      ? await projectStore.getWorkflowDefinition(selection.workflowId)
                      : undefined;
                    const ir = def
                      ? (typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir)
                      : BUILTIN_CODING_WORKFLOW_IR;
                    const fields = ir.version === "v2" ? (ir.fields ?? []) : [];
                    const chips: Array<{ label: string; value: string }> = [];
                    for (const field of fields) {
                      if (field.render?.placement !== "card") continue;
                      const raw = values[field.id];
                      if (raw === undefined || raw === null || raw === "") continue;
                      const optLabel = (v: string): string =>
                        field.options?.find((o) => o.value === v)?.label ?? v;
                      let display: string;
                      if (field.type === "boolean") {
                        if (raw !== true) continue;
                        display = field.name;
                      } else if (field.type === "multi-enum" && Array.isArray(raw)) {
                        if (raw.length === 0) continue;
                        display = raw.map((v) => optLabel(String(v))).join(", ");
                      } else if (field.type === "enum") {
                        display = optLabel(String(raw));
                      } else {
                        display = String(raw);
                      }
                      chips.push({ label: field.name, value: display });
                    }
                    if (chips.length > 0) customFields = chips;
                  }
                } catch {
                  customFields = undefined;
                }
                return {
                  id: t.id,
                  title: t.title,
                  description: t.description ?? "",
                  column: t.column,
                  agentState: (t as { agentState?: string }).agentState,
                  branch: t.branch,
                  worktree: t.worktree,
                  currentStepIndex: t.currentStep,
                  steps,
                  recentLogs,
                  ...(customFields ? { customFields } : {}),
                };
              } catch {
                // Task not found (deleted/archived between selection and fetch).
                return null;
              }
            },
            subscribeTaskEvents: (
              projectPath: string,
              taskId: string,
              handler: (event: TaskEvent) => void,
            ): (() => void) => {
              // Subscribe to the project store's task:updated event; filter by taskId.
              // Steps + log both land via task:updated whenever the engine writes a task.
              let projectStorePromise: Promise<typeof store> | null = null;
              // Track the last log length so we only emit new entries as log:appended.
              let lastLogLength = 0;

              const listener = (task: { id: string; steps: Array<{ name: string; status: string }>; currentStep: number; log: Array<{ timestamp: string; action: string; outcome?: string; runContext?: { agentId?: string } }>; column: string; title?: string; description: string; branch?: string; worktree?: string }) => {
                if (task.id !== taskId) return;

                // Emit step:updated events for any step whose status differs.
                task.steps.forEach((s, idx) => {
                  const status = s.status === "in-progress" ? "running" : s.status as TUITaskStep["status"];
                  handler({
                    kind: "step:updated",
                    step: { index: idx, name: s.name, status },
                  });
                });

                // Emit log:appended for each new log entry appended since last event.
                const newEntries = task.log.slice(lastLogLength);
                lastLogLength = task.log.length;
                for (const entry of newEntries) {
                  handler({
                    kind: "log:appended",
                    entry: {
                      timestamp: entry.timestamp,
                      level: "info" as const,
                      text: entry.outcome ? `${entry.action} → ${entry.outcome}` : entry.action,
                      source: entry.runContext?.agentId ? "agent" : "executor",
                    },
                  });
                }
              };

              // Resolve the project store and attach the listener asynchronously.
              projectStorePromise = getProjectStore(projectPath).then((ps) => {
                ps.on("task:updated", listener as Parameters<typeof ps.on>[1]);
                return ps;
              }).catch(() => null as unknown as typeof store);

              return () => {
                // Detach the listener once the store resolves (or immediately if already resolved).
                void projectStorePromise?.then((ps) => {
                  if (ps) ps.off("task:updated", listener as Parameters<typeof ps.off>[1]);
                });
              };
            },
          },
        });
      }

      // Log startup messages to TUI
      tui.log(`Dashboard started at ${baseUrl}`);
      if (engineMode === "active") {
        tui.log("AI engine active");
      } else if (engineMode === "no-engine") {
        tui.log("AI engine disabled (--no-engine)");
      } else {
        tui.log("AI engine paused");
      }
      tui.log("File watcher active");
      if (updateMessage) {
        tui.log(updateMessage);
      }
    } else {
      // ── Non-TTY Mode: Print plain-text banner ───────────────────────────
      //
      // Preserve the original banner format for CI/automated workflows
      // and backward compatibility.
      //
      console.log();
      console.log(`  fn board`);
      console.log(`  ────────────────────────`);
      console.log(`  → ${baseUrl}`);
      if (dashboardAuthToken) {
        console.log(`  Auth:    bearer token required`);
        console.log(`  Token:   ${dashboardAuthToken}`);
        console.log(`  Open:    ${tokenizedUrl}`);
        console.log(`           (the browser stores the token so you only need to click once)`);
      } else {
        console.log(`  Auth:    disabled (--no-auth)`);
      }
      console.log();
      console.log(`  Tasks stored in .fusion/tasks/`);
      console.log(`  Merge:      AI-assisted (conflict resolution + commit messages)`);
      if (noEngine) {
        console.log(`  AI engine:  ✗ disabled (--no-engine)`);
      } else {
        console.log(`  AI engine:  ✓ active`);
        console.log(`    • planning: auto-planning tasks`);
        console.log(`    • scheduler: dependency-aware execution`);
        console.log(`    • cron: scheduled task execution`);
      }
      console.log(`  File watcher: ✓ active`);
      if (updateMessage) {
        console.log(`  ${updateMessage}`);
      }
      console.log(`  Press Ctrl+C to stop`);
      console.log();
    }
  });

  return { dispose };
}

// ── System Panel Support ─────────────────────────────────────────────────────

/*
FNXC:SystemPanel 2026-07-12-11:05:
"Rebuild & restart" in the dashboard System panel only makes sense when the
running CLI comes from a Fusion source checkout (where `pnpm build` /
scripts/*.mjs exist). Resolve the workspace root by walking up from this
module and requiring BOTH pnpm-workspace.yaml AND package.json name
"fusion-workspace" — the name guard prevents a globally-installed
@runfusion/fusion nested under some unrelated pnpm workspace from being
misdetected as a rebuildable checkout. Returns undefined for packaged
installs, which disables rebuild controls in the UI.
*/
export function resolveFusionSourceWorkspaceRoot(): string | undefined {
  try {
    let dir = pathResolve(fileURLToPath(import.meta.url), "..");
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
          return pkg?.name === "fusion-workspace" ? dir : undefined;
        } catch {
          return undefined;
        }
      }
      const parent = pathResolve(dir, "..");
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    // Best-effort detection only — never let it break startup.
  }
  return undefined;
}

// ── Supervised Dashboard Mode ────────────────────────────────────────────────

const SUPERVISE_MAX_RESTARTS = 3;
const SUPERVISE_BASE_DELAY_MS = 2_000;
const SUPERVISE_MAX_DELAY_MS = 16_000;
const SUPERVISE_STALE_RESET_MS = 60_000;

/** True when running inside a bun-compiled single-file `fn` binary. */
function isCompiledBinary(): boolean {
  const bun = (globalThis as { Bun?: { embeddedFiles?: unknown } }).Bun;
  return typeof bun !== "undefined" && Boolean(bun.embeddedFiles);
}

/*
FNXC:SystemPanel 2026-07-12-14:05:
How the supervisor respawns "itself", per install shape:
  - node script (npx / global npm install / `pnpm dev` source run): re-exec
    process.execPath with execArgv preserved (tsx loader flags under source
    runs) plus the argv[1] entry script.
  - bun-compiled packaged binary (`fn`/`fn.exe` from build:exe): the binary IS
    the program; argv[1] is Bun's virtual embedded path, so re-exec
    process.execPath alone.
Returns null when no respawn command can be determined (then supervision is
skipped and the dashboard runs unsupervised).
*/
export function resolveSupervisorRespawnCommand(): { command: string; args: string[] } | null {
  if (isCompiledBinary()) {
    return { command: process.execPath, args: [] };
  }
  const entryPoint = process.argv[1];
  if (!entryPoint) return null;
  return { command: process.execPath, args: [...process.execArgv, entryPoint] };
}

/*
FNXC:SystemPanel 2026-07-12-14:05:
Supervision decision for `fn dashboard` (and bare `fn`, which defaults to the
dashboard). Supervision is now the DEFAULT so every install shape — bare `fn`,
`fusion`, npx, packaged binary — supports the System panel's in-place restart
and gets crash recovery. Skipped when:
  - --no-supervise is passed (explicit opt-out; also the escape hatch for
    debugging the child directly),
  - FUSION_RESTART_SUPERVISED=1 (a supervising parent already exists — the
    supervisor's own child, or scripts/dev-with-memory.mjs under `pnpm dev` —
    so never nest supervisors),
  - an inspector flag is active (the debugger must attach to the real app
    process, and a respawned child would fight over the inspector port),
  - no respawn command can be resolved.
*/
export function shouldSuperviseDashboard(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): boolean {
  if (args.includes("--no-supervise")) return false;
  if (env.FUSION_RESTART_SUPERVISED === "1") return false;
  if (execArgv.some((arg) => arg.startsWith("--inspect"))) return false;
  return resolveSupervisorRespawnCommand() !== null;
}

/**
 * Run the dashboard under foreground process supervision with bounded restart
 * attempts and exponential backoff.
 *
 * FNXC:DashboardAvailability 2026-06-30-23:20:
 * Long-lived remote dashboard sessions need bounded crash recovery without
 * detaching from the operator terminal or terminating unrelated port listeners.
 *
 * Spawns the current CLI entry point as a child process (minus the --supervise
 * flag) and monitors for unexpected exits. If the child exits non-zero, the
 * supervisor restarts up to SUPERVISE_MAX_RESTARTS times with exponential
 * backoff. Clean exits (SIGINT/SIGTERM/exit 0) propagate without restart.
 *
 * FNXC:SystemPanel 2026-07-12-14:05:
 * The child is spawned ATTACHED (same foreground process group, stdio
 * inherited) — NOT via superviseSpawn's detached process group — because the
 * interactive TUI must own the terminal: a background-process-group child
 * reading a TTY gets SIGTTIN/SIGTTOU-stopped, which is why detached
 * supervision was headless-only. Attached means terminal Ctrl+C reaches the
 * child directly; when a child is alive the parent waits for its graceful exit
 * (and exits immediately on SIGINT during crash-backoff, when no child is alive
 * to receive Ctrl+C), and forwards direct SIGTERM kills to the child. A parent
 * signal latches `stopping` so an intentional shutdown never respawns. Exit code
 * FUSION_RESTART_EXIT_CODE is an operator-requested restart (System panel):
 * immediate respawn, no crash budget consumed.
 *
 * This does NOT use shell detachment wrappers, shell kill loops, or unbounded retries.
 * Port 4040 processes are never killed — the child binds its own port.
 */
export async function runDashboardSupervised(
  port: number,
  _opts: Parameters<typeof runDashboard>[1] = {},
): Promise<void> {
  // Reconstruct child args: same flags, minus the supervision flags.
  const childArgs = process.argv.slice(2).filter((a) => a !== "--supervise" && a !== "--no-supervise");
  // Ensure "dashboard" is present without duplicating it after global flags.
  if (!childArgs.includes("dashboard")) {
    const firstOptionIndex = childArgs.findIndex((arg) => arg.startsWith("-"));
    childArgs.splice(firstOptionIndex === -1 ? 0 : firstOptionIndex, 0, "dashboard");
  }

  const respawn = resolveSupervisorRespawnCommand();
  if (!respawn) {
    console.error("[dashboard:supervisor] cannot determine entry point for child process");
    process.exit(1);
  }

  let restartCount = 0;
  let lastExitTime = 0;
  const restartCommand = formatSupervisorRestartCommand(respawn.command, respawn.args, childArgs);

  let activeChild: ReturnType<typeof spawnAttached> | null = null;
  // `stopping` latches once the operator asks to quit so the restart loop never
  // respawns after an intentional shutdown, even if the child's post-signal
  // exit code is non-zero.
  let stopping = false;
  // Parent lifecycle: terminal Ctrl+C (SIGINT) already reaches the attached
  // child via the shared foreground process group, so when a child is alive the
  // parent just waits for its graceful exit. But during crash-backoff (or
  // between spawns) there is NO child to receive the terminal SIGINT, so Ctrl+C
  // would hang for up to the backoff window — exit immediately in that case.
  process.on("SIGINT", () => {
    stopping = true;
    if (!activeChild) process.exit(130);
  });
  // A direct SIGTERM to the parent (process managers, `kill`) is forwarded so
  // the child shuts down too, then the loop stops. During crash-backoff there
  // is no child to forward to and the loop is parked in a sleep, so exit
  // immediately rather than waiting out the backoff. If the parent dies
  // unexpectedly, best-effort kill the child on exit.
  process.on("SIGTERM", () => {
    stopping = true;
    if (!activeChild) process.exit(143);
    try {
      activeChild.child.kill("SIGTERM");
    } catch {
      // Child may already be gone.
    }
  });
  process.on("exit", () => {
    try {
      activeChild?.child.kill("SIGTERM");
    } catch {
      // Child may already be gone.
    }
  });

  while (true) {
    const attemptLabel = `${restartCount + 1}/${SUPERVISE_MAX_RESTARTS + 1}`;
    console.log(`[dashboard:supervisor] starting dashboard (attempt ${attemptLabel})`);

    try {
      activeChild = spawnAttached(respawn.command, [...respawn.args, ...childArgs]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[dashboard:supervisor] failed to spawn child: ${message}`);
      process.exit(1);
    }

    const exitResult = await activeChild.waitExit;
    activeChild = null;
    const exitCode = exitResult.code ?? 1;
    const exitSignal = exitResult.signal;

    // Operator asked to stop (SIGINT/SIGTERM to the parent) — never respawn,
    // regardless of the child's post-signal exit code.
    if (stopping) {
      return;
    }

    // Clean exit — propagate without restart
    if (exitSignal === "SIGINT" || exitSignal === "SIGTERM" || exitCode === 0) {
      return;
    }

    /*
    FNXC:SystemPanel 2026-07-12-10:50:
    Operator-requested restart (dashboard System panel). Respawn immediately
    and reset the crash budget — an intentional restart must never consume
    SUPERVISE_MAX_RESTARTS or incur crash backoff.
    */
    if (exitCode === FUSION_RESTART_EXIT_CODE) {
      console.log("[dashboard:supervisor] restart requested — restarting now");
      restartCount = 0;
      lastExitTime = 0;
      continue;
    }

    // Reset restart counter if the child ran for a long time
    const now = Date.now();
    if (now - lastExitTime > SUPERVISE_STALE_RESET_MS) {
      restartCount = 0;
    }
    lastExitTime = now;

    restartCount++;
    if (restartCount > SUPERVISE_MAX_RESTARTS) {
      console.error(
        `\n[dashboard:supervisor] dashboard exited unexpectedly ${SUPERVISE_MAX_RESTARTS + 1} times.\n` +
        `Giving up. If using Tailscale Serve, the remote URL will return 502\n` +
        `until the dashboard is restarted manually:\n\n` +
        `  ${restartCommand}\n\n` +
        `To check if a listener is still active:\n` +
        `  curl http://127.0.0.1:${port}/api/health\n`,
      );
      process.exit(1);
    }

    const delay = Math.min(
      SUPERVISE_BASE_DELAY_MS * Math.pow(2, restartCount - 1),
      SUPERVISE_MAX_DELAY_MS,
    );
    console.log(
      `[dashboard:supervisor] restarting in ${Math.round(delay / 1000)}s (attempt ${restartCount}/${SUPERVISE_MAX_RESTARTS})`,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

interface AttachedChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/*
FNXC:SystemPanel 2026-07-12-14:05:
Attached (non-detached) supervised spawn: the child shares the parent's
foreground process group so the interactive TUI keeps terminal ownership.
Deliberately NOT superviseSpawn (its detached process group is what made the
supervised TUI unusable on a TTY); parent-death cleanup is handled by the
supervisor's own exit/SIGTERM handlers.
*/
function spawnAttached(command: string, args: string[]): { child: ChildProcess; waitExit: Promise<AttachedChildExit> } {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, FUSION_RESTART_SUPERVISED: "1" },
  });
  const waitExit = new Promise<AttachedChildExit>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: 1, signal: null }));
  });
  return { child, waitExit };
}

function formatSupervisorRestartCommand(command: string, respawnArgs: readonly string[], childArgs: readonly string[]): string {
  return [command, ...respawnArgs, ...childArgs].map(quoteShellArg).join(" ");
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
