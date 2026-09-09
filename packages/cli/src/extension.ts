import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as fusionCore from "@fusion/core";
import {
  type TaskStore,
  createTaskStoreForBackend,
  drizzleSql,
  AgentStore,
  ReflectionStore,
  isEphemeralAgent,
  evaluateImplementationTaskBind,
  AGENT_VALID_TRANSITIONS,
  ApprovalRequestStore,
  COLUMNS,
  COLUMN_LABELS,
  buildAutoPauseClearPatch,
  buildManualRetryResetPatch,
  validateNodeOverrideChange,
  type Task,
  type ColumnId,
  type InsightCategory,
  type TaskPriority,
  type InsightStatus,
  type InsightRunStatus,
  type InsightRunTrigger,
  type Agent,
  type AgentCapability,
  type AgentUpdateInput,
  getTaskDuplicateLineage,
  resolveAgentProvisioningPolicy,
  TASK_PRIORITIES,
  MAX_TASK_LIST_TEXT_CHARS,
  MAX_TASK_MESSAGE_LENGTH,
  resolveSecretAccessPolicy,
  getProjectRootFromWorktree,
  resolveWorktreesDirLayout,
  resolveTaskGithubTracking,
  formatCurrentTaskLine,
  resolveFusionSessionPrincipal,
  isTaskExecutionSessionPrincipal,
  taskExecutionTaskCreationRefusalText,
  resolveEffectiveAgentPermissionPolicy,
  type FusionSessionPrincipal,
  type AgentPermissionPolicy,
  type ApprovalRequestActorSnapshot,
  type SecretScope,
  declaresAnyLifecycleTrait,
  resolveNodeOverrideLanes,
  resolveLifecycleColumns,
  resolveWorkflowIrForTaskWithProvenance,
  resolveWorkflowIrForTask,
  resolveReviewColumns,
} from "@fusion/core";
import {
  getGhErrorMessage,
  isGhAuthenticated,
  isGhAvailable,
  runGhJsonAsync,
} from "@fusion/core/gh-cli";
import {
  defaultGitOps,
  ExperimentFinalizeBranchExistsError,
  ExperimentFinalizeCherryPickConflictError,
  ExperimentFinalizeMergeBaseError,
  ExperimentFinalizeNoKeptRunsError,
  ExperimentFinalizePlanError,
  ExperimentFinalizeService,
  ExperimentFinalizeStateError,
  type FinalizePlanOverride,
  fetchWebContent,
  assertNoSecretPlaintext,
  emitGoalRetrievalAudit,
  createWorkflowAuthoringTools,
  workflowListParams,
  workflowGetParams,
  workflowValidateParams,
  workflowSelectParams,
  workflowCreateParams,
  workflowUpdateParams,
  workflowDeleteParams,
  workflowSettingsParams,
  traitListParams,
  isInReviewMissingWorktreeSessionStartFailure,
  normalizeAgentLogPaging,
  buildTaskAgentLogReadText,
  createAgentTask,
  evaluateAgentActionGate,
  resolveGateOutcome,
  resolveFeatureRepairTargets,
  reconcileMissionState,
} from "@fusion/engine";
import * as dashboard from "@fusion/dashboard";
import { resolve, relative, isAbsolute, sep, basename, extname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

// ── Helpers ────────────────────────────────────────────────────────

type TaskListClamp = (lines: string[], opts?: { maxChars?: number }) => string;
type TaskListFormatter = (
  lines: string[],
  opts?: { maxChars?: number; clamp?: TaskListClamp },
) => string;

type AgentDiagnosticLineInput = {
  state?: string;
  lastError?: string;
  pauseReason?: string;
  metadata?: Record<string, unknown> | null;
};

function truncateAgentDiagnosticText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function formatAgentErrorRecoveryLine(metadata: Record<string, unknown> | null | undefined): string | null {
  const heartbeatRaw = metadata?.heartbeatErrorRecovery;
  const heartbeat = heartbeatRaw && typeof heartbeatRaw === "object" ? heartbeatRaw as Record<string, unknown> : null;
  const heartbeatAttempts = typeof heartbeat?.consecutiveAttempts === "number" && Number.isFinite(heartbeat.consecutiveAttempts)
    ? Math.max(0, Math.floor(heartbeat.consecutiveAttempts))
    : undefined;

  const durableRaw = metadata?.durableErrorRecovery;
  const durable = durableRaw && typeof durableRaw === "object" ? durableRaw as Record<string, unknown> : null;
  const durableAttempts = typeof durable?.attempts === "number" && Number.isFinite(durable.attempts)
    ? Math.max(0, Math.floor(durable.attempts))
    : undefined;
  const attempts = Math.max(heartbeatAttempts ?? 0, durableAttempts ?? 0);
  const hasRecoveryMetadata = heartbeatAttempts !== undefined || durableAttempts !== undefined;
  if (!hasRecoveryMetadata) {
    return null;
  }

  const details: string[] = [`attempts ${attempts}`];
  if (durable?.exhausted === true) details.push("exhausted");
  if (typeof durable?.nextRetryAt === "string") details.push(`next ${durable.nextRetryAt}`);
  return `Error Recovery: ${details.join(", ")}`;
}

function appendAgentDiagnosticLines(parts: string[], agent: AgentDiagnosticLineInput, options: { compact: boolean }): void {
  const shouldShowStateDetails = !options.compact || agent.state === "error" || agent.state === "paused";
  if (!shouldShowStateDetails) {
    return;
  }

  if (agent.lastError) {
    const maxChars = options.compact ? 180 : 500;
    parts.push(`Last Error: ${truncateAgentDiagnosticText(agent.lastError, maxChars)}`);
  }
  if (agent.pauseReason) {
    parts.push(`Pause Reason: ${truncateAgentDiagnosticText(agent.pauseReason, 180)}`);
  }
  const recoveryLine = formatAgentErrorRecoveryLine(agent.metadata);
  if (recoveryLine) {
    parts.push(recoveryLine);
  }
}

export function inlineTaskListFallback(
  lines: string[],
  opts: { maxChars?: number } = {},
): string {
  /*
  FNXC:TaskListOutput 2026-06-18-03:20:
  FN-6629 requires stale-runtime fallback formatting to mirror the shared host-safe task-list budget; otherwise missing @fusion/core formatter exports can re-emit imageified column-filtered listings.
  */
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? MAX_TASK_LIST_TEXT_CHARS));
  try {
    const text = lines.join("\n");
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, Math.max(0, maxChars - 1)) + "…";
  } catch {
    return "";
  }
}

export function resolveTaskListFormatter(core: { formatTaskListText?: unknown }): TaskListFormatter {
  return typeof core.formatTaskListText === "function"
    ? (core.formatTaskListText as TaskListFormatter)
    : inlineTaskListFallback;
}


/** #1403: display a column's label, falling back to the raw id for
 *  workflow-defined custom columns that have no legacy label. */
function columnLabel(column: ColumnId): string {
  return (COLUMN_LABELS as Record<string, string>)[column] ?? column;
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/x-toml",
  ".csv": "text/csv",
  ".xml": "application/xml",
};

let warnedMissingProjectRootResolver = false;

type WorkspaceRootConfig = { settings?: { worktreesDir?: string; workspaceMode?: boolean } };
type WorkspaceReposConfig = { repos?: unknown };

/*
FNXC:WorkspaceWorktree 2026-08-20-01:46:
Extension sessions launched from grouped member checkouts must use a project root
provided by a forward-derived layout candidate. The hash-bearing group segment is
one-way, so parent trimming can select a non-project directory and is forbidden.
*/
function getKnownWorktreeCandidates(): Array<{ dir: string; projectRoot: string }> {
  const candidates: Array<{ dir: string; projectRoot: string }> = [];
  for (const projectRoot of knownProjectRoots) {
    try {
      const config = JSON.parse(readFileSync(join(projectRoot, ".fusion", "config.json"), "utf8")) as WorkspaceRootConfig;
      const settings = config.settings;
      candidates.push({ dir: resolveWorktreesDirLayout(projectRoot, settings), projectRoot });
      if (settings?.workspaceMode !== true) continue;
      const workspace = JSON.parse(readFileSync(join(projectRoot, ".fusion", "workspace.json"), "utf8")) as WorkspaceReposConfig;
      if (!Array.isArray(workspace.repos)) continue;
      for (const repoRelPath of workspace.repos) {
        if (typeof repoRelPath !== "string") continue;
        candidates.push({
          dir: resolveWorktreesDirLayout(projectRoot, settings, { workspaceRootDir: projectRoot, repoRelPath }),
          projectRoot,
        });
      }
    } catch {
      // A missing or malformed local config cannot prove a workspace root.
    }
  }
  return candidates;
}

function resolveProjectRoot(cwd: string): string {
  const worktreeProjectRoot = typeof getProjectRootFromWorktree === "function"
    ? getProjectRootFromWorktree(cwd, { worktreesDirCandidates: getKnownWorktreeCandidates() })
    : null;
  if (typeof getProjectRootFromWorktree !== "function" && !warnedMissingProjectRootResolver) {
    warnedMissingProjectRootResolver = true;
    console.warn("[fusion-extension] @fusion/core.getProjectRootFromWorktree is unavailable; using filesystem fallback resolution.");
  }
  if (worktreeProjectRoot && existsSync(join(worktreeProjectRoot, ".fusion"))) {
    return worktreeProjectRoot;
  }

  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".fusion"))) {
      return current;
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      return resolve(cwd);
    }
    current = parent;
  }
}

/*
FNXC:WorkspaceWorktree 2026-08-20-02:23:
Keep the production root-resolution route directly testable so a separately
loaded Pi extension proves it reads the host's shared known-project registry
for grouped workspace member checkouts instead of stopping at the member repo.
*/
export function __resolveProjectRootForTesting(cwd: string): string {
  return resolveProjectRoot(cwd);
}

/*
FNXC:PostgresCutover 2026-07-04-00:00:
The agent-tool store path must boot the PostgreSQL backend (embedded by default, or external via DATABASE_URL) instead of constructing a legacy SQLite TaskStore, whose runtime was removed under VAL-REMOVAL-005. Mirrors the fn serve boot path, which already routes through createTaskStoreForBackend. The boot result is cached per project root so the connection pool (and any embedded PostgreSQL process) is released deterministically in closeCachedStores.
*/
interface CachedStoreEntry {
  readonly store: TaskStore;
  /** Releases the connection pool and stops an embedded PostgreSQL process when one was started. Absent for test-injected stores. */
  readonly shutdown?: () => Promise<void>;
  /**
   * True when the entry was injected by tests (`__setCachedStoreForTesting`).
   * closeCachedStores removes it from the cache but does NOT close the store —
   * the owning test harness (shared PG fixture) controls that store's lifetime.
   */
  readonly external?: boolean;
}

/*
FNXC:ExtensionStoreRegistry 2026-07-16-15:20:
Agent-read tools loaded through Pi's additionalExtensionPaths can be evaluated as a different ESM module instance from the CLI host that called setHostTaskStore. Keep cache, inflight, and cooldown state in one process registry so fn_list_agents and fn_agent_show reuse the host pool instead of opening a second backend that can wedge on schema/pool contention for 30 seconds.
*/
interface ExtensionStoreState {
  readonly cache: Map<string, CachedStoreEntry>;
  readonly bootInflight: Map<string, Promise<TaskStore>>;
  readonly bootFailureCooldown: Map<string, { untilMs: number; error: string }>;
  readonly knownProjectRoots: Set<string>;
}

const extensionStoreStateKey = Symbol.for("@runfusion/fusion/extension-store-state");
const extensionStoreGlobal = globalThis as typeof globalThis & { [key: symbol]: ExtensionStoreState | undefined };
const extensionStoreState = extensionStoreGlobal[extensionStoreStateKey] ?? {
  cache: new Map<string, CachedStoreEntry>(),
  bootInflight: new Map<string, Promise<TaskStore>>(),
  bootFailureCooldown: new Map<string, { untilMs: number; error: string }>(),
  knownProjectRoots: new Set<string>(),
};
extensionStoreGlobal[extensionStoreStateKey] = extensionStoreState;

/** Cache stores per project root to avoid re-booting the backend on every tool call. */
const storeCache = extensionStoreState.cache;
/* FNXC:WorkspaceWorktree 2026-08-20-01:46: Keep grouped-layout candidates visible to Pi's separately evaluated extension module. */
const knownProjectRoots = extensionStoreState.knownProjectRoots;
/*
FNXC:MergeQueue 2026-07-15-11:08:
Concurrent first-call fn_* tools must share one boot promise. Without this, two parallel cache misses each call createTaskStoreForBackend and contend on fusion:schema-applier advisory locks / pool setup — the pattern behind wedged fn_task_show during AI merge.
*/
const storeBootInflight = extensionStoreState.bootInflight;
/*
FNXC:MergeQueue 2026-07-15-11:20:
After a hard boot failure, brief cooldown prevents stampede re-boots against a broken backend.
Timeout alone does not set cooldown — the orphan inflight may still succeed and populate storeCache.
*/
const storeBootFailureCooldown = extensionStoreState.bootFailureCooldown;
const BOOT_FAILURE_COOLDOWN_MS = 5_000;
/*
FNXC:MergeQueue 2026-07-15-11:08:
Propagate the active tool AbortSignal into getStore without rewriting every execute body. registerTool installs the signal here before invoking the real execute.
*/
const extensionToolSignal = new AsyncLocalStorage<AbortSignal | undefined>();
/** Hard ceiling for extension TaskStore boot (second backend open inside a live dashboard/engine process). */
const EXTENSION_STORE_BOOT_TIMEOUT_MS = 30_000;
/*
FNXC:MergeQueue 2026-07-15-11:15:
Default wall-clock budget for store/CRUD host-extension tools. Long-running tools use resolveExtensionToolTimeoutMs instead of this flat default (research wait, skills install, imports).
*/
const EXTENSION_TOOL_TIMEOUT_MS = 60_000;
const SKILLS_INSTALL_TIMEOUT_MS = 300_000;
const IMPORT_BROWSE_TIMEOUT_MS = 180_000;
const WEB_FETCH_TIMEOUT_MS = 90_000;
const TASK_PLAN_TIMEOUT_MS = 300_000;
const EXPERIMENT_FINALIZE_TIMEOUT_MS = 180_000;
const MISSION_BACKFILL_TIMEOUT_MS = 180_000;
/*
FNXC:MergeQueue 2026-07-15-11:40:
Hard ceiling for import/browse batch size so agents cannot request unbounded GitHub/GitLab fan-out under the host extension.
*/
export const MAX_IMPORT_BROWSE_ITEMS = 50;

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
  );
}

/**
 * FNXC:MergeQueue 2026-07-15-11:20:
 * Per-tool outer budgets. Store tools stay at 60s; intentional multi-minute tools get higher ceilings.
 * FNXC:MergeQueue 2026-07-15-11:28:
 * Host extension no longer registers fn_research_* (engine injects createResearchTools when experimental research is on), so research wait budgets are not needed here.
 *
 * @internal Exported for unit tests.
 */
export function resolveExtensionToolTimeoutMs(toolName: string, _params?: unknown): number {
  const name = toolName.trim();
  if (name === "fn_skills_install") return SKILLS_INSTALL_TIMEOUT_MS;
  if (name === "fn_task_plan") return TASK_PLAN_TIMEOUT_MS;
  if (name === "fn_experiment_finalize") return EXPERIMENT_FINALIZE_TIMEOUT_MS;
  if (name === "fn_mission_backfill_assertions") return MISSION_BACKFILL_TIMEOUT_MS;
  if (name.startsWith("fn_task_import_") || name.startsWith("fn_task_browse_")) return IMPORT_BROWSE_TIMEOUT_MS;
  if (name === "fn_web_fetch") return WEB_FETCH_TIMEOUT_MS;
  return EXTENSION_TOOL_TIMEOUT_MS;
}

/** Clamp import/browse limits so host tools cannot request unbounded remote fan-out. */
export function clampImportBrowseLimit(limit: number | undefined, defaultLimit = 30): number {
  const raw = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : defaultLimit;
  return Math.min(MAX_IMPORT_BROWSE_ITEMS, Math.max(1, raw));
}

/**
 * Race a promise against a wall-clock timeout and optional AbortSignal.
 * Does not cancel the underlying work (Node has no structured cancel for store boot),
 * but unblocks the tool caller so the agent session can fail closed instead of wedging forever.
 *
 * @internal Exported for unit tests of the hang-prevention budget.
 */
export async function raceWithTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException(`${label} aborted`, "AbortError");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let settled = false;
  try {
    return await new Promise<T>((resolve, reject) => {
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        fn();
      };
      // Late settlement after timeout/abort is no-op'd; the .then handlers keep the promise from becoming unhandledRejection.
      promise.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          settle(() =>
            reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          );
        }, timeoutMs);
        if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
          timer.unref();
        }
      }
      if (signal) {
        onAbort = () => settle(() => reject(new DOMException(`${label} aborted`, "AbortError")));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * FNXC:MergeQueue 2026-07-15-11:15:
 * Wrap every extension tool execute with timeout + AbortSignal so a wedged store call cannot park the agent forever (FN-7956 fn_task_show hang).
 * Errors become isError tool results so the model can continue rather than leaving the turn blocked on an open tool call.
 * FNXC:MergeQueue 2026-07-15-11:20: Timeout budget is per-tool (resolveExtensionToolTimeoutMs) unless an explicit timeoutMs is passed.
 * FNXC:MergeQueue 2026-07-15-11:50:
 * On timeout, abort a linked AbortController so tools that honor signal (e.g. fn_skills_install npx) actually stop work instead of racing forever after the wrap rejects.
 */
export function wrapExtensionToolExecute<TArgs extends unknown[], TResult>(
  toolName: string,
  execute: (...args: TArgs) => TResult | Promise<TResult>,
  timeoutMs?: number,
): (...args: TArgs) => Promise<TResult | {
  content: Array<{ type: "text"; text: string }>;
  details: { error: string };
  isError: true;
}> {
  return async (...args: TArgs) => {
    // ExtensionAPI execute signature: (toolCallId, params, signal?, onUpdate?, ctx?)
    const parentSignal = (args[2] instanceof AbortSignal ? args[2] : undefined) as AbortSignal | undefined;
    const params = args[1];
    const budgetMs =
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : resolveExtensionToolTimeoutMs(toolName, params);

    const controller = new AbortController();
    const onParentAbort = (): void => {
      controller.abort();
    };
    if (parentSignal?.aborted) {
      controller.abort();
    } else {
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    }

    const invokeArgs = [...args] as unknown as unknown[];
    while (invokeArgs.length < 2) invokeArgs.push(undefined);
    if (invokeArgs.length === 2) {
      invokeArgs.push(controller.signal);
    } else {
      invokeArgs[2] = controller.signal;
    }

    try {
      return await extensionToolSignal.run(controller.signal, () =>
        raceWithTimeoutAndAbort(
          Promise.resolve(execute(...(invokeArgs as TArgs))),
          budgetMs,
          controller.signal,
          toolName,
        ),
      );
    } catch (error) {
      // Ensure nested work observing the tool signal stops on budget expiry (not only on parent abort).
      if (!controller.signal.aborted) {
        controller.abort();
      }
      if (isAbortError(error)) {
        console.warn(`[fusion-extension] ${toolName} aborted`);
        return {
          content: [{ type: "text" as const, text: `${toolName} aborted.` }],
          details: { error: "aborted" },
          isError: true as const,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out after \d+ms/.test(message)) {
        console.warn(`[fusion-extension] ${toolName}: ${message}`);
      } else {
        console.error(`[fusion-extension] ${toolName} failed: ${message}`);
      }
      return {
        content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }],
        details: { error: message },
        isError: true as const,
      };
    } finally {
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  };
}

/*
FNXC:MergeQueue 2026-07-15-11:40:
When dashboard/serve/daemon injects the live engine TaskStore via setHostTaskStore, getStore must never call createTaskStoreForBackend for that project root — dual-boot was the FN-7956 hang class (second pool + schema advisory lock). CLI one-shot sessions without a host store still boot a short-lived cache entry.
*/
let extensionStoreBootFactory: typeof createTaskStoreForBackend = createTaskStoreForBackend;

async function getStore(
  cwd: string,
  signal?: AbortSignal,
  bootTimeoutMs = EXTENSION_STORE_BOOT_TIMEOUT_MS,
): Promise<TaskStore> {
  const projectRoot = resolveProjectRoot(cwd);
  const existing = storeCache.get(projectRoot);
  if (existing) return existing.store;

  const cooldown = storeBootFailureCooldown.get(projectRoot);
  if (cooldown && Date.now() < cooldown.untilMs) {
    throw new Error(
      `fn extension TaskStore boot recently failed (cooldown ${BOOT_FAILURE_COOLDOWN_MS}ms): ${cooldown.error}`,
    );
  }

  const effectiveSignal = signal ?? extensionToolSignal.getStore();

  let inflight = storeBootInflight.get(projectRoot);
  if (!inflight) {
    /*
    FNXC:PostgresFinalCutover 2026-07-14-17:20: Agent tools cache only the
    PostgreSQL factory result; the removed SQLite opt-out is an explicit error.

    FNXC:MergeQueue 2026-07-15-11:08:
    First extension tool call without a host-injected store boots a TaskStore (CLI path).
    Bound that boot and coalesce concurrent callers so a wedged boot cannot park every fn_* tool forever.

    FNXC:MergeQueue 2026-07-15-11:20:
    Boot failure sets a short cooldown to avoid stampede re-boots. Tool timeout does not cancel the orphan boot; on success it still populates storeCache for later calls.
    */
    inflight = (async () => {
      try {
        const boot = await extensionStoreBootFactory({ rootDir: projectRoot });
        storeBootFailureCooldown.delete(projectRoot);
        // Do not overwrite a host-injected external store that landed while we were booting.
        const raced = storeCache.get(projectRoot);
        if (raced?.external) {
          await boot.shutdown().catch(() => undefined);
          return raced.store;
        }
        /* FNXC:TaskLifecycleTools 2026-08-15-06:35: Agent tools intentionally install the protective baseline with no force path; only a human CLI invocation can override live removal. */
        storeCache.set(projectRoot, { store: boot.taskStore, shutdown: boot.shutdown });
        return boot.taskStore;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        storeBootFailureCooldown.set(projectRoot, {
          untilMs: Date.now() + BOOT_FAILURE_COOLDOWN_MS,
          error: message,
        });
        throw error;
      } finally {
        storeBootInflight.delete(projectRoot);
      }
    })();
    // Keep a handler attached so timed-out waiters cannot leave an unhandledRejection when boot fails late.
    void inflight.catch(() => undefined);
    storeBootInflight.set(projectRoot, inflight);
  }

  try {
    return await raceWithTimeoutAndAbort(
      inflight,
      bootTimeoutMs,
      effectiveSignal,
      "fn extension TaskStore boot",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out after \d+ms/.test(message)) {
      /*
      FNXC:MergeQueue 2026-07-15-11:20:
      Timeout unblocks the tool turn only — the orphan createTaskStoreForBackend continues. Log so operators do not assume the dual-store boot stopped.
      */
      console.warn(
        `[fusion-extension] TaskStore boot still running after ${EXTENSION_STORE_BOOT_TIMEOUT_MS}ms ` +
          `(projectRoot=${projectRoot}); orphan boot continues and may populate the cache later`,
      );
    }
    throw error;
  }
}

/**
 * FNXC:MergeQueue 2026-07-15-11:40:
 * Publish the live engine/dashboard TaskStore into the host extension cache so in-process agent tools share one pool and never dual-boot embedded PostgreSQL.
 * The entry is external: closeCachedStores / clearHostTaskStores will not shut it down — the host owns lifecycle.
 */
export function setHostTaskStore(projectRoot: string, store: TaskStore): void {
  knownProjectRoots.add(resolve(projectRoot));
  // FNXC:TaskArchiveRemoval 2026-09-04-18:25: Host-injected stores are canonicalized before caching so every tool shares the already-initialized store and its one-time historical reintegration pass.
  const canonical = resolveProjectRoot(projectRoot);
  storeCache.set(canonical, { store, external: true });
  storeBootInflight.delete(canonical);
  storeBootFailureCooldown.delete(canonical);
}

/**
 * Remove host-injected store entries without closing them (host owns lifecycle).
 * Pass projectRoot to clear one project; omit to clear all external entries.
 * FNXC:MergeQueue 2026-07-15-11:50: Full clear only drops external entries and their boot metadata — never wipe inflight/cooldown for non-host CLI boots that may still be active in the same process.
 */
export function clearHostTaskStores(projectRoot?: string): void {
  if (projectRoot) {
    const canonical = resolveProjectRoot(projectRoot);
    const entry = storeCache.get(canonical);
    if (entry?.external) storeCache.delete(canonical);
    storeBootInflight.delete(canonical);
    storeBootFailureCooldown.delete(canonical);
    return;
  }
  for (const [key, entry] of [...storeCache.entries()]) {
    if (!entry.external) continue;
    storeCache.delete(key);
    storeBootInflight.delete(key);
    storeBootFailureCooldown.delete(key);
  }
}

/** @internal Test seam: read cached store for a project root after host injection / boot. */
export function __peekCachedStoreForTesting(projectRoot: string): TaskStore | undefined {
  return storeCache.get(resolveProjectRoot(projectRoot))?.store;
}

/**
 * @internal Test-only: clear inflight boot map and failure cooldown without closing cached stores.
 */
export function __clearExtensionStoreBootStateForTesting(): void {
  storeBootInflight.clear();
  storeBootFailureCooldown.clear();
  extensionStoreBootFactory = createTaskStoreForBackend;
}

/** @internal Test-only: control cold-cache boot without starting embedded PostgreSQL. */
export function __setExtensionStoreBootFactoryForTesting(factory?: typeof createTaskStoreForBackend): void {
  extensionStoreBootFactory = factory ?? createTaskStoreForBackend;
}

/** @internal Test-only: exercise the same cache/inflight resolution seam with a bounded test budget. */
export function __getStoreForTesting(cwd: string, bootTimeoutMs = EXTENSION_STORE_BOOT_TIMEOUT_MS): Promise<TaskStore> {
  return getStore(cwd, undefined, bootTimeoutMs);
}

/**
 * @internal Test-only: inject a pre-built store for a project root so tests share
 * one isolated PostgreSQL database with the agent tools without re-booting the
 * backend per tool call. The entry carries no shutdown hook; tests own the
 * injected store's lifecycle (the shared PG harness tears it down in afterAll).
 * An optional shutdown owner supports lifecycle tests that must prove the host
 * awaits an internally-owned factory result.
 */
export function __setCachedStoreForTesting(
  projectRoot: string,
  store: TaskStore,
  shutdown?: () => Promise<void>,
): void {
  storeCache.set(projectRoot, shutdown ? { store, shutdown } : { store, external: true });
}

/** @internal Exposed so tests and the extension shutdown hook can close cached stores deterministically; not a public CLI API contract. */
export async function closeCachedStores(): Promise<void> {
  /*
  FNXC:CliTests 2026-06-17-23:58: FN-6626 found the CLI extension cache cleared real TaskStore instances without closing them, leaving SQLite/WAL handles to survive module resets and making canonical-project-root task-tool tests timeout under suite load.
  FNXC:CliTests 2026-06-21-09:58: FN-6839 requires awaiting TaskStore.close() so deferred task-created filesystem work and SQLite/WAL handles drain before temp-root removal; do not appease this loaded-lane seam with timeouts, retries, or worker changes.
  */
  const entries = [...storeCache.values()];
  storeCache.clear();
  for (const entry of entries) {
    // Externally-owned (test-injected) entries are removed by the clear() above;
    // their owning harness controls the store's lifetime, so do not close them.
    if (entry.external) continue;
    try {
      if (entry.shutdown) {
        await entry.shutdown();
      } else {
        await entry.store.close();
      }
    } catch (error) {
      console.warn("[fusion-extension] cached TaskStore close skipped", error);
    }
  }
}

function getFusionDir(cwd: string): string {
  return join(resolveProjectRoot(cwd), ".fusion");
}
function requireProjectLayer(store: TaskStore, consumer: string) {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error(`${consumer} requires the project PostgreSQL AsyncDataLayer`);
  return layer;
}
/*
FNXC:PostgresCutover 2026-07-04-00:00:
Agent tools must construct AgentStore in backend mode so agent data lives in PostgreSQL, not the removed SQLite runtime (VAL-REMOVAL-005). The asyncLayer is borrowed from the project's cached TaskStore (same connection pool), mirroring the TaskStore backend injection. The returned store is NOT pre-initialized — callers keep their existing `await agentStore.init()` (idempotent mkdir in backend mode).
*/
async function getAgentStore(cwd: string): Promise<AgentStore> {
  const projectStore = await getStore(cwd);
  return new AgentStore({ rootDir: getFusionDir(cwd), asyncLayer: requireProjectLayer(projectStore, "CLI AgentStore") });
}

type ManagerEvaluationToolErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  details: Record<string, unknown>;
};

type ManagerEvaluationTargetResolution =
  | { kind: "error"; response: ManagerEvaluationToolErrorResult }
  | { kind: "allowed"; target: Agent; callerAgentId?: string };

/** Resolve and authorize a manager's evaluation target under the shared org-subtree boundary. */
async function resolveManagerEvaluationTarget(
  agentStore: AgentStore,
  agentId: string,
  ctx: ExtensionCallerContext,
): Promise<ManagerEvaluationTargetResolution> {
  const target = await agentStore.resolveAgent(agentId);
  if (!target) {
    return {
      kind: "error",
      response: {
        content: [{ type: "text" as const, text: `Agent '${agentId}' not found` }],
        isError: true as const,
        details: { outcome: "not_found", error: "Agent not found", agentId },
      },
    };
  }
  if (isEphemeralAgent(target)) {
    return {
      kind: "error",
      response: {
        content: [{ type: "text" as const, text: `ERROR: Cannot evaluate ephemeral/runtime agent ${target.id}` }],
        isError: true as const,
        details: { outcome: "invalid", field: "agent_id", agentId: target.id },
      },
    };
  }

  const callerAgentId = typeof ctx.agentId === "string" && ctx.agentId ? ctx.agentId : undefined;
  if (callerAgentId) {
    const chain = await agentStore.getChainOfCommand(target.id);
    const callerIndex = chain.findIndex((agent) => agent.id === callerAgentId);
    if (callerAgentId === target.id || callerIndex < 1) {
      return {
        kind: "error",
        response: {
          content: [{ type: "text" as const, text: "ERROR: You can only access evaluations for your own direct or indirect reports." }],
          isError: true as const,
          details: {
            outcome: "denied",
            agentId: target.id,
            callerAgentId,
            rule: "direct-or-indirect-reports-only",
          },
        },
      };
    }
  }

  return { kind: "allowed", target, callerAgentId };
}

function emitSecretAudit(
  store: TaskStore,
  ctx: { runId?: string; agentId?: string; taskId?: string },
  mutationType: string,
  target: string,
  metadata?: Record<string, unknown>,
): void {
  if (!ctx.runId || !ctx.agentId) return;
  try {
    assertNoSecretPlaintext(metadata);
    void store.recordRunAuditEvent({
      runId: ctx.runId,
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      domain: "filesystem",
      mutationType,
      target,
      metadata,
    });
  } catch (error) {
    console.warn("[fusion-extension] secret audit emission skipped", error);
  }
}

/**
 * FNXC:Secrets 2026-08-27-03:47:
 * Pi forwards tool `content` to the model but treats `details` as host-render metadata.
 * A policy-allowed read must therefore include its value here or it is audited but undelivered.
 * Keep details.value for host consumers; refusal and approval-pending returns remain plaintext-free.
 */
function formatRevealedSecretContent(confirmation: string, plaintextValue: string): string {
  const delivery = plaintextValue === ""
    ? "The stored secret value is empty."
    : `Secret value:\n${plaintextValue}`;
  return `${confirmation}\n${delivery}\nUse this value only for the immediate operation. Never write it to files, commits, logs, PR descriptions, or task documents.`;
}

/**
 * Validate an agent id supplied to task create/update tools.
 * Returns null on success, or an error message describing why the id was rejected.
 *
 * Rejects unknown agents and ephemeral/runtime-managed agents — mirrors fn_delegate
 * so callers can't park hallucinated or task-worker IDs in `task.assignedAgentId`.
 */
async function validateAssignableAgentId(
  cwd: string,
  agentId: string,
  task?: Pick<Task, "id" | "column"> | null,
  override = false,
): Promise<string | null> {
  const agentStore = await getAgentStore(cwd);
  await agentStore.init();
  const agent = await agentStore.getAgent(agentId);
  if (!agent) {
    return `Agent ${agentId} not found`;
  }
  if (isEphemeralAgent(agent)) {
    return `Cannot assign task to ephemeral/runtime agent ${agentId}`;
  }
  if (task) {
    // FNXC:AgentRouting 2026-07-12-12:30: issue #2015 — shared bind evaluator; override bypasses role only, never assignmentPolicy "none".
    const verdict = evaluateImplementationTaskBind(agent, task, {
      explicitRouting: true,
      executorRoleOverride: override,
    });
    if (!verdict.allowed) {
      return verdict.reason;
    }
  }
  return null;
}

/*
FNXC:EphemeralAgentTaskCreation 2026-07-01-00:00:
fn_task_create runs inside whatever agent loaded the pi extension. When the caller is an ephemeral/runtime task-worker (executor-FN-XXXX and friends), the project setting `ephemeralAgentsCanCreateTasks` decides whether it may open new tasks.
Human/dashboard/CLI callers have no `ctx.agentId`, so they are never gated here — the setting only constrains runtime-managed agents.

FNXC:EphemeralAgentTaskCreation 2026-07-26-06:20:
Lookup resolution is now fail-CLOSED (superseding the original fail-open rule stated here): a
runtime task-worker session carries a caller id, only a human/dashboard/CLI caller has none, so an
id that is PRESENT but does not resolve to an agent row (deleted ephemeral row, cross-project
store, transient read failure) is a runtime caller with unknown identity and is classified
ephemeral so the project policy still applies. An absent id keeps the human pass-through, and a
resolved permanent agent is still never gated.

FNXC:EphemeralAgentTaskCreation 2026-07-26-07:40:
KNOWN LIMITATION (superseded 2026-07-26, see below) — pi's `ExtensionContext` (pi-coding-agent,
core/extensions/types) carries no `agentId`; the read at the fn_task_create execute site is a
speculative cast, and only tests ever supply one. Without another identity signal every real call
short-circuited at `!callerAgentId` and passed through as a human caller.

FNXC:ToolPermissionGates 2026-07-26-13:55:
The identity signal now exists: the engine registers agent sessions by cwd in @fusion/core's
session-identity registry (resolveFusionSessionPrincipal). fn_task_create's ephemeral gate uses
the registry-resolved agentId as a fallback when ctx.agentId is absent (see
resolveExtensionCallerPrincipal below), so the Deny policy is enforceable for engine-spawned
sessions even though pi's ExtensionContext still carries no identity of its own. The fail-closed
lookup semantics above are unchanged: a caller id that is present but unresolvable is classified
ephemeral, an ambiguous registry entry is treated as an agent with unknown identity, and an
unregistered cwd remains a human operator CLI pass-through.
*/
async function isEphemeralCallerAgent(cwd: string, callerAgentId: string | undefined): Promise<boolean> {
  if (!callerAgentId) return false;
  try {

    const agentStore = await getAgentStore(cwd);
    await agentStore.init();
    const agent = await agentStore.resolveAgent(callerAgentId);
    if (!agent) return true;
    return isEphemeralAgent(agent);
  } catch {
    return true;
  }
}

// ── Caller principal + agent tool gates ────────────────────────────

/** Minimal caller-context shape read from the pi ExtensionContext (augmented fields are optional). */
type ExtensionCallerContext = {
  cwd?: string;
  agentId?: unknown;
  agentName?: unknown;
  taskId?: unknown;
  runId?: unknown;
};

/** Stand-in agent id when the principal is ambiguous (multiple live sessions in one cwd). */
const AMBIGUOUS_AGENT_PRINCIPAL_ID = "unknown-agent";

/**
 * FNXC:SecretsAccessApproval 2026-08-05-21:31:
 * Prompt-gated secret approvals must resolve one caller principal before every
 * lifecycle operation. Dashboard chat's pi tool context omits `agentId`, but
 * its engine-owned session registration proves the bound durable agent; treating
 * that omission as the operator makes the operator self-approval guard permanently
 * reject both decisions. Ambiguous cwd registrations deliberately fail closed:
 * this tool refuses to mint or redeem a grant rather than sharing an approval
 * between concurrent agents or collapsing either one into the operator.
 */
function resolveSecretAccessPrincipal(ctx: ExtensionCallerContext):
  | { kind: "resolved"; actor: ApprovalRequestActorSnapshot; agentId: string | null; agentName?: string; taskId?: string }
  | { kind: "ambiguous" } {
  const principal = resolveExtensionCallerPrincipal(ctx);
  if (principal.kind === "ambiguous") return { kind: "ambiguous" };
  if (principal.kind === "operator") {
    return {
      kind: "resolved",
      actor: { actorId: "user", actorType: "user", actorName: "CLI User" },
      agentId: null,
    };
  }
  return {
    kind: "resolved",
    actor: {
      actorId: principal.identity.agentId,
      actorType: "agent",
      actorName: principal.identity.agentName ?? principal.identity.agentId,
    },
    agentId: principal.identity.agentId,
    ...(principal.identity.agentName ? { agentName: principal.identity.agentName } : {}),
    ...(principal.identity.taskId ? { taskId: principal.identity.taskId } : {}),
  };
}

/*
FNXC:ToolPermissionGates 2026-07-26-13:55:
Security incident root cause: all fn_* host-extension tools are delivered to engine agent
sessions via pi's extension loader and NEVER pass through the engine's per-session gate
wrappers, so destructive tools (fn_task_delete etc.) ran ungated for agents — an agent
autonomously deleted a live task. The engine now registers agent sessions by cwd in
@fusion/core's session-identity registry; this resolver is the extension-side principal
channel. Precedence:
1. An explicit ctx.agentId (engine-augmented contexts and tests) is an agent principal.
2. Otherwise the registry decides: no registration = human operator CLI, exactly one live
   registration = that agent, multiple = ambiguous.
"ambiguous" MUST be treated as an agent with unknown identity (fail closed), never as an
operator. Operator (human CLI) behavior is unchanged by every gate built on this resolver.
*/
export function resolveExtensionCallerPrincipal(ctx: ExtensionCallerContext): FusionSessionPrincipal {
  const explicitAgentId =
    typeof ctx.agentId === "string" && ctx.agentId.trim().length > 0 ? ctx.agentId.trim() : undefined;
  if (explicitAgentId) {
    return {
      kind: "agent",
      identity: {
        agentId: explicitAgentId,
        ...(typeof ctx.agentName === "string" && ctx.agentName ? { agentName: ctx.agentName } : {}),
        ...(typeof ctx.taskId === "string" && ctx.taskId ? { taskId: ctx.taskId } : {}),
        registeredAt: Date.now(),
      },
    };
  }
  return resolveFusionSessionPrincipal(typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd());
}

/*
FNXC:ToolPermissionGates 2026-07-26-13:55:
INTENDED BEHAVIOR CHANGE for agents: these destructive/irreversible tools are hard-withheld
from agent and ambiguous principals at execute time, regardless of permission policy or
preset. Human operator CLI sessions (no registry entry, no ctx.agentId) are unaffected.
The guard runs FIRST in each tool's execute, before any store access or param validation.
*/
const WITHHELD_FROM_AGENT_EXTENSION_TOOLS: ReadonlySet<string> = new Set([
  "fn_task_delete",
  "fn_task_bypass_review",
  "fn_workflow_step_resume",
  "fn_mission_delete",
  "fn_mission_clear_blocked",
  "fn_milestone_delete",
  "fn_slice_delete",
  "fn_feature_delete",
  "fn_workflow_delete",
  "fn_experiment_finalize",
  "fn_skills_install",
]);

interface AgentGateDenyResult {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  details: Record<string, unknown>;
}

/**
 * FNXC:ToolPermissionGates 2026-07-26-14:40:
 * Dedupe-key lookup that works in PostgreSQL backend mode.
 * ApprovalRequestStore.findLatestByDedupeKey's backend branch parses the jsonb
 * `targetContext` (already an object from drizzle) through the string-only fromJson
 * helper, so it never matches and every retry minted a duplicate request. Until that
 * core defect is fixed, fall back to list() — whose backend row mapping returns the
 * parsed context verbatim — and match `context.approvalDedupeKey` newest-first, the
 * same contract chat.ts uses.
 */
async function findLatestApprovalRequestByDedupeKey(
  approvalStore: ApprovalRequestStore,
  input: { requesterActorId: string; taskId?: string; dedupeKey: string },
): Promise<Awaited<ReturnType<ApprovalRequestStore["findLatestByDedupeKey"]>>> {
  const direct = await approvalStore.findLatestByDedupeKey(input);
  if (direct) return direct;
  const rows = await approvalStore.list({ requesterActorId: input.requesterActorId, ...(input.taskId ? { taskId: input.taskId } : {}) });
  return (
    rows.find((row) => row.targetAction.context?.approvalDedupeKey === input.dedupeKey) ?? null
  );
}

/**
 * FNXC:TaskExecutionTaskCreation 2026-08-21-23:43:
 * FN-125 closes every host-extension route that can add a board card, not only
 * fn_task_create and fn_delegate_task. Pi injects this extension into coding sessions,
 * so duplicate, refine, imports, and planning share this execute-time fence.
 */
function denyTaskCreationForTaskExecutionPrincipal(
  toolName: string,
  ctx: ExtensionCallerContext,
): AgentGateDenyResult | null {
  /* FNXC:TaskExecutionTaskCreation 2026-08-21-23:16: explicit ctx.agentId
  synthesizes an identity without the execution marker, so inspect the registry too. */
  const resolved = resolveExtensionCallerPrincipal(ctx);
  const registry = resolveFusionSessionPrincipal(typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd());
  if (!isTaskExecutionSessionPrincipal(resolved) && !isTaskExecutionSessionPrincipal(registry)) return null;
  const agentId = resolved.kind === "agent" ? resolved.identity.agentId : undefined;
  const taskId = resolved.kind === "agent" ? resolved.identity.taskId : undefined;
  return {
    content: [{ type: "text", text: taskExecutionTaskCreationRefusalText(toolName) }],
    isError: true,
    details: { rule: "task-execution-cannot-create-tasks", tool: toolName, ...(taskId ? { taskId } : {}), ...(agentId ? { agentId } : {}) },
  };
}

function denyWithheldToolForAgentPrincipal(
  toolName: string,
  ctx: ExtensionCallerContext,
): AgentGateDenyResult | null {
  if (!WITHHELD_FROM_AGENT_EXTENSION_TOOLS.has(toolName)) return null;
  const principal = resolveExtensionCallerPrincipal(ctx);
  if (principal.kind === "operator") return null;
  const agentId = principal.kind === "agent" ? principal.identity.agentId : undefined;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${toolName} is withheld from agent sessions: this destructive operation is reserved for the human operator. ` +
          "Do not retry it; ask the operator to run it from the dashboard or CLI if it is genuinely needed.",
      },
    ],
    isError: true as const,
    details: {
      deniedFor: "agent-principal",
      tool: toolName,
      ...(agentId ? { agentId } : {}),
    },
  };
}

/*
FNXC:ToolPermissionGates 2026-07-26-13:55:
Policy gate for sensitive-but-policy-governed extension tools called by agent/ambiguous
principals. Resolves the caller's effective permission policy (agent row policy layered over
the project default; the shipped default preset is `unrestricted`) and evaluates the SAME
engine action gate used in engine lanes. Contract:
- Operator principals: never gated, behavior unchanged.
- disposition "allow" (the DEFAULT PRESET path): proceed friction-free — no approval row is
  ever created on this path.
- "block": structured deny.
- "require-approval": reuse the latest request for the dedupe key (pending → still waiting,
  denied → deny, approved → consume the grant via markCompleted and proceed once); otherwise
  mint one approval request with the agent's REAL requester snapshot.
- Ambiguous principals resolve the project default policy only (unknown agent, fail closed on
  identity but still policy-governed).
- Any resolution failure (store/asyncLayer unavailable, policy read error) fails CLOSED with a
  structured deny.
*/
async function applyAgentPolicyGateForExtensionTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ExtensionCallerContext,
): Promise<
  | AgentGateDenyResult
  | { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }
  | null
> {
  const principal = resolveExtensionCallerPrincipal(ctx);
  if (principal.kind === "operator") return null;
  const callerAgentId = principal.kind === "agent" ? principal.identity.agentId : undefined;
  const cwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
  const taskId = typeof ctx.taskId === "string" && ctx.taskId ? ctx.taskId : undefined;
  const runId = typeof ctx.runId === "string" && ctx.runId ? ctx.runId : undefined;

  try {
    const store = await getStore(cwd);
    const settings = await store.getSettings();

    let agentRow: { name?: string; permissionPolicy?: AgentPermissionPolicy } | null = null;
    if (callerAgentId) {
      try {
        const agentStore = await getAgentStore(cwd);
        await agentStore.init();
        agentRow = await agentStore.resolveAgent(callerAgentId);
      } catch {
        // Unknown/unreadable agent row: fall through to the project default policy (still an
        // agent principal — never an operator).
        agentRow = null;
      }
    }

    const policy = resolveEffectiveAgentPermissionPolicy(
      agentRow?.permissionPolicy,
      settings.defaultAgentPermissionPolicy,
    );
    const gateAgentId = callerAgentId ?? AMBIGUOUS_AGENT_PRINCIPAL_ID;
    let decision = evaluateAgentActionGate({
      agentId: gateAgentId,
      ...(taskId ? { taskId } : {}),
      toolName,
      args,
      permissionPolicy: policy,
    });
    if (decision.category === "exempt") {
      /*
      FNXC:ToolPermissionGates 2026-07-26-13:55:
      A policy-gated extension tool that the engine's static classification does not know
      (today: fn_agent_set_instructions) must not fall through the gate's exempt default to
      an unconditional allow. Treat it as task_agent_mutation, honoring exact toolRules first
      — under the default `unrestricted` preset this still resolves to "allow", so default
      agent behavior is unchanged.
      */
      const fallbackDisposition = policy.toolRules?.[toolName] ?? policy.rules.task_agent_mutation;
      decision = {
        ...decision,
        disposition: fallbackDisposition,
        category: "task_agent_mutation",
        resourceType: "agent",
      };
    }

    if (decision.disposition === "allow") {
      // DEFAULT PRESET PATH: friction-free, no approval row.
      return null;
    }

    if (decision.disposition === "block") {
      return {
        content: [
          {
            type: "text" as const,
            text: `${toolName} is blocked by this agent's permission policy (category ${decision.category}). Ask the operator to run it or adjust the agent's permission policy.`,
          },
        ],
        isError: true as const,
        details: {
          deniedFor: "agent-permission-policy",
          tool: toolName,
          disposition: "block",
          category: decision.category,
          ...(callerAgentId ? { agentId: callerAgentId } : {}),
        },
      };
    }

    // require-approval
    const layer = store.getAsyncLayer();
    if (!layer) {
      throw new Error("approval request store unavailable (no project async layer)");
    }
    const approvalStore = new ApprovalRequestStore(null, { asyncLayer: layer });
    const requester: ApprovalRequestActorSnapshot = {
      actorId: gateAgentId,
      actorType: "agent",
      actorName:
        agentRow?.name ??
        (principal.kind === "agent" ? principal.identity.agentName ?? gateAgentId : gateAgentId),
    };
    const latest = await findLatestApprovalRequestByDedupeKey(approvalStore, {
      requesterActorId: gateAgentId,
      ...(taskId ? { taskId } : {}),
      dedupeKey: decision.approvalDedupeKey,
    });
    const outcome = resolveGateOutcome(decision, latest ? { id: latest.id, status: latest.status } : null);

    if (outcome.outcome === "execute-once-then-complete" && outcome.approvalRequestId) {
      // Consume the operator's grant so it cannot be replayed; then proceed once.
      await approvalStore.markCompleted(outcome.approvalRequestId, {
        actor: requester,
        note: `Approval consumed by ${toolName}`,
        expectedRequesterActorId: gateAgentId,
      });
      return null;
    }

    if (outcome.outcome === "block") {
      return {
        content: [
          {
            type: "text" as const,
            text: `${toolName} was denied by the operator (approval request ${outcome.approvalRequestId ?? "unknown"}).`,
          },
        ],
        isError: true as const,
        details: {
          deniedFor: "agent-approval-denied",
          tool: toolName,
          ...(outcome.approvalRequestId ? { approvalRequestId: outcome.approvalRequestId } : {}),
          ...(callerAgentId ? { agentId: callerAgentId } : {}),
        },
      };
    }

    if (latest && latest.status === "pending") {
      return {
        content: [
          {
            type: "text" as const,
            text: `${toolName} requires operator approval. Request ${latest.id} is still pending — do not retry until it is decided.`,
          },
        ],
        details: {
          outcome: "pending_approval",
          approvalRequestId: latest.id,
          tool: toolName,
          ...(callerAgentId ? { agentId: callerAgentId } : {}),
        },
      };
    }

    const request = await approvalStore.create({
      requester,
      targetAction: {
        category: decision.category === "exempt" ? "task_agent_mutation" : decision.category,
        action: decision.operation,
        summary: decision.summary,
        resourceType: decision.resourceType,
        resourceId: decision.resourceId ?? "",
        context: {
          approvalDedupeKey: decision.approvalDedupeKey,
          toolName,
          toolArgs: args,
          source: "pi-extension-agent-gating",
        },
      },
      ...(taskId ? { taskId } : {}),
      ...(runId ? { runId } : {}),
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `${toolName} requires operator approval. Request ${request.id} created and pending — approve via POST /api/approvals/:id/decision.`,
        },
      ],
      details: {
        outcome: "pending_approval",
        approvalRequestId: request.id,
        tool: toolName,
        ...(callerAgentId ? { agentId: callerAgentId } : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `${toolName} denied: the agent permission policy could not be resolved (${message}). Failing closed — ask the operator to run this tool.`,
        },
      ],
      isError: true as const,
      details: {
        deniedFor: "agent-permission-policy-unavailable",
        tool: toolName,
        error: message,
        ...(callerAgentId ? { agentId: callerAgentId } : {}),
      },
    };
  }
}

function normalizeNullableStringInput(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "null") {
    return null;
  }

  return trimmed;
}

const INSIGHT_CATEGORIES: InsightCategory[] = [
  "quality",
  "performance",
  "architecture",
  "security",
  "reliability",
  "ux",
  "testability",
  "documentation",
  "dependency",
  "workflow",
  "other",
  "features",
  "competitive_analysis",
  "research",
  "trends",
];

const INSIGHT_STATUSES: InsightStatus[] = ["generated", "confirmed", "stale", "dismissed", "archived"];
const INSIGHT_RUN_STATUSES: InsightRunStatus[] = ["pending", "running", "completed", "failed", "cancelled"];
const INSIGHT_RUN_TRIGGERS: InsightRunTrigger[] = ["schedule", "manual", "task_completion", "merge_event", "api"];

function getTaskSourceAgentLabel(task: Pick<Task, "sourceMetadata" | "sourceAgentId">): string | undefined {
  const metadataAgentName = task.sourceMetadata?.agentName;
  if (typeof metadataAgentName === "string" && metadataAgentName.trim().length > 0) {
    return metadataAgentName.trim();
  }

  if (typeof task.sourceAgentId === "string" && task.sourceAgentId.trim().length > 0) {
    return task.sourceAgentId.trim();
  }

  return undefined;
}

function getTaskSourceLabel(task: Pick<Task, "sourceType" | "sourceMetadata" | "sourceAgentId" | "sourceParentTaskId">): string | undefined {
  switch (task.sourceType) {
    case "dashboard_ui":
      return "Dashboard";
    case "quick_chat":
      return "Quick Chat";
    case "chat_session":
      return "Chat Session";
    case "agent_heartbeat": {
      const sourceAgent = getTaskSourceAgentLabel(task);
      return sourceAgent ? `Agent (${sourceAgent})` : "Agent";
    }
    case "automation": {
      const sourceAgent = getTaskSourceAgentLabel(task);
      return sourceAgent ? `Automation (${sourceAgent})` : "Automation";
    }
    case "cron":
      return "Scheduled Task";
    case "workflow_step":
      return "Workflow Step";
    case "github_import": {
      const issueUrl = task.sourceMetadata?.issueUrl;
      return typeof issueUrl === "string" && issueUrl.length > 0
        ? `GitHub Import (${issueUrl})`
        : "GitHub Import";
    }
    case "research": {
      const findingLabel = task.sourceMetadata?.findingLabel;
      if (typeof findingLabel === "string" && findingLabel.length > 0) {
        return `Research (${findingLabel})`;
      }
      const runId = task.sourceMetadata?.runId;
      return typeof runId === "string" && runId.length > 0
        ? `Research (${runId})`
        : "Research";
    }
    case "task" + "_refine":
      return task.sourceParentTaskId ? `Refinement of ${task.sourceParentTaskId}` : "Refinement";
    case "task" + "_duplicate":
      return task.sourceParentTaskId ? `Duplicate of ${task.sourceParentTaskId}` : "Duplicate";
    case "cli":
      return "CLI";
    case "api":
      return "API";
    case "recovery":
      return "Recovery";
    default:
      return undefined;
  }
}

function formatDuplicateLineageLine(task: Task): string | null {
  const lineage = getTaskDuplicateLineage(task);
  return lineage.length > 0 ? `Duplicate of: ${lineage.join(", ")}` : null;
}

export function formatTaskLine(t: Task): string {
  const label =
    t.title || t.description.slice(0, 60) + (t.description.length > 60 ? "…" : "");
  const source = getTaskSourceLabel(t);
  const sourceSuffix = source ? ` [via: ${source}]` : "";
  const deps = t.dependencies.length ? ` [deps: ${t.dependencies.join(", ")}]` : "";
  /* Degraded synchronous formatter: live task listings exclude deleted/historical rows, and `done` is the
     built-in Complete fallback when no workflow metadata is available. */
  const isTerminalColumn = t.column === "done";
  const paused = t.paused && !isTerminalColumn ? " (paused)" : "";
  return `${t.id}  ${label}${sourceSuffix}${deps}${paused}`;
}

interface GitHubIssueApiResult {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels?: Array<{ name: string }>;
  pull_request?: unknown;
}

function ensureGhCliAuth(): void {
  if (!isGhAvailable() || !isGhAuthenticated()) {
    throw new Error("GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.");
  }
}

async function fetchGitHubIssuesViaGh(
  owner: string,
  repo: string,
  options: { limit?: number; labels?: string[]; signal?: AbortSignal } = {},
): Promise<GitHubIssueApiResult[]> {
  ensureGhCliAuth();

  const queryParams = new URLSearchParams();
  queryParams.append("state", "open");
  queryParams.append("per_page", String(Math.min(options.limit ?? 30, 100)));
  if (options.labels && options.labels.length > 0) {
    queryParams.append("labels", options.labels.join(","));
  }

  const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${queryParams.toString()}`;

  try {
    const issues = await runGhJsonAsync<GitHubIssueApiResult[]>(["api", path], { signal: options.signal });
    return issues.filter((issue) => !issue.pull_request);
  } catch (error) {
    throw new Error(getGhErrorMessage(error));
  }
}

async function resolveImportedIssueGithubTracking(store: TaskStore): Promise<{ enabled: true } | undefined> {
  const projectSettings = await store.getSettings();
  if (projectSettings.githubLinkImportedIssuesToTracking === true) {
    /*
    FNXC:GithubImportTracking 2026-07-01-00:00:
    Pi extension GitHub issue imports honor the import-only linking setting without enabling tracking for ordinary task tools. The created task keeps sourceIssue so the post-create hook links the imported issue instead of opening a duplicate tracking issue.
    */
    return { enabled: true };
  }

  const globalSettings = await store.getGlobalSettingsStore().getSettings();
  const resolvedTracking = resolveTaskGithubTracking(
    { githubTracking: undefined },
    projectSettings,
    globalSettings,
  );
  return resolvedTracking.enabled ? { enabled: true } : undefined;
}

async function fetchGitHubIssueViaGh(
  owner: string,
  repo: string,
  issueNumber: number,
  options: { signal?: AbortSignal } = {},
): Promise<GitHubIssueApiResult> {
  ensureGhCliAuth();

  const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;

  try {
    return await runGhJsonAsync<GitHubIssueApiResult>(["api", path], { signal: options.signal });
  } catch (error) {
    throw new Error(getGhErrorMessage(error));
  }
}

type EngineWorkflowToolName =
  | "fn_workflow_list"
  | "fn_workflow_get"
  | "fn_workflow_validate"
  | "fn_workflow_create"
  | "fn_workflow_update"
  | "fn_workflow_delete"
  | "fn_workflow_settings"
  | "fn_trait_list"
  | "fn_workflow_select";

const workflowExtensionToolSpecs: Array<{
  name: EngineWorkflowToolName;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: TSchema;
}> = [
  {
    name: "fn_workflow_list",
    label: "fn: List Workflows",
    description: "List built-in and custom Fusion workflow definitions available in this project.",
    promptSnippet: "List Fusion workflow definitions available in this project",
    promptGuidelines: ["Use before selecting or editing workflows to discover valid workflow IDs."],
    parameters: workflowListParams,
  },
  {
    name: "fn_workflow_get",
    label: "fn: Get Workflow",
    description: "Fetch a Fusion workflow definition by ID, including its resolved workflow IR.",
    promptSnippet: "Fetch a Fusion workflow definition by ID",
    promptGuidelines: ["Use after fn_workflow_list to inspect the current IR before updating a workflow."],
    parameters: workflowGetParams,
  },
  {
    name: "fn_workflow_validate",
    label: "fn: Validate Workflow",
    description: "Dry-run validate a Fusion workflow IR without creating or mutating any workflow.",
    promptSnippet: "Validate a Fusion workflow IR without persisting it",
    promptGuidelines: ["Use before create/update while iterating on custom workflow IR; validation failures are reported as dry-run results with no persistence."],
    parameters: workflowValidateParams,
  },
  {
    name: "fn_workflow_create",
    label: "fn: Create Workflow",
    description: "Create a custom Fusion workflow definition from a validated workflow IR.",
    promptSnippet: "Create a custom Fusion workflow definition",
    promptGuidelines: ["Use fn_trait_list first when choosing column traits for a new workflow IR."],
    parameters: workflowCreateParams,
  },
  {
    name: "fn_workflow_update",
    label: "fn: Update Workflow",
    description: "Update a custom Fusion workflow definition's metadata, IR, or layout.",
    promptSnippet: "Update a custom Fusion workflow definition",
    promptGuidelines: ["Fetch the existing workflow first and preserve intentional IR fields when editing."],
    parameters: workflowUpdateParams,
  },
  {
    name: "fn_workflow_delete",
    label: "fn: Delete Workflow",
    description: "Delete a custom Fusion workflow definition; built-in workflows are protected.",
    promptSnippet: "Delete a custom Fusion workflow definition",
    promptGuidelines: ["Only delete custom workflows; built-in workflows are protected."],
    parameters: workflowDeleteParams,
  },
  {
    name: "fn_workflow_settings",
    label: "fn: Workflow Settings",
    description: "Read or write per-project values for a workflow's declared settings.",
    promptSnippet: "Read or write per-project values for a workflow's declared settings",
    promptGuidelines: ["Use fn_workflow_get to inspect setting declarations before writing values."],
    parameters: workflowSettingsParams,
  },
  {
    name: "fn_trait_list",
    label: "fn: List Workflow Traits",
    description: "List column traits available when authoring Fusion workflow IR columns.",
    promptSnippet: "List column traits available for Fusion workflow authoring",
    promptGuidelines: ["Use when authoring or updating workflow IR column traits."],
    parameters: traitListParams,
  },
  {
    name: "fn_workflow_select",
    label: "fn: Select Task Workflow",
    description: "Assign a workflow definition to a task by workflow ID.",
    promptSnippet: "Assign a Fusion workflow to a task",
    promptGuidelines: ["Provide task_id unless the current agent context is already bound to the intended task."],
    parameters: workflowSelectParams,
  },
];

// ── Extension entry point ──────────────────────────────────────────

export default function kbExtension(pi: ExtensionAPI) {
  /*
  FNXC:MergeQueue 2026-07-15-11:15:
  Intercept every registerTool so all fn_* executes share one timeout/abort budget.
  Without this, only hand-wrapped tools fail closed; FN-7956 hung on an unwrapped secondary-store path during merge review.
  */
  const rawRegisterTool = pi.registerTool.bind(pi) as ExtensionAPI["registerTool"];
  pi.registerTool = ((tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") {
      return rawRegisterTool(tool);
    }
    const original = tool as { name?: string; execute: (...args: unknown[]) => unknown };
    return rawRegisterTool({
      ...tool,
      execute: wrapExtensionToolExecute(original.name ?? "fn_tool", original.execute as (...args: unknown[]) => unknown),
    } as Parameters<ExtensionAPI["registerTool"]>[0]);
  }) as ExtensionAPI["registerTool"];

  // Register GitHub tracking hook once per extension lifecycle so that
  // fn_task_create, fn_task_import_github*, fn_delegate_task, etc.
  // trigger tracking issue creation when settings enable it.
  try {
    dashboard.registerGithubTrackingHook?.();
  } catch {
    // Tests may provide partial @fusion/dashboard mocks without this export.
  }

  for (const spec of workflowExtensionToolSpecs) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      promptSnippet: spec.promptSnippet,
      promptGuidelines: spec.promptGuidelines,
      parameters: spec.parameters,
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        /*
        FNXC:WorkflowAuthoringTools 2026-06-29-22:20:
        The pi extension must expose the same workflow authoring surface agents get in engine lanes: list, get, create, update, delete, settings, trait vocabulary, and task selection when an ambient or explicit task target exists.
        Reuse engine factories per call so validation and store-side behavior stay centralized; the extension only adapts cwd/task context to ExtensionAPI.registerTool.

        FNXC:WorkflowAuthoringTools 2026-06-29-22:42:
        The published/pi extension is prompt-injectable rather than executor-owner controlled, so workflow create/update must strip approval-bypass flags before persistence. Only task executor owner paths may keep cliSkipApproval/autoApprove intact.

        FNXC:WorkflowAuthoringTools 2026-06-29-23:06:
        fn_workflow_select may default only in task-bound extension contexts; no-task published API calls must pass task_id explicitly so an empty ambient task cannot accidentally route the wrong card.

        FNXC:ToolPermissionGates 2026-07-26-13:55:
        fn_workflow_delete is hard-withheld from agent principals; fn_workflow_update is
        policy-gated per the caller agent's effective permission policy. Operator CLI calls
        are unaffected by both.
        */
        const withheldDenied = denyWithheldToolForAgentPrincipal(spec.name, ctx as ExtensionCallerContext);
        if (withheldDenied) return withheldDenied;
        if (spec.name === "fn_workflow_update") {
          const gated = await applyAgentPolicyGateForExtensionTool(
            spec.name,
            params as Record<string, unknown>,
            ctx as ExtensionCallerContext,
          );
          if (gated) return gated;
        }
        const store = await getStore(ctx.cwd);
        const extensionContext = ctx as typeof ctx & { taskId?: string };
        const currentTaskId = typeof extensionContext.taskId === "string" ? extensionContext.taskId : "";
        const workflowTools = createWorkflowAuthoringTools(store, currentTaskId, { stripApprovalFlags: true });
        const tool = workflowTools.find((candidate) => candidate.name === spec.name);
        if (!tool) {
          return {
            content: [{ type: "text" as const, text: `ERROR: Workflow tool '${spec.name}' is not available.` }],
            details: {},
            isError: true,
          };
        }
        if (spec.name === "fn_workflow_select" && !currentTaskId) {
          const explicitTaskId = typeof (params as { task_id?: unknown }).task_id === "string"
            ? (params as { task_id: string }).task_id.trim()
            : "";
          if (!explicitTaskId) {
            return {
              content: [{ type: "text" as const, text: "ERROR: task_id is required when fn_workflow_select is called outside a task-bound extension context." }],
              details: { error: "task_id_required" },
              isError: true,
            };
          }
        }
        return tool.execute(toolCallId, params as never, _signal, _onUpdate, ctx);
      },
    });
  }

  // ── fn_task_create ───────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_create",
    label: "fn: Create Task",
    description:
      "Create a new task on the Fusion task board. The task enters the planning column " +
      "where the AI planning agent will plan it into a full prompt with steps, " +
      "file scope, and acceptance criteria. Optionally pass workflow_id to select " +
      "a workflow at creation time; use fn_workflow_list to discover valid IDs.",
    promptSnippet: "Create a task on the Fusion AI-orchestrated task board",
    promptGuidelines: [
      "Use fn_task_create for task tracking — be descriptive so the planning agent can write a good plan.",
      "Include the problem AND desired outcome. For bugs, describe current vs expected behavior.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "What needs to be done — be descriptive" }),
      depends: Type.Optional(
        Type.Array(Type.String(), {
          description: "Task IDs this depends on (e.g. ['FN-001', 'FN-002'])",
        }),
      ),
      agentId: Type.Optional(
        Type.String({
          description: "Agent ID to assign this task to (e.g. 'agent-abc123')",
        }),
      ),
      priority: Type.Optional(
        StringEnum([...TASK_PRIORITIES], { description: "Task priority (low, normal, high, urgent)" }) as unknown as TSchema,
      ),
      workflow_id: Type.Optional(
        Type.String({
          description:
            "Workflow ID to select for the new task (e.g. 'WF-003' or 'builtin:coding'). " +
            "Omit to inherit the project default workflow. Use fn_workflow_list to discover valid IDs.",
        }),
      ),
      github_tracking: Type.Optional(
        Type.Boolean({
          description:
            "Per-task GitHub issue tracking override. true links a tracking issue to this task; " +
            "false disables tracking even when the project/global default enables it. " +
            "Omit to inherit the project/global default.",
        }),
      ),
      github_repo: Type.Optional(
        Type.String({
          description:
            "\"owner/repo\" override for the GitHub tracking issue's repository. " +
            "Omit to use the project/global default repo.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_task_create", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      const store = await getStore(ctx.cwd);

      /*
      FNXC:EphemeralAgentTaskCreation 2026-07-01-00:00:
      Gate ephemeral task-worker callers behind the project `ephemeralAgentsCanCreateTasks` toggle (default true). Only runtime-managed agents are affected; humans/CLI/dashboard calls carry no ctx.agentId and pass through.
      */
      const fnCtx = ctx as typeof ctx & { agentId?: string; taskId?: string };
      const projectSettingsForGate = await store.getSettings();
      /*
      FNXC:ToolPermissionGates 2026-07-26-13:55:
      Fall back to the session-identity registry when pi's context carries no agentId so the
      ephemeral-task-creation policy actually fires for engine-spawned sessions. An ambiguous
      principal uses a sentinel id that never resolves to an agent row, which the fail-closed
      lookup classifies as ephemeral.
      */
      const createPrincipal = resolveExtensionCallerPrincipal(ctx as ExtensionCallerContext);
      const registryAgentId =
        createPrincipal.kind === "agent"
          ? createPrincipal.identity.agentId
          : createPrincipal.kind === "ambiguous"
            ? AMBIGUOUS_AGENT_PRINCIPAL_ID
            : undefined;
      const callerIsEphemeral = await isEphemeralCallerAgent(ctx.cwd ?? process.cwd(), fnCtx.agentId ?? registryAgentId);
      if (callerIsEphemeral) {
        const policy = fusionCore.resolveEphemeralTaskCreationPolicy(projectSettingsForGate);
        if (policy === "deny") {
          const error = "Ephemeral task-worker agents are not allowed to create tasks (ephemeral agent task creation is denied for this project).";
          return { content: [{ type: "text", text: `ERROR: ${error}` }], isError: true, details: { error, rule: "ephemeral-agents-cannot-create-tasks", callerAgentId: fnCtx.agentId } };
        }
        if (policy === "upon_validation") {
          /*
          FNXC:EphemeralAgentTaskCreation 2026-07-30-19:10:
          Validation proposals must work for both durable backends. PostgreSQL uses
          the scoped async layer; legacy SQLite uses the TaskStore database so an
          ephemeral CLI caller is never denied merely because it is not backend-mode.
          */
          const layer = store.getAsyncLayer();
          const messageStore = layer
            ? new fusionCore.MessageStore(null, { asyncLayer: layer })
            : new fusionCore.MessageStore(store.getDatabase());
          const title = params.description.split(/\r?\n/, 1)[0]?.trim().slice(0, 80) || "Follow-up task";
          await messageStore.sendMessage({ fromId: fnCtx.agentId ?? "ephemeral-worker", fromType: "agent", toId: fusionCore.DASHBOARD_USER_ID, toType: "user", type: "agent-to-user", content: `Task proposal awaiting validation: ${title}`, metadata: { kind: "task-proposal", proposalStatus: "pending", proposalIdempotencyKey: randomUUID(), proposedTask: { title, description: params.description, priority: params.priority as TaskPriority | undefined, workflowId: params.workflow_id, dependencies: params.depends } } });
          return { content: [{ type: "text", text: "Task proposal submitted to the operator for validation; no task was created." }], details: { proposed: true } };
        }
      }

      const normalizedAgentId = normalizeNullableStringInput(params.agentId);

      if (normalizedAgentId !== undefined && normalizedAgentId !== null) {
        const candidateTask: Pick<Task, "id" | "column"> = { id: "<new>", column: "todo" };
        const error = await validateAssignableAgentId(ctx.cwd ?? process.cwd(), normalizedAgentId, candidateTask);
        if (error) {
          return {
            content: [{ type: "text", text: error }],
            isError: true,
            details: { error },
          };
        }
      }

      /*
      FNXC:GithubTracking 2026-08-15-03:50:
      Per-task GitHub tracking is decided at CREATE time (the lifecycle hooks key off the
      persisted `task.githubTracking.enabled === true` flag, never re-resolving defaults),
      so callers need a create-time override. `github_tracking`/`github_repo` feed the
      task-level slot of resolveTaskGithubTracking, which already gives task > project >
      global precedence. An explicit `false` is persisted (not dropped) so a later flip of
      the project default cannot retroactively enable tracking for this task.
      */
      const githubRepoOverride = params.github_repo?.trim() || undefined;
      if (githubRepoOverride && !fusionCore.isValidRepoSlug(githubRepoOverride)) {
        const error = `Invalid github_repo "${githubRepoOverride}" — expected "owner/repo".`;
        return { content: [{ type: "text", text: `ERROR: ${error}` }], isError: true, details: { error } };
      }

      try {
        const globalSettings = await store.getGlobalSettingsStore().getSettings();
        const resolvedTracking = resolveTaskGithubTracking(
          {
            githubTracking:
              params.github_tracking !== undefined || githubRepoOverride
                ? {
                    ...(params.github_tracking !== undefined ? { enabled: params.github_tracking } : {}),
                    ...(githubRepoOverride ? { repoOverride: githubRepoOverride } : {}),
                  }
                : undefined,
          },
          projectSettingsForGate,
          globalSettings,
        );
        /*
        FNXC:OriginWorkflowSelection 2026-07-26-19:40:
        Precedence for the new task's workflow: the caller's explicit `workflow_id`
        argument wins, then the project `taskCreateWorkflowId` setting (a pinned workflow,
        else the mirrored Board lane = the "Selected workflow" option), then `undefined`
        so createTask keeps its existing project-default path unchanged.
        Note the sibling fn_delegate_task tool deliberately does NOT consult this setting:
        the setting is scoped to task CREATION origins, not delegation.
        */
        const workflowId = params.workflow_id?.trim()
          || (await store.resolveOriginWorkflowOverrideId("task-create"));

        const { task, wasDuplicate } = await createAgentTask(store, {
          description: params.description.trim(),
          dependencies: params.depends,
          assignedAgentId: normalizedAgentId === null ? undefined : normalizedAgentId,
          priority: params.priority as TaskPriority | undefined,
          ...(workflowId ? { workflowId } : {}),
          source: { sourceType: "api", sourceAgentId: fnCtx.agentId, sourceParentTaskId: fnCtx.taskId },
          githubTracking: resolvedTracking.enabled
            ? {
                enabled: true,
                ...(resolvedTracking.repo
                  ? { repoOverride: `${resolvedTracking.repo.owner}/${resolvedTracking.repo.repo}` }
                  : {}),
              }
            : params.github_tracking === false
              ? { enabled: false }
              : undefined,
        }, { rootDir: ctx.cwd, sourceAgentId: fnCtx.agentId, sourceTaskId: fnCtx.taskId });

        const label =
          task.description.length > 80
            ? task.description.slice(0, 80) + "…"
            : task.description;

        /*
        FNXC:Workflows 2026-07-05-00:00:
        The response text must reflect the ACTUAL resolved landing column (task.column),
        not a hardcoded "triage" string. store.createTask already resolves intake correctly
        (this call never overrides `column`), so a custom workflow's non-triage intake
        column (e.g. "Inbox") must be echoed back to the caller instead of a fixed value
        that would misreport where the card actually landed.
        */
        return {
          content: [
            {
              type: "text",
              text:
                `${wasDuplicate ? "Linked existing" : "Created"} ${task.id}: ${label}${workflowId && !wasDuplicate ? ` (workflow: ${workflowId})` : ""}\n` +
                `Column: ${task.column}\n` +
                (task.dependencies.length
                  ? `Dependencies: ${task.dependencies.join(", ")}\n`
                  : "") +
                (task.assignedAgentId
                  ? `Assigned to: ${task.assignedAgentId}\n`
                  : "") +
                `Priority: ${task.priority}\n` +
                `Path: .fusion/tasks/${task.id}/`,
            },
          ],
          details: {
            taskId: task.id,
            wasDuplicate,
            column: task.column,
            dependencies: task.dependencies,
            assignedAgentId: task.assignedAgentId,
            priority: task.priority,
          },
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Task ID already exists:")) {
          return {
            content: [{ type: "text", text: `ERROR: ${error.message}` }],
            isError: true,
            details: { error: error.message },
          };
        }
        throw error;
      }
    },
  });

  // ── fn_task_update ────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_update",
    label: "fn: Update Task",
    description:
      "Update fields on an existing task. Supports modifying the title, " +
      "description, dependencies, assigned agent, priority, and workflow_id after task creation. " +
      "Set workflow_id to a workflow ID to select it, or null to clear the workflow selection.",
    promptSnippet: "Update fields on an existing Fusion task",
    promptGuidelines: [
      "Use fn_task_update to modify task title, description, dependencies, assigned agent, priority, or workflow_id after creation.",
      "Set workflow_id to null to clear a task's workflow selection and enabled workflow steps.",
      "At least one field must be provided to update.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. FN-001)" }),
      title: Type.Optional(Type.String({ description: "New task title" })),
      description: Type.Optional(Type.String({ description: "New task description" })),
      depends: Type.Optional(
        Type.Array(Type.String(), {
          description: "New dependency list — replaces existing dependencies (e.g. ['FN-001', 'FN-002'])",
        }),
      ),
      agentId: Type.Optional(
        Type.Union([
          Type.String(),
          Type.Null(),
        ], {
          description: "Agent ID to assign this task to, or null to clear (e.g. 'agent-abc123')",
        }),
      ),
      nodeId: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: "Node ID override for this task, or null to clear",
        }),
      ),
      priority: Type.Optional(
        StringEnum([...TASK_PRIORITIES], { description: "Task priority (low, normal, high, urgent)" }) as unknown as TSchema,
      ),
      workflow_id: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description:
            "Workflow ID to select for this task (e.g. 'WF-003' or 'builtin:coding'), " +
            "or null to clear the workflow selection and revert to the project default. " +
            "Use fn_workflow_list to discover valid IDs.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);

      // Validate task exists
      let task: Task;
      try {
        task = await store.getTask(params.id);
      } catch {
        return {
          content: [{ type: "text", text: `Task ${params.id} not found` }],
          isError: true,
          details: { error: "Task not found" },
        };
      }

      // Build update payload
      const updates: Record<string, unknown> = {};
      const updatedFields: string[] = [];

      if (params.title !== undefined) {
        updates.title = params.title.trim();
        updatedFields.push("title");
      }
      if (params.description !== undefined) {
        updates.description = params.description.trim();
        updatedFields.push("description");
      }
      if (params.depends !== undefined) {
        updates.dependencies = params.depends;
        updatedFields.push("dependencies");
      }
      if (params.agentId !== undefined) {
        const normalizedAgentId = normalizeNullableStringInput(params.agentId);
        if (typeof normalizedAgentId === "string") {
          const error = await validateAssignableAgentId(ctx.cwd ?? process.cwd(), normalizedAgentId, task);
          if (error) {
            return {
              content: [{ type: "text", text: error }],
              isError: true,
              details: { error },
            };
          }
        }
        updates.assignedAgentId = normalizedAgentId;
        updatedFields.push("agentId");
      }
      if (params.nodeId !== undefined) {
        /*
        FNXC:StateMachine 2026-07-07-12:00:
        Signature 2 (FN-7641 / NEXT-322 / NEXT-375 / NEXT-340): nodeId='end' after an
        out-of-band merge must never silently no-op here either. Pre-validate exactly like
        the dashboard route so the CLI tool returns an explicit isError instead of a "success"
        response that changed nothing when there is no durable merge proof. When proof exists,
        `store.updateTask` below performs the real finalize-to-done move (shared logic in
        TaskStore.updateTask / node-override-guard.ts), so this tool, the dashboard route, and
        store.updateTask all exhibit identical behavior.
        */
        const normalizedNodeId = normalizeNullableStringInput(params.nodeId);
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-12:20:
        Supply this task's resolved WIP and COMPLETE lanes — without them the guard does not fire.

        `validateNodeOverrideChange` defaults `wipColumns` to `{"in-progress"}`, so on a board whose
        WIP lane is named anything else `wipColumns.has(task.column)` is false and the mid-flight
        check passes. An operator could then change the node override on a RUNNING task, which is
        precisely what that guard exists to refuse (see its own note in node-override-guard.ts).

        The guard's options doc says "Both callers supply them" and assumes a CLI tool has no cheap
        IR access. Neither held here: this is a third caller, and it is an async handler that has
        already awaited `store.getTask`, so one more resolve is the same cost `resolveTaskLifecycleColumns`
        is already paid for elsewhere in this file (the linked-lineage label at ~1239).

        Passed as present-but-conditionally-valued rather than a conditional argument: an omitted
        set keeps the documented legacy default, and only this shape is visible to
        scripts/lib/lane-wiring-census.mjs, which matches an object-literal argument and cannot see a
        ternary. This site was a known-unwired entry in that gate's baseline.
        */
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-01:30:
        EVERY wip/complete lane, not the FIRST — and via the guard's own resolver, like its two other callers.

        #3019 wired this call with `resolveTaskLifecycleColumns(...).wip`, whose per-role accessor is
        `resolved.find(...)` (workflow-lifecycle-traits.ts:353) — the FIRST column carrying the trait.
        The guard's contract is every column: `resolveNodeOverrideLanes` builds its sets from
        `columnsWithFlag(ir, "countsTowardWip")`. On a board with a build lane beside a verify lane
        the two answers differ, and a task sitting in the SECOND wip lane slipped the mid-flight
        check — the exact defect #3019 set out to close, still open one lane over.

        Interchangeable on any single-wip-lane board, which is why it read as correct. Same arity trap
        #2975 removed from the surfacing family.

        `resolveNodeOverrideLanes` is what `task-update.ts` and `branch-and-pr-entities.ts` already
        call, so all three callers now resolve identically and the fallback lives in one place.
        */
        const overrideLanes = await resolveNodeOverrideLanes(store, task.id);
        /*
        Spelled as an object literal naming both keys, not `…, overrideLanes)`. The two are identical
        at runtime, but `scripts/lib/lane-wiring-census.mjs` matches an object-literal argument and
        cannot see through a variable — passing the resolved object directly reads to that gate as an
        UNWIRED call and turns it red. #3019's header records the same constraint, and it is what
        pushed that PR toward resolving the lanes inline; the constraint is real, the bespoke
        resolution it produced was not required by it.
        */
        const validation = validateNodeOverrideChange(task, normalizedNodeId ?? null, {
          wipColumns: overrideLanes.wipColumns,
          completeColumns: overrideLanes.completeColumns,
        });
        if (!validation.allowed) {
          return {
            content: [{ type: "text", text: validation.message ?? "Node override change blocked" }],
            isError: true,
            details: { error: validation.reason },
          };
        }
        updates.nodeId = normalizedNodeId;
        updatedFields.push("nodeId");
      }
      if (params.priority !== undefined) {
        updates.priority = params.priority;
        updatedFields.push("priority");
      }
      if (params.workflow_id !== undefined) {
        if (params.workflow_id === null) {
          await store.clearTaskWorkflowSelection(task.id);
          updatedFields.push("workflowId");
        } else {
          const workflowId = params.workflow_id.trim();
          if (workflowId.length > 0) {
            try {
              await store.selectTaskWorkflowAndReconcile(task.id, workflowId);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              /*
              FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2512 review):
              TRANSLATE the switch re-home failure here too. `fn_task_update` is a
              second switch consumer alongside `fn_task_set_workflow`, and a bare
              message string gives the caller no way to tell "nothing changed, retry
              after making room" from "the selection committed and the task is now
              INCONSISTENT" — which is exactly the distinction that decides whether it
              may treat the switch as done.
              */
              const typed = error as { name?: string; committed?: boolean; taskId?: string; workflowId?: string; fromColumn?: string; intendedColumn?: string };
              if (typed?.name === "WorkflowSwitchRehomeFailedError") {
                return {
                  content: [{ type: "text", text: `ERROR: ${message}` }],
                  isError: true,
                  details: {
                    code: "workflow-switch-rehome-failed",
                    taskId: typed.taskId,
                    workflowId: typed.workflowId,
                    fromColumn: typed.fromColumn,
                    intendedColumn: typed.intendedColumn,
                    selectionCommitted: typed.committed === true,
                  },
                };
              }
              return {
                content: [{ type: "text", text: `ERROR: ${message}` }],
                isError: true,
                details: { error: message },
              };
            }
            updatedFields.push("workflowId");
          }
        }
      }

      if (updatedFields.length === 0) {
        return {
          content: [{ type: "text", text: "No fields to update. Provide at least one of: title, description, depends, agentId, nodeId, priority, workflow_id." }],
          isError: true,
          details: { error: "No fields provided" },
        };
      }

      if (Object.keys(updates).length > 0) {
        await store.updateTask(params.id, updates);
      }

      return {
        content: [
          {
            type: "text",
            text: `Updated ${params.id}: ${updatedFields.join(", ")}`,
          },
        ],
        details: { taskId: params.id, updatedFields },
      };
    },
  });

  // ── fn_task_list ─────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_list",
    label: "fn: List Tasks",
    description: "List all tasks on the Fusion board, grouped by column.",
    promptSnippet: "List all tasks on the Fusion board grouped by column",
    parameters: Type.Object({
      column: Type.Optional(
        StringEnum([...COLUMNS] as unknown as string[], {
          description: "Filter to a specific column",
        }) as unknown as TSchema,
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max tasks to show per column (default: 10)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const tasks = await store.listTasks({ slim: true });

      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: "No tasks yet." }],
          details: { count: 0 },
        };
      }

      const perColumn = params.limit ?? 10;
      const requestedColumn = params.column as ColumnId | undefined;
      const lines: string[] = [];
      for (const col of COLUMNS) {
        if (requestedColumn && requestedColumn !== col) continue;

        const colTasks = tasks.filter((t) => t.column === col);
        if (colTasks.length === 0) continue;

        lines.push(`${COLUMN_LABELS[col]} (${colTasks.length}):`);
        const shown = colTasks.slice(0, perColumn);
        for (const t of shown) {
          lines.push(`  ${formatTaskLine(t)}`);
        }
        const hidden = colTasks.length - shown.length;
        if (hidden > 0) {
          lines.push(`  ... and ${hidden} more`);
        }
        lines.push("");
      }

      const emptyStateText = requestedColumn
        ? `No tasks in ${columnLabel(requestedColumn)} (${requestedColumn}).`
        : "No matching tasks.";

      /*
      FNXC:TaskListOutput 2026-06-16-17:47:
      FN-6492 routes CLI fn_task_list through the shared clamp so large column-filtered board reads remain text-only instead of being converted to host attachments.

      FNXC:TaskListOutput 2026-06-17-05:46:
      FN-6570 resolves the clamp from the runtime @fusion/core namespace and lets formatTaskListText fall back when stale dist/interoperability paths omit clampTaskListText, preventing heartbeat board reads from crashing.

      FNXC:TaskListOutput 2026-06-17-07:25:
      FN-6573 requires CLI fn_task_list to resolve formatTaskListText from the runtime @fusion/core namespace with a typeof guard and a self-contained bounded fallback. A stale @fusion/core dist missing the FN-6570 formatter export crashed ambient heartbeat agents as `(0 , _core.formatTaskListText) is not a function`; the tool must now return bounded text instead.

      FNXC:TaskListOutput 2026-06-18-04:46:
      FN-6630 refines FN-6492 by requiring filtered fn_task_list calls against empty target columns to return explicit empty-state text. Host runtimes can imageify empty content blocks as `(see attached image)`, so this call site must never emit empty or whitespace-only text.
      */
      const formatter = resolveTaskListFormatter(fusionCore);
      const text = lines.length === 0
        ? emptyStateText
        : formatter(lines, { clamp: fusionCore.clampTaskListText }).trimEnd();
      return {
        content: [{ type: "text", text: text.trim().length > 0 ? text : emptyStateText }],
        details: { count: tasks.length },
      };
    },
  });

  // ── fn_task_show ─────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_show",
    label: "fn: Show Task",
    description: "Show full details for a task including steps, progress, and log entries.",
    promptSnippet: "Show full details for a Fusion task",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. FN-001)" }),
    }),

    /*
    FNXC:MergeQueue 2026-07-15-11:15:
    Timeout/abort come from the extension-wide registerTool wrapper + getStore ALS signal.
    Keep this body lean; do not re-wrap (double budgets hide the real failure).
    */
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const task = await store.getTask(params.id);

      const lines: string[] = [];
      lines.push(`${task.id}: ${task.title || task.description}`);
      lines.push(
        `Column: ${columnLabel(task.column)}` +
          (task.size ? ` · Size: ${task.size}` : "") +
          (task.reviewLevel !== undefined ? ` · Review: ${task.reviewLevel}` : ""),
      );
      if (task.dependencies.length) {
        lines.push(`Dependencies: ${task.dependencies.join(", ")}`);
      }
      const sourceLabel = getTaskSourceLabel(task);
      if (sourceLabel) {
        lines.push(`Created via: ${sourceLabel}`);
      }
      const duplicateLineage = formatDuplicateLineageLine(task);
      if (duplicateLineage) {
        lines.push(duplicateLineage);
      }
      if (task.paused) lines.push("Status: PAUSED");
      lines.push("");

      // Steps
      if (task.steps.length > 0) {
        const done = task.steps.filter((s) => s.status === "done").length;
        lines.push(`Steps (${done}/${task.steps.length}):`);
        for (let i = 0; i < task.steps.length; i++) {
          const s = task.steps[i];
          const icon =
            s.status === "done"
              ? "✓"
              : s.status === "in-progress"
                ? "▸"
                : s.status === "skipped"
                  ? "–"
                  : " ";
          const marker =
            i === task.currentStep && s.status !== "done" ? " ◀" : "";
          lines.push(`  [${icon}] ${i}: ${s.name}${marker}`);
        }
        lines.push("");
      }

      // Prompt (truncated)
      if (task.prompt) {
        const promptPreview =
          task.prompt.length > 500
            ? task.prompt.slice(0, 500) + "\n... (truncated)"
            : task.prompt;
        lines.push("Prompt:");
        lines.push(promptPreview);
        lines.push("");
      }

      // Recent log
      if (task.log.length > 0) {
        const recent = task.log.slice(-5);
        lines.push(`Log (last ${recent.length}):`);
        for (const l of recent) {
          const ts = new Date(l.timestamp).toLocaleTimeString();
          lines.push(
            `  ${ts}  ${l.action}${l.outcome ? ` → ${l.outcome}` : ""}`,
          );
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n").trimEnd() }],
        details: { task },
      };
    },
  });

  // ── fn_task_logs_read ───────────────────────────────────────────

  /*
  FNXC:TaskLogsRead 2026-08-29-05:00:
  FN-253 makes tool detail default-persisted. This pi registration must use the shared engine builder
  so its per-row preview, whole-response cap, and explicit full-detail escape hatch cannot drift from
  task-bound and chat agent readers.
  */
  pi.registerTool({
    name: "fn_task_logs_read",
    label: "fn: Read Task Logs",
    description: "Read a task's persisted agent log with pagination and optional type filtering. Tool detail is previewed per row by default; detail: full lifts the row preview while the whole response remains bounded.",
    promptSnippet: "Read persisted agent logs for a Fusion task",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. FN-001)" }),
      limit: Type.Optional(Type.Number({ description: "Maximum matching entries to return (default 100)." })),
      offset: Type.Optional(Type.Number({ description: "Number of matching entries to skip from newest (default 0)." })),
      type: Type.Optional(Type.Union([
        Type.Literal("text"), Type.Literal("status"), Type.Literal("tool"),
        Type.Literal("thinking"), Type.Literal("tool_result"), Type.Literal("tool_error"),
      ], { description: "Only return entries of this agent-log type." })),
      detail: Type.Optional(Type.Union([
        Type.Literal("preview"), Type.Literal("full"),
      ], { description: "Tool-detail mode. Preview (default) bounds each detail row; full lifts that row preview while the whole response remains bounded." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const { limit, offset } = normalizeAgentLogPaging(params.limit, params.offset);
      const [entries, total] = await Promise.all([
        store.getAgentLogs(params.id, { limit, offset, type: params.type }),
        store.getAgentLogCount(params.id, { type: params.type }),
      ]);
      return {
        content: [{ type: "text", text: buildTaskAgentLogReadText(entries, {
          total,
          limit,
          offset,
          type: params.type,
          detail: params.detail,
        }) }],
        details: { taskId: params.id, total, limit, offset, type: params.type },
      };
    },
  });

  // ── fn_task_attach ───────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_attach",
    label: "fn: Attach File",
    description:
      "Attach a file to a task. Supports images (png, jpg, gif, webp) and " +
      "text files (txt, log, json, yaml, yml, toml, csv, xml).",
    promptSnippet: "Attach a file to a Fusion task",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. FN-001)" }),
      path: Type.String({ description: "Path to the file to attach" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const filename = basename(filePath);
      const ext = extname(filename).toLowerCase();
      const mimeType = MIME_TYPES[ext];

      if (!mimeType) {
        throw new Error(
          `Unsupported file type: ${ext}. Supported: ${Object.keys(MIME_TYPES).join(", ")}`,
        );
      }

      /*
       * FNXC:CliTaskAttach 2026-07-05-00:00:
       * fn_task_attach must confine reads to the task worktree boundary (ctx.cwd) to
       * prevent a path-traversal / absolute-path read-boundary bypass — an agent could
       * previously pass "../../../etc/hosts" or an absolute path (with an allowed
       * extension) and exfiltrate arbitrary files into a task's attachments. The guard
       * must run BEFORE readFile so an out-of-boundary path is never opened, even to
       * fail. The boundary is intentionally ctx.cwd (the worktree) — not a broader
       * project root — to avoid re-exposing sibling worktrees. (FN-7619, flagged
       * out-of-scope during FN-7608.)
       */
      const boundaryRoot = resolve(ctx.cwd);
      const rel = relative(boundaryRoot, filePath);
      const escapesBoundary =
        rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
      if (escapesBoundary) {
        throw new Error(
          `Refusing to attach file outside the task worktree boundary: ${params.path}`,
        );
      }

      let content: Buffer;
      try {
        content = await readFile(filePath);
      } catch {
        throw new Error(`Cannot read file: ${params.path}`);
      }

      const store = await getStore(ctx.cwd);
      const attachment = await store.addAttachment(params.id, filename, content, mimeType);
      const sizeKB = (attachment.size / 1024).toFixed(1);

      return {
        content: [
          {
            type: "text",
            text:
              `Attached to ${params.id}: ${attachment.originalName} (${sizeKB} KB)\n` +
              `Path: .fusion/tasks/${params.id}/attachments/${attachment.filename}`,
          },
        ],
        details: { taskId: params.id, attachment },
      };
    },
  });

  // ── fn_task_pause ────────────────────────────────────────────────

  /*
   * FNXC:AgentPauseGuidance 2026-06-28-00:05:
   * Pause is a user-requested manual-control lever, not an agent failure-handling response.
   * Tool guidance must steer agents toward retry, follow-up work, or normal failure surfacing instead of stranding tasks in paused state.
   */
  pi.registerTool({
    name: "fn_task_pause",
    label: "fn: Pause Task",
    description:
      "Pause a task for explicit user-requested manual control — stops all automated agent and scheduler interaction. Agents should not pause tasks to handle failures or blockers; use retry, create/delegate follow-up work, or let the task surface as failed instead.",
    promptSnippet:
      "Pause a Fusion task only for explicit user-requested manual control; do not use for failure/blocker handling",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. FN-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: policy-gated for agent principals; operators unaffected.
      const gated = await applyAgentPolicyGateForExtensionTool("fn_task_pause", params as Record<string, unknown>, ctx as ExtensionCallerContext);
      if (gated) return gated;
      const store = await getStore(ctx.cwd);
      const task = await store.pauseTask(params.id, true, undefined, { userPaused: true });

      return {
        content: [{ type: "text", text: `Paused ${task.id}` }],
        details: { taskId: task.id },
      };
    },
  });

  // ── fn_task_unpause ──────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_unpause",
    label: "fn: Unpause Task",
    description:
      "Unpause a task — resumes automated agent and scheduler interaction.",
    promptSnippet: "Unpause a Fusion task (resumes automation)",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. FN-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: policy-gated for agent principals; operators unaffected.
      const gated = await applyAgentPolicyGateForExtensionTool("fn_task_unpause", params as Record<string, unknown>, ctx as ExtensionCallerContext);
      if (gated) return gated;
      const store = await getStore(ctx.cwd);
      const task = await store.pauseTask(params.id, false);

      return {
        content: [{ type: "text", text: `Unpaused ${task.id}` }],
        details: { taskId: task.id },
      };
    },
  });

  // ── fn_task_retry ────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_retry",
    label: "fn: Retry Task",
    description:
      "Retry a failed task — clears the error state. Non-review failures move to todo; in-review execution failures move to todo preserving progress; in-review merge failures stay in-place for auto-merge retry.",
    promptSnippet: "Retry a failed Fusion task (clears error, moves to todo or stays in in-review)",
    promptGuidelines: [
      "Use when a task has failed and needs to be retried",
      "Only tasks in 'failed' or 'stuck-killed' state, plus stranded in-review tasks with incomplete execution or prior merge attempts, can be retried",
      "In-review tasks with incomplete steps (pending/in-progress) move to todo with preserveProgress so execution can resume",
      "In-review tasks with all steps done stay in in-review and reset merge retry state for auto-merge re-attempt",
      "Tasks in other columns are moved to the todo column with error state cleared",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to retry (e.g. FN-001). Must be in 'failed' state." }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: policy-gated for agent principals; operators unaffected.
      const gated = await applyAgentPolicyGateForExtensionTool("fn_task_retry", params as Record<string, unknown>, ctx as ExtensionCallerContext);
      if (gated) return gated;
      const store = await getStore(ctx.cwd);

      // Validate task exists
      let task;
      try {
        task = await store.getTask(params.id);
      } catch {
        return {
          content: [{ type: "text", text: `Task ${params.id} not found` }],
          isError: true,
          details: { error: "Task not found" },
        };
      }
      
      /*
      FNXC:WorkflowLifecycleColumns 2026-08-02-12:40 (PR #2728 review — the retry gate exists THREE times):
      This is `fn_task_retry`, the MCP tool AGENTS call — the third copy of the same classifier, after the
      dashboard route (#2713) and the CLI command (this PR). Converting two of three is worse than converting
      none: the operator retries from the board and it works, the agent retries the same card and is told it
      is not retryable, and nothing in either message mentions columns.

      Same SET semantics as the other two surfaces (mergeBlocker / humanReview can sit on different columns,
      #2713), and the same note applies: three copies of one predicate is the argument for a set-returning
      resolver in core, which is a follow-up rather than a rider on this PR.
      */
      /*
      FNXC:WorkflowLifecycleColumns 2026-08-02-22:15 (consolidation onto #2730's core resolver):
      CORE'S `resolveReviewColumns` — see the fuller note in `commands/task.ts`. This copy carried
      `.slice(0, 1)` on the merge-orchestration lanes while the CLI command took the full union, so
      `fn_task_retry` refused a card in a SECOND merge lane that `fn task retry` accepted: two surfaces, one
      operator action, two answers. That is the exact defect #2728 was opened to remove, reproduced by two
      copies of one definition drifting apart within a single PR.
      */
      const retryIr = await resolveWorkflowIrForTask(store, params.id).catch(() => undefined);
      const resolvedRetryReviewColumns = retryIr === undefined ? [] : resolveReviewColumns(retryIr);
      const retryReviewColumns = new Set<string>(
        resolvedRetryReviewColumns.length > 0 ? resolvedRetryReviewColumns : ["in-review"],
      );
      const isInReviewStatusNone =
        retryReviewColumns.has(task.column) && (task.status === null || task.status === undefined);
      const hasIncompleteSteps = task.steps.some(
        (s: { status: string }) => s.status === "pending" || s.status === "in-progress",
      );
      // FN-4130 / PR #59 follow-up: zero-step review failures with no merge attempts
      // (`mergeRetries ?? 0 === 0`) failed during execution, not merge finalization.
      const isExecutionFailureInReview =
        hasIncompleteSteps || (task.steps.length === 0 && (task.mergeRetries ?? 0) === 0);
      const isInReviewExecutionStall = isInReviewStatusNone && isExecutionFailureInReview;
      const isInReviewMergeRetryStall = isInReviewStatusNone && (task.mergeRetries ?? 0) > 0;
      const isInReviewRetry =
        retryReviewColumns.has(task.column) &&
        (task.status === "failed" ||
          task.status === "stuck-killed" ||
          isInReviewExecutionStall ||
          isInReviewMergeRetryStall);
      /*
      FNXC:MissingWorktreeRetry 2026-07-10-18:30:
      Upstream #1992 requires fn_task_retry to recover an in-review unusable-worktree session-start failure even when status remains merge-active. Keep this status bypass constrained to the centrally classified missing/incomplete/unregistered worktree signature.
      */
      const isMissingWorktreeSessionRetry = isInReviewMissingWorktreeSessionStartFailure(task, retryReviewColumns.has(task.column));

      // Validate task is in a retryable state
      if (task.status !== 'failed' && task.status !== 'stuck-killed' && !isInReviewRetry && !isMissingWorktreeSessionRetry) {
        return {
          content: [{ type: "text", text: `Task ${params.id} is not in a retryable state (status: ${task.status || 'none'})` }],
          isError: true,
          details: { taskId: params.id, currentStatus: task.status },
        };
      }
      
      const autoPauseClearPatch = buildAutoPauseClearPatch(task);
      const clearedDeadlockAutoPause = Object.keys(autoPauseClearPatch).length > 0;
      const retryLogSuffix = clearedDeadlockAutoPause ? ", cleared deadlock auto-pause" : "";
      // FNXC:TaskWedgeNotifications 2026-08-10-20:15: an operator retry ends the prior terminal-failure episode and mints a fresh budget.
      await store.resetTerminalFailureAutoRecoveryBudget(params.id);

      if (isMissingWorktreeSessionRetry) {
        await store.updateTask(params.id, {
          status: null,
          error: null,
          worktree: null,
          branch: null, branchWriteOrigin: "engine" as const,
          sessionFile: null,
          ...autoPauseClearPatch,
          ...buildManualRetryResetPatch({ resetMergeRetries: true }),
        });
        await store.logEntry(params.id, `Retry requested via Fusion extension (unusable worktree session-start recovery → todo, preserving progress${retryLogSuffix})`);
        /* FNXC:WorkflowResolvedColumns 2026-07-30-22:20: census-invisible moveTask DESTINATION — a call argument, not a comparison. This is an OPERATOR-triggered Retry: on a board that does not declare `todo` the move is REJECTED and the retry fails in the operator's face. The reply text below uses the SAME resolved value so it cannot name a lane the card did not go to. */
        const retryTarget = await fusionCore.resolveReboundTargetForTask(store, params.id);
        /* FNXC:ToolPermissionGates 2026-07-30-13:55: fn_task_retry is a user-facing lever — carry the user move source (target resolves by role). */
        await store.moveTask(params.id, retryTarget, { preserveProgress: true, moveSource: "user" });
        return {
          content: [{ type: "text", text: `Retried ${params.id} → ${retryTarget} (unusable worktree session metadata cleared)` }],
          details: { taskId: params.id, newColumn: 'todo' },
        };
      }

      // In-review retry: distinguish between execution failures and merge failures.
      if (isInReviewRetry) {
        if (isExecutionFailureInReview) {
          await store.updateTask(params.id, {
            status: null,
            error: null,
            ...autoPauseClearPatch,
            ...buildManualRetryResetPatch(),
          });
          await store.logEntry(
            params.id,
            isInReviewExecutionStall
              ? `Retry requested via Fusion extension (stranded in-review execution retry → todo, preserving progress${retryLogSuffix})`
              : `Retry requested via Fusion extension (execution failure in-review → todo, preserving progress${retryLogSuffix})`,
          );
          /* FNXC:WorkflowResolvedColumns 2026-07-30-22:20: census-invisible moveTask DESTINATION — same operator Retry path as above. */
          const executionRetryTarget = await fusionCore.resolveReboundTargetForTask(store, params.id);
          /* FNXC:ToolPermissionGates 2026-07-30-13:55: fn_task_retry is a user-facing lever — carry the user move source (target resolves by role). */
          await store.moveTask(params.id, executionRetryTarget, { preserveProgress: true, moveSource: "user" });
          return {
            content: [{ type: "text", text: `Retried ${params.id} → ${executionRetryTarget} (execution failure, preserving step progress)` }],
            details: { taskId: params.id, newColumn: 'todo' },
          };
        }

        await store.updateTask(params.id, {
          status: null,
          error: null,
          ...autoPauseClearPatch,
          ...buildManualRetryResetPatch({ resetMergeRetries: true }),
        });
        await store.logEntry(params.id, `Retry requested via Fusion extension (in-review merge retry, mergeRetries reset${retryLogSuffix})`);
        return {
          content: [{ type: "text", text: `Retried ${params.id} → in-review (merge retry state cleared)` }],
          details: { taskId: params.id, newColumn: 'in-review' },
        };
      }

      // Clear failure state and move to todo for other columns
      await store.updateTask(params.id, {
        status: null,
        error: null,
        ...autoPauseClearPatch,
        ...buildManualRetryResetPatch({ resetMergeRetries: true }),
      });
      
      /*
      FNXC:TaskRetry 2026-07-31-23:59 (the SECOND instance of the review finding on #3152):
      A reviewer caught the chat `fn_task_retry` tool resolving its move target while still reporting
      `"todo"` in the log, the response text and `details.newColumn`. This CLI retry had the identical
      gap — same PR, same conversion, same three unconverted report sites — so it is fixed with it
      rather than waiting for the same comment on the next surface.

      Resolve once, then use that value everywhere the operator or a downstream tool reads it.
      */
      // FNXC:ToolPermissionGates 2026-07-26-13:55: user-facing retry move carries the user/hard-cancel source (Move-Task contract).
      const retryTarget = await fusionCore.resolveReboundTargetForTask(store, params.id);
      await store.moveTask(params.id, retryTarget, { moveSource: "user" });

      // Log the retry action
      await store.logEntry(params.id, "Retry requested via Fusion extension", `Task reset to ${retryTarget} for retry`);

      return {
        content: [{ type: "text", text: `Retried ${params.id} → ${retryTarget} (failure state cleared)` }],
        details: { taskId: params.id, newColumn: retryTarget },
      };
    },
  });

  // ── fn_task_bypass_review ────────────────────────────────────────

  /*
   * FNXC:ReviewLaneBypass 2026-07-09-00:00:
   * Policy-gated escape hatch (FN-7720) for a card stranded in `in-review`
   * solely by a failed pre-merge review step — the leading real-world cause
   * being the Runfusion/Fusion#1946 `(no feedback captured)` no-verdict
   * dispatch defect. Registered ONLY on this pi-extension/CLI operator tool
   * surface — deliberately NOT wired into packages/engine/src/executor.ts or
   * packages/engine/src/agent-heartbeat.ts autonomous per-role tool lists, and
   * NOT part of packages/dashboard/src/planning-board-tools.ts read-only
   * planning tools. Requires a mandatory reason; audit-logged via
   * store.bypassFailedPreMergeReviewStep's run-audit event.
   *
   * FNXC:ToolPermissionGates 2026-07-26-13:55:
   * Registration-surface separation alone was NOT sufficient: pi's host-extension
   * loader delivers this tool into engine agent sessions too. Operator-only access
   * is now enforced by construction — the withheld-from-agents principal guard runs
   * first in execute and hard-denies agent/ambiguous principals.
   */
  pi.registerTool({
    name: "fn_task_bypass_review",
    label: "fn: Bypass Failed Review Step",
    description:
      "Policy-gated escape hatch for an in-review task stranded solely by a failed pre-merge " +
      "review lane (leading real-world cause: the Runfusion/Fusion#1946 '(no feedback captured)' " +
      "no-verdict dispatch defect), not a real REVISE. Rewrites the latest failed pre-merge " +
      "WorkflowStepResult to a terminal non-blocking status with explicit bypass audit metadata " +
      "(who/when/why/prior status) — it never fabricates a reviewer verdict. Requires a mandatory " +
      "reason and is audit-logged. Clears ONLY the failed-pre-merge-step merge blocker; paused, " +
      "incomplete-step, blocking-status, and still-pending conditions still block, and an " +
      "autoMerge:false task is not force-merged.",
    promptSnippet:
      "Bypass a failed pre-merge review step on an in-review Fusion task (policy-gated, mandatory reason, audit-logged)",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. FN-001)" }),
      reason: Type.String({ description: "Mandatory justification for the bypass (audit-logged)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_task_bypass_review", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      const store = await getStore(ctx.cwd);
      const fnCtx = ctx as typeof ctx & { agentId?: string };
      const actor = fnCtx.agentId ?? "cli-operator";

      try {
        const task = await store.bypassFailedPreMergeReviewStep(params.id, {
          reason: params.reason,
          actor,
        });
        return {
          content: [{ type: "text", text: `Bypassed failed pre-merge review step for ${task.id}` }],
          details: { taskId: task.id },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `ERROR: Failed to bypass review lane for ${params.id}: ${err?.message ?? err}` }],
          isError: true,
          details: { taskId: params.id, error: String(err?.message ?? err) },
        };
      }
    },
  });

  // ── fn_workflow_step_resume ────────────────────────────────────

  /*
   * FNXC:StepResume 2026-08-06-17:42:
   * Operator escape hatch for in-review/in-progress tasks with workflow steps
   * stuck in `pending` because a dispatched prompt node verdict callback was
   * never received (Runfusion/Fusion#1946). Transitions the stuck `pending` step to
   * `failed` so the existing `fn_task_bypass_review` escape hatch can then clear
   * the merge blocker. Registered ONLY on this pi-extension/CLI operator tool
   * surface — deliberately NOT wired into executor/reviewer/triage agent tool
   * lists; the WITHHELD_FROM_AGENT_EXTENSION_TOOLS guard below is the hard
   * enforcement that an agent session cannot reach it (operator-only, mandatory
   * `reason` and `stepId`, audit-logged via store.resumeWorkflowStep's run-audit
   * event).
   */
  pi.registerTool({
    name: "fn_workflow_step_resume",
    label: "fn: Resume Stuck Pending Step",
    description:
      "Resume a stuck pending workflow step on an in-review or in-progress Fusion task " +
      "(operator-only, mandatory reason, audit-logged). When a prompt node (like code-review) " +
      "is dispatched but never receives a verdict callback (Runfusion/Fusion#1946), the step " +
      "stays in 'pending' status indefinitely. This tool transitions it to 'failed', enabling " +
      "the existing fn_task_bypass_review escape hatch to clear the merge blocker. Requires " +
      "a mandatory reason and step ID.",
    promptSnippet:
      "Resume a stuck pending workflow step on an in-review or in-progress Fusion task (operator-only, mandatory reason, audit-logged)",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID (e.g. FN-001)" }),
      stepId: Type.String({ description: "Workflow step ID to resume (e.g. 'code-review', 'plan-review')" }),
      reason: Type.String({ description: "Mandatory justification for resuming the step (audit-logged)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_workflow_step_resume", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      const store = await getStore(ctx.cwd);
      const fnCtx = ctx as typeof ctx & { agentId?: string };
      const actor = fnCtx.agentId ?? "cli-operator";

      try {
        const task = await store.resumeWorkflowStep(params.id, {
          stepId: params.stepId,
          reason: params.reason,
          actor,
        });
        return {
          content: [{ type: "text", text: `Resumed stuck pending workflow step '${params.stepId}' for ${task.id}` }],
          details: { taskId: task.id, stepId: params.stepId },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `ERROR: Failed to resume step '${params.stepId}' for ${params.id}: ${err?.message ?? err}` }],
          isError: true,
          details: { taskId: params.id, stepId: params.stepId, error: String(err?.message ?? err) },
        };
      }
    },
  });

  // ── fn_task_duplicate ─────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_duplicate",
    label: "fn: Duplicate Task",
    description:
      "Duplicate an existing task, creating a fresh copy in planning. " +
      "Copies the title and description but resets all execution state. " +
      "The AI planning agent will replan the new task.",
    promptSnippet: "Duplicate a Fusion task (creates copy in planning)",
    promptGuidelines: [
      "Use when a task needs to be re-done, split, or used as a template",
      "The duplicated task will be placed in planning for replanning",
      "Dependencies, attachments, and execution state are NOT copied",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Source task ID to duplicate (e.g. FN-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_task_duplicate", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      const store = await getStore(ctx.cwd);
      const newTask = await store.duplicateTask(params.id);

      return {
        content: [{ type: "text", text: `Duplicated ${params.id} → ${newTask.id}` }],
        details: { sourceId: params.id, newTaskId: newTask.id },
      };
    },
  });

  // ── fn_task_refine ──────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_refine",
    label: "fn: Refine Task",
    description:
      "Request a refinement of a completed or in-review task. " +
      "Creates a new follow-up task in planning that references the original task as a dependency. " +
      "Use this when a done or in-review task needs additional work, improvements, or follow-up changes.",
    promptSnippet: "Create a refinement task for follow-up work on a completed task",
    promptGuidelines: [
      "Use when a completed or in-review task needs follow-up work or improvements",
      "The original task must be in 'done' or 'in-review' column",
      "The refinement task will be created in planning and depend on the original task",
      "Provide clear feedback about what needs to be refined or improved",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to refine (e.g. FN-001). Must be in 'done' or 'in-review' column." }),
      feedback: Type.String({ 
        description: "Description of what needs to be refined or improved",
        minLength: 1,
        maxLength: MAX_TASK_MESSAGE_LENGTH,
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_task_refine", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      const store = await getStore(ctx.cwd);
      const newTask = await store.refineTask(params.id, params.feedback);

      return {
        content: [
          { type: "text", text: `Created refinement ${newTask.id} for ${params.id}` },
        ],
        details: { sourceId: params.id, newTaskId: newTask.id, feedback: params.feedback },
      };
    },
  });


  // ── fn_task_delete ─────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_delete",
    label: "fn: Delete Task",
    description:
      "Soft-delete a task from active Fusion board views. " +
      "The task row and artifacts are preserved; optional allowResurrection marks the ID for intentional recreation. " +
      "If live lineage children or dependents still reference the task, deletion is rejected unless the matching explicit reference-removal option is passed.",
    promptSnippet: "Soft-delete a Fusion task",
    promptGuidelines: [
      "Use for cleaning up test tasks or tasks created in error when you want the task hidden from active board views",
      "This tool performs a soft delete: task data is preserved and the ID stays reserved",
      "Use allowResurrection:true when operators want the deleted task ID to be intentionally reusable on future createTask calls",
      "If deletion fails because the task is still referenced as a lineage parent by another task, retry with removeLineageReferences:true to clear that reference and unblock the delete",
      "If deletion fails because live tasks depend on it, first review the conflict, then deliberately retry with removeDependencyReferences:true to atomically remove only those incoming dependency edges and replan affected tasks",
    ],
    /*
    FNXC:TaskLifecycleTools 2026-07-07-00:00:
    The store's TaskHasLineageChildrenError advertises { removeLineageReferences: true }, so this
    deletion tool must expose and forward the same recovery path.

    FNXC:DependencyIntegrity 2026-08-20-19:00:
    FN-075 exposes the store's explicit dependent-conflict recovery at the CLI bridge. The bridge
    must delegate incoming-edge removal, stale-blocker clearing, and dependency replan fencing to
    the PostgreSQL delete transaction; it must not mutate dependency arrays itself.
    */
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to delete (e.g. FN-001)" }),
      allowResurrection: Type.Optional(Type.Boolean({ description: "When true, mark this tombstone as explicitly reusable for future recreation." })),
      removeLineageReferences: Type.Optional(Type.Boolean({ description: "When true, clear incoming lineage-parent references (child sourceParentTaskId) before deleting, so a task still referenced as a lineage parent can be removed." })),
      removeDependencyReferences: Type.Optional(Type.Boolean({ description: "When true, remove incoming dependency edges before soft deletion. Omit or pass false to retain the dependent-conflict refusal." })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: hard-withheld from agent/ambiguous principals (root cause of the live-task deletion incident); operators unaffected.
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_task_delete", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      const store = await getStore(ctx.cwd);
      const callerTaskId = (ctx as { taskId?: string }).taskId;
      const task = await store.deleteTask(params.id, {
        allowResurrection: params.allowResurrection === true,
        removeLineageReferences: params.removeLineageReferences === true,
        removeDependencyReferences: params.removeDependencyReferences === true,
        auditContext: {
          /*
          FNXC:TaskDeleteAttribution 2026-07-26-14:30:
          `agentId` names the TOOL SURFACE, not the actor. Before callerKind/callerTaskId were
          persisted, an agent deleting a task through this tool produced a row indistinguishable
          from any other pi-extension write and the calling task was lost. `taskId` was already
          passed here (the store's self-delete guard reads it) but never reached metadata.
          */
          agentId: "pi-extension",
          runId: `synthetic-pi-delete-${params.id}-${Date.now()}`,
          taskId: callerTaskId,
          callerKind: "agent-tool",
        },
      });

      return {
        content: [{ type: "text", text: `Deleted ${task.id}` }],
        details: { taskId: task.id },
      };
    },
  });

  // ── fn_task_import_github ─────────────────────────────────────────

  pi.registerTool({
    name: "fn_task_import_github",
    label: "fn: Import GitHub Issues",
    description:
      "Import GitHub issues as Fusion tasks. Fetches open issues from a repository " +
      "and creates tasks in the planning column. Each task includes the issue title " +
      "and body with a link to the source issue.",
    promptSnippet: "Import GitHub issues as Fusion tasks",
    promptGuidelines: [
      "Use for syncing GitHub issue backlog to Fusion board",
      "Uses gh CLI authentication (run 'gh auth login')",
      "Use --limit to control how many issues to import (default: 30)",
      "Use --labels to filter by specific labels",
    ],
    parameters: Type.Object({
      ownerRepo: Type.String({
        description: "Repository in owner/repo format (e.g., 'dustinbyrne/fusion')",
        pattern: "^[^/]+/[^/]+$",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max issues to import (default: 30, max: 50)",
          minimum: 1,
          maximum: 50,
        })
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), {
          description: "Label names to filter by",
        })
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_task_import_github", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      const [owner, repo] = params.ownerRepo.split("/");
      const limit = clampImportBrowseLimit(params.limit, 30);
      const labels = params.labels;

      const issues = await fetchGitHubIssuesViaGh(owner, repo, { limit, labels, signal });

      if (issues.length === 0) {
        return {
          content: [{ type: "text", text: `No open issues found in ${owner}/${repo}.` }],
          details: { createdTasks: [], summary: `Imported 0 tasks from ${owner}/${repo}` },
        };
      }

      const store = await getStore(ctx.cwd);
      const existingTasks = await store.listTasks({ slim: false });
      const importedIssueGithubTracking = await resolveImportedIssueGithubTracking(store);
      const createdTasks: Array<{ id: string; title: string }> = [];

      for (const issue of issues) {
        const sourceUrl = issue.html_url;
        const alreadyImported = existingTasks.some((task) => dashboard.isGitHubIssueAlreadyImported(task, { owner, repo, issueNumber: issue.number, sourceUrl }));
        if (alreadyImported) {
          continue;
        }

        const title = issue.title.slice(0, 200);
        const body = issue.body?.trim() || "(no description)";
        const description = `${body}\n\nSource: ${sourceUrl}`;

        const source = dashboard.buildGitHubIssueSource(owner, repo, issue);
        const task = await store.createTask({
          title: title || undefined,
          description,
          /* FNXC:WorkflowLifecycleColumns 2026-07-29-20:15 (U11): no explicit column —
             `createTaskImpl` resolves the WORKFLOW'S intake column, and `input.column` would
             override it. Hard-coding `"triage"` created the card in a column the default
             lineage no longer declares (#2515), i.e. straight into the stranded state. */
          dependencies: [],
          sourceIssue: source.sourceIssue,
          source: {
            sourceType: "github_import",
            sourceMetadata: source.sourceMetadata,
          },
          ...(importedIssueGithubTracking ? { githubTracking: importedIssueGithubTracking } : {}),
        });

        await store.logEntry(task.id, "Imported from GitHub", sourceUrl);
        createdTasks.push({ id: task.id, title: task.title || issue.title });

        existingTasks.push(task);
      }

      const summary = `✓ Imported ${createdTasks.length} tasks from ${owner}/${repo}`;
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\nCreated tasks:\n${createdTasks.map((task) => `  ${task.id}: ${task.title}`).join("\n") || "  None"}`,
          },
        ],
        details: { createdTasks, summary },
      };
    },
  });

  // ── fn_task_import_github_issue ───────────────────────────────────
  // Import a single GitHub issue by its issue number

  pi.registerTool({
    name: "fn_task_import_github_issue",
    label: "fn: Import GitHub Issue",
    description:
      "Import a specific GitHub issue as a Fusion task. Fetches the issue by number " +
      "and creates a single task in the planning column with the issue title and body.",
    promptSnippet: "Import a specific GitHub issue as a Fusion task",
    promptGuidelines: [
      "Use for importing a single known issue by its number",
      "Uses gh CLI authentication (run 'gh auth login')",
      "Skips import if the issue is already imported (checks for existing Source URL)",
    ],
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner (e.g., 'dustinbyrne')",
      }),
      repo: Type.String({
        description: "Repository name (e.g., 'fusion')",
      }),
      issueNumber: Type.Number({
        description: "GitHub issue number to import",
        minimum: 1,
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_task_import_github_issue", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      const { owner, repo, issueNumber } = params;
      const issue = await fetchGitHubIssueViaGh(owner, repo, issueNumber, { signal });

      if (issue.pull_request) {
        throw new Error(`#${issueNumber} is a pull request, not an issue`);
      }

      // Check if already imported
      const store = await getStore(ctx.cwd);
      const existingTasks = await store.listTasks({ slim: false });
      const sourceUrl = issue.html_url;

      for (const task of existingTasks) {
        if (dashboard.isGitHubIssueAlreadyImported(task, { owner, repo, issueNumber, sourceUrl })) {
          return {
            content: [
              {
                type: "text",
                text: `Issue #${issueNumber} already imported as ${task.id}\nSource: ${sourceUrl}`,
              },
            ],
            details: { skipped: true, existingTaskId: task.id, sourceUrl },
          };
        }
      }

      // Create the task
      const title = issue.title.slice(0, 200);
      const body = issue.body?.trim() || "(no description)";
      const description = `${body}\n\nSource: ${sourceUrl}`;

      const importedIssueGithubTracking = await resolveImportedIssueGithubTracking(store);

      const source = dashboard.buildGitHubIssueSource(owner, repo, issue);
      const task = await store.createTask({
        title: title || undefined,
        description,
        /* FNXC:WorkflowLifecycleColumns 2026-07-29-20:15 (U11): no explicit column —
           `createTaskImpl` resolves the WORKFLOW'S intake column, and `input.column` would
           override it. Hard-coding `"triage"` created the card in a column the default
           lineage no longer declares (#2515), i.e. straight into the stranded state. */
        dependencies: [],
        sourceIssue: source.sourceIssue,
        source: {
          sourceType: "github_import",
          sourceMetadata: source.sourceMetadata,
        },
        ...(importedIssueGithubTracking ? { githubTracking: importedIssueGithubTracking } : {}),
      });

      await store.logEntry(task.id, "Imported from GitHub", sourceUrl);

      return {
        content: [
          {
            type: "text",
            text: `Imported ${task.id} from GitHub\n${sourceUrl}`,
          },
        ],
        details: { taskId: task.id, sourceUrl },
      };
    },
  });

  // ── fn_task_browse_github_issues ──────────────────────────────────
  // Browse available GitHub issues before importing

  pi.registerTool({
    name: "fn_task_browse_github_issues",
    label: "fn: Browse GitHub Issues",
    description:
      "List open GitHub issues from a repository to browse before importing. " +
      "Returns issue numbers, titles, and URLs for selection. Use with fn_task_import_github_issue " +
      "to import specific issues by number.",
    promptSnippet: "Browse open GitHub issues in a repository",
    promptGuidelines: [
      "Use to preview available issues before importing",
      "Returns a list you can reference when importing specific issues",
      "Use --limit to control how many issues to show (default: 30)",
      "Use --labels to filter by specific labels",
      "Uses gh CLI authentication (run 'gh auth login')",
    ],
    parameters: Type.Object({
      owner: Type.String({
        description: "Repository owner (e.g., 'dustinbyrne')",
      }),
      repo: Type.String({
        description: "Repository name (e.g., 'fusion')",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max issues to show (default: 30, max: 50)",
          minimum: 1,
          maximum: 50,
        })
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), {
          description: "Label names to filter by",
        })
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { owner, repo, labels } = params;
      const limit = clampImportBrowseLimit(params.limit, 30);
      const issues = await fetchGitHubIssuesViaGh(owner, repo, { limit, labels, signal });

      if (issues.length === 0) {
        return {
          content: [{ type: "text", text: `No open issues found in ${owner}/${repo}.` }],
          details: { count: 0, issues: [] },
        };
      }

      // Check which issues are already imported
      const store = await getStore(ctx.cwd);
      // FNXC:GithubImport 2026-07-17-00:00: Browse must load full provenance and use the shared helper so its imported marker agrees with all issue-import surfaces even after descriptions are edited.
      const existingTasks = await store.listTasks({ slim: false });
      const importedIssueNumbers = new Set(
        issues
          .filter((issue) => existingTasks.some((task) => dashboard.isGitHubIssueAlreadyImported(task, {
            owner,
            repo,
            issueNumber: issue.number,
            sourceUrl: issue.html_url,
          })))
          .map((issue) => issue.number),
      );

      const lines: string[] = [];
      lines.push(`Found ${issues.length} open issues in ${owner}/${repo}:\n`);

      for (const issue of issues) {
        const isImported = importedIssueNumbers.has(issue.number);
        const issueLabels = issue.labels ?? [];
        const labelStr = issueLabels.length > 0 ? ` [${issueLabels.map((label) => label.name).join(", ")}]` : "";
        const importedStr = isImported ? " ✓ Imported" : "";
        lines.push(`  #${issue.number}: ${issue.title.slice(0, 80)}${issue.title.length > 80 ? "…" : ""}${labelStr}${importedStr}`);
        lines.push(`     ${issue.html_url}`);
      }

      lines.push("\nUse fn_task_import_github_issue to import a specific issue by number.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: issues.length,
          issues: issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            labels: (issue.labels ?? []).map((label) => label.name),
            imported: importedIssueNumbers.has(issue.number),
          })),
        },
      };
    },
  });

  async function createGitLabClient(ctx: { cwd: string }) {
    const store = await getStore(ctx.cwd);
    const projectSettings = await store.getSettings();
    const globalSettings = await store.getGlobalSettingsStore().getSettings();
    const auth = dashboard.resolveGitlabAuth({ projectSettings, globalSettings });
    if (!auth.ok) throw new Error(auth.message);
    return { store, client: new dashboard.GitLabClient(auth.auth) };
  }

  async function importGitLabItems(ctx: { cwd: string }, resourceType: dashboard.GitLabResourceType, target: string, items: Array<dashboard.GitLabIssue | dashboard.GitLabMergeRequest>) {
    const { store, client } = await createGitLabClient(ctx);
    const existingTasks = await store.listTasks({ slim: false, includeArchived: false });
    const createdTasks: Array<{ id: string; title: string }> = [];
    for (const item of items) {
      const provenance = dashboard.buildGitLabTaskProvenance({ auth: client.auth, resourceType, item, projectInput: resourceType !== "group_issue" ? target : undefined, groupInput: resourceType === "group_issue" ? target : undefined });
      if (existingTasks.some((task) => dashboard.isGitLabAlreadyImported(task, provenance))) continue;
      const title = resourceType === "merge_request" ? `Review MR !${item.iid}: ${item.title.slice(0, 180)}` : item.title.slice(0, 200);
      const task = await store.createTask({ title: title || undefined, description: dashboard.buildGitLabTaskDescription(item), dependencies: [], sourceIssue: provenance.sourceIssue, gitlabTracking: provenance.gitlabTracking, source: { sourceType: "gitlab_import", sourceMetadata: provenance.sourceMetadata } });
      await store.logEntry(task.id, resourceType === "merge_request" ? "Imported merge request from GitLab" : "Imported from GitLab", item.webUrl);
      existingTasks.push(task);
      createdTasks.push({ id: task.id, title: task.title || item.title });
    }
    return createdTasks;
  }

  pi.registerTool({
    name: "fn_task_browse_gitlab_project_issues",
    label: "fn: Browse GitLab Project Issues",
    description: "List GitLab project issues from the configured GitLab instance.",
    promptSnippet: "Browse GitLab project issues",
    parameters: Type.Object({ project: Type.String({ description: "GitLab project path or numeric ID" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), labels: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { client } = await createGitLabClient(ctx);
      const issues = await client.listProjectIssues(params.project, { limit: clampImportBrowseLimit(params.limit, 30), labels: params.labels });
      return { content: [{ type: "text", text: issues.map((issue) => `#${issue.iid}: ${issue.title}\n${issue.webUrl}`).join("\n") || `No GitLab project issues found in ${params.project}.` }], details: { count: issues.length, issues } };
    },
  });

  pi.registerTool({
    name: "fn_task_import_gitlab_project_issues",
    label: "fn: Import GitLab Project Issues",
    description: "Import GitLab project issues as Fusion tasks using configured GitLab HTTP API auth.",
    promptSnippet: "Import GitLab project issues",
    parameters: Type.Object({ project: Type.String({ description: "GitLab project path or numeric ID" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), labels: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_task_import_gitlab_project_issues", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      const { client } = await createGitLabClient(ctx);
      const issues = await client.listProjectIssues(params.project, { limit: clampImportBrowseLimit(params.limit, 30), labels: params.labels });
      const createdTasks = await importGitLabItems(ctx, "project_issue", params.project, issues);
      return { content: [{ type: "text", text: `Imported ${createdTasks.length} GitLab project issue tasks.` }], details: { createdTasks } };
    },
  });

  pi.registerTool({
    name: "fn_task_browse_gitlab_group_issues",
    label: "fn: Browse GitLab Group Issues",
    description: "List GitLab group issues while preserving each issue's originating project identity.",
    promptSnippet: "Browse GitLab group issues",
    parameters: Type.Object({ group: Type.String({ description: "GitLab group path or numeric ID" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), labels: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { client } = await createGitLabClient(ctx);
      const issues = await client.listGroupIssues(params.group, { limit: clampImportBrowseLimit(params.limit, 30), labels: params.labels });
      return { content: [{ type: "text", text: issues.map((issue) => `#${issue.iid}: ${issue.projectPath ?? issue.projectId} — ${issue.title}\n${issue.webUrl}`).join("\n") || `No GitLab group issues found in ${params.group}.` }], details: { count: issues.length, issues } };
    },
  });

  pi.registerTool({
    name: "fn_task_import_gitlab_group_issues",
    label: "fn: Import GitLab Group Issues",
    description: "Import GitLab group issues as Fusion tasks using each issue's originating project identity.",
    promptSnippet: "Import GitLab group issues",
    parameters: Type.Object({ group: Type.String({ description: "GitLab group path or numeric ID" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), labels: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_task_import_gitlab_group_issues", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      const { client } = await createGitLabClient(ctx);
      const issues = await client.listGroupIssues(params.group, { limit: clampImportBrowseLimit(params.limit, 30), labels: params.labels });
      const createdTasks = await importGitLabItems(ctx, "group_issue", params.group, issues);
      return { content: [{ type: "text", text: `Imported ${createdTasks.length} GitLab group issue tasks.` }], details: { createdTasks } };
    },
  });

  pi.registerTool({
    name: "fn_task_browse_gitlab_merge_requests",
    label: "fn: Browse GitLab Merge Requests",
    description: "List GitLab project merge requests from the configured GitLab instance.",
    promptSnippet: "Browse GitLab merge requests",
    parameters: Type.Object({ project: Type.String({ description: "GitLab project path or numeric ID" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), labels: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { client } = await createGitLabClient(ctx);
      const mergeRequests = await client.listMergeRequests(params.project, { limit: clampImportBrowseLimit(params.limit, 30), labels: params.labels });
      return { content: [{ type: "text", text: mergeRequests.map((mr) => `!${mr.iid}: ${mr.title}\n${mr.webUrl}`).join("\n") || `No GitLab merge requests found in ${params.project}.` }], details: { count: mergeRequests.length, mergeRequests } };
    },
  });

  pi.registerTool({
    name: "fn_task_import_gitlab_merge_requests",
    label: "fn: Import GitLab Merge Requests",
    description: "Import GitLab project merge requests as Fusion review tasks using configured GitLab HTTP API auth.",
    promptSnippet: "Import GitLab merge requests",
    parameters: Type.Object({ project: Type.String({ description: "GitLab project path or numeric ID" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), labels: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_task_import_gitlab_merge_requests", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      const { client } = await createGitLabClient(ctx);
      const mergeRequests = await client.listMergeRequests(params.project, { limit: clampImportBrowseLimit(params.limit, 30), labels: params.labels });
      const createdTasks = await importGitLabItems(ctx, "merge_request", params.project, mergeRequests);
      return { content: [{ type: "text", text: `Imported ${createdTasks.length} GitLab merge request tasks.` }], details: { createdTasks } };
    },
  });

  // ── fn_task_plan ────────────────────────────────────────────────
  // Create a task via AI-guided planning mode

  pi.registerTool({
    name: "fn_task_plan",
    label: "fn: Plan Task",
    description:
      "Create a task via AI-guided planning mode — interactive conversation to refine your idea into a well-specified task. Pass resumeSessionId to reopen an existing planning session (even one whose task was already created) and create another task from the evolved plan.",
    promptSnippet: "Create a task via AI-guided planning mode",
    promptGuidelines: [
      "Use for breaking down vague ideas into actionable tasks",
      "The AI will ask clarifying questions before creating the task",
      "One plan can produce multiple tasks: resume the session with resumeSessionId to refine further and create another",
    ],
    parameters: Type.Object({
      description: Type.Optional(
        Type.String({
          description: "Initial plan description (optional) — the AI will ask clarifying questions if not provided",
        })
      ),
      baseBranch: Type.Optional(Type.String({ description: "Optional base branch for the task created from this planning session" })),
      // FNXC:PlanningMultiTask 2026-07-24-02:30: agent parity with the dashboard's reopen loop — resuming rotates the creation epoch when the plan already produced a task.
      resumeSessionId: Type.Optional(Type.String({ description: "Existing planning session id to resume instead of starting a new session" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_task_plan", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      // Import the planning function dynamically to avoid circular dependencies
      const { runTaskPlan } = await import("./commands/task.js");

      // Capture console output
      const originalLog = console.log;
      const originalError = console.error;
      const logs: string[] = [];

      console.log = (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        logs.push(line);
        originalLog.apply(console, args);
      };
      console.error = (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        logs.push(line);
        originalError.apply(console, args);
      };

      let taskId: string | undefined;
      try {
        taskId = await runTaskPlan(params.description, true, undefined, params.baseBranch, params.resumeSessionId); // Use --yes flag for non-interactive
      } catch (err) {
        console.error = originalError;
        console.log = originalLog;
        throw new Error(`Planning mode failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        console.error = originalError;
        console.log = originalLog;
      }

      // Get summary line
      const summaryLine = logs.find((l) => l.includes("✓ Created")) || "Task created";

      return {
        content: [
          {
            type: "text",
            text: summaryLine + (taskId ? `\n\nPlanning session completed. Task ${taskId} is now in planning and will be auto-planned by the AI planning agent.` : ""),
          },
        ],
        details: { taskId, logs },
      };
    },
  });

  pi.registerTool({
    name: "fn_web_fetch",
    label: "fn: Web Fetch",
    description: "Lightweight URL fetch (no JS rendering). Use agent-browser skill for JS-heavy pages.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch (http/https)" }),
      prompt: Type.Optional(Type.String({ description: "Optional extraction hint for downstream summarization" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
      maxBytes: Type.Optional(Type.Number({ description: "Max bytes to return (default: 512000)" })),
    }),
    promptSnippet: "Fetch and extract readable text from a webpage URL",
    promptGuidelines: [
      "Use for lightweight GET requests where JS rendering is not required.",
      "For JS-rendered pages or complex browsing flows, use agent-browser skill instead.",
    ],
    async execute(_toolCallId, params) {
      const result = await fetchWebContent(params.url, {
        timeoutMs: params.timeoutMs,
        maxBytes: params.maxBytes,
      });
      return {
        content: [{
          type: "text",
          text: [
            `URL: ${result.finalUrl}`,
            `Status: ${result.status}`,
            `Content-Type: ${result.contentType}`,
            params.prompt ? `Prompt: ${params.prompt}` : undefined,
            result.title ? `Title: ${result.title}` : undefined,
            "",
            result.content,
            result.truncated ? "\n[truncated to maxBytes]" : "",
          ].filter(Boolean).join("\n"),
        }],
        details: {
          finalUrl: result.finalUrl,
          status: result.status,
          contentType: result.contentType,
          title: result.title,
          truncated: result.truncated,
          bytesRead: result.bytesRead,
          promptSnippet: params.prompt ? params.prompt.slice(0, 200) : undefined,
          promptGuidelines: "Lightweight fetch only; for JS-rendered pages, use agent-browser skill.",
        },
      };
    },
  });

  pi.registerTool({
    name: "fn_secret_get",
    label: "fn: Secret Get",
    description: "Read a secret by key using per-secret access policy.",
    parameters: Type.Object({
      key: Type.String({ description: "Secret key" }),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], { description: "Optional scope" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fnCtx = ctx as typeof ctx & ExtensionCallerContext;
      const secretPrincipal = resolveSecretAccessPrincipal(fnCtx);
      if (secretPrincipal.kind === "ambiguous") {
        return {
          content: [{ type: "text", text: "Secret access was not requested because the calling agent identity is ambiguous. End one concurrent session and retry." }],
          isError: true,
          details: { error: "ambiguous-caller-identity", key: params.key, scope: params.scope ?? null },
        };
      }
      const effectiveCtx: { agentId?: string; agentName?: string; taskId?: string; runId?: string } = {
        ...(secretPrincipal.agentId ? { agentId: secretPrincipal.agentId } : {}),
        ...(secretPrincipal.agentName ? { agentName: secretPrincipal.agentName } : {}),
        ...(typeof fnCtx.taskId === "string"
          ? { taskId: fnCtx.taskId }
          : secretPrincipal.taskId ? { taskId: secretPrincipal.taskId } : {}),
        ...(typeof fnCtx.runId === "string" ? { runId: fnCtx.runId } : {}),
      };
      const store = await getStore(ctx.cwd);
      const secretsStore = await store.getSecretsStore();
      const scopes: SecretScope[] = params.scope ? [params.scope] : ["project", "global"];

      let record: import("@fusion/core").SecretRecord | null = null;
      let resolvedScope: import("@fusion/core").SecretScope | null = null;
      for (const scope of scopes) {
        const match = (await secretsStore.listSecrets(scope)).find((candidate) => candidate.key === params.key);
        if (match) {
          record = match;
          resolvedScope = scope;
          break;
        }
      }

      if (!record || !resolvedScope) {
        return { content: [{ type: "text", text: `Secret '${params.key}' not found.` }], details: { error: "not-found", key: params.key, scope: params.scope ?? null } };
      }

      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      const decision = resolveSecretAccessPolicy({
        secretPolicy: record.accessPolicy,
        settings: { secretsAccessPolicy: globalSettings.secretsAccessPolicy },
      });

      if (decision.policy === "deny") {
        emitSecretAudit(store, effectiveCtx, "secret:approval-denied", `${resolvedScope}:${params.key}`);
        return { content: [{ type: "text", text: "Secret access denied by policy." }], details: { error: "denied", key: params.key, scope: resolvedScope, policySource: decision.source } };
      }

      if (decision.policy === "prompt") {
        /*
        FNXC:SecretsApproval 2026-07-26-14:10:
        BEHAVIOR CHANGES (broken approval control, both intentional):
        (a) An `approved` row previously fell through and minted a BRAND-NEW pending request,
            so operator approval never granted anything — the loop was unwinnable. The status
            ladder is now: pending → still-awaiting message (no re-mint); denied → denied
            message (no re-mint); approved → REDEEM: reveal the secret, then markCompleted so
            the grant is consumed execute-once; completed (already redeemed) → mint a fresh
            request.
        (b) The approval row's category was "task_mutation" (normalized to
            task_agent_mutation), so the dashboard's emitSecretsAccessDecisionAudit — which
            fires only for category "secrets_access" — never ran. The category is now
            "secrets_access" (accepted verbatim by normalizeApprovalRequestActionCategory).
        */
        const cliLayer = requireProjectLayer(store, "CLI secret approval store");
        const approvalStore = new ApprovalRequestStore(null, { asyncLayer: cliLayer });
        const requesterSnapshot = secretPrincipal.actor;
        const requesterActorId = requesterSnapshot.actorId;
        const dedupeKey = `secret-read:${resolvedScope}:${params.key}:${requesterActorId}`;
        const existing = await findLatestApprovalRequestByDedupeKey(approvalStore, { requesterActorId, ...(effectiveCtx.taskId ? { taskId: effectiveCtx.taskId } : {}), dedupeKey });

        if (existing?.status === "pending") {
          emitSecretAudit(store, effectiveCtx, "secret:approval-requested", `${resolvedScope}:${params.key}`);
          return {
            content: [{ type: "text", text: `Secret access approval request ${existing.id} is still pending. Approve via POST /api/approvals/:id/decision.` }],
            details: { outcome: "pending_approval", approvalRequestId: existing.id, key: params.key, scope: resolvedScope },
          };
        }

        if (existing?.status === "denied") {
          emitSecretAudit(store, effectiveCtx, "secret:approval-denied", `${resolvedScope}:${params.key}`);
          return {
            content: [{ type: "text", text: `Secret access request ${existing.id} was denied by the operator. Do not retry without operator direction.` }],
            details: { outcome: "denied", approvalRequestId: existing.id, key: params.key, scope: resolvedScope },
          };
        }

        if (existing?.status === "approved") {
          const revealedAfterApproval = await secretsStore.revealSecret(record.id, resolvedScope, { agentId: secretPrincipal.agentId });
          await approvalStore.markCompleted(existing.id, {
            actor: requesterSnapshot,
            note: "Secret revealed after approval",
            // FNXC:SecretsAccessApproval 2026-07-26-18:35: ownership guard — secret grants
            // get the same expectedRequesterActorId enforcement as the gate path.
            expectedRequesterActorId: requesterActorId,
          });
          emitSecretAudit(store, effectiveCtx, "secret:read", `${resolvedScope}:${params.key}`, { key: params.key, scope: resolvedScope, approvalRequestId: existing.id });
          return {
            content: [{ type: "text", text: formatRevealedSecretContent(`Loaded secret '${params.key}' from ${resolvedScope} scope (approval ${existing.id} consumed).`, revealedAfterApproval.plaintextValue) }],
            details: { key: params.key, value: revealedAfterApproval.plaintextValue, scope: resolvedScope, approvalRequestId: existing.id },
          };
        }

        // No prior request, or the previous grant was already redeemed (completed) → mint a fresh one.
        const request = await approvalStore.create({
          requester: requesterSnapshot,
          targetAction: {
            category: "secrets_access",
            action: "read",
            summary: `Read secret ${params.key}`,
            resourceType: "secret",
            resourceId: record.id,
            context: { approvalDedupeKey: dedupeKey, key: params.key, scope: resolvedScope },
          },
          ...(effectiveCtx.runId ? { runId: effectiveCtx.runId } : {}),
          ...(effectiveCtx.taskId ? { taskId: effectiveCtx.taskId } : {}),
        });

        emitSecretAudit(store, effectiveCtx, "secret:approval-requested", `${resolvedScope}:${params.key}`);
        return {
          content: [{ type: "text", text: `Secret access requires approval. Request ${request.id} is pending. Approve via POST /api/approvals/:id/decision.` }],
          details: { outcome: "pending_approval", approvalRequestId: request.id, key: params.key, scope: resolvedScope },
        };
      }

      const revealed = await secretsStore.revealSecret(record.id, resolvedScope, { agentId: secretPrincipal.agentId });
      emitSecretAudit(store, effectiveCtx, "secret:read", `${resolvedScope}:${params.key}`, { key: params.key, scope: resolvedScope });
      return {
        content: [{ type: "text", text: formatRevealedSecretContent(`Loaded secret '${params.key}' from ${resolvedScope} scope.`, revealed.plaintextValue) }],
        details: { key: params.key, value: revealed.plaintextValue, scope: resolvedScope },
      };
    },
  });

  /*
  FNXC:MergeQueue 2026-07-15-11:28:
  Do not register fn_research_* on the host pi extension. These tools dual-boot a second TaskStore via getStore and can wedge agent turns with wait_for_completion polling (same hang class as FN-7956 fn_task_show). Bounded research remains available only when the engine injects createResearchTools into triage/executor/heartbeat sessions with experimentalFeatures.researchView enabled. Operators use `fn research` CLI / dashboard Research view.
  */

  pi.registerTool({
    name: "fn_experiment_finalize",
    label: "fn: Finalize Experiment Session",
    description: "Group kept experiment runs into reviewable branches and finalize the session. Use dryRun=true to preview the plan without touching git.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Experiment session ID" }),
      integrationBranch: Type.Optional(Type.String({ description: "Integration branch to compute merge-base against (default: main)" })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview plan only; do not create branches" })),
      planOverride: Type.Optional(Type.Any({ description: "Optional plan override payload" })),
      summary: Type.Optional(Type.String({ description: "Optional finalize summary" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: hard-withheld from agent/ambiguous principals; operators unaffected.
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_experiment_finalize", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      try {
        const store = await getStore(ctx.cwd);
        const sessionStore = store.getExperimentSessionStore();
        const service = new ExperimentFinalizeService({
          store: sessionStore,
          git: defaultGitOps(resolveProjectRoot(ctx.cwd)),
        });

        if (params.dryRun) {
          const plan = await service.previewPlan({
            sessionId: params.sessionId,
            integrationBranch: params.integrationBranch,
          });
          return {
            content: [{ type: "text", text: `Finalize plan for ${plan.sessionId}: ${plan.groups.length} group(s), merge-base ${plan.mergeBaseCommit}.` }],
            details: { plan },
          };
        }

        const result = await service.finalize({
          sessionId: params.sessionId,
          integrationBranch: params.integrationBranch,
          planOverride: params.planOverride as FinalizePlanOverride | undefined,
          summary: params.summary,
        });
        return {
          content: [{ type: "text", text: `Finalized ${result.sessionId}. Created ${result.branches.length} branch(es).` }],
          details: { result },
        };
      } catch (error) {
        if (
          error instanceof ExperimentFinalizeStateError
          || error instanceof ExperimentFinalizeNoKeptRunsError
          || error instanceof ExperimentFinalizePlanError
          || error instanceof ExperimentFinalizeMergeBaseError
          || error instanceof ExperimentFinalizeBranchExistsError
          || error instanceof ExperimentFinalizeCherryPickConflictError
        ) {
          return {
            content: [{ type: "text", text: error.message }],
            isError: true,
            details: {
              code: error.code,
              ...(error instanceof ExperimentFinalizeCherryPickConflictError
                ? { groupId: error.groupId, commit: error.commit, stderr: error.stderr }
                : {}),
            },
          };
        }
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Unknown experiment finalize error" }],
          isError: true,
          details: { code: "INTERNAL_ERROR" },
        };
      }
    },
  });

  // ── Insights Tools ──────────────────────────────────────────────

  pi.registerTool({
    name: "fn_insight_list",
    label: "fn: List Insights",
    description: "List persisted project insights with optional category/status filters.",
    promptSnippet: "List persisted project insights",
    parameters: Type.Object({
      category: Type.Optional(
        StringEnum([...INSIGHT_CATEGORIES], {
          description: "Filter by insight category",
        }) as unknown as TSchema,
      ),
      status: Type.Optional(
        StringEnum([...INSIGHT_STATUSES], {
          description: "Filter by insight status",
        }) as unknown as TSchema,
      ),
      runId: Type.Optional(Type.String({ description: "Filter to insights linked to a specific run ID" })),
      limit: Type.Optional(Type.Number({ description: "Max insights to return" })),
      offset: Type.Optional(Type.Number({ description: "Number of rows to skip" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
        return {
          content: [{ type: "text", text: "Invalid limit. Provide an integer >= 1." }],
          isError: true,
          details: { error: "Invalid limit" },
        };
      }
      if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0)) {
        return {
          content: [{ type: "text", text: "Invalid offset. Provide an integer >= 0." }],
          isError: true,
          details: { error: "Invalid offset" },
        };
      }

      const store = await getStore(ctx.cwd);
      const insightStore = store.getInsightStore();
      const category = params.category as InsightCategory | undefined;
      const status = params.status as InsightStatus | undefined;
      const options = {
        category,
        status,
        runId: params.runId,
        limit: params.limit,
        offset: params.offset,
      };
      const insights = await insightStore.listInsights(options);
      const count = await insightStore.countInsights({
        category,
        status,
        runId: params.runId,
      });

      if (insights.length === 0) {
        return {
          content: [{ type: "text", text: "No insights found for the provided filters." }],
          details: { count, insights: [] },
        };
      }

      const lines = [`Insights (${insights.length}/${count} shown):`];
      for (const insight of insights) {
        const title = insight.title.length > 80 ? `${insight.title.slice(0, 80)}…` : insight.title;
        lines.push(`  ${insight.id} [${insight.category}] [${insight.status}] ${title}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count, insights },
      };
    },
  });

  pi.registerTool({
    name: "fn_insight_show",
    label: "fn: Show Insight",
    description: "Show a single persisted insight by ID.",
    promptSnippet: "Show full details for a persisted insight",
    parameters: Type.Object({
      id: Type.String({ description: "Insight ID (e.g. INS-XXXXX)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const insightStore = store.getInsightStore();
      const insight = await insightStore.getInsight(params.id);

      if (!insight) {
        return {
          content: [{ type: "text", text: `Insight ${params.id} not found.` }],
          isError: true,
          details: { error: "Insight not found", id: params.id },
        };
      }

      const lines = [
        `${insight.id}: ${insight.title}`,
        `Category: ${insight.category}`,
        `Status: ${insight.status}`,
        `Last run: ${insight.lastRunId ?? "none"}`,
        `Created: ${insight.createdAt}`,
        `Updated: ${insight.updatedAt}`,
      ];

      if (insight.content) {
        lines.push("", "Content:", insight.content.length > 500 ? `${insight.content.slice(0, 500)}\n... (truncated)` : insight.content);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { insight },
      };
    },
  });

  pi.registerTool({
    name: "fn_insight_run_list",
    label: "fn: List Insight Runs",
    description: "List recent insight-generation runs with optional status/trigger filters.",
    promptSnippet: "List recent insight-generation runs",
    parameters: Type.Object({
      status: Type.Optional(
        StringEnum([...INSIGHT_RUN_STATUSES], {
          description: "Filter by run status",
        }) as unknown as TSchema,
      ),
      trigger: Type.Optional(
        StringEnum([...INSIGHT_RUN_TRIGGERS], {
          description: "Filter by run trigger",
        }) as unknown as TSchema,
      ),
      limit: Type.Optional(Type.Number({ description: "Max runs to return" })),
      offset: Type.Optional(Type.Number({ description: "Number of runs to skip" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
        return {
          content: [{ type: "text", text: "Invalid limit. Provide an integer >= 1." }],
          isError: true,
          details: { error: "Invalid limit" },
        };
      }
      if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0)) {
        return {
          content: [{ type: "text", text: "Invalid offset. Provide an integer >= 0." }],
          isError: true,
          details: { error: "Invalid offset" },
        };
      }

      const store = await getStore(ctx.cwd);
      const insightStore = store.getInsightStore();
      const status = params.status as InsightRunStatus | undefined;
      const trigger = params.trigger as InsightRunTrigger | undefined;
      const options = {
        status,
        trigger,
        limit: params.limit,
        offset: params.offset,
      };
      const runs = await insightStore.listRuns(options);
      const count = await insightStore.countRuns({ status, trigger });

      if (runs.length === 0) {
        return {
          content: [{ type: "text", text: "No insight runs found for the provided filters." }],
          details: { count, runs: [] },
        };
      }

      const lines = [`Insight runs (${runs.length}/${count} shown):`];
      for (const run of runs) {
        lines.push(
          `  ${run.id} [${run.status}] [${run.trigger}] created=${run.insightsCreated} updated=${run.insightsUpdated}`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count, runs },
      };
    },
  });

  pi.registerTool({
    name: "fn_insight_run_show",
    label: "fn: Show Insight Run",
    description: "Show a single insight-generation run by ID.",
    promptSnippet: "Show full details for an insight-generation run",
    parameters: Type.Object({
      id: Type.String({ description: "Insight run ID (e.g. INSR-XXXXX)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const insightStore = store.getInsightStore();
      const run = await insightStore.getRun(params.id);

      if (!run) {
        return {
          content: [{ type: "text", text: `Insight run ${params.id} not found.` }],
          isError: true,
          details: { error: "Insight run not found", id: params.id },
        };
      }

      const lines = [
        `${run.id}`,
        `Trigger: ${run.trigger}`,
        `Status: ${run.status}`,
        `Insights: created ${run.insightsCreated}, updated ${run.insightsUpdated}`,
        `Created: ${run.createdAt}`,
        `Started: ${run.startedAt ?? "not started"}`,
        `Completed: ${run.completedAt ?? "not completed"}`,
      ];
      if (run.summary) lines.push(`Summary: ${run.summary}`);
      if (run.error) lines.push(`Error: ${run.error}`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { run },
      };
    },
  });

  // ── Mission Tools ───────────────────────────────────────────────
  // Mission hierarchy management for multi-phase project planning

  /*
  FNXC:MissionAutonomyAudit 2026-07-23-16:10:
  Pi-extension mission mutations execute for either a human CLI operator or a
  runtime agent. Forward that real identity to the atomic transition audit so
  lifecycle changes never collapse into the mission-store fallback actor.
  */
  const missionTransitionActor = (toolContext: unknown): fusionCore.MissionTransitionActor => {
    const runtimeContext = toolContext as { agentId?: unknown; agentName?: unknown };
    const agentId = typeof runtimeContext.agentId === "string" && runtimeContext.agentId.trim()
      ? runtimeContext.agentId.trim()
      : undefined;
    if (agentId) {
      return {
        type: "agent",
        id: agentId,
        ...(typeof runtimeContext.agentName === "string" && runtimeContext.agentName.trim() ? { displayName: runtimeContext.agentName.trim() } : {}),
        source: "pi-extension",
      };
    }
    return { type: "operator", id: "cli-operator", displayName: "CLI operator", source: "pi-extension" };
  };

  // ── fn_mission_create ───────────────────────────────────────────

  pi.registerTool({
    name: "fn_mission_create",
    label: "fn: Create Mission",
    description:
      "Create a new mission — a high-level objective that can span multiple milestones. " +
      "Missions contain milestones that break down work into phases.",
    promptSnippet: "Create a new mission for high-level project planning",
    promptGuidelines: [
      "Use for high-level project objectives that span multiple work phases",
      "Missions are broken down into milestones → slices → features → tasks",
      "Be descriptive so the mission purpose is clear",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Mission title — brief but descriptive" }),
      description: Type.Optional(
        Type.String({ description: "Detailed mission objectives and context" })
      ),
      autoAdvance: Type.Optional(
        Type.Boolean({ description: "Automatically activate the next pending slice when the current slice completes" })
      ),
      baseBranch: Type.Optional(Type.String({ description: "Optional integration base branch for tasks triaged from this mission" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const mission = await missionStore.createMission({
        title: params.title.trim(),
        description: params.description?.trim(),
        baseBranch: params.baseBranch?.trim() || undefined,
      });

      if (params.autoAdvance !== undefined) {
        await missionStore.updateMission(mission.id, { autoAdvance: params.autoAdvance }, { actor: missionTransitionActor(ctx) });
      }

      const createdMission = (await missionStore.getMission(mission.id))!;

      return {
        content: [
          {
            type: "text",
            text: `Created ${createdMission.id}: ${createdMission.title}\nStatus: ${createdMission.status}${createdMission.autoAdvance ? "\nAuto-advance: enabled" : ""}`,
          },
        ],
        details: {
          missionId: createdMission.id,
          title: createdMission.title,
          status: createdMission.status,
          autoAdvance: createdMission.autoAdvance ?? false,
        },
      };
    },
  });

  // ── fn_mission_list ──────────────────────────────────────────────

  pi.registerTool({
    name: "fn_mission_list",
    label: "fn: List Missions",
    description: "List all missions with their current status.",
    promptSnippet: "List all missions",
    promptGuidelines: [
      "Use to see all missions and their current status",
      "Missions are grouped by status (active, planning, complete, etc.)",
      "Drafts represent unfinished mission interview sessions; fn_mission_show does not work on draft IDs because no mission row exists yet",
      "Use before fn_mission_show to find a specific mission ID",
    ],
    parameters: Type.Object({
      includeDrafts: Type.Optional(Type.Boolean({ description: "Include in-flight mission interview drafts (default: true)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();
      const includeDrafts = params.includeDrafts ?? true;

      const missions = await missionStore.listMissions();
      // FNXC:PostgresCutover 2026-07-04: in backend mode read mission-interview
      // drafts from PostgreSQL via Drizzle (the SQLite getDatabase() runtime was
      // removed under VAL-REMOVAL-005). PG ai_sessions columns are snake_case, so
      // alias updated_at -> updatedAt to preserve the existing draft row shape.
      type MissionInterviewDraft = {
        id: string;
        title: string;
        status: "generating" | "awaiting_input" | "error" | "complete";
        updatedAt: string;
      };
      let drafts: MissionInterviewDraft[] = [];
      if (includeDrafts) {
        drafts = await requireProjectLayer(store, "CLI mission drafts").db.execute<MissionInterviewDraft>(
          drizzleSql`SELECT id, title, status, updated_at AS "updatedAt" FROM project.ai_sessions WHERE type = 'mission_interview' AND status IN ('generating', 'awaiting_input', 'error', 'complete') AND COALESCE(archived, 0) = 0 ORDER BY updated_at DESC`,
        );
      }

      if (missions.length === 0 && drafts.length === 0) {
        return {
          content: [{ type: "text", text: "No missions yet." }],
          details: { count: 0, drafts: [] },
        };
      }

      const summary = {
        planning: missions.filter((mission) => mission.status === "planning").length,
        active: missions.filter((mission) => mission.status === "active").length,
        blocked: missions.filter((mission) => mission.status === "blocked").length,
        complete: missions.filter((mission) => mission.status === "complete").length,
        archived: missions.filter((mission) => mission.status === "archived").length,
      };

      const lines: string[] = [];
      lines.push(`Missions (${missions.length})`);
      lines.push(
        `Summary: active ${summary.active}, planning ${summary.planning}, blocked ${summary.blocked}, complete ${summary.complete}, archived ${summary.archived}`,
      );
      lines.push("");

      if (drafts.length > 0) {
        lines.push(`Drafts (${drafts.length})`);
        for (const draft of drafts) {
          const draftStatus = draft.status === "complete" ? "plan ready" : draft.status;
          lines.push(`  ◌ ${draft.id}: ${draft.title} (draft · interview ${draftStatus})`);
        }
        lines.push("");
      }

      for (const mission of missions) {
        const statusIcon = mission.status === "complete" ? "✓" : mission.status === "active" ? "●" : mission.status === "blocked" ? "⚠" : "○";
        const autoAdvance = mission.autoAdvance ? " · auto-advance" : "";
        lines.push(`  ${statusIcon} ${mission.id}: ${mission.title} (${mission.status}${autoAdvance})`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: missions.length,
          missions: missions.map((m) => ({ id: m.id, title: m.title, status: m.status })),
          drafts: drafts.map((draft) => ({ id: draft.id, title: draft.title, status: draft.status, updatedAt: draft.updatedAt })),
        },
      };
    },
  });

  // ── Goal Tools ───────────────────────────────────────────────
  // Author-facing goal management

  const GOAL_LIST_HARD_LIMIT = 5;
  const GOAL_LIST_SOFT_WARNING_THRESHOLD = 3;
  const GOAL_SNIPPET_MAX_CHARS = 80;

  const buildGoalSnippet = (description?: string): string | undefined => {
    const firstLine = description?.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim();
    if (!firstLine) return undefined;
    if (firstLine.length <= GOAL_SNIPPET_MAX_CHARS) return firstLine;
    return `${firstLine.slice(0, GOAL_SNIPPET_MAX_CHARS - 1).trimEnd()}…`;
  };

  const buildGoalListEntry = (goal: { id: string; title: string; status: string; description?: string }) => {
    const snippet = buildGoalSnippet(goal.description);
    return snippet
      ? { id: goal.id, title: goal.title, status: goal.status, snippet }
      : { id: goal.id, title: goal.title, status: goal.status };
  };

  const formatGoalListLine = (goal: { id: string; title: string; status: string; snippet?: string }) => (
    `- ${goal.id} [${goal.status}] ${goal.title}${goal.snippet ? ` — ${goal.snippet}` : ""}`
  );

  pi.registerTool({
    name: "fn_goal_list",
    label: "fn: List Goals",
    description: "List goals by status with active-goal warning details.",
    promptSnippet: "List project goals",
    promptGuidelines: [
      "Use to inspect current goals before creating or archiving",
      "Default status is active; pass archived/all when needed",
      "Soft warning begins at 3 active goals and hard cap is 5",
    ],
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union([
          Type.Literal("active"),
          Type.Literal("archived"),
          Type.Literal("all"),
        ], { description: "Filter by goal status (default: active)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fnCtx = ctx as typeof ctx & {
        agentId?: string;
        runId?: string;
        taskId?: string;
      };
      const store = await getStore(ctx.cwd);
      const goalStore = store.getGoalStore();
      const status = params.status ?? "active";
      const goals = status === "all" ? await goalStore.listGoals() : await goalStore.listGoals({ status });
      const activeCount = (await goalStore.listGoals({ status: "active" })).length;
      const softWarning = activeCount >= GOAL_LIST_SOFT_WARNING_THRESHOLD;
      const goalEntries = goals.map(buildGoalListEntry);

      emitGoalRetrievalAudit(store, fnCtx, {
        toolName: "fn_goal_list",
        resultCount: goals.length,
        goalIds: goals.map((goal) => goal.id),
      });

      const lines: string[] = [];
      lines.push(`Goals (${goals.length}) [filter: ${status}]`);
      lines.push(`Active: ${activeCount}/${GOAL_LIST_HARD_LIMIT}`);
      if (softWarning) {
        lines.push(`⚠  ${GOAL_LIST_SOFT_WARNING_THRESHOLD}/${GOAL_LIST_HARD_LIMIT} active goals — soft warning at ${GOAL_LIST_SOFT_WARNING_THRESHOLD}, hard cap at ${GOAL_LIST_HARD_LIMIT}`);
      }
      lines.push("");
      if (goalEntries.length === 0) {
        lines.push("No goals found.");
      } else {
        lines.push(...goalEntries.map(formatGoalListLine));
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { goals: goalEntries, activeCount, softWarning, hardLimit: GOAL_LIST_HARD_LIMIT },
      };
    },
  });

  pi.registerTool({
    name: "fn_goal_create",
    label: "fn: Create Goal",
    description: "Create a new project goal.",
    promptSnippet: "Create a new goal",
    promptGuidelines: [
      "Use clear titles and optional context-rich descriptions",
      "Goal creation counts toward the 5 active-goal hard cap",
      "Archive older goals when the active cap is reached",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Goal title — brief but descriptive" }),
      description: Type.Optional(
        Type.String({ description: "Long-form goal description (free-text markdown)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const goalStore = store.getGoalStore();

      try {
        const goal = await goalStore.createGoal({
          title: params.title.trim(),
          description: params.description?.trim() || undefined,
        });
        const activeCount = (await goalStore.listGoals({ status: "active" })).length;
        const softWarning = activeCount >= 3;

        return {
          content: [{ type: "text", text: `Created ${goal.id}: ${goal.title}\nStatus: ${goal.status}${softWarning ? `\n⚠  ${activeCount}/5 active goals — approaching hard cap` : ""}` }],
          details: { goalId: goal.id, title: goal.title, status: goal.status, softWarning },
        };
      } catch (err) {
        if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ACTIVE_GOAL_LIMIT_EXCEEDED") {
          const limit = (err as { limit?: number }).limit ?? 5;
          const currentActive = (err as { currentActive?: number }).currentActive ?? 5;
          return {
            isError: true,
            content: [{ type: "text", text: `Cannot create goal — already at the hard cap of 5 active goals (currently ${currentActive}). Archive one first.` }],
            details: { code: "ACTIVE_GOAL_LIMIT_EXCEEDED", limit, currentActive },
          };
        }
        throw err;
      }
    },
  });

  pi.registerTool({
    name: "fn_goal_archive",
    label: "fn: Archive Goal",
    description: "Archive a goal by ID.",
    promptSnippet: "Archive a goal by ID",
    promptGuidelines: [
      "Use when a goal is complete or no longer active",
      "Archiving frees active-goal capacity",
      "Returns success for already archived goals",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Goal ID (G-…) to archive" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const goalStore = store.getGoalStore();
      const goal = await goalStore.getGoal(params.id);

      if (!goal) {
        return {
          isError: true,
          content: [{ type: "text", text: `Goal ${params.id} not found` }],
          details: { code: "GOAL_NOT_FOUND", goalId: params.id },
        };
      }

      if (goal.status === "archived") {
        return {
          content: [{ type: "text", text: `Goal ${params.id} is already archived` }],
          details: { goalId: params.id, status: "archived" },
        };
      }

      const archived = await goalStore.archiveGoal(params.id);
      return {
        content: [{ type: "text", text: `Archived ${archived.id}: ${archived.title}` }],
        details: { goalId: archived.id, status: "archived" },
      };
    },
  });

  pi.registerTool({
    name: "fn_goal_show",
    label: "fn: Show Goal",
    description: "Show full details for a single goal by ID.",
    promptSnippet: "Show goal details by ID",
    promptGuidelines: [
      "Use to inspect a specific goal after listing or referencing its ID",
      "Cite the goal ID and status when summarizing or planning from this output",
      "Read-only retrieval; does not mutate goals",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Goal ID (G-…)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fnCtx = ctx as typeof ctx & {
        agentId?: string;
        runId?: string;
        taskId?: string;
      };
      const store = await getStore(ctx.cwd);
      const goalStore = store.getGoalStore();
      const goal = await goalStore.getGoal(params.id);

      if (!goal) {
        emitGoalRetrievalAudit(store, fnCtx, {
          toolName: "fn_goal_show",
          resultCount: 0,
          goalId: params.id,
          goalIds: [],
          notFound: true,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Goal ${params.id} not found` }],
          details: { code: "GOAL_NOT_FOUND", goalId: params.id },
        };
      }

      const lines: string[] = [];
      lines.push(`${goal.id}: ${goal.title}`);
      lines.push(`Status: ${goal.status}`);
      lines.push(`Created: ${goal.createdAt}`);
      lines.push(`Updated: ${goal.updatedAt}`);
      if (goal.description) {
        lines.push(`Description: ${goal.description}`);
      }

      emitGoalRetrievalAudit(store, fnCtx, {
        toolName: "fn_goal_show",
        resultCount: 1,
        goalId: params.id,
        goalIds: [params.id],
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { goal },
      };
    },
  });

  // ── fn_mission_show ──────────────────────────────────────────────

  pi.registerTool({
    name: "fn_mission_show",
    label: "fn: Show Mission",
    description: "Show mission details with full hierarchy: milestones → slices → features.",
    promptSnippet: "Show mission details with hierarchy",
    promptGuidelines: [
      "Use to see the full mission structure before planning work",
      "Shows milestones, slices, and features in hierarchical order",
      "Check slice status to see if features can be linked to tasks",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Mission ID (e.g., M-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const mission = await missionStore.getMissionWithHierarchy(params.id);
      if (!mission) {
        return {
          content: [{ type: "text", text: `Mission ${params.id} not found` }],
          isError: true,
          details: { error: "Mission not found" },
        };
      }

      const lines: string[] = [];
      const renderGateLine = (indent: string, label: string, value: string | undefined) => {
        const trimmed = value?.trim();
        if (!trimmed) return;
        if (trimmed.length > 240) {
          lines.push(`${indent}${label} ${trimmed.slice(0, 240)}… (truncated, ${trimmed.length} chars)`);
          return;
        }
        lines.push(`${indent}${label} ${trimmed}`);
      };

      lines.push(`${mission.id}: ${mission.title}`);
      lines.push(`Status: ${mission.status}`);
      if (mission.description) {
        lines.push(`Description: ${mission.description}`);
      }
      lines.push("");

      lines.push("Linked Goals:");
      if ((mission.linkedGoals?.length ?? 0) === 0) {
        lines.push("No linked goals.");
      } else {
        for (const goal of mission.linkedGoals ?? []) {
          lines.push(`- ${goal.id}: ${goal.title}`);
        }
      }
      lines.push("");

      if (mission.milestones.length === 0) {
        lines.push("No milestones yet.");
      } else {
        lines.push("Milestones:");
        for (const milestone of mission.milestones) {
          const mIcon = milestone.status === "complete" ? "✓" : milestone.status === "active" ? "●" : "○";
          lines.push(`  ${mIcon} ${milestone.id}: ${milestone.title} (${milestone.status})`);
          renderGateLine("    ", "AC:", milestone.acceptanceCriteria);

          for (const slice of milestone.slices) {
            const sIcon = slice.status === "complete" ? "✓" : slice.status === "active" ? "●" : "○";
            lines.push(`    ${sIcon} ${slice.id}: ${slice.title} (${slice.status})`);
            renderGateLine("      ", "Verification:", slice.verification);

            for (const feature of slice.features) {
              const fIcon = feature.status === "done" ? "✓" : feature.status === "in-progress" ? "▸" : feature.status === "triaged" ? "●" : "○";
              const taskLink = feature.taskId ? ` → ${feature.taskId}` : "";
              lines.push(`      ${fIcon} ${feature.id}: ${feature.title} (${feature.status})${taskLink}`);
              renderGateLine("        ", "AC:", feature.acceptanceCriteria);
            }
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { mission },
      };
    },
  });

  // ── fn_mission_list_goals ─────────────────────────────────────

  pi.registerTool({
    name: "fn_mission_list_goals",
    label: "fn: List Mission Goals",
    description: "List goals linked to a mission.",
    promptSnippet: "List goals linked to a mission",
    promptGuidelines: [
      "Use after fn_mission_list or fn_mission_show when you need goal linkage details",
      "Returns linked goals in mission-link order",
      "Prefer this before linking or unlinking to avoid duplicate work",
    ],
    parameters: Type.Object({
      missionId: Type.String({ description: "Mission ID (e.g., M-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();
      const goalStore = store.getGoalStore();
      const mission = await missionStore.getMission(params.missionId);

      if (!mission) {
        return {
          content: [{ type: "text", text: `Mission ${params.missionId} not found` }],
          isError: true,
          details: { code: "MISSION_NOT_FOUND", missionId: params.missionId },
        };
      }

      const goals = (await Promise.all(
        (await missionStore.listGoalIdsForMission(params.missionId)).map((goalId) => goalStore.getGoal(goalId)),
      )).filter((goal): goal is NonNullable<typeof goal> => Boolean(goal));

      const lines = [`Linked goals for ${mission.id}: ${mission.title}`];
      if (goals.length === 0) {
        lines.push("No linked goals.");
      } else {
        for (const goal of goals) {
          const description = goal.description ? ` — ${goal.description}` : "";
          lines.push(`- ${goal.id} [${goal.status}] ${goal.title}${description}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          missionId: mission.id,
          missionTitle: mission.title,
          goals,
        },
      };
    },
  });

  // ── fn_mission_link_goal ───────────────────────────────────────

  pi.registerTool({
    name: "fn_mission_link_goal",
    label: "fn: Link Mission Goal",
    description: "Link a goal to a mission.",
    promptSnippet: "Link a goal to a mission",
    promptGuidelines: [
      "Use after confirming both the mission and goal IDs",
      "Idempotent: linking an already-linked goal is safe",
      "Use fn_mission_list_goals afterward to verify the resulting set",
    ],
    parameters: Type.Object({
      missionId: Type.String({ description: "Mission ID (e.g., M-001)" }),
      goalId: Type.String({ description: "Goal ID (e.g., G-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();
      const goalStore = store.getGoalStore();
      const mission = await missionStore.getMission(params.missionId);
      if (!mission) {
        return {
          content: [{ type: "text", text: `Mission ${params.missionId} not found` }],
          isError: true,
          details: { code: "MISSION_NOT_FOUND", missionId: params.missionId },
        };
      }

      const goal = await goalStore.getGoal(params.goalId);
      if (!goal) {
        return {
          content: [{ type: "text", text: `Goal ${params.goalId} not found` }],
          isError: true,
          details: { code: "GOAL_NOT_FOUND", goalId: params.goalId },
        };
      }
      if (goal.status === "archived") {
        return {
          content: [{ type: "text", text: `Goal ${params.goalId} is archived and cannot be linked` }],
          isError: true,
          details: { code: "GOAL_ARCHIVED", goalId: params.goalId },
        };
      }

      await missionStore.linkGoal(params.missionId, params.goalId);
      const goals = (await Promise.all(
        (await missionStore.listGoalIdsForMission(params.missionId)).map((goalId) => goalStore.getGoal(goalId)),
      )).filter((linkedGoal): linkedGoal is NonNullable<typeof linkedGoal> => Boolean(linkedGoal));

      return {
        content: [{ type: "text", text: `Linked ${goal.id}: ${goal.title} → ${mission.id}` }],
        details: {
          missionId: mission.id,
          missionTitle: mission.title,
          goal,
          goals,
        },
      };
    },
  });

  // ── fn_mission_unlink_goal ─────────────────────────────────────

  pi.registerTool({
    name: "fn_mission_unlink_goal",
    label: "fn: Unlink Mission Goal",
    description: "Unlink a goal from a mission.",
    promptSnippet: "Unlink a goal from a mission",
    promptGuidelines: [
      "Use when a goal no longer belongs on a mission",
      "Idempotent: unlinking an absent link is safe",
      "Returns the remaining linked goals for quick verification",
    ],
    parameters: Type.Object({
      missionId: Type.String({ description: "Mission ID (e.g., M-001)" }),
      goalId: Type.String({ description: "Goal ID (e.g., G-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();
      const goalStore = store.getGoalStore();
      const mission = await missionStore.getMission(params.missionId);
      if (!mission) {
        return {
          content: [{ type: "text", text: `Mission ${params.missionId} not found` }],
          isError: true,
          details: { code: "MISSION_NOT_FOUND", missionId: params.missionId },
        };
      }

      const goal = await goalStore.getGoal(params.goalId);
      if (!goal) {
        return {
          content: [{ type: "text", text: `Goal ${params.goalId} not found` }],
          isError: true,
          details: { code: "GOAL_NOT_FOUND", goalId: params.goalId },
        };
      }

      await missionStore.unlinkGoal(params.missionId, params.goalId);
      const goals = (await Promise.all(
        (await missionStore.listGoalIdsForMission(params.missionId)).map((goalId) => goalStore.getGoal(goalId)),
      )).filter((linkedGoal): linkedGoal is NonNullable<typeof linkedGoal> => Boolean(linkedGoal));

      return {
        content: [{ type: "text", text: `Unlinked ${goal.id}: ${goal.title} from ${mission.id}` }],
        details: {
          missionId: mission.id,
          missionTitle: mission.title,
          goal,
          goals,
        },
      };
    },
  });

  // ── fn_mission_backfill_assertions ─────────────────────────────

  pi.registerTool({
    name: "fn_mission_backfill_assertions",
    label: "fn: Backfill Mission Assertions",
    description:
      "Backfill mission assertions by deriving and linking one store-managed assertion for each feature without linked assertions. Supports dry-run mode.",
    promptSnippet: "Backfill mission assertions for unlinked features",
    promptGuidelines: [
      "Use dryRun=true first to inspect proposed repairs before applying",
      "Scopes to a single mission when missionId is provided; otherwise scans all missions",
      "Creates one store-managed assertion per unlinked feature and links it",
    ],
    parameters: Type.Object({
      missionId: Type.Optional(Type.String({ description: "Mission ID to scope backfill to (e.g., M-001)" })),
      dryRun: Type.Optional(Type.Boolean({ description: "When true, preview repairs without writing changes (default: true)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();
      const report = await missionStore.backfillFeatureAssertions({
        missionId: params.missionId,
        dryRun: params.dryRun ?? true,
      });

      const scopeLabel = params.missionId ? `mission ${params.missionId}` : "all missions";
      const modeLabel = (params.dryRun ?? true) ? "dry-run" : "apply";
      const lines = [
        `Backfill ${modeLabel} complete for ${scopeLabel}.`,
        `Scanned: ${report.scanned}`,
        `Already linked: ${report.alreadyLinked}`,
        `Repaired: ${report.repaired.length}`,
        `Skipped errors: ${report.skippedErrors.length}`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: report,
      };
    },
  });

  // ── fn_mission_delete ───────────────────────────────────────────

  pi.registerTool({
    name: "fn_mission_delete",
    label: "fn: Delete Mission",
    description: "Delete a mission and all its milestones, slices, and features. Cannot be undone.",
    promptSnippet: "Delete a mission and all its contents",
    promptGuidelines: [
      "Use for cleaning up test missions or mistakenly created missions",
      "Permanently deletes all milestones, slices, and features within the mission",
      "Tasks linked to features are NOT deleted — only the feature links are removed",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Mission ID to delete (e.g., M-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: hard-withheld from agent/ambiguous principals; operators unaffected.
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_mission_delete", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const mission = await missionStore.getMission(params.id);
      if (!mission) {
        return {
          content: [{ type: "text", text: `Mission ${params.id} not found` }],
          isError: true,
          details: { error: "Mission not found" },
        };
      }

      await missionStore.deleteMission(params.id);

      return {
        content: [{ type: "text", text: `Deleted ${params.id}: "${mission.title}"` }],
        details: { missionId: params.id, title: mission.title },
      };
    },
  });

  // ── fn_mission_set_status ───────────────────────────────────────
  pi.registerTool({
    name: "fn_mission_set_status", label: "fn: Set Mission Status", description: "Set a mission lifecycle status.", promptSnippet: "Set a mission status", promptGuidelines: ["Use lifecycle statuses only"],
    parameters: Type.Object({ id: Type.String(), status: Type.Union(fusionCore.MISSION_STATUSES.map((status) => Type.Literal(status))), reason: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!fusionCore.MISSION_STATUSES.includes(params.status)) return { content: [{ type: "text", text: `Invalid status. Must be one of: ${fusionCore.MISSION_STATUSES.join(", ")}` }], isError: true, details: { error: "Invalid status" } };
      const missionStore = (await getStore(ctx.cwd)).getMissionStore();
      try { const mission = await missionStore.updateMission(params.id, { status: params.status }, { actor: missionTransitionActor(ctx), reason: params.reason }); return { content: [{ type: "text", text: `Set ${mission.id} status to ${mission.status}` }], details: { mission } }; }
      catch (error) { const message = error instanceof Error ? error.message : String(error); return { content: [{ type: "text", text: message }], isError: true, details: { error: message } }; }
    },
  });

  /*
   * FNXC:MissionBlockedRepair 2026-08-11-03:58:
   * Clear repairs a stale blocked badge without re-arming automation. Because it overrides a
   * durable pause, stop, or manual PATCH signal, it is operator-only and absent from
   * createMissionTools so engine lanes and dashboard chat never receive it.
   */
  // ── fn_mission_clear_blocked ─────────────────────────────────────
  pi.registerTool({
    name: "fn_mission_clear_blocked",
    label: "fn: Clear Mission Blocked Status",
    description: "Clear a stale mission-level blocked badge without resuming automation.",
    promptSnippet: "Clear a stale mission blocked badge",
    promptGuidelines: [
      "Repairs the badge only; it does not resume mission automation",
      "Use Resume mission as the only path that re-arms automation",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Mission ID (e.g., M-001)" }),
      reason: Type.Optional(Type.String({ description: "Why the badge is stale (audit-logged)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_mission_clear_blocked", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      const missionStore = (await getStore(ctx.cwd)).getMissionStore();
      if (!("clearMissionBlockedStatus" in missionStore)) {
        return { content: [{ type: "text", text: "Clearing mission blocked status requires the PostgreSQL mission store" }], isError: true, details: { code: "POSTGRES_REQUIRED" } };
      }
      const mission = await missionStore.getMission(params.id);
      if (!mission) {
        return { content: [{ type: "text", text: `Mission ${params.id} not found` }], isError: true, details: { code: "MISSION_NOT_FOUND" } };
      }
      try {
        const { mission: clearedMission, blockers } = await missionStore.clearMissionBlockedStatus(params.id, {
          actor: missionTransitionActor(ctx),
          reason: params.reason,
        });
        const residualWarning = blockers.length > 0
          ? `\n${blockers.length} blocker(s) remain; automation stays gated until they are resolved or the mission is resumed.`
          : "";
        return {
          content: [{ type: "text", text: `Cleared blocked status for ${params.id} → ${clearedMission.status}${residualWarning}` }],
          details: { mission: clearedMission, blockers },
        };
      } catch (error) {
        if (error instanceof fusionCore.MissionBlockedClearConflictError) {
          return { content: [{ type: "text", text: `Mission ${params.id} is not blocked (status: ${error.status})` }], isError: true, details: { code: "MISSION_NOT_BLOCKED", status: error.status } };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true, details: { error: message } };
      }
    },
  });

  // ── fn_mission_update ───────────────────────────────────────────

  pi.registerTool({
    name: "fn_mission_update",
    label: "fn: Update Mission",
    description:
      "Update an existing mission's title or description. " +
      "Partial patches leave untouched fields intact.",
    promptSnippet: "Update an existing mission",
    promptGuidelines: [
      "Use to revise mission framing without re-creating the mission",
      "Mission hierarchy and ordering are preserved",
      "Provide only the fields you want to change",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Mission ID to update (e.g., M-001)" }),
      title: Type.Optional(Type.String({ description: "Updated mission title" })),
      description: Type.Optional(Type.String({ description: "Updated mission description" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const existingMission = await missionStore.getMission(params.id);
      if (!existingMission) {
        return {
          content: [{ type: "text", text: `Mission ${params.id} not found` }],
          isError: true,
          details: { error: "Mission not found" },
        };
      }

      const updates: { title?: string; description?: string } = {};

      if ("title" in params) {
        updates.title = params.title?.trim();
      }
      if ("description" in params) {
        updates.description = params.description?.trim();
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields to update (provide at least one of: title, description)",
            },
          ],
          isError: true,
          details: { error: "No fields to update" },
        };
      }

      const mission = await missionStore.updateMission(params.id, updates, { actor: missionTransitionActor(ctx) });

      return {
        content: [{ type: "text", text: `Updated ${mission.id}: "${mission.title}"` }],
        details: {
          missionId: mission.id,
          title: mission.title,
          description: mission.description,
          status: mission.status,
        },
      };
    },
  });

  // ── fn_milestone_add ────────────────────────────────────────────

  pi.registerTool({
    name: "fn_milestone_add",
    label: "fn: Add Milestone",
    description: "Add a milestone to a mission. Milestones represent phases of work.",
    promptSnippet: "Add a milestone to a mission",
    promptGuidelines: [
      "Use to break down a mission into manageable phases",
      "Milestones are ordered and contain slices (work units)",
    ],
    parameters: Type.Object({
      missionId: Type.String({ description: "Parent mission ID (e.g., M-001)" }),
      title: Type.String({ description: "Milestone title" }),
      description: Type.Optional(Type.String({ description: "Milestone description" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const mission = await missionStore.getMission(params.missionId);
      if (!mission) {
        return {
          content: [{ type: "text", text: `Mission ${params.missionId} not found` }],
          isError: true,
          details: { error: "Mission not found" },
        };
      }

      const milestone = await missionStore.addMilestone(params.missionId, {
        title: params.title.trim(),
        description: params.description?.trim(),
      });

      return {
        content: [
          { type: "text", text: `Added ${milestone.id}: "${milestone.title}" to ${params.missionId}` },
        ],
        details: { milestoneId: milestone.id, missionId: params.missionId, title: milestone.title },
      };
    },
  });

  // ── fn_slice_add ─────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_slice_add",
    label: "fn: Add Slice",
    description: "Add a slice to a milestone. Slices are work units that can be activated for implementation.",
    promptSnippet: "Add a work slice to a milestone",
    promptGuidelines: [
      "Slices represent work units within a milestone",
      "Slices are activated for implementation, linking features to tasks",
      "Order slices by priority — they execute in sequence",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Parent milestone ID (e.g., MS-001)" }),
      title: Type.String({ description: "Slice title" }),
      description: Type.Optional(Type.String({ description: "Slice description" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const milestone = await missionStore.getMilestone(params.milestoneId);
      if (!milestone) {
        return {
          content: [{ type: "text", text: `Milestone ${params.milestoneId} not found` }],
          isError: true,
          details: { error: "Milestone not found" },
        };
      }

      const slice = await missionStore.addSlice(params.milestoneId, {
        title: params.title.trim(),
        description: params.description?.trim(),
      });

      return {
        content: [
          { type: "text", text: `Added ${slice.id}: "${slice.title}" to ${params.milestoneId}` },
        ],
        details: { sliceId: slice.id, milestoneId: params.milestoneId, title: slice.title },
      };
    },
  });

  // ── fn_feature_add ────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_feature_add",
    label: "fn: Add Feature",
    description: "Add a feature to a slice. Features are deliverables that can be linked to tasks.",
    promptSnippet: "Add a feature to a slice",
    promptGuidelines: [
      "Features represent deliverables within a slice",
      "Features start as 'defined' and progress through 'triaged' → 'in-progress' → 'done'",
      "Link features to tasks using fn_feature_link_task",
    ],
    parameters: Type.Object({
      sliceId: Type.String({ description: "Parent slice ID (e.g., SL-001)" }),
      title: Type.String({ description: "Feature title" }),
      description: Type.Optional(Type.String({ description: "Feature description" })),
      acceptanceCriteria: Type.Optional(
        Type.String({ description: "Acceptance criteria for completing the feature" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const slice = await missionStore.getSlice(params.sliceId);
      if (!slice) {
        return {
          content: [{ type: "text", text: `Slice ${params.sliceId} not found` }],
          isError: true,
          details: { error: "Slice not found" },
        };
      }

      const feature = await missionStore.addFeature(params.sliceId, {
        title: params.title.trim(),
        description: params.description?.trim(),
        acceptanceCriteria: params.acceptanceCriteria?.trim(),
      });

      return {
        content: [
          { type: "text", text: `Added ${feature.id}: "${feature.title}" to ${params.sliceId}` },
        ],
        details: { featureId: feature.id, sliceId: params.sliceId, title: feature.title },
      };
    },
  });

  // ── fn_feature_delete ────────────────────────────────────────────

  pi.registerTool({
    name: "fn_feature_delete",
    label: "fn: Delete Feature",
    description: "Delete a feature. Rejects deletion when linked to a live task unless force=true.",
    promptSnippet: "Delete a mission feature",
    promptGuidelines: [
      "Use force=true only when intentionally overriding linked live-task guards",
      "Deleting a feature is permanent and cannot be undone",
    ],
    parameters: Type.Object({
      featureId: Type.String({ description: "Feature ID to delete (e.g., F-001)" }),
      force: Type.Optional(Type.Boolean({ description: "Override linked-task guard" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: hard-withheld from agent/ambiguous principals; operators unaffected.
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_feature_delete", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      try {
        await missionStore.deleteFeature(params.featureId, params.force === true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: { error: message },
        };
      }

      return {
        content: [{ type: "text", text: `Deleted ${params.featureId}` }],
        details: { featureId: params.featureId, force: params.force === true },
      };
    },
  });

  // ── fn_slice_delete ────────────────────────────────────────────

  pi.registerTool({
    name: "fn_slice_delete",
    label: "fn: Delete Slice",
    description: "Delete a slice and its features. Rejects deletion when child features link to live tasks unless force=true.",
    promptSnippet: "Delete a mission slice",
    parameters: Type.Object({
      sliceId: Type.String({ description: "Slice ID to delete (e.g., SL-001)" }),
      force: Type.Optional(Type.Boolean({ description: "Override linked-task guard" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: hard-withheld from agent/ambiguous principals; operators unaffected.
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_slice_delete", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      try {
        await missionStore.deleteSlice(params.sliceId, params.force === true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: { error: message },
        };
      }

      return {
        content: [{ type: "text", text: `Deleted ${params.sliceId}` }],
        details: { sliceId: params.sliceId, force: params.force === true },
      };
    },
  });

  // ── fn_milestone_delete ────────────────────────────────────────────

  pi.registerTool({
    name: "fn_milestone_delete",
    label: "fn: Delete Milestone",
    description: "Delete a milestone and all descendant slices/features. Rejects deletion when child features link to live tasks unless force=true.",
    promptSnippet: "Delete a mission milestone",
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID to delete (e.g., MS-001)" }),
      force: Type.Optional(Type.Boolean({ description: "Override linked-task guard" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: hard-withheld from agent/ambiguous principals; operators unaffected.
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_milestone_delete", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      try {
        await missionStore.deleteMilestone(params.milestoneId, params.force === true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: { error: message },
        };
      }

      return {
        content: [{ type: "text", text: `Deleted ${params.milestoneId}` }],
        details: { milestoneId: params.milestoneId, force: params.force === true },
      };
    },
  });

  // ── fn_slice_activate ────────────────────────────────────────────

  pi.registerTool({
    name: "fn_slice_activate",
    label: "fn: Activate Slice",
    description:
      "Activate a pending slice for implementation. " +
      "Sets status to 'active' and enables task linking for its features.",
    promptSnippet: "Activate a slice for implementation",
    promptGuidelines: [
      "Activating a slice allows its features to be linked to tasks",
      "Only pending slices can be activated",
      "Slice activation triggers auto-advance when linked tasks complete",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Slice ID to activate (e.g., SL-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const slice = await missionStore.getSlice(params.id);
      if (!slice) {
        return {
          content: [{ type: "text", text: `Slice ${params.id} not found` }],
          isError: true,
          details: { error: "Slice not found" },
        };
      }

      if (slice.status !== "pending") {
        return {
          content: [{ type: "text", text: `Slice ${params.id} is not pending (status: ${slice.status})` }],
          isError: true,
          details: { error: "Slice not pending", currentStatus: slice.status },
        };
      }

      const activated = await missionStore.activateSlice(params.id);

      return {
        content: [
          {
            type: "text",
            text: `Activated ${activated.id}: "${activated.title}"\nStatus: ${activated.status}`,
          },
        ],
        details: { sliceId: activated.id, title: activated.title, status: activated.status },
      };
    },
  });

  // ── fn_feature_link_task ──────────────────────────────────────────

  pi.registerTool({
    name: "fn_feature_link_task",
    label: "fn: Link Feature to Task",
    description:
      "Link a feature to a fn task for implementation. " +
      "Updates the feature status to 'triaged' and associates it with the task. " +
      "If the target task is not on the active board (for example deleted, historical, or never created), " +
      "the tool returns a clear validation error indicating that only active tasks can be linked.",
    promptSnippet: "Link a feature to a task",
    promptGuidelines: [
      "Use when a feature is ready for implementation and has a corresponding task",
      "The feature's slice must be active to link tasks",
      "Linking updates the feature status to 'triaged'",
      "When the linked task moves to 'done', the feature status becomes 'done'",
    ],
    parameters: Type.Object({
      featureId: Type.String({ description: "Feature ID to link (e.g., F-001)" }),
      taskId: Type.String({ description: "Task ID to link to (e.g., FN-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const feature = await missionStore.getFeature(params.featureId);
      if (!feature) {
        return {
          content: [{ type: "text", text: `Feature ${params.featureId} not found` }],
          isError: true,
          details: { error: "Feature not found" },
        };
      }

      // Check if task exists
      try {
        await store.getTask(params.taskId);
      } catch {
        return {
          content: [{ type: "text", text: `Task ${params.taskId} not found` }],
          isError: true,
          details: { error: "Task not found" },
        };
      }

      try {
        // FNXC:MissionToolParity 2026-07-29-12:00: linkFeatureToTask owns both feature and project-scoped task linkage; do not duplicate a route/tool-level slice update.
        const updated = await missionStore.linkFeatureToTask(params.featureId, params.taskId);

        return {
          content: [
            {
              type: "text",
              text: `Linked ${updated.id}: "${updated.title}" → ${params.taskId}\nStatus: ${updated.status}`,
            },
          ],
          details: { featureId: updated.id, taskId: params.taskId, title: updated.title, status: updated.status },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: { error: message },
        };
      }
    },
  });

  // ── fn_feature_repoint_task ────────────────────────────────────
  pi.registerTool({
    name: "fn_feature_repoint_task",
    label: "fn: Re-point Feature to Task",
    description:
      "Atomically re-point an already-linked feature's single-valued taskId to a different task. " +
      "Corrects a feature pinned to the wrong task (for example a shared vision doc) without the status-lossy " +
      "unlink then link two-step. The target task must be live; same-task re-point is an idempotent no-op.",
    promptSnippet: "Re-point a feature to a different task",
    promptGuidelines: [
      "Use when a feature is linked to the wrong task and should point at a different delivery task",
      "The target task must be active; re-point fails with a clear error otherwise",
      "A task already linked to another feature rejects the re-point with a conflict error",
      "Same-task re-point is a safe idempotent no-op",
    ],
    parameters: Type.Object({
      featureId: Type.String({ description: "Feature ID to re-point (e.g., F-001)" }),
      taskId: Type.String({ description: "Task ID to re-point to (e.g., FN-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const feature = await missionStore.getFeature(params.featureId);
      if (!feature) {
        return {
          content: [{ type: "text", text: `Feature ${params.featureId} not found` }],
          isError: true,
          details: { error: "Feature not found" },
        };
      }

      try {
        const updated = await missionStore.repointFeatureToTask(params.featureId, params.taskId);
        return {
          content: [
            {
              type: "text",
              text: `Re-pointed ${updated.id}: "${updated.title}" → ${params.taskId}\nStatus: ${updated.status}`,
            },
          ],
          details: { featureId: updated.id, taskId: params.taskId, title: updated.title, status: updated.status },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: { error: message },
        };
      }
    },
  });

  // ── fn_feature_unlink_task ─────────────────────────────────────
  pi.registerTool({
    name: "fn_feature_unlink_task",
    label: "fn: Unlink Feature from Task",
    description:
      "Detach a feature from its linked task entirely, clearing its single-valued taskId and demoting its status " +
      "to 'defined'. Use before the documented safe duplicate-cleanup and reconcile-done flow. Returns a clear error " +
      "if the feature is not currently linked to any task.",
    promptSnippet: "Unlink a feature from its task",
    promptGuidelines: [
      "Use to fully detach a feature from its current task before re-linking or cleaning up a duplicate",
      "Fails with a clear error if the feature is not linked to any task",
      "Clears the old task's reverse mission/slice linkage and demotes the feature to 'defined'",
      "Prefer fn_feature_repoint_task to move a link directly without the status loss",
    ],
    parameters: Type.Object({
      featureId: Type.String({ description: "Feature ID to unlink (e.g., F-001)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const feature = await missionStore.getFeature(params.featureId);
      if (!feature) {
        return {
          content: [{ type: "text", text: `Feature ${params.featureId} not found` }],
          isError: true,
          details: { error: "Feature not found" },
        };
      }

      try {
        const updated = await missionStore.unlinkFeatureFromTask(params.featureId);
        return {
          content: [
            {
              type: "text",
              text: `Unlinked ${updated.id}: "${updated.title}" from its task\nStatus: ${updated.status}`,
            },
          ],
          details: { featureId: updated.id, title: updated.title, status: updated.status },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: { error: message },
        };
      }
    },
  });

  // ── fn_feature_set_status ───────────────────────────────────────
  /* FNXC:MissionStatusWrites 2026-08-10-12:47: Dedicated tools keep the linked-task execution-status guard unambiguous instead of widening generic updates. */
  pi.registerTool({
    name: "fn_feature_set_status", label: "fn: Set Feature Status", description: "Set a feature lifecycle status.", promptSnippet: "Set a feature status", promptGuidelines: ["Link a task before execution statuses"],
    parameters: Type.Object({ id: Type.String(), status: Type.Union(fusionCore.FEATURE_STATUSES.map((status) => Type.Literal(status))), reason: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!fusionCore.FEATURE_STATUSES.includes(params.status)) return { content: [{ type: "text", text: `Invalid status. Must be one of: ${fusionCore.FEATURE_STATUSES.join(", ")}` }], isError: true, details: { error: "Invalid status" } };
      const missionStore = (await getStore(ctx.cwd)).getMissionStore(); const feature = await missionStore.getFeature(params.id);
      if (!feature) return { content: [{ type: "text", text: `Feature ${params.id} not found` }], isError: true, details: { error: "Feature not found" } };
      if ((["triaged", "in-progress", "done", "blocked"] as const).includes(params.status) && !feature.taskId) return { content: [{ type: "text", text: `Cannot set status to '${params.status}' without a linked task. Use the triage endpoint to create and link a task first, or link an existing task via fn_feature_link_task.` }], isError: true, details: { error: "FEATURE_TASK_REQUIRED" } };
      try { const updated = await missionStore.updateFeatureStatus(params.id, params.status, { actor: missionTransitionActor(ctx), reason: params.reason }); return { content: [{ type: "text", text: `Set ${updated.id} status to ${updated.status}` }], details: { feature: updated } }; }
      catch (error) { const message = error instanceof Error ? error.message : String(error); return { content: [{ type: "text", text: message }], isError: true, details: { error: message } }; }
    },
  });

  // ── fn_mission_reconcile ─────────────────────────────────────────
  pi.registerTool({
    name: "fn_mission_reconcile", label: "fn: Reconcile Mission", description: "Reconcile mission state against deterministic delivery ground truth.",
    parameters: Type.Object({ id: Type.Optional(Type.String()), dryRun: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const store = await getStore(ctx.cwd);
        const result = await reconcileMissionState({ taskStore: store, missionStore: store.getMissionStore() }, { missionId: params.id, dryRun: params.dryRun === true, source: "tool", actor: missionTransitionActor(ctx) });
        return { content: [{ type: "text", text: `Reconciled ${params.id ?? "project"}` }], details: result };
      } catch (error) { const message = error instanceof Error ? error.message : String(error); return { content: [{ type: "text", text: message }], isError: true, details: { error: message } }; }
    },
  });

  // ── fn_feature_repair_validation ──────────────────────────────────
  /* FNXC:MissionValidationRepair 2026-08-10-17:20: CLI mirrors the engine tool so either agent surface performs the same fenced, single-retry repair rather than bypassing store validation. */
  pi.registerTool({
    name: "fn_feature_repair_validation", label: "fn: Repair Feature Validation",
    description: "Clear a stale validation badge or re-run validation.", promptSnippet: "Repair a feature validation badge",
    promptGuidelines: ["Use Clear for stale blocked badges", "Use re-run only when validation is not already live"],
    parameters: Type.Object({ id: Type.String(), action: Type.Union([Type.Literal("clear"), Type.Literal("re_run")]), reason: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd); const missionStore = store.getMissionStore();
      if (!("repairFeatureValidationState" in missionStore)) return { content: [{ type: "text", text: "Validation repair requires the PostgreSQL mission store" }], isError: true, details: { code: "POSTGRES_REQUIRED" } };
      const feature = await missionStore.getFeature(params.id);
      if (!feature) return { content: [{ type: "text", text: `Feature ${params.id} not found` }], isError: true, details: { code: "FEATURE_NOT_FOUND" } };
      const eligible = fusionCore.featureValidationRepairEligibility(feature);
      if ((params.action === "clear" && !eligible.clear) || (params.action === "re_run" && !eligible.reRun)) return { content: [{ type: "text", text: `Cannot ${params.action === "clear" ? "clear" : "re-run"} validation for ${feature.id}: current loop state is ${feature.loopState ?? "idle"} and status is ${feature.status}.` }], isError: true, details: { code: "FEATURE_REPAIR_INELIGIBLE" } };
      try {
        if (params.action === "re_run") {
          const repaired = await missionStore.repairFeatureValidationState(params.id, { action: "re_run", actor: missionTransitionActor(ctx), reason: params.reason });
          return { content: [{ type: "text", text: `Re-ran validation for ${params.id}` }], details: repaired };
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const current = await missionStore.getFeature(params.id);
          if (!current) return { content: [{ type: "text", text: `Feature ${params.id} not found` }], isError: true, details: { code: "FEATURE_NOT_FOUND" } };
          const targets = await resolveFeatureRepairTargets(store, current);
          try {
            const repaired = await missionStore.repairFeatureValidationState(params.id, { action: "clear", actor: missionTransitionActor(ctx), reason: params.reason, resolvedStatus: targets.status, resolvedLoopState: targets.resumeImplementation ? "implementing" : "idle", groundTruth: targets.groundTruth });
            return { content: [{ type: "text", text: `Cleared validation state for ${params.id}` }], details: repaired };
          } catch (error) {
            if (!(error instanceof fusionCore.RepairGroundTruthStaleError) || attempt === 1) throw error;
          }
        }
      } catch (error) {
        if (error instanceof fusionCore.RepairGroundTruthStaleError) return { content: [{ type: "text", text: "Linked task state changed while repairing; re-check the feature and retry." }], isError: true, details: { code: "FEATURE_REPAIR_STALE" } };
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true, details: { error: message } };
      }
      return { content: [{ type: "text", text: "Linked task state changed while repairing; re-check the feature and retry." }], isError: true, details: { code: "FEATURE_REPAIR_STALE" } };
    },
  });

  // ── fn_feature_update ─────────────────────────────────────────────

  pi.registerTool({
    name: "fn_feature_update",
    label: "fn: Update Feature",
    description:
      "Update an existing feature's title, description, or acceptance criteria. " +
      "Partial patches leave untouched fields intact.",
    promptSnippet: "Update an existing mission feature",
    promptGuidelines: [
      "Use to revise acceptance criteria after reconciliation without re-creating the feature",
      "Slice ordering and linked tasks are preserved",
      "Provide only the fields you want to change",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Feature ID to update (e.g., F-001)" }),
      title: Type.Optional(Type.String({ description: "Updated feature title" })),
      description: Type.Optional(Type.String({ description: "Updated feature description" })),
      acceptanceCriteria: Type.Optional(
        Type.String({ description: "Updated acceptance criteria for completing the feature" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const existingFeature = await missionStore.getFeature(params.id);
      if (!existingFeature) {
        return {
          content: [{ type: "text", text: `Feature ${params.id} not found` }],
          isError: true,
          details: { error: "Feature not found" },
        };
      }

      const updates: { title?: string; description?: string; acceptanceCriteria?: string } = {};

      if ("title" in params) {
        updates.title = params.title?.trim();
      }
      if ("description" in params) {
        updates.description = params.description?.trim();
      }
      if ("acceptanceCriteria" in params) {
        updates.acceptanceCriteria = params.acceptanceCriteria?.trim();
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields to update (provide at least one of: title, description, acceptanceCriteria)",
            },
          ],
          isError: true,
          details: { error: "No fields to update" },
        };
      }

      const feature = await missionStore.updateFeature(params.id, updates);

      return {
        content: [{ type: "text", text: `Updated ${feature.id}: "${feature.title}"` }],
        details: {
          featureId: feature.id,
          sliceId: feature.sliceId,
          title: feature.title,
          description: feature.description,
          acceptanceCriteria: feature.acceptanceCriteria,
          status: feature.status,
        },
      };
    },
  });

  // ── fn_milestone_update ───────────────────────────────────────────

  pi.registerTool({
    name: "fn_milestone_update",
    label: "fn: Update Milestone",
    description:
      "Update an existing milestone's title, description, or acceptance criteria (the structured pass/fail bar, distinct from verification's free-form how-to-confirm notes). " +
      "Partial patches leave untouched fields intact.",
    promptSnippet: "Update an existing mission milestone",
    promptGuidelines: [
      "Use to revise milestone details without re-creating it",
      "Mission linkage and ordering are preserved",
      "Provide only the fields you want to change",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Milestone ID to update (e.g., MS-001)" }),
      title: Type.Optional(Type.String({ description: "Updated milestone title" })),
      description: Type.Optional(Type.String({ description: "Updated milestone description" })),
      acceptanceCriteria: Type.Optional(
        Type.String({ description: "Updated acceptance criteria for completing the milestone" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await getStore(ctx.cwd);
      const missionStore = store.getMissionStore();

      const existingMilestone = await missionStore.getMilestone(params.id);
      if (!existingMilestone) {
        return {
          content: [{ type: "text", text: `Milestone ${params.id} not found` }],
          isError: true,
          details: { error: "Milestone not found" },
        };
      }

      const updates: { title?: string; description?: string; acceptanceCriteria?: string } = {};

      if ("title" in params) {
        updates.title = params.title?.trim();
      }
      if ("description" in params) {
        updates.description = params.description?.trim();
      }
      if ("acceptanceCriteria" in params) {
        updates.acceptanceCriteria = params.acceptanceCriteria?.trim();
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields to update (provide at least one of: title, description, acceptanceCriteria)",
            },
          ],
          isError: true,
          details: { error: "No fields to update" },
        };
      }

      const milestone = await missionStore.updateMilestone(params.id, updates);

      return {
        content: [{ type: "text", text: `Updated ${milestone.id}: "${milestone.title}"` }],
        details: {
          milestoneId: milestone.id,
          missionId: milestone.missionId,
          title: milestone.title,
          description: milestone.description,
          acceptanceCriteria: milestone.acceptanceCriteria,
          status: milestone.status,
        },
      };
    },
  });

  // ── fn_agent_stop ─────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_agent_stop",
    label: "fn: Stop Agent",
    description:
      "Stop a running agent — pauses its execution without changing assigned task pause state. " +
      "Transitions the agent from running/active to paused state.",
    promptSnippet: "Stop (pause) a running Fusion agent",
    promptGuidelines: [
      "Use to pause an agent that is currently running, active, or in error",
      "Stopped agents can be resumed with fn_agent_start",
      "Agents in 'idle' or already-paused state cannot be stopped",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Agent ID to stop (e.g., agent-abc123)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: policy-gated for agent principals; operators unaffected.
      const gated = await applyAgentPolicyGateForExtensionTool("fn_agent_stop", params as Record<string, unknown>, ctx as ExtensionCallerContext);
      if (gated) return gated;

      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();

      const agent = await agentStore.getAgent(params.id);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Agent ${params.id} not found` }],
          isError: true,
          details: { error: "Agent not found" },
        };
      }

      if (agent.state === "paused") {
        return {
          content: [{ type: "text", text: `Agent ${params.id} is already paused` }],
          details: { agentId: params.id, state: agent.state },
        };
      }

      const validTargets = AGENT_VALID_TRANSITIONS[agent.state];
      if (!validTargets.includes("paused")) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot stop agent ${params.id} — current state '${agent.state}' cannot transition to 'paused'. Valid transitions: ${validTargets.join(", ")}`,
            },
          ],
          isError: true,
          details: { agentId: params.id, currentState: agent.state, validTargets },
        };
      }

      // FNXC:AgentLifecyclePause 2026-07-19-00:00: fn_agent_stop changes
      // only the agent row. Assigned task pause state remains user/system-owned.
      await agentStore.updateAgentState(params.id, "paused");

      return {
        content: [{ type: "text", text: `Stopped ${params.id}` }],
        details: { agentId: params.id, previousState: agent.state, newState: "paused" },
      };
    },
  });

  // ── fn_agent_start ────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_agent_start",
    label: "fn: Start Agent",
    description:
      "Start a stopped agent — resumes its execution without changing assigned task pause state. " +
      "Transitions the agent from paused to active state.",
    promptSnippet: "Start (resume) a stopped Fusion agent",
    promptGuidelines: [
      "Use to resume an agent that has been paused",
      "Only agents in 'paused' state can be started",
      "Agents in 'idle' or 'error' state cannot be started — use reset instead",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Agent ID to start (e.g., agent-abc123)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: policy-gated for agent principals; operators unaffected.
      const gated = await applyAgentPolicyGateForExtensionTool("fn_agent_start", params as Record<string, unknown>, ctx as ExtensionCallerContext);
      if (gated) return gated;

      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();

      const agent = await agentStore.getAgent(params.id);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Agent ${params.id} not found` }],
          isError: true,
          details: { error: "Agent not found" },
        };
      }

      if (agent.state === "active" || agent.state === "running") {
        return {
          content: [{ type: "text", text: `Agent ${params.id} is already running (${agent.state})` }],
          details: { agentId: params.id, state: agent.state },
        };
      }

      const validTargets = AGENT_VALID_TRANSITIONS[agent.state];
      if (!validTargets.includes("active")) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot start agent ${params.id} — current state '${agent.state}' cannot transition to 'active'. Valid transitions: ${validTargets.join(", ")}`,
            },
          ],
          isError: true,
          details: { agentId: params.id, currentState: agent.state, validTargets },
        };
      }

      // FNXC:AgentLifecyclePause 2026-07-19-00:00: fn_agent_start is not a
      // task resume operation, including for a task already assigned to agent.
      await agentStore.updateAgentState(params.id, "active");

      return {
        content: [{ type: "text", text: `Started ${params.id}` }],
        details: { agentId: params.id, previousState: agent.state, newState: "active" },
      };
    },
  });

  // ── fn_agent_create ─────────────────────────────────────────────

  pi.registerTool({
    name: "fn_agent_create",
    label: "fn: Create Agent",
    description: "Create a new non-ephemeral agent.",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name" }),
      role: Type.Optional(Type.Union([
        Type.Literal("triage"),
        Type.Literal("executor"),
        Type.Literal("reviewer"),
        Type.Literal("merger"),
        Type.Literal("scheduler"),
        Type.Literal("engineer"),
        Type.Literal("custom"),
      ], { description: "Deprecated singular role; use roles for multi-role agents." })),
      roles: Type.Optional(Type.Array(Type.Union([
        Type.Literal("triage"), Type.Literal("executor"), Type.Literal("reviewer"),
        Type.Literal("merger"), Type.Literal("scheduler"), Type.Literal("engineer"), Type.Literal("custom"),
      ]), { minItems: 1, description: "Canonical permanent-agent role tags." })),
      soul: Type.Optional(Type.String({ description: "Agent personality/identity text" })),
      instructions_text: Type.Optional(Type.String({ description: "Inline custom instructions" })),
      instructions_path: Type.Optional(Type.String({ description: "Path to instructions markdown" })),
      reportsTo: Type.Optional(Type.String({ description: "Manager agent ID" })),
      heartbeat_interval_ms: Type.Optional(Type.Number({ minimum: 1000 })),
      heartbeat_timeout_ms: Type.Optional(Type.Number({ minimum: 5000 })),
      max_concurrent_runs: Type.Optional(Type.Number({ minimum: 1 })),
      max_workflow_sessions: Type.Optional(Type.Number({ minimum: 1, description: "Max concurrent workflow sessions, independent of heartbeat runs" })),
      message_response_mode: Type.Optional(Type.Union([Type.Literal("immediate"), Type.Literal("on-heartbeat")])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {

      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();
      const store = await getStore(ctx.cwd);
      /*
      FNXC:ToolPermissionGates 2026-07-26-13:55:
      BEHAVIOR CHANGE (honest provisioning caller): this site previously hardcoded
      `{ id: "user", role: "user", isPrivileged: true }`, so an agent session calling this
      tool through the host extension was treated as a privileged human and bypassed the
      provisioning policy entirely. The caller is now principal-derived: operator CLI stays
      privileged (unchanged); agent principals use their real id/role and are NOT privileged;
      ambiguous principals are an unknown, unprivileged agent. Approval requests carry the
      REAL requester snapshot instead of the hardcoded CLI User.
      */
      const provisionPrincipal = resolveExtensionCallerPrincipal(ctx as ExtensionCallerContext);
      let caller: { id: string; role: string; isPrivileged: boolean };
      let provisionRequester: ApprovalRequestActorSnapshot;
      if (provisionPrincipal.kind === "operator") {
        caller = { id: "user", role: "user", isPrivileged: true };
        provisionRequester = { actorId: "user", actorType: "user", actorName: "CLI User" };
      } else {
        const callerAgentId = provisionPrincipal.kind === "agent" ? provisionPrincipal.identity.agentId : AMBIGUOUS_AGENT_PRINCIPAL_ID;
        let callerRow: { name?: string; role?: string } | null = null;
        if (provisionPrincipal.kind === "agent") {
          try {
            callerRow = await agentStore.resolveAgent(callerAgentId);
          } catch {
            callerRow = null;
          }
        }
        const fallbackName = provisionPrincipal.kind === "agent"
          ? provisionPrincipal.identity.agentName ?? callerAgentId
          : callerAgentId;
        caller = { id: callerAgentId, role: callerRow?.role ?? "custom", isPrivileged: false };
        provisionRequester = { actorId: callerAgentId, actorType: "agent", actorName: callerRow?.name ?? fallbackName };
      }
      const policy = resolveAgentProvisioningPolicy({
        tool: "fn_agent_create",
        caller,
        settings: await store.getSettings(),
      });

      if (!caller.isPrivileged && params.reportsTo !== undefined && params.reportsTo !== caller.id) {
        return {
          content: [{ type: "text" as const, text: "ERROR: You can only create agents that report to you" }],
          details: { outcome: "denied", matchedRule: "privileged-caller", effectiveMode: policy.effectiveMode },
        };
      }

      if (policy.decision === "require-approval") {
        const cliLayer2 = requireProjectLayer(store, "CLI agent-create approval store");
        const approvalStore = new ApprovalRequestStore(null, { asyncLayer: cliLayer2 });
        const request = await approvalStore.create({
          requester: provisionRequester,
          targetAction: { category: "agent_provisioning", action: "create", summary: `Create agent ${params.name} (${params.role})`, resourceType: "agent", resourceId: "", context: { tool: "fn_agent_create", params } },
        });
        return { content: [{ type: "text" as const, text: `Approval required. Request ${request.id} created.` }], details: { outcome: "pending_approval", approvalRequestId: request.id, matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode } };
      }

      if (policy.decision === "deny") {
        return {
          content: [{ type: "text" as const, text: `DENIED: agent create blocked by policy (${policy.matchedRule})` }],
          details: { outcome: "denied", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode },
        };
      }

      const runtimeConfig: Record<string, unknown> = {
        ...(params.heartbeat_interval_ms !== undefined ? { heartbeatIntervalMs: params.heartbeat_interval_ms } : {}),
        ...(params.heartbeat_timeout_ms !== undefined ? { heartbeatTimeoutMs: params.heartbeat_timeout_ms } : {}),
        ...(params.max_concurrent_runs !== undefined ? { maxConcurrentRuns: params.max_concurrent_runs } : {}),
        ...(params.max_workflow_sessions !== undefined ? { maxWorkflowSessions: params.max_workflow_sessions } : {}),
        ...(params.message_response_mode !== undefined ? { messageResponseMode: params.message_response_mode } : {}),
      };
      const created = await agentStore.createAgent({
        name: params.name,
        /*
        FNXC:WorkflowAgentRouting 2026-08-07-07:56:
        FN-8764 exposes canonical multi-role creation through the public CLI.
        Singular `role` remains an input-only compatibility seam in AgentStore.
        */
        ...(params.roles !== undefined ? { roles: params.roles as AgentCapability[] } : {}),
        ...(params.role !== undefined ? { role: params.role as AgentCapability } : {}),
        ...(params.soul !== undefined ? { soul: params.soul } : {}),
        ...(params.instructions_text !== undefined ? { instructionsText: params.instructions_text } : {}),
        ...(params.instructions_path !== undefined ? { instructionsPath: params.instructions_path } : {}),
        ...(params.reportsTo !== undefined ? { reportsTo: params.reportsTo } : {}),
        ...(Object.keys(runtimeConfig).length > 0 ? { runtimeConfig } : {}),
      });

      return {
        content: [{ type: "text" as const, text: `Created agent ${created.name} (${created.id})` }],
        details: { outcome: "created", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agent: created, agentId: created.id },
      };
    },
  });

  // ── fn_agent_update ─────────────────────────────────────────────

  /**
   * FNXC:AgentManagement 2026-07-02-12:00:
   * Chat operators need broad in-place edits for existing non-ephemeral agent configuration so they can change role, instructions, manager links, and heartbeat settings without delete/recreate churn.
   * Keep the update org-scoped for agent callers and funnel successful edits through one AgentStore.updateAgent call so hierarchy checks and config revisions stay auditable.
   */
  pi.registerTool({
    name: "fn_agent_update",
    label: "fn: Update Agent",
    description:
      "Update editable configuration for an existing non-ephemeral agent. " +
      "Agent callers can only update direct or indirect reports inside their management subtree; user/operator calls are privileged.",
    promptSnippet: "Update an existing Fusion agent without deleting and recreating it",
    promptGuidelines: [
      "Use to update editable agent configuration such as role, instructions, manager, and heartbeat settings",
      "Agent callers can only target direct or indirect reports, never themselves, peers, ancestors, or unrelated agents",
      "Use reportsTo as an agent ID/name for a new manager; privileged user/operator calls may pass reportsTo: \"\" to clear the manager",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target agent ID or name to update" }),
      name: Type.Optional(Type.String({ description: "New display name" })),
      role: Type.Optional(Type.Union([
        Type.Literal("triage"),
        Type.Literal("executor"),
        Type.Literal("reviewer"),
        Type.Literal("merger"),
        Type.Literal("scheduler"),
        Type.Literal("engineer"),
        Type.Literal("custom"),
      ], { description: "Deprecated singular role; replaces roles for compatibility." })),
      roles: Type.Optional(Type.Array(Type.Union([
        Type.Literal("triage"), Type.Literal("executor"), Type.Literal("reviewer"),
        Type.Literal("merger"), Type.Literal("scheduler"), Type.Literal("engineer"), Type.Literal("custom"),
      ]), { minItems: 1, description: "Canonical permanent-agent role tags." })),
      title: Type.Optional(Type.String({ description: "Optional title shown for the agent" })),
      icon: Type.Optional(Type.String({ description: "Optional compact icon/emoji" })),
      soul: Type.Optional(Type.String({ description: "Agent personality/identity text", maxLength: 10000 })),
      instructions_text: Type.Optional(Type.String({ description: "Inline custom instructions", maxLength: 50000 })),
      instructions_path: Type.Optional(Type.String({ description: "Path to instructions markdown", maxLength: 500 })),
      heartbeat_procedure_path: Type.Optional(Type.String({ description: "Path to heartbeat procedure markdown", maxLength: 500 })),
      reportsTo: Type.Optional(Type.String({ description: "Manager agent ID/name. Pass empty string to clear for privileged user/operator calls." })),
      heartbeat_interval_ms: Type.Optional(Type.Number({ minimum: 1000, description: "Heartbeat polling interval in ms" })),
      heartbeat_timeout_ms: Type.Optional(Type.Number({ minimum: 5000, description: "Heartbeat timeout in ms" })),
      max_concurrent_runs: Type.Optional(Type.Number({ minimum: 1, description: "Max concurrent heartbeat runs" })),
      max_workflow_sessions: Type.Optional(Type.Number({ minimum: 1, description: "Max concurrent workflow sessions, independent of heartbeat runs" })),
      message_response_mode: Type.Optional(Type.Union([
        Type.Literal("immediate"),
        Type.Literal("on-heartbeat"),
      ], { description: "How agent responds to messages" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:PostgresCutover 2026-07-04: every other agent tool uses
      // getAgentStore(cwd) (backend-mode AgentStore via the project asyncLayer);
      // this site was missed and constructed a layerless AgentStore whose SQLite
      // runtime was removed under VAL-REMOVAL-005.
      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();

      const updateParamKeys = [
        "name",
        "role",
        "roles",
        "title",
        "icon",
        "soul",
        "instructions_text",
        "instructions_path",
        "heartbeat_procedure_path",
        "reportsTo",
        "heartbeat_interval_ms",
        "heartbeat_timeout_ms",
        "max_concurrent_runs",
        "max_workflow_sessions",
        "message_response_mode",
      ] as const;
      const providedKeys = updateParamKeys.filter((key) => params[key] !== undefined);
      const invalid = (field: string, message: string, extra: Record<string, unknown> = {}) => ({
        content: [{ type: "text" as const, text: `ERROR: ${message}` }],
        isError: true,
        details: { outcome: "invalid", field, error: message, ...extra },
      });
      const denied = (message: string, extra: Record<string, unknown> = {}) => ({
        content: [{ type: "text" as const, text: `ERROR: ${message}` }],
        isError: true,
        details: { outcome: "denied", error: message, ...extra },
      });

      if (providedKeys.length === 0) {
        return invalid("fields", "Provide at least one field to update");
      }
      if (params.soul !== undefined && params.soul.length > 10000) {
        return invalid("soul", "soul exceeds 10000 character limit");
      }
      if (params.instructions_text !== undefined && params.instructions_text.length > 50000) {
        return invalid("instructions_text", "instructions_text exceeds 50000 character limit");
      }
      if (params.instructions_path !== undefined && params.instructions_path.length > 500) {
        return invalid("instructions_path", "instructions_path exceeds 500 character limit");
      }
      if (params.heartbeat_procedure_path !== undefined && params.heartbeat_procedure_path.length > 500) {
        return invalid("heartbeat_procedure_path", "heartbeat_procedure_path exceeds 500 character limit");
      }
      if (params.heartbeat_interval_ms !== undefined && params.heartbeat_interval_ms < 1000) {
        return invalid("heartbeat_interval_ms", "heartbeat_interval_ms must be at least 1000");
      }
      if (params.heartbeat_timeout_ms !== undefined && params.heartbeat_timeout_ms < 5000) {
        return invalid("heartbeat_timeout_ms", "heartbeat_timeout_ms must be at least 5000");
      }
      if (params.max_concurrent_runs !== undefined && params.max_concurrent_runs < 1) {
        return invalid("max_concurrent_runs", "max_concurrent_runs must be at least 1");
      }
      if (params.max_workflow_sessions !== undefined && params.max_workflow_sessions < 1) {
        return invalid("max_workflow_sessions", "max_workflow_sessions must be at least 1");
      }

      const target = (await agentStore.getAgent(params.agent_id)) ?? (await agentStore.resolveAgent(params.agent_id));
      if (!target) {
        return {
          content: [{ type: "text" as const, text: `Agent '${params.agent_id}' not found` }],
          isError: true,
          details: { outcome: "not_found", error: "Agent not found", agentId: params.agent_id },
        };
      }
      if (isEphemeralAgent(target)) {
        return invalid("agent_id", `Cannot update ephemeral/runtime agent ${target.id}`, { agentId: target.id });
      }

      const fnCtx = ctx as typeof ctx & { agentId?: string };
      const callerAgentId = fnCtx.agentId;
      const targetChain = await agentStore.getChainOfCommand(target.id);
      if (callerAgentId) {
        if (callerAgentId === target.id) {
          return denied("You can only update your own direct or indirect reports, not yourself.", {
            agentId: target.id,
            callerAgentId,
            rule: "direct-or-indirect-reports-only",
          });
        }
        const callerIndex = targetChain.findIndex((agent) => agent.id === callerAgentId);
        if (callerIndex < 1) {
          return denied("You can only update your own direct or indirect reports.", {
            agentId: target.id,
            callerAgentId,
            rule: "direct-or-indirect-reports-only",
          });
        }
      }

      let resolvedReportsTo: string | undefined;
      let managerForCycleCheck: string | undefined;
      if (params.reportsTo !== undefined) {
        if (params.reportsTo === "") {
          if (callerAgentId) {
            return denied("Only privileged user/operator calls can clear an agent's manager.", {
              agentId: target.id,
              callerAgentId,
              rule: "privileged-clear-manager-only",
            });
          }
          resolvedReportsTo = undefined;
        } else {
          const manager = await agentStore.resolveAgent(params.reportsTo);
          if (!manager) {
            return invalid("reportsTo", `Manager '${params.reportsTo}' not found`, { agentId: target.id });
          }
          if (manager.id === target.id) {
            return invalid("reportsTo", "An agent cannot report to itself", { agentId: target.id });
          }
          const managerChain = await agentStore.getChainOfCommand(manager.id);
          if (managerChain.some((agent) => agent.id === target.id)) {
            return invalid("reportsTo", "reportsTo would create a management cycle", {
              agentId: target.id,
              managerId: manager.id,
            });
          }
          if (callerAgentId) {
            const managerCallerIndex = managerChain.findIndex((agent) => agent.id === callerAgentId);
            if (manager.id !== callerAgentId && managerCallerIndex < 1) {
              return denied("You can only reparent reports to yourself or another agent in your management subtree.", {
                agentId: target.id,
                callerAgentId,
                managerId: manager.id,
                rule: "reparent-within-subtree-only",
              });
            }
          }
          resolvedReportsTo = manager.id;
          managerForCycleCheck = manager.id;
        }
      }

      const hasRuntimeConfigUpdates = [
        params.heartbeat_interval_ms,
        params.heartbeat_timeout_ms,
        params.max_concurrent_runs,
        params.max_workflow_sessions,
        params.message_response_mode,
      ].some((value) => value !== undefined);
      const updateInput: AgentUpdateInput = {};
      const updatedFields: string[] = [];
      const setField = <K extends keyof AgentUpdateInput>(field: K, value: AgentUpdateInput[K]) => {
        updateInput[field] = value;
        updatedFields.push(String(field));
      };

      if (params.name !== undefined) setField("name", params.name);
      if (params.roles !== undefined) setField("roles", params.roles as AgentCapability[]);
      else if (params.role !== undefined) setField("role", params.role as AgentCapability);
      if (params.title !== undefined) setField("title", params.title);
      if (params.icon !== undefined) setField("icon", params.icon);
      if (params.soul !== undefined) setField("soul", params.soul);
      if (params.instructions_text !== undefined) setField("instructionsText", params.instructions_text);
      if (params.instructions_path !== undefined) setField("instructionsPath", params.instructions_path);
      if (params.heartbeat_procedure_path !== undefined) setField("heartbeatProcedurePath", params.heartbeat_procedure_path);
      if (params.reportsTo !== undefined) {
        setField("reportsTo", resolvedReportsTo);
      }
      if (hasRuntimeConfigUpdates) {
        setField("runtimeConfig", {
          ...((target.runtimeConfig ?? {}) as Record<string, unknown>),
          ...(params.heartbeat_interval_ms !== undefined ? { heartbeatIntervalMs: params.heartbeat_interval_ms } : {}),
          ...(params.heartbeat_timeout_ms !== undefined ? { heartbeatTimeoutMs: params.heartbeat_timeout_ms } : {}),
          ...(params.max_concurrent_runs !== undefined ? { maxConcurrentRuns: params.max_concurrent_runs } : {}),
          ...(params.max_workflow_sessions !== undefined ? { maxWorkflowSessions: params.max_workflow_sessions } : {}),
          ...(params.message_response_mode !== undefined ? { messageResponseMode: params.message_response_mode } : {}),
        });
      }

      if (managerForCycleCheck && managerForCycleCheck === target.id) {
        return invalid("reportsTo", "An agent cannot report to itself", { agentId: target.id });
      }

      const updated = await agentStore.updateAgent(target.id, updateInput);
      return {
        content: [{
          type: "text" as const,
          text: `Updated ${updated.name} (${updated.id}): ${updatedFields.join(", ")}`,
        }],
        details: { outcome: "updated", agentId: updated.id, updatedFields, agent: updated },
      };
    },
  });

  // ── fn_agent_set_instructions ───────────────────────────────────

  /**
   * FNXC:AgentManagement 2026-06-19-06:58:
   * Managing agents need a scoped runtime tool for updating a direct or indirect report's operating instructions without granting peer, ancestor, or self-mutation rights.
   * The no-agent caller path remains privileged for CLI/user control, while agent callers must appear as an ancestor in the target's chain of command so AgentStore config revisions preserve an auditable record of each instruction edit.
   */
  pi.registerTool({
    name: "fn_agent_set_instructions",
    label: "fn: Set Agent Instructions",
    description:
      "Set the instructionsText and/or instructionsPath of one of the caller's direct or indirect reports. " +
      "At least one of instructions_text or instructions_path is required; pass an empty string to clear a field. " +
      "The change is persisted and recorded as a config revision.",
    promptSnippet: "Update operating instructions for an agent in your management subtree",
    promptGuidelines: [
      "Use to update operating instructions for an agent in your management subtree",
      "You can only target your own direct or indirect reports, not yourself, peers, or ancestors",
      "Provide instructions_text, instructions_path, or both; use an explicit empty string to clear a field",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target agent whose instructions to set" }),
      instructions_text: Type.Optional(
        Type.String({ description: "Inline instructions. Pass an empty string to clear." }),
      ),
      instructions_path: Type.Optional(
        Type.String({ description: "Path to a markdown instructions file. Pass an empty string to clear." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: policy-gated for agent principals (classified as task_agent_mutation via the extension gate's exempt fallback); operators unaffected.
      const gated = await applyAgentPolicyGateForExtensionTool("fn_agent_set_instructions", params as Record<string, unknown>, ctx as ExtensionCallerContext);
      if (gated) return gated;
      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();

      const hasInstructionsText = params.instructions_text !== undefined;
      const hasInstructionsPath = params.instructions_path !== undefined;
      if (!hasInstructionsText && !hasInstructionsPath) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Provide instructions_text and/or instructions_path to update agent instructions." }],
          isError: true,
          details: { outcome: "invalid", error: "instructions_text or instructions_path is required" },
        };
      }

      const target = await agentStore.resolveAgent(params.agent_id);
      if (!target) {
        return {
          content: [{ type: "text" as const, text: `Agent '${params.agent_id}' not found` }],
          isError: true,
          details: { outcome: "not_found", error: "Agent not found", agentId: params.agent_id },
        };
      }

      const fnCtx = ctx as typeof ctx & { agentId?: string };
      const callerAgentId = fnCtx.agentId;
      if (callerAgentId) {
        if (callerAgentId === target.id) {
          return {
            content: [{ type: "text" as const, text: "ERROR: You can only set instructions for your own direct or indirect reports, not yourself." }],
            isError: true,
            details: { outcome: "denied", agentId: target.id, callerAgentId, rule: "direct-or-indirect-reports-only" },
          };
        }

        const chain = await agentStore.getChainOfCommand(target.id);
        const callerIndex = chain.findIndex((agent) => agent.id === callerAgentId);
        if (callerIndex < 1) {
          return {
            content: [{ type: "text" as const, text: "ERROR: You can only set instructions for your own direct or indirect reports." }],
            isError: true,
            details: { outcome: "denied", agentId: target.id, callerAgentId, rule: "direct-or-indirect-reports-only" },
          };
        }
      }

      const updatedFields: string[] = [];
      if (hasInstructionsText) updatedFields.push("instructionsText");
      if (hasInstructionsPath) updatedFields.push("instructionsPath");

      const updated = await agentStore.updateAgent(target.id, {
        ...(hasInstructionsText ? { instructionsText: params.instructions_text } : {}),
        ...(hasInstructionsPath ? { instructionsPath: params.instructions_path } : {}),
      });

      return {
        content: [{
          type: "text" as const,
          text: `Updated ${updated.name} (${updated.id}) instructions: ${updatedFields.join(", ")}`,
        }],
        details: { outcome: "updated", agentId: updated.id, updatedFields },
      };
    },
  });

  // ── fn_agent_read_evaluations ──────────────────────────────────

  /**
   * FNXC:AgentEvaluations 2026-08-12-22:11:
   * Manager agents need cross-agent evaluation visibility for direct and indirect reports,
   * while peers, ancestors, and self remain private. This intentionally reuses
   * getChainOfCommand so the management-subtree boundary has one auditable rule.
   * Reads use AgentStore and ReflectionStore rather than duplicating evaluation storage.
   */
  pi.registerTool({
    name: "fn_agent_read_evaluations",
    label: "fn: Read Report Evaluations",
    description: "Read ratings, feedback, reflections, and performance data for a direct or indirect report.",
    promptSnippet: "Review evaluation and reflection results for an agent in your management subtree",
    promptGuidelines: [
      "Use to review evaluation data for a direct or indirect report in your management subtree",
      "Agent callers cannot target themselves, peers, ancestors, or agents outside their subtree",
      "Operator and CLI calls are privileged and may read any durable agent",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target agent ID or resolvable name" }),
      rating_limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Maximum ratings to return (default 10)" })),
      reflection_limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum reflections to return (default 5)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();
      const resolved = await resolveManagerEvaluationTarget(agentStore, params.agent_id, ctx as ExtensionCallerContext);
      if (resolved.kind === "error") return resolved.response;

      const ratingLimit = params.rating_limit ?? 10;
      const reflectionLimit = params.reflection_limit ?? 5;
      const reflectionStore = new ReflectionStore({ rootDir: getFusionDir(ctx.cwd) });
      await reflectionStore.init();
      const [summary, ratings, latestReflection, reflections, performance] = await Promise.all([
        agentStore.getRatingSummary(resolved.target.id),
        agentStore.getRatings(resolved.target.id, { limit: ratingLimit }),
        reflectionStore.getLatestReflection(resolved.target.id),
        reflectionStore.getReflections(resolved.target.id, reflectionLimit),
        reflectionStore.getPerformanceSummary(resolved.target.id),
      ]);

      const hasRatings = ratings.length > 0 || summary.totalRatings > 0;
      const hasReflections = Boolean(latestReflection) || reflections.length > 0;
      if (!hasRatings && !hasReflections) {
        return {
          content: [{ type: "text" as const, text: `${resolved.target.name} (${resolved.target.id})\n\nNo evaluation data available yet.` }],
          details: { outcome: "empty", agentId: resolved.target.id, agentName: resolved.target.name, summary, ratings, reflections, latestReflection, performance },
        };
      }

      const formatScore = (score: number | null | undefined) =>
        typeof score === "number" && Number.isFinite(score) ? score.toFixed(2) : "n/a";
      const lines: string[] = [
        `Evaluation Summary: ${resolved.target.name} (${resolved.target.id})`,
        `- Average score: ${formatScore(summary.averageScore)}`,
        `- Trend: ${summary.trend}`,
        `- Total ratings: ${summary.totalRatings}`,
      ];
      const categoryEntries = Object.entries(summary.categoryAverages ?? {});
      if (categoryEntries.length > 0) {
        lines.push("", "Category averages:");
        categoryEntries.forEach(([category, score]) => lines.push(`- ${category}: ${formatScore(score)}`));
      }
      const commentedRatings = ratings.filter((rating) => rating.comment?.trim());
      if (commentedRatings.length > 0) {
        lines.push("", "Recent rating comments:");
        commentedRatings.slice(0, 5).forEach((rating) => lines.push(`- [${rating.score}/5] ${rating.comment!.trim()}`));
      }
      if (latestReflection) {
        lines.push("", "Latest reflection:", `- Summary: ${latestReflection.summary}`);
        if (latestReflection.insights.length > 0) {
          lines.push("- Insights:");
          latestReflection.insights.forEach((insight) => lines.push(`  - ${insight}`));
        }
        if (latestReflection.suggestedImprovements.length > 0) {
          lines.push("- Suggested improvements:");
          latestReflection.suggestedImprovements.forEach((item) => lines.push(`  - ${item}`));
        }
      }
      if (reflections.length > 0) {
        lines.push("", "Recent reflection history:");
        reflections.slice(0, 5).forEach((reflection) => lines.push(`- ${reflection.timestamp}: ${reflection.summary}`));
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { outcome: "read", agentId: resolved.target.id, agentName: resolved.target.name, summary, ratings, reflections, latestReflection, performance },
      };
    },
  });

  // ── fn_agent_evaluation_followup ───────────────────────────────

  /*
   * FNXC:AgentEvaluations 2026-08-12-22:11:
   * Follow-ups reuse AgentStore.addRating, the same evaluation row read by the report's
   * self-improvement loop and dashboard rating routes, instead of creating a parallel
   * feedback channel. Task-level routing remains with fn_delegate_task and fn_task_create.
   */
  pi.registerTool({
    name: "fn_agent_evaluation_followup",
    label: "fn: Record Evaluation Follow-up",
    description: "Record a coaching evaluation follow-up for a direct or indirect report to read through its self-improvement loop.",
    promptSnippet: "Record coaching feedback for an agent in your management subtree",
    promptGuidelines: [
      "Use to record actionable coaching feedback for a direct or indirect report",
      "Agent callers cannot target themselves, peers, ancestors, or agents outside their subtree",
      "Create or delegate separate implementation work with fn_task_create or fn_delegate_task",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target agent ID or resolvable name" }),
      score: Type.Number({ minimum: 1, maximum: 5, description: "Evaluation score from 1 to 5" }),
      comment: Type.String({ minLength: 1, maxLength: 4000, description: "Coaching or follow-up note" }),
      category: Type.Optional(Type.String({ maxLength: 100, description: "Optional evaluation category" })),
      task_id: Type.Optional(Type.String({ description: "Optional related task ID" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-08-12-22:11: This mutation intentionally falls through the exempt fallback as task_agent_mutation; do not classify it as a read-only coordination tool.
      const gated = await applyAgentPolicyGateForExtensionTool(
        "fn_agent_evaluation_followup",
        params as Record<string, unknown>,
        ctx as ExtensionCallerContext,
      );
      if (gated) return gated;

      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();
      const resolved = await resolveManagerEvaluationTarget(agentStore, params.agent_id, ctx as ExtensionCallerContext);
      if (resolved.kind === "error") return resolved.response;

      if (!Number.isFinite(params.score) || params.score < 1 || params.score > 5) {
        return {
          content: [{ type: "text" as const, text: "ERROR: score must be a finite value from 1 to 5" }],
          isError: true,
          details: { outcome: "invalid", field: "score" },
        };
      }
      const comment = params.comment.trim();
      if (!comment) {
        return {
          content: [{ type: "text" as const, text: "ERROR: comment must not be empty" }],
          isError: true,
          details: { outcome: "invalid", field: "comment" },
        };
      }

      const raterType = resolved.callerAgentId ? "agent" as const : "user" as const;
      const rating = await agentStore.addRating(resolved.target.id, {
        raterType,
        ...(resolved.callerAgentId ? { raterId: resolved.callerAgentId } : {}),
        score: params.score,
        ...(params.category !== undefined ? { category: params.category } : {}),
        comment,
        ...(params.task_id !== undefined ? { taskId: params.task_id } : {}),
      });
      return {
        content: [{ type: "text" as const, text: `Recorded evaluation follow-up for ${resolved.target.name} (${resolved.target.id}).` }],
        details: { outcome: "recorded", agentId: resolved.target.id, ratingId: rating.id, score: rating.score, raterType },
      };
    },
  });

  // ── fn_agent_delete ─────────────────────────────────────────────

  pi.registerTool({
    name: "fn_agent_delete",
    label: "fn: Delete Agent",
    description: "Delete a non-ephemeral agent.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Agent ID to delete" }),
      force: Type.Optional(Type.Boolean({ description: "Force delete when holding checkout" })),
      reassign_to: Type.Optional(Type.String({ description: "Optional replacement agent for assigned tasks" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {

      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();
      const store = await getStore(ctx.cwd);
      /*
      FNXC:ToolPermissionGates 2026-07-26-13:55:
      BEHAVIOR CHANGE (honest provisioning caller) — see the matching comment on
      fn_agent_create: the caller is principal-derived instead of a hardcoded privileged
      CLI User, and approval requests carry the real agent requester snapshot.
      */
      const provisionPrincipal = resolveExtensionCallerPrincipal(ctx as ExtensionCallerContext);
      let caller: { id: string; role: string; isPrivileged: boolean };
      let provisionRequester: ApprovalRequestActorSnapshot;
      if (provisionPrincipal.kind === "operator") {
        caller = { id: "user", role: "user", isPrivileged: true };
        provisionRequester = { actorId: "user", actorType: "user", actorName: "CLI User" };
      } else {
        const callerAgentId = provisionPrincipal.kind === "agent" ? provisionPrincipal.identity.agentId : AMBIGUOUS_AGENT_PRINCIPAL_ID;
        let callerRow: { name?: string; role?: string } | null = null;
        if (provisionPrincipal.kind === "agent") {
          try {
            callerRow = await agentStore.resolveAgent(callerAgentId);
          } catch {
            callerRow = null;
          }
        }
        const fallbackName = provisionPrincipal.kind === "agent"
          ? provisionPrincipal.identity.agentName ?? callerAgentId
          : callerAgentId;
        caller = { id: callerAgentId, role: callerRow?.role ?? "custom", isPrivileged: false };
        provisionRequester = { actorId: callerAgentId, actorType: "agent", actorName: callerRow?.name ?? fallbackName };
      }
      const policy = resolveAgentProvisioningPolicy({
        tool: "fn_agent_delete",
        caller,
        settings: await store.getSettings(),
      });

      if (policy.decision === "require-approval") {
        const cliLayer3 = requireProjectLayer(store, "CLI agent-delete approval store");
        const approvalStore = new ApprovalRequestStore(null, { asyncLayer: cliLayer3 });
        const request = await approvalStore.create({
          requester: provisionRequester,
          targetAction: { category: "agent_provisioning", action: "delete", summary: `Delete agent ${params.agent_id}`, resourceType: "agent", resourceId: params.agent_id, context: { tool: "fn_agent_delete", params } },
        });
        return { content: [{ type: "text" as const, text: `Approval required. Request ${request.id} created.` }], details: { outcome: "pending_approval", approvalRequestId: request.id, matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId: params.agent_id } };
      }

      if (policy.decision === "deny") {
        return {
          content: [{ type: "text" as const, text: `DENIED: agent delete blocked by policy (${policy.matchedRule})` }],
          details: { outcome: "denied", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId: params.agent_id },
        };
      }

      await agentStore.deleteAgent(params.agent_id, { force: params.force === true, reassignTo: params.reassign_to });
      return {
        content: [{ type: "text" as const, text: `Deleted ${params.agent_id}` }],
        details: { outcome: "deleted", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId: params.agent_id },
      };
    },
  });

  // ── fn_list_agents ───────────────────────────────────────────────

  pi.registerTool({
    name: "fn_list_agents",
    label: "fn: List Agents",
    description:
      "List all available agents in the system. Shows each agent's name, role, state, " +
      "personality (soul), and current assignment. Use this to discover which agents exist " +
      "and what they specialize in before delegating work.",
    promptSnippet: "List all available Fusion agents",
    promptGuidelines: [
      "Use fn_list_agents to discover which agents exist before delegating work",
      "Filter by role or state to narrow results",
      "Ephemeral/runtime agents are excluded by default",
    ],
    parameters: Type.Object({
      role: Type.Optional(
        Type.String({ description: "Filter by agent role/capability (e.g., 'executor', 'reviewer', 'qa')" }),
      ),
      state: Type.Optional(
        Type.String({ description: "Filter by agent state (e.g., 'idle', 'active', 'running')" }),
      ),
      includeEphemeral: Type.Optional(
        Type.Boolean({ description: "Include ephemeral/runtime agents (default: false)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      

      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();

      const filter: Record<string, unknown> = {};
      if (params.role) filter.role = params.role;
      if (params.state) filter.state = params.state;
      if (params.includeEphemeral !== undefined) filter.includeEphemeral = params.includeEphemeral;

      const agents = await agentStore.listAgents(filter as Parameters<typeof agentStore.listAgents>[0]);
      const store = await getStore(ctx.cwd);

      if (agents.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No agents found matching the specified filters." }],
          details: { agents: [], count: 0 },
        };
      }

      const lines = await Promise.all(agents.map(async (agent) => {
        const parts: string[] = [
          `ID: ${agent.id}`,
          `Name: ${agent.name}`,
          `Roles: ${(agent.roles?.length ? agent.roles : [agent.role]).join(", ")}`,
          `State: ${agent.state}`,
        ];

        if (agent.title) parts.push(`Title: ${agent.title}`);
        /*
        FNXC:AgentHeartbeat 2026-07-12-18:20:
        FN-7859 requires list output to explain error/paused durable agents without DB inspection, while keeping healthy-agent rows compact.
        */
        appendAgentDiagnosticLines(parts, agent, { compact: true });
        if (agent.soul) parts.push(`Soul: ${agent.soul.slice(0, 200)}`);
        if (agent.instructionsText) {
          const snippet = agent.instructionsText.slice(0, 100);
          parts.push(`Custom Instructions: ${snippet}${agent.instructionsText.length > 100 ? "…" : ""}`);
        }
        if (agent.taskId) {
          /*
          FNXC:AgentTaskStateDrift 2026-06-27-16:05:
          Show the linked task column in fn_list_agents so parked triage/todo ownership is not mistaken for an in-progress execution mismatch.
          */
          let linkedTask: Pick<Task, "id" | "column"> | null = null;
          try {
            linkedTask = await store.getTask(agent.taskId);
          } catch {
            linkedTask = null;
          }
          parts.push(formatCurrentTaskLine(agent.taskId, linkedTask));
        }

        return parts.join("\n");
      }));

      return {
        content: [{ type: "text" as const, text: `Available agents (${agents.length}):\n\n${lines.join("\n\n")}` }],
        details: { agents, count: agents.length },
      };
    },
  });

  // ── fn_delegate_task ──────────────────────────────────────────────

  pi.registerTool({
    name: "fn_delegate_task",
    label: "fn: Delegate Task",
    description:
      "Create a new task and assign it to a specific agent for execution. The task lands in the " +
      "selected workflow's ready lane (`todo` on the built-in board, whatever that workflow calls " +
      "it otherwise) and will be picked up by the target agent on their next heartbeat cycle. " +
      "Use fn_list_agents first to find available agents and their capabilities. " +
      "Optionally pass workflow_id to select a workflow at creation time; use " +
      "fn_workflow_list to discover valid IDs.",
    promptSnippet: "Delegate a task to a specific Fusion agent",
    promptGuidelines: [
      "Use fn_list_agents first to find available agents and their capabilities",
      "The task is created in the workflow's ready (hold) lane and assigned to the target agent",
      "Cannot delegate to ephemeral/runtime agents",
      "Implementation tasks use executor by default; durable engineer supports explicit routing without override, other non-executor roles require override=true",
      "Optionally specify dependencies on other tasks",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to delegate work to" }),
      description: Type.String({ description: "What needs to be done" }),
      dependencies: Type.Optional(
        Type.Array(Type.String(), { description: "Task IDs this new task depends on (e.g. [\"KB-001\"]" }),
      ),
      workflow_id: Type.Optional(
        Type.String({
          description:
            "Workflow ID to select for the new task (e.g. 'WF-003' or 'builtin:coding'). " +
            "Omit to inherit the project default workflow. Use fn_workflow_list to discover valid IDs.",
        }),
      ),
      override: Type.Optional(
        Type.Boolean({ description: "Set true to bypass executor-role assignment policy" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskExecutionDenied = denyTaskCreationForTaskExecutionPrincipal("fn_delegate_task", ctx as ExtensionCallerContext);
      if (taskExecutionDenied) return taskExecutionDenied;
      /*
      FNXC:ToolPermissionGates 2026-07-26-13:55:
      Ordinary delegation stays ungated (coordination primitive), but the executor-role
      policy override is a sensitive escalation: policy-gate it for agent principals when
      override=true. Operators unaffected.
      */
      if (params.override === true) {
        const gated = await applyAgentPolicyGateForExtensionTool("fn_delegate_task", params as Record<string, unknown>, ctx as ExtensionCallerContext);
        if (gated) return gated;
      }
      // Validate target agent exists and is not ephemeral
      const delegateTask: Pick<Task, "id" | "column"> = { id: "<new>", column: "todo" };
      const agentError = await validateAssignableAgentId(ctx.cwd ?? process.cwd(), params.agent_id, delegateTask, params.override === true);
      if (agentError) {
        return {
          content: [{ type: "text", text: `ERROR: ${agentError}` }],
          isError: true,
          details: { error: agentError },
        };
      }

      
      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();
      const agent = await agentStore.getAgent(params.agent_id);

      try {
        // Create task assigned to the target agent
        const store = await getStore(ctx.cwd);
        const workflowId = params.workflow_id?.trim() || undefined;
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-14:30:
        Delegation lands in the HOLD lane of the workflow the card ACTUALLY got, not in the literal
        `todo` and not in a lane resolved from a second, independent read.

        The tool's contract (see the description above) is "the task goes to the ready-to-work lane
        and the target agent picks it up on its next heartbeat" — deliberately NOT intake, so this
        cannot simply omit `column` and inherit `createTask`'s intake resolution: on a manual-intake
        workflow the card would sit waiting for a human and never reach the agent it was delegated
        to. Keyed on the literal, a workflow that calls that lane anything else received a card in an
        undeclared column: written, reported as delegated, invisible to the agent.

        RESOLVED FROM THE CREATED TASK, and that ordering is the fix rather than a detail (#2843
        review, greptile P1 — it is right). My first version resolved the hold column BEFORE the
        create, from `getDefaultWorkflowId()`. `createTask` then resolves the project default AGAIN
        to select the workflow, so two reads answered the same question and a default changed between
        them yields a column from workflow A written onto a card selected into workflow B — the exact
        undeclared-lane write this conversion exists to remove, reintroduced by the fix for it.

        Resolving afterwards leaves ONE authority: the task's own selection. The move is skipped
        entirely when the entry lane already carries `hold` — true on the built-in board, where entry
        and hold are both `todo` — so the common path is byte-identical and costs no extra write.

        A failed move is reported, not swallowed: the card exists either way, and telling the caller
        it is ready when it is sitting in intake is the failure mode this whole change is about.
        */
        const task = await store.createTask({
          description: params.description,
          dependencies: params.dependencies,
          assignedAgentId: params.agent_id,
          ...(workflowId ? { workflowId } : {}),
          source: {
            sourceType: "api",
            ...(params.override === true ? { sourceMetadata: { executorRoleOverride: true } } : {}),
          },
        });

        let landedColumn = task.column;
        let landingError: string | undefined;
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-15:20 (#2843 review — coderabbit major / greptile P1):
        AN UNRESOLVABLE WORKFLOW, AN UNTRAITED BOARD, AND A BOARD WITH NO HOLD LANE ARE THREE ANSWERS.

        Reading `?.hold` off the result collapsed the first two into one: both produced `undefined`,
        the move was skipped, and the tool reported success — so a split-lane workflow whose IR could
        not be read left the card on intake while telling the caller it was on its way. That is the
        same success-with-nothing-behind-it this branch was rewritten to remove, arriving a line early.

          - `undefined` OBJECT — the workflow could not be resolved at all. Nothing can be verified, so
            the landing is reported as failed rather than assumed.
          - resolved, NO column declares any lifecycle trait — a v1 graph upgraded by
            `synthesizeDefaultColumns`, or a fixture like `linearWorkflowIr`. Its `todo` column plainly
            exists and is where agents pick work up, so the legacy vocabulary still applies and success
            is honest. Failing these would break every untraited board to fix a case none of them have,
            and the existing suite caught exactly that when this gate was first written without it.
          - resolved, traits EXPRESSED, still no hold lane — the board has answered, and the answer is
            that nothing will dispatch this card: assigned-agent selection picks OUT OF the hold lane.
            Staying on intake is correct and "will be picked up" is false, so it is reported like any
            other failed landing.

        A FOURTH STATE, and it is the one that made the first arm look unreachable (#2843 review,
        greptile P1 — the third round, and right again). `resolveWorkflowIrForTask` never throws: an
        unreadable selection, a missing definition, a malformed one and a throwing lookup ALL
        SUBSTITUTE the default coding IR. So the substitution never surfaced as a failure, it surfaced
        as the BUILT-IN lanes — `hold: "todo"`.

        I argued that was harmless because `todo` would be undeclared on such a board and the move
        would be rejected. That is true only of a board that does not declare `todo` AT ALL. A
        workflow that holds work in `queued` and ALSO declares a `todo` column for something else
        gets a move that SUCCEEDS into a lane nothing dispatches from, and a success message. The
        argument was right about the mechanism and wrong about the population it covers.

        `resolveWorkflowIrForTaskWithProvenance` is the seam built for exactly this: it reports
        `source: "selection"` ONLY when it genuinely resolved the workflow the task selected, and
        `"default"` whenever it substituted. Pairing that with the task's own selection separates the
        two reasons for `"default"` — no workflow selected (legitimate; the built-in board IS the
        answer) from selected-but-unresolvable (a substitution wearing the board's authority).

        This also makes the first arm REACHABLE, so it is now covered rather than defended.
        */
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-19:10 (#2843 review — greptile P1, fourth round):
        ONE READ. Provenance and lanes come from the same snapshot, and a substitution is judged by
        whether it would MOVE the card rather than by a second lookup.

        My previous fix paired the provenance read with an independent `getTaskWorkflowSelectionAsync`
        to tell "no workflow selected" (legitimate — the built-in board IS the answer) apart from
        "selected but unresolvable". Two reads answering one question is the same defect the FIRST
        review round on this PR caught, reintroduced three rounds later in a different place: a
        selection written or cleared between them makes `resolved.ir` describe one workflow and
        `selectedWorkflowId` another, and the tool then moves the card with the wrong board's hold
        lane or reports a resolution error that never happened.

        The second read is not needed. `source === "selection"` means the resolver genuinely resolved
        what the task selected, so the lanes are authoritative. `"default"` means it SUBSTITUTED —
        and the honest question is not why, it is whether the substitution is about to be acted on:

          - the substituted hold lane equals the card's current column: no move, nothing is being
            decided on unverified information, and this is exactly the no-selection/untraited case
            where the built-in vocabulary is correct. Success.
          - it DIFFERS: acting would move a real card into a lane inferred from a workflow that is
            not the card's. That is the misroute round three found, and it is refused.

        Judging by the action rather than by the reason needs no second lookup, so there is no window
        for the two to disagree.
        */
        const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
        /* `resolveLifecycleColumns` returns undefined for an IR that declares no columns at all;
           `holdColumn` is then undefined and the untraited branch below is the honest answer. */
        const holdColumn = resolveLifecycleColumns(resolved.ir)?.hold;
        const substituted = resolved.source !== "selection";
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-20:30 (#2843 review — greptile P1, "fallback equality
        masks wrong hold"):
        A SUBSTITUTION IS FATAL WHEN THE CALLER NAMED THE WORKFLOW. Equality proves nothing on its own.

        The equality rule below accepts a substitution whose hold lane already matches the card's
        column, on the grounds that no move means nothing was decided on bad information. The review
        names the board where that is false: a workflow using `todo` as INTAKE and `queued` as hold
        puts the card on `todo`, the degraded lookup fabricates `hold: "todo"`, the two match, and the
        delegation is reported for a card assigned-agent dispatch will never select.

        `params.workflow_id` settles the decidable half WITHOUT a second read — it is caller input, so
        there is no snapshot to race. When the caller NAMED a workflow and the resolver substituted,
        a real workflow provably exists and we provably failed to read it, so its hold lane cannot be
        inferred from the built-in vocabulary and the landing is refused.

        WHAT THIS DOES NOT COVER, stated because the gap is real: the same board reached through the
        project DEFAULT with no `workflow_id` argument. There, "substituted" and "this project has no
        resolvable workflow" are the same observation, and the second is a legitimate configuration
        whose cards belong exactly where they are. Failing it would trade a false success for a false
        alarm on a valid setup. Distinguishing them needs the read that just failed; it is not
        available here, and guessing is what produced the last four rounds of this review.
        */
        if (substituted && workflowId) {
          landingError = `the requested workflow (${workflowId}) could not be resolved, so its ready lane is unknown`;
        } else if (substituted && holdColumn && holdColumn !== task.column) {
          landingError = "the task's workflow could not be resolved, so its ready lane is unknown";
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-19:35 (#2843 review — greptile P1, "lifecycle snapshot
        race persists"):
        THE SAME SNAPSHOT, NOT A SECOND RESOLVE.

        This read the traits through a helper that resolved the workflow AGAIN, so a selection changing
        in between combined the hold column from one board with the trait state of another — the exact
        two-reads-of-one-fact defect the round above removed, surviving in the branch I added to fix a
        different one. `resolved.ir` is already in hand and is the only snapshot anything here should
        consult.
        */
        } else if (!holdColumn && declaresAnyLifecycleTrait(resolved.ir)) {
          landingError = "this workflow declares no hold (ready-to-pick-up) lane";
        } else if (holdColumn && holdColumn !== task.column) {
          try {
            await store.moveTask(task.id, holdColumn);
            landedColumn = holdColumn;
          } catch (moveError) {
            landingError = moveError instanceof Error ? moveError.message : String(moveError);
          }
        }

        const deps = task.dependencies.length ? ` (depends on: ${task.dependencies.join(", ")})` : "";
        const workflow = workflowId ? ` (workflow: ${workflowId})` : "";
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-14:50 (#2843 review — greptile P1, and it is right):
        A FAILED landing is an ERROR result, not a success sentence with a warning appended.

        My first version kept the "will be picked up by X on their next heartbeat cycle" text and
        added a ` WARNING: ...` suffix. That still LEADS with a claim that is false: assigned-agent
        selection skips cards outside the workflow's hold lane, so a card stranded on intake is never
        dispatched, and a caller — usually another agent — reads the first sentence and moves on.
        "Reported success with a caveat" is how the delegation silently goes nowhere.

        The task id stays in `details` because the card DOES exist and the caller needs it to finish
        the job by hand; what changes is that nothing in this branch claims the delegation completed.

        The MOVE-REJECTED half of this is defensive rather than a live path: `holdColumn` comes from
        the task's own resolved IR, so `moveTask`'s declared-column check passes by construction. I
        tried to reach it with a workflow declaring a `hold` column with no node on it, expecting a
        rejection — the move SUCCEEDED and the card landed there, because `moveTask` accepts any
        column the workflow DECLARES and node reachability does not gate it. The unresolvable-workflow
        half above is reachable. Both are covered by the message-shape test, which is explicit that it
        pins the handling and not the reachability.
        */
        if (landingError) {
          const target = holdColumn ? `the ready lane "${holdColumn}"` : "its ready lane";
          const remedy = holdColumn
            ? `move it to "${holdColumn}" to dispatch it`
            : "resolve its workflow and move it to that workflow's ready lane to dispatch it";
          const text = `ERROR: Created ${task.id}${deps}${workflow} and assigned it to ${agent!.name} (${agent!.id}), `
            + `but it could NOT be moved out of "${task.column}" into ${target}: ${landingError}. `
            + `It is stranded on intake and will NOT be picked up — ${remedy}.`;
          return {
            content: [{ type: "text" as const, text }],
            isError: true,
            details: { taskId: task.id, agentId: agent!.id, agentName: agent!.name, column: landedColumn, error: landingError },
          };
        }
        return {
          content: [{
            type: "text" as const,
            /*
            FNXC:WorkflowLifecycleColumns 2026-07-30-22:10 (#2894 review, second round — greptile):
            THE CAVEAT BELONGS IN THE SENTENCE, NOT ONLY IN `details`.

            `landingVerified: false` was the right fact in the wrong place: the caller is usually
            another agent, and agents read the first sentence. A structured field beside a confident
            "will be picked up" is the same "success with a caveat" shape the error branch was
            rewritten to remove — the caveat is present and nobody sees it.

            The pickup claim is therefore CONDITIONAL on having verified the landing. Where it could
            not be verified the text says what is true — the card exists, is assigned, and sits on a
            lane we could not confirm — without either promising dispatch or failing a configuration
            that is probably fine.
            */
            text: substituted
              ? `Delegated to ${agent!.name} (${agent!.id}): Created ${task.id}${deps}${workflow} in `
                + `"${landedColumn}". Its workflow could not be resolved, so I could NOT confirm that `
                + `column is the lane ${agent!.name} picks work up from — check the board if it does `
                + "not start."
              : `Delegated to ${agent!.name} (${agent!.id}): Created ${task.id}${deps}${workflow}. `
                + `The task will be picked up by ${agent!.name} on their next heartbeat cycle.`,
          }],
          /*
          FNXC:WorkflowLifecycleColumns 2026-07-30-20:45 (#2894 review — greptile, "fallback equality
          strands delegations"): THE GAP IS DELIBERATE; THE SILENCE WAS NOT.

          The finding restates the limitation recorded above: with no `workflow_id` argument,
          "substituted" and "this project has no resolvable workflow" are the same observation, and the
          second is a valid configuration whose cards belong where they are. Failing it would trade a
          false success for a false alarm on a working setup, and distinguishing them needs the read
          that just failed.

          What IS fixable is that the card came back indistinguishable from a verified landing. The
          caller — usually another agent — now gets `landingVerified: false`, so "we could not confirm
          this card is on a lane anything picks up from" is a readable fact rather than an absence.
          Same principle as the contamination sweep in #2891: when you cannot answer, say so instead of
          picking a side.
          */
          details: {
            taskId: task.id,
            agentId: agent!.id,
            agentName: agent!.name,
            column: landedColumn,
            ...(substituted ? { landingVerified: false } : {}),
          },
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Task ID already exists:")) {
          return {
            content: [{ type: "text", text: `ERROR: ${error.message}` }],
            isError: true,
            details: { error: error.message },
          };
        }
        throw error;
      }
    },
  });

  // ── fn_agent_show ─────────────────────────────────────────────────

  pi.registerTool({
    name: "fn_agent_show",
    label: "fn: Show Agent",
    description:
      "Show detailed information about a single agent, including their role, state, " +
      "position in the org hierarchy (reports-to, direct reports), skills, and current assignment.",
    promptSnippet: "Show details of a specific Fusion agent",
    promptGuidelines: [
      "Use to get full details about a specific agent",
      "Provide agent ID or a resolvable name",
      "Shows the agent's position in the org hierarchy",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Agent ID or resolvable name" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      

      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();

      const agent = await agentStore.resolveAgent(params.id);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Agent '${params.id}' not found` }],
          isError: true,
          details: { error: "Agent not found" },
        };
      }

      // Get direct reports
      const directReports = await agentStore.getAgentsByReportsTo(agent.id);
      const store = await getStore(ctx.cwd);

      const parts: string[] = [
        `ID: ${agent.id}`,
        `Name: ${agent.name}`,
        `Roles: ${(agent.roles?.length ? agent.roles : [agent.role]).join(", ")}`,
        `State: ${agent.state}`,
      ];

      if (agent.title) parts.push(`Title: ${agent.title}`);
      if (agent.icon) parts.push(`Icon: ${agent.icon}`);
      /*
      FNXC:AgentHeartbeat 2026-07-12-18:20:
      FN-7859 requires fn_agent_show to surface why an agent is in error/paused so operators can classify recovery state without engine logs.
      */
      appendAgentDiagnosticLines(parts, agent, { compact: false });

      if (agent.reportsTo) {
        const manager = await agentStore.getAgent(agent.reportsTo);
        if (manager) {
          parts.push(`Reports To: ${manager.name} (${manager.id})`);
        } else {
          parts.push(`Reports To: ${agent.reportsTo}`);
        }
      }

      if (directReports.length > 0) {
        parts.push(`Direct Reports: ${directReports.map((r) => `${r.name} (${r.id})`).join(", ")}`);
      }

      if (agent.taskId) {
        /*
        FNXC:AgentTaskStateDrift 2026-06-27-16:05:
        Show the linked task column in fn_agent_show so parked triage/todo ownership is not mistaken for an in-progress execution mismatch.
        */
        let linkedTask: Pick<Task, "id" | "column"> | null = null;
        try {
          linkedTask = await store.getTask(agent.taskId);
        } catch {
          linkedTask = null;
        }
        parts.push(formatCurrentTaskLine(agent.taskId, linkedTask));
      }

      if (agent.instructionsText) {
        const snippet = agent.instructionsText.slice(0, 100);
        parts.push(`Custom Instructions: ${snippet}${agent.instructionsText.length > 100 ? "…" : ""}`);
      }

      if (agent.soul) {
        const snippet = agent.soul.slice(0, 200);
        parts.push(`Soul: ${snippet}${agent.soul.length > 200 ? "…" : ""}`);
      }

      if (agent.metadata?.skills) {
        parts.push(`Skills: ${JSON.stringify(agent.metadata.skills)}`);
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        details: {
          agent,
          directReports: directReports.map((r) => ({ id: r.id, name: r.name, role: r.role })),
        },
      };
    },
  });

  // ── fn_agent_org_chart ────────────────────────────────────────────

  pi.registerTool({
    name: "fn_agent_org_chart",
    label: "fn: Agent Org Chart",
    description:
      "Show the organizational tree of agents, displaying the role hierarchy. " +
      "Optionally filter to a subtree rooted at a specific agent.",
    promptSnippet: "Show the Fusion agent org chart",
    promptGuidelines: [
      "Use to understand the team structure and reporting hierarchy",
      "Optionally specify a root agent to see only their subtree",
      "Ephemeral/runtime agents are excluded by default",
    ],
    parameters: Type.Object({
      root_agent_id: Type.Optional(
        Type.String({ description: "If provided, show only the subtree rooted at this agent" }),
      ),
      include_ephemeral: Type.Optional(
        Type.Boolean({ description: "Include ephemeral/runtime agents (default: false)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      
      type OrgTreeNode = { agent: { id: string; icon?: string; name: string; role: string; state: string; taskId?: string }; children: OrgTreeNode[] };

      const agentStore = await getAgentStore(ctx.cwd);
      await agentStore.init();

      const includeEphemeral = params.include_ephemeral ?? false;

      // If root_agent_id specified, show subtree via chain-of-command + reports
      if (params.root_agent_id) {
        const rootAgent = await agentStore.resolveAgent(params.root_agent_id);
        if (!rootAgent) {
          return {
            content: [{ type: "text", text: `Agent '${params.root_agent_id}' not found` }],
            isError: true,
            details: { error: "Root agent not found" },
          };
        }

        // Get the full tree, then find the subtree
        const fullTree = await agentStore.getOrgTree({ includeEphemeral });

        // Find the subtree rooted at the specified agent
        const findSubtree = (nodes: OrgTreeNode[]): OrgTreeNode | null => {
          for (const node of nodes) {
            if (node.agent.id === rootAgent.id) return node;
            const found = findSubtree(node.children);
            if (found) return found;
          }
          return null;
        };

        const subtree = findSubtree(fullTree);
        if (!subtree) {
          // Agent exists but has no tree position — show just that agent
          return {
            content: [{
              type: "text" as const,
              text: `${rootAgent.icon ?? "🤖"} ${rootAgent.name} (${rootAgent.role}) — ${rootAgent.state}${rootAgent.taskId ? ` [${rootAgent.taskId}]` : ""}`,
            }],
            details: { tree: [{ agent: rootAgent, children: [] }] },
          };
        }

        const lines: string[] = [];
        const renderNode = (node: OrgTreeNode, indent: string) => {
          const a = node.agent;
          lines.push(
            `${indent}${a.icon ?? "🤖"} ${a.name} (${a.role}) — ${a.state}${a.taskId ? ` [${a.taskId}]` : ""}`,
          );
          for (const child of node.children) {
            renderNode(child, indent + "  ");
          }
        };
        renderNode(subtree, "");

        return {
          content: [{ type: "text" as const, text: `Agent Org Tree (subtree: ${rootAgent.name}):\n${lines.join("\n")}` }],
          details: { tree: [subtree] },
        };
      }

      // Full tree
      const tree = await agentStore.getOrgTree({ includeEphemeral });

      if (tree.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No agents found." }],
          details: { tree: [], count: 0 },
        };
      }

      const lines: string[] = [];
      let count = 0;
      const renderNode = (node: OrgTreeNode, indent: string) => {
        const a = node.agent;
        lines.push(
          `${indent}${a.icon ?? "🤖"} ${a.name} (${a.role}) — ${a.state}${a.taskId ? ` [${a.taskId}]` : ""}`,
        );
        count++;
        for (const child of node.children) {
          renderNode(child, indent + "  ");
        }
      };
      for (const root of tree) {
        renderNode(root, "");
      }

      return {
        content: [{ type: "text" as const, text: `Agent Org Tree (${count} agents):\n${lines.join("\n")}` }],
        details: { tree, count },
      };
    },
  });

  // ── fn_skills_search ─────────────────────────────────────────────

  pi.registerTool({
    name: "fn_skills_search",
    label: "FN: Search Skills",
    description:
      "Search the skills.sh directory for agent skills. Returns matching skills with names, " +
      "sources (owner/repo), install counts, and install commands. " +
      "Use fn_skills_install to install a selected skill.",
    promptSnippet: "Search skills.sh for agent skills",
    promptGuidelines: [
      "Use fn_skills_search to discover skills before installing",
      "Returns skills sorted by popularity (install count)",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query — framework name, technology, or capability (e.g., 'react', 'firebase', 'testing', 'docker')",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (default: 10, max: 50)",
          minimum: 1,
          maximum: 50,
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // Dynamic import to match existing extension patterns
      const { searchSkills, formatInstalls } = await import("./commands/skills.js");

      const skills = await searchSkills(params.query, params.limit ?? 10);

      if (skills.length === 0) {
        return {
          content: [{ type: "text", text: `No skills found for '${params.query}'` }],
          details: { count: 0, skills: [] },
        };
      }

      const lines: string[] = [];
      lines.push(`Found ${skills.length} skills matching '${params.query}':\n`);

      for (let i = 0; i < skills.length; i++) {
        const skill = skills[i]!;
        const installs = formatInstalls(skill.installs);
        lines.push(`${i + 1}. ${skill.name} (${skill.source})${installs ? ` — ${installs}` : ""}`);
      }

      lines.push("\nInstall a skill with: fn_skills_install({ source: \"<owner/repo>\", skill: \"<name>\" })");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: skills.length,
          skills: skills.map((s) => ({
            name: s.name,
            source: s.source,
            installs: s.installs,
            installCommand: `fn skills install ${s.source} --skill ${s.name}`,
          })),
        },
      };
    },
  });

  // ── fn_skills_install ─────────────────────────────────────────────

  pi.registerTool({
    name: "fn_skills_install",
    label: "FN: Install Skill",
    description:
      "Install an agent skill from skills.sh into the current project. " +
      "Downloads skill files into the project's skill directories (.fusion/skills/, legacy .pi/skills/, .agents/skills/). " +
      "The skill becomes available to AI agents in subsequent sessions.",
    promptSnippet: "Install a skill from skills.sh into the current project",
    promptGuidelines: [
      "Use fn_skills_install after fn_skills_search to install a discovered skill",
      "The source is in owner/repo format (e.g., 'firebase/agent-skills')",
      "Specify the skill name to install a specific skill, or omit to install all from the source",
    ],
    parameters: Type.Object({
      source: Type.String({
        description: "GitHub source in owner/repo format (e.g., 'firebase/agent-skills')",
      }),
      skill: Type.Optional(
        Type.String({
          description: "Specific skill name to install (e.g., 'firebase-basics'). Omit to install all skills from the source.",
        }),
      ),
    }),

    /*
    FNXC:MergeQueue 2026-07-15-11:40:
    Kill npx on abort/timeout so outer tool budgets cannot leave orphan install processes after the agent turn fails closed.
    */
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // FNXC:ToolPermissionGates 2026-07-26-13:55: hard-withheld from agent/ambiguous principals (installs third-party code into the project); operators unaffected.
      const withheldDenied = denyWithheldToolForAgentPrincipal("fn_skills_install", ctx as ExtensionCallerContext);
      if (withheldDenied) return withheldDenied;
      // Validate source format
      if (!/^[^/]+\/[^/]+$/.test(params.source)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid source format: '${params.source}'. Use owner/repo format (e.g., 'firebase/agent-skills').`,
            },
          ],
          isError: true,
          details: { error: "Invalid source format" },
        };
      }

      // Build npx skills add arguments
      const npxArgs = ["skills", "add", params.source];

      if (params.skill) {
        npxArgs.push("--skill", params.skill);
      }

      // Non-interactive mode (-y) targeting pi agent (-a pi)
      npxArgs.push("-y", "-a", "pi");

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "fn_skills_install aborted." }],
          isError: true,
          details: { error: "aborted" },
        };
      }

      const child = spawn("npx", npxArgs, {
        cwd: resolveProjectRoot(ctx.cwd),
        stdio: "pipe",
        shell: true,
      });

      let stderr = "";
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      /*
      FNXC:MergeQueue 2026-07-15-11:50:
      Prefer SIGTERM first; escalate to SIGKILL after a short grace so npx can flush, while still guaranteeing orphans do not survive tool timeout/abort.
      */
      let killEscalation: ReturnType<typeof setTimeout> | undefined;
      const killChild = (force = false) => {
        try {
          child.kill(force ? "SIGKILL" : "SIGTERM");
        } catch {
          /* ignore */
        }
        if (!force && killEscalation === undefined && child.exitCode === null && child.signalCode === null) {
          killEscalation = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }, 1_000);
          if (typeof killEscalation === "object" && killEscalation && "unref" in killEscalation) {
            killEscalation.unref();
          }
        }
      };

      const onAbort = () => killChild(false);
      signal?.addEventListener("abort", onAbort, { once: true });

      let exitCode: number;
      try {
        exitCode = await new Promise<number>((resolve) => {
          child.on("exit", (code) => {
            resolve(code ?? 1);
          });
          child.on("error", () => {
            resolve(1);
          });
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (killEscalation !== undefined) clearTimeout(killEscalation);
        // Process already exited on the success path; kill is a no-op. On hang/abort, ensure cleanup.
        if (child.exitCode === null && child.signalCode === null) {
          killChild(true);
        }
      }

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "fn_skills_install aborted." }],
          isError: true,
          details: { error: "aborted", stderr },
        };
      }

      if (exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to install skill: ${stderr || "npx skills add exited with code " + exitCode}`,
            },
          ],
          isError: true,
          details: { exitCode, stderr },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Installed skill from ${params.source}. Skills are discovered from .fusion/skills/, legacy .pi/skills/, and .agents/skills/. The skill will be available in future agent sessions.`,
          },
        ],
        details: { source: params.source, skill: params.skill ?? "all" },
      };
    },
  });

  // ── /fn command — start the dashboard + engine ───────────────────

  let dashboardProcess: ChildProcess | null = null;
  let dashboardPort: number | null = null;

  pi.registerCommand("fn", {
    description: "Start (or stop) the Fusion dashboard and AI engine",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      // /fn stop — kill the dashboard
      if (trimmed === "stop") {
        if (dashboardProcess) {
          dashboardProcess.kill("SIGINT");
          dashboardProcess = null;
          dashboardPort = null;
          ctx.ui.setStatus("fn", "");
          ctx.ui.notify("Fusion dashboard stopped", "info");
        } else {
          ctx.ui.notify("Fusion dashboard is not running", "warning");
        }
        return;
      }

      // /fn status
      if (trimmed === "status") {
        if (dashboardProcess && !dashboardProcess.killed) {
          ctx.ui.notify(`Fusion dashboard running on http://localhost:${dashboardPort}`, "info");
        } else {
          dashboardProcess = null;
          dashboardPort = null;
          ctx.ui.notify("Fusion dashboard is not running", "info");
        }
        return;
      }

      // /fn [port] — start the dashboard
      if (dashboardProcess && !dashboardProcess.killed) {
        ctx.ui.notify(
          `Fusion dashboard already running on http://localhost:${dashboardPort}. Use /fn stop first.`,
          "warning",
        );
        return;
      }

      const port = trimmed ? parseInt(trimmed, 10) || 4040 : 4040;

      // Find the fn binary: prefer local node_modules, then global
      const child = spawn("fn", ["dashboard", "--port", String(port)], {
        cwd: resolveProjectRoot(ctx.cwd),
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: { ...process.env },
        shell: true,
      });

      dashboardProcess = child;
      dashboardPort = port;

      // Watch for early exit (e.g. fn not found)
      child.on("error", (err) => {
        dashboardProcess = null;
        dashboardPort = null;
        ctx.ui.setStatus("fn", "");
        ctx.ui.notify(`Failed to start Fusion dashboard: ${err.message}`, "error");
      });

      child.on("exit", (code) => {
        if (dashboardProcess === child) {
          dashboardProcess = null;
          dashboardPort = null;
          ctx.ui.setStatus("fn", "");
          if (code !== 0 && code !== null) {
            ctx.ui.notify(`Fusion dashboard exited with code ${code}`, "warning");
          }
        }
      });

      // Wait briefly to see if it crashes immediately
      await new Promise((r) => setTimeout(r, 500));

      if (dashboardProcess && !dashboardProcess.killed) {
        const url = `http://localhost:${port}`;
        ctx.ui.notify(`Fusion dashboard started on ${url} (AI engine active)`, "info");
        const link = `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
        ctx.ui.setStatus("fn", `Fusion ● ${link}`);
      }
    },
  });

  // ── Cleanup on session end ───────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (dashboardProcess) {
      dashboardProcess.kill("SIGINT");
      dashboardProcess = null;
      dashboardPort = null;
    }
    /*
    FNXC:PostgresCliLifecycle 2026-07-14-22:38:
    The session shutdown handler's returned promise is the host's teardown barrier. Await cache cleanup so every factory-owned PostgreSQL pool or embedded process is stopped before the host considers the extension session closed.
    */
    await closeCachedStores();
  });
}
