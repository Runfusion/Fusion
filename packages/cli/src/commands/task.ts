import { TaskStore, COLUMNS, COLUMN_LABELS, CentralCore, buildAutoPauseClearPatch, buildManualRetryResetPatch, extractIntentSignature, findNearDuplicates, getTaskDuplicateLineage, isWorkspaceTask, reconcileDeterministicDuplicate, resolveTaskGithubTracking, runDeterministicDuplicateGuard, type Settings, type Column, type ColumnId, type StepStatus, type AgentLogType, type AgentLogEntry, type IntentSignature, type NearDuplicateCandidate, type NearDuplicateMatch, type TaskDependencyMutation } from "@fusion/core";
import { isInReviewMissingWorktreeSessionStartFailure, runAiMerge, landWorkspaceTask, installBaselineArchiveWorktreeDisposer } from "@fusion/engine";
import { createInterface } from "node:readline/promises";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";
import { createSession, submitResponse, validateSession, RateLimitError, SessionNotFoundError, InvalidSessionStateError } from "@fusion/dashboard/planning";
import { watchFile, unwatchFile, statSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as dashboard from "@fusion/dashboard";
import {
  getGhErrorMessage,
  isGhAuthenticated,
  isGhAvailable,
  runGhJsonAsync,
} from "@fusion/core/gh-cli";
import { resolveProject, createLocalStore, closeProjectStore, type ProjectContext } from "../project-context.js";
import { findNodeByNameOrId } from "./node.js";
import { retryOnLock, LockRetryExhaustedError } from "../lock-retry.js";

const STEP_STATUSES: StepStatus[] = ["pending", "in-progress", "done", "skipped"];

/** #1403: display a column's label, falling back to the raw id for
 *  workflow-defined custom columns that have no legacy label. */
function columnLabel(column: ColumnId): string {
  return (COLUMN_LABELS as Record<string, string>)[column] ?? column;
}

// Register GitHub tracking hook so CLI task creation paths (add, duplicate,
// refine, import, delegate) trigger tracking issue creation.
try {
  dashboard.registerGithubTrackingHook?.();
} catch {
  // Some tests partially mock @fusion/dashboard and omit the hook export.
}

function getGitHubIssueUrl(sourceMetadata: unknown): string | undefined {
  if (!sourceMetadata || typeof sourceMetadata !== "object") return undefined;
  const issueUrl = (sourceMetadata as { issueUrl?: unknown }).issueUrl;
  return typeof issueUrl === "string" && issueUrl.length > 0 ? issueUrl : undefined;
}

function getResearchSourceContext(sourceMetadata: unknown): string | undefined {
  if (!sourceMetadata || typeof sourceMetadata !== "object") return undefined;

  const findingLabel = (sourceMetadata as { findingLabel?: unknown }).findingLabel;
  if (typeof findingLabel === "string" && findingLabel.length > 0) {
    return findingLabel;
  }

  const runId = (sourceMetadata as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

async function formatTaskDuplicateLineage(task: Awaited<ReturnType<TaskStore["getTask"]>>, store: TaskStore): Promise<string | null> {
  const lineage = getTaskDuplicateLineage(task);
  if (lineage.length === 0) return null;

  const labels = await Promise.all(lineage.map(async (id) => {
    try {
      const linked = await store.getTask(id);
      return linked.column === "archived" ? `${id} (archived)` : id;
    } catch {
      return id;
    }
  }));

  return labels.join(", ");
}

function formatTaskSource(task: {
  sourceType?: string;
  sourceAgentId?: string;
  sourceParentTaskId?: string;
  sourceMetadata?: unknown;
}): string | null {
  switch (task.sourceType) {
    case "dashboard_ui":
      return "Dashboard";
    case "quick_chat":
      return "Quick Chat";
    case "chat_session":
      return "Chat Session";
    case "agent_heartbeat":
      return task.sourceAgentId ? `Agent (${task.sourceAgentId})` : "Agent";
    case "automation":
      return "Automation";
    case "cron":
      return "Scheduled Task";
    case "workflow_step":
      return "Workflow Step";
    case "github_import": {
      const issueUrl = getGitHubIssueUrl(task.sourceMetadata);
      return issueUrl ? `GitHub Import (${issueUrl})` : "GitHub Import";
    }
    case "gitlab_import":
      return "GitLab Import";
    case "research": {
      const context = getResearchSourceContext(task.sourceMetadata);
      return context ? `Research (${context})` : "Research";
    }
    case "task_refine":
      return task.sourceParentTaskId
        ? `Refinement of ${task.sourceParentTaskId}`
        : "Refinement";
    case "task_duplicate":
      return task.sourceParentTaskId
        ? `Duplicate of ${task.sourceParentTaskId}`
        : "Duplicate";
    case "cli":
      return "CLI";
    case "api":
      return "API";
    case "recovery":
      return "Recovery";
    case "unknown":
    default:
      return null;
  }
}

// FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): the old bare-`TaskStore`
// `getCommandContext`/`getStore` resolution path (which never closed the
// store it opened) has been fully replaced by `getBoardCommandContext` +
// `withBoardWrite`/`resolveBoardContext` below, which always resolve a full
// `ProjectContext` and close/evict it on every exit path. Removed here
// rather than left as an unused dead path.
function asLocalProjectContext(store: TaskStore): ProjectContext {
  const cwd = process.cwd();
  return {
    projectId: cwd,
    projectPath: cwd,
    projectName: basename(cwd) || "current-project",
    isRegistered: false,
    store,
  };
}

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Resolve the FULL `ProjectContext` (not just a bare `TaskStore`, unlike
 * `getStore`/`getCommandContext` above) for board read/write commands
 * (`runTaskShow`/`runTaskMove`) so they can deterministically close+evict
 * the store they open via `closeProjectStore` on every exit path — mirroring
 * the FN-7704 `fn agent stop/start` teardown fix. Covers all three
 * project-resolution branches `getCommandContext` covers (explicit
 * `--project`, default-project, and CWD-detected/unregistered fallback via
 * `new TaskStore(process.cwd())`), reusing `asLocalProjectContext` for the
 * fallback so `closeProjectStore` always receives a well-formed context.
 */
async function getBoardCommandContext(projectName?: string): Promise<ProjectContext> {
  if (projectName) {
    const context = await resolveProject(projectName);
    if (!context) {
      throw new Error(`Project ${projectName} not found`);
    }
    installBaselineArchiveWorktreeDisposer(context.store, {rootDir: context.projectPath, getSettings: () => context.store.getSettings()});
    return context;
  }

  try {
    const context = await resolveProject(undefined);
    if (!context) {
      throw new Error("No project context");
    }
    installBaselineArchiveWorktreeDisposer(context.store, {rootDir: context.projectPath, getSettings: () => context.store.getSettings()});
    return context;
  } catch {
    // FNXC:PostgresCutover 2026-07-05-12:00: the cwd fallback must boot through
    // the PostgreSQL startup factory (createLocalStore); a bare `new TaskStore`
    // resolves to the removed SQLite runtime, which throws on first DB access.
    const store = await createLocalStore(process.cwd());
    const context = asLocalProjectContext(store);
    installBaselineArchiveWorktreeDisposer(store, {rootDir: context.projectPath, getSettings: () => store.getSettings()});
    return context;
  }
}

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Translate a `LockRetryExhaustedError` (or any other error) from a board
 * read/write into the CLI's standard "print + exit(1)" failure shape. A
 * lock-exhaustion error already carries an actionable message (task id,
 * operation, and the `FUSION_CLI_LOCK_RETRY_MS` override), so it is printed
 * as-is rather than re-wrapped.
 */
function failBoardCommand(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734):
 * Generalizes the FN-7731 `runTaskShow`/`runTaskMove` retry+teardown shape
 * to every other `fn task` subcommand instead of forking a second copy of
 * the pattern. Two shared shapes cover the ~26 remaining `runTask*`
 * handlers:
 *
 *  - `withBoardWrite` mirrors runTaskShow/runTaskMove exactly: resolve
 *    context + run the ENTIRE board interaction as one retryable unit,
 *    closing the store on every attempt. Used for single-logical-unit
 *    commands (even ones that are technically 2-3 store calls that must all
 *    succeed/fail together, e.g. setNode's getTask+updateTask guard).
 *  - `resolveBoardContext` + `retryBoardCall` + `closeBoardContextAndExit`
 *    split resolution-retry from per-write-retry for MULTI-STEP flows
 *    (create, retry, delete, merge, bulk imports, plan) where retrying the
 *    WHOLE flow after a later step's lock error would redo an
 *    already-committed earlier write (e.g. double-creating a task,
 *    double-logging a retry entry). Only SQLite lock errors
 *    (`isSqliteLockError`, via `retryOnLock`) are retried in either shape;
 *    not-found/invalid-input errors propagate immediately without looping.
 *
 * Per MEMORY.md, `process.exit()` does NOT run pending `finally` blocks, so
 * any exit that occurs AFTER context resolution must close the store
 * explicitly first — `closeBoardContextAndExit` centralizes that.
 */
async function withBoardWrite<T>(
  projectName: string | undefined,
  context: { id: string; action: string },
  fn: (ctx: ProjectContext) => Promise<T>,
): Promise<T> {
  try {
    return await retryOnLock(
      async () => {
        const ctx = await getBoardCommandContext(projectName);
        try {
          return await fn(ctx);
        } finally {
          await closeProjectStore(ctx);
        }
      },
      context,
    );
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      failBoardCommand(error);
    }
    throw error;
  }
}

/** Resolve project/store context, retrying ONLY the resolution step (which can itself hit `database is locked` inside `TaskStore.init()`). Used by multi-step commands that must not retry already-committed writes. */
async function resolveBoardContext(projectName: string | undefined, id: string, action = "resolve project"): Promise<ProjectContext> {
  try {
    return await retryOnLock(() => getBoardCommandContext(projectName), { id, action });
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      failBoardCommand(error);
    }
    throw error;
  }
}

/** Retry a single discrete board write/read within an already-resolved multi-step flow. On lock-exhaustion, closes the resolved context before failing (mirrors `failBoardCommand`, but store-aware). */
async function retryBoardCall<T>(context: ProjectContext, id: string, action: string, op: () => Promise<T>): Promise<T> {
  try {
    return await retryOnLock(op, { id, action });
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await closeProjectStore(context).catch(() => {});
      failBoardCommand(error);
    }
    throw error;
  }
}

/** Close the resolved board context, then exit — used for exit paths reached AFTER context resolution, since `process.exit()` skips pending `finally` blocks. */
async function closeBoardContextAndExit(context: ProjectContext, code: number): Promise<never> {
  await closeProjectStore(context).catch(() => {});
  process.exit(code);
}

async function resolveNodeByNameOrId(nodeNameOrId: string): Promise<{ id: string; name?: string }> {
  const central = new CentralCore();
  await central.init();

  try {
    const looksLikeNodeId = nodeNameOrId.includes("-") && nodeNameOrId.length > 20;
    let node = looksLikeNodeId
      ? await central.getNode(nodeNameOrId)
      : await central.getNodeByName(nodeNameOrId);

    if (!node) {
      node = await findNodeByNameOrId(central, nodeNameOrId);
    }

    if (!node) {
      throw new Error(`Node not found: ${nodeNameOrId}`);
    }

    return { id: node.id, name: node.name };
  } finally {
    await central.close();
  }
}

function truncateNearDuplicateLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "(untitled)";
  return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
}

function formatNearDuplicateMatch(match: NearDuplicateMatch, candidates: Map<string, NearDuplicateCandidate>): string[] {
  const candidate = candidates.get(match.id);
  const labelSource = candidate?.title?.trim() || candidate?.description?.trim() || "(untitled)";
  const shared = match.sharedTokens.slice(0, 6).join(", ");
  return [
    `  ${match.id}  (${candidate?.column ?? "unknown"})  ${truncateNearDuplicateLabel(labelSource)}`,
    `           score: ${match.score.toFixed(2)}  shared: ${shared}`,
  ];
}

interface CliNearDuplicateOutcome {
  signature?: IntentSignature;
}

function hasIntentSignal(signature?: IntentSignature): signature is IntentSignature {
  return !!signature && (signature.routePaths.length + signature.filePaths.length + signature.identifiers.length) > 0;
}

async function runCliNearDuplicateCheck(args: {
  store: TaskStore;
  description: string;
  bypass: boolean;
}): Promise<CliNearDuplicateOutcome> {
  let signature: IntentSignature | undefined;
  let matches: NearDuplicateMatch[] = [];
  const candidates = new Map<string, NearDuplicateCandidate>();

  try {
    signature = extractIntentSignature({ description: args.description });
    const signalCount = signature.routePaths.length + signature.filePaths.length + signature.identifiers.length;
    if (signalCount === 0) {
      return { signature };
    }
    if (!args.bypass) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const taskCandidates = (await args.store.listTasks({ slim: false, includeArchived: false }))
        .filter((task) => task.column !== "done")
        .filter((task) => {
          const createdAtMs = Date.parse(task.createdAt);
          return Number.isFinite(createdAtMs) && createdAtMs >= cutoff;
        })
        .slice(0, 200)
        .map((task) => ({
          id: task.id,
          title: task.title ?? "",
          description: task.description,
          column: task.column,
          fileScope: Array.isArray(task.sourceMetadata?.fileScope)
            ? task.sourceMetadata.fileScope.filter((entry: unknown): entry is string => typeof entry === "string")
            : undefined,
          createdAt: Date.parse(task.createdAt),
        } satisfies NearDuplicateCandidate));
      for (const candidate of taskCandidates) {
        candidates.set(candidate.id, candidate);
      }
      matches = findNearDuplicates(
        { description: args.description },
        taskCandidates,
        { windowMs: 7 * 24 * 60 * 60 * 1000 },
      );
    }
  } catch (error) {
    console.error(`Warning: near-duplicate check failed (${error instanceof Error ? error.message : String(error)}); proceeding.`);
    return { signature: undefined };
  }

  if (matches.length === 0) {
    return { signature };
  }

  console.error("Possible near-duplicate of existing task(s):");
  for (const match of matches) {
    for (const line of formatNearDuplicateMatch(match, candidates)) {
      console.error(line);
    }
  }
  console.error("Pass --no-dedup to create anyway.");

  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error("Refusing to create near-duplicate task in non-interactive mode. Re-run with --no-dedup to override.");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Create anyway? [y/N]: ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      return { signature };
    }
  } finally {
    rl.close();
  }

  console.error("Task creation cancelled. Use --no-dedup to bypass.");
  process.exit(0);
}

export async function runTaskCreate(descriptionArg?: string, attachFiles?: string[], depends?: string[], projectName?: string, nodeName?: string, noDedup = false) {
  let description = descriptionArg;

  if (!description) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    description = await rl.question("Task description: ");
    rl.close();
  }

  if (!description?.trim()) {
    console.error("Description is required");
    process.exit(1);
  }
  const trimmedDescription = description.trim();

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): MULTI-STEP mutation
  // (duplicate guard -> createTask/link -> optional node update -> optional
  // attachments). Resolution is retried once via `resolveBoardContext`; the
  // dedup-guard+create step is naturally self-correcting on retry (a
  // fingerprint match after a partial earlier success surfaces as
  // guard.action==="duplicate", linking rather than re-creating), so it is
  // retried as a unit via `retryBoardCall`. The subsequent node-update and
  // attachment steps are each retried independently — NOT re-wrapped with
  // the create step — so a later step's lock error never re-runs the
  // already-committed create. The store is closed in a `finally` covering
  // every exit path.
  const context = await resolveBoardContext(projectName, "create", "resolve project");
  const store = context.store;
  try {
    const task = await retryBoardCall(context, "create", "create task", async () => {
      const guard = await runDeterministicDuplicateGuard(
        store,
        { description: trimmedDescription },
        {
          lockScope: context.projectId,
          bypass: noDedup,
        },
      );

      let createdOrLinked = guard.existing;
      let didLinkExisting = false;

      try {
        if (guard.action === "duplicate" && guard.existing) {
          createdOrLinked = guard.existing;
          didLinkExisting = true;
        } else {
          // FN-5171: create ordering remains deterministic duplicate (FN-4918) -> near-duplicate intent.
          // Mirrors the dashboard FN-5152 guard while keeping CLI create fail-open.
          const nearDuplicate = await runCliNearDuplicateCheck({
            store,
            description: trimmedDescription,
            bypass: noDedup,
          });
          const sourceMetadata = {
            ...(guard.fingerprint ? { contentFingerprint: guard.fingerprint } : {}),
            ...(hasIntentSignal(nearDuplicate.signature) ? { intentSignature: nearDuplicate.signature } : {}),
          };
          const created = await store.createTask({
            description: trimmedDescription,
            dependencies: depends,
            source: {
              sourceType: "cli",
              sourceMetadata: Object.keys(sourceMetadata).length > 0 ? sourceMetadata : undefined,
            },
          });

          const reconcileResult = await reconcileDeterministicDuplicate(store, {
            createdTask: created,
            fingerprint: guard.fingerprint,
          });
          createdOrLinked = reconcileResult.canonical;
          didLinkExisting = reconcileResult.outcome === "archived";
        }
      } finally {
        guard.releaseLock();
      }

      return { task: createdOrLinked, linkedExisting: didLinkExisting };
    });

    if (!task.task) {
      console.error("Failed to create or link task");
      await closeBoardContextAndExit(context, 1);
      return;
    }
    const resolvedTask = task.task;
    const linkedExisting = task.linkedExisting;

    let resolvedNode: { id: string; name?: string } | undefined;
    if (nodeName) {
      try {
        resolvedNode = await resolveNodeByNameOrId(nodeName);
        await retryBoardCall(context, resolvedTask.id, "set node override", () => store.updateTask(resolvedTask.id, { nodeId: resolvedNode!.id }));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        await closeBoardContextAndExit(context, 1);
        return;
      }
    }

    const label = resolvedTask.description.length > 60
      ? resolvedTask.description.slice(0, 60) + "…"
      : resolvedTask.description;

    console.log();
    if (context.projectName) {
      console.log(`  Project: ${context.projectName}`);
    }
    if (linkedExisting) {
      console.log(`  ✓ Linked existing ${resolvedTask.id}: ${label}`);
    } else {
      console.log(`  ✓ Created ${resolvedTask.id}: ${label}`);
    }
    console.log(`    Column: ${resolvedTask.column}`);
    if (resolvedTask.dependencies.length > 0) {
      console.log(`    Dependencies: ${resolvedTask.dependencies.join(", ")}`);
    }
    if (resolvedNode) {
      console.log(`    Node: ${resolvedNode.name || resolvedNode.id}`);
    }
    console.log(`    Path:   .fusion/tasks/${resolvedTask.id}/`);

    if (attachFiles && attachFiles.length > 0) {
      const { readFile } = await import("node:fs/promises");
      const { basename, extname, resolve } = await import("node:path");

      for (const filePath of attachFiles) {
        const resolvedPath = resolve(filePath);
        const filename = basename(resolvedPath);
        const ext = extname(filename).toLowerCase();
        const mimeType = MIME_TYPES[ext];

        if (!mimeType) {
          console.error(`    ✗ Unsupported file type: ${ext} (${filename})`);
          continue;
        }

        let content: Buffer;
        try {
          content = await readFile(resolvedPath);
        } catch {
          console.error(`    ✗ Cannot read file: ${filePath}`);
          continue;
        }

        const attachment = await retryBoardCall(context, resolvedTask.id, "attach file", () => store.addAttachment(resolvedTask.id, filename, content, mimeType));
        const sizeKB = (attachment.size / 1024).toFixed(1);
        console.log(`    📎 Attached: ${attachment.originalName} (${sizeKB} KB)`);
      }
    }

    console.log();
  } finally {
    await closeProjectStore(context).catch(() => {});
  }
}

export async function runTaskList(projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board read.
  // This command always calls `process.exit(0)` at the end (both branches),
  // so the store must be closed explicitly before each exit — `finally`
  // does not run past `process.exit()` (MEMORY.md).
  const context = await resolveBoardContext(projectName, "list", "resolve project");
  const tasks = await retryBoardCall(context, "list", "list tasks", () => context.store.listTasks({ slim: true }));

  if (tasks.length === 0) {
    console.log("\n  No tasks yet. Create one with: fn task create\n");
    await closeBoardContextAndExit(context, 0);
    return;
  }

  console.log();
  if (context.projectName && projectName) {
    console.log(`  Tasks for project '${context.projectName}':`);
    console.log();
  }

  for (const col of COLUMNS) {
    const colTasks = tasks.filter((t) => t.column === col);
    if (colTasks.length === 0) continue;

    const label = COLUMN_LABELS[col];
    const dot =
      col === "triage" ? "●" :
      col === "todo" ? "●" :
      col === "in-progress" ? "●" :
      col === "in-review" ? "●" : "○";

    console.log(`  ${dot} ${label} (${colTasks.length})`);
    for (const t of colTasks) {
      const deps = t.dependencies.length ? ` [deps: ${t.dependencies.join(", ")}]` : "";
      const label = t.title || t.description.slice(0, 60) + (t.description.length > 60 ? "…" : "");
      console.log(`    ${t.id}  ${label}${deps}`);
    }
    console.log();
  }

  await closeBoardContextAndExit(context, 0);
}

export async function runTaskUpdate(id: string, stepStr: string, status: string, projectName?: string) {
  const stepIndex = parseInt(stepStr, 10);
  if (isNaN(stepIndex)) {
    console.error(`Invalid step number: ${stepStr}`);
    process.exit(1);
  }
  if (!STEP_STATUSES.includes(status as StepStatus)) {
    console.error(`Invalid status: ${status}`);
    console.error(`Valid statuses: ${STEP_STATUSES.join(", ")}`);
    process.exit(1);
  }

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write —
  // wrap resolution+write in one retryable unit via `withBoardWrite`, closing
  // the resolved store on every attempt.
  await withBoardWrite(projectName, { id, action: "update step" }, async (context) => {
    const task = await context.store.updateStep(id, stepIndex, status as StepStatus);

    const step = task.steps[stepIndex];
    console.log();
    console.log(`  ✓ ${task.id} Step ${stepIndex} (${step.name}) → ${status}`);
    console.log(`    Progress: ${task.steps.filter((s) => s.status === "done").length}/${task.steps.length} steps done`);
    console.log();
  });
}


export async function runTaskDeps(
  operation: "add" | "remove" | "replace" | "set",
  id: string,
  dependencyArgs: string[],
  projectName?: string,
) {
  let mutation: TaskDependencyMutation;
  switch (operation) {
    case "add":
      if (dependencyArgs.length !== 1) throw new Error("Usage: fn task deps add <task> <dependency>");
      mutation = { operation, dependency: dependencyArgs[0] };
      break;
    case "remove":
      if (dependencyArgs.length !== 1) throw new Error("Usage: fn task deps remove <task> <dependency>");
      mutation = { operation, dependency: dependencyArgs[0] };
      break;
    case "replace":
      if (dependencyArgs.length !== 2) throw new Error("Usage: fn task deps replace <task> <old> <new>");
      mutation = { operation, from: dependencyArgs[0], to: dependencyArgs[1] };
      break;
    case "set":
      mutation = { operation, dependencies: dependencyArgs };
      break;
  }

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write.
  await withBoardWrite(projectName, { id, action: "update dependencies" }, async (context) => {
    const task = await context.store.updateTaskDependencies(id, mutation);
    console.log();
    console.log(`  ✓ ${task.id}: dependencies → ${task.dependencies.length ? task.dependencies.join(", ") : "none"}`);
    if (task.blockedBy) {
      console.log(`    Blocked by: ${task.blockedBy}`);
    } else {
      console.log("    Blocked by: none");
    }
    console.log();
  });
}

export async function runTaskLog(id: string, message: string, outcome?: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write.
  await withBoardWrite(projectName, { id, action: "log entry" }, async (context) => {
    await context.store.logEntry(id, message, outcome);

    console.log();
    console.log(`  ✓ ${id}: logged "${message}"`);
    console.log();
  });
}

export interface LogsOptions {
  follow?: boolean;
  limit?: number;
  type?: AgentLogType;
}

// ANSI color codes for terminal output
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

/**
 * Format a timestamp for display (locale time string)
 */
function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Format a single agent log entry for display
 */
function formatLogEntry(entry: AgentLogEntry): string {
  const ts = formatTimestamp(entry.timestamp);
  const agent = entry.agent ? `[${entry.agent.toUpperCase()}] ` : "";

  switch (entry.type) {
    case "text":
      return `  ${ts} ${agent}${entry.text}`;
    case "thinking":
      return `${ANSI.dim}${ANSI.gray}  ${ts} ${agent}[THINK] ${entry.text}${ANSI.reset}`;
    case "tool":
      return `  ${ts} ${agent}[TOOL] ${entry.text}${entry.detail ? ` (${entry.detail})` : ""}`;
    case "tool_result":
      return `  ${ts} ${agent}[RESULT] ${entry.text}${entry.detail ? ` (${entry.detail})` : ""}`;
    case "tool_error":
      return `${ANSI.red}  ${ts} ${agent}[ERROR] ${entry.text}${entry.detail ? ` (${entry.detail})` : ""}${ANSI.reset}`;
    default:
      return `  ${ts} ${agent}${entry.text}`;
  }
}

/**
 * Print log entries to console
 */
function printEntries(entries: AgentLogEntry[]): void {
  for (const entry of entries) {
    console.log(formatLogEntry(entry));
  }
}

/**
 * Filter and limit entries based on options
 */
function filterEntries(entries: AgentLogEntry[], options: LogsOptions): AgentLogEntry[] {
  let result = entries;

  // Filter by type if specified
  if (options.type) {
    result = result.filter((e) => e.type === options.type);
  }

  // Apply limit (default 100, max 1000)
  const limit = Math.min(options.limit ?? 100, 1000);
  if (result.length > limit) {
    result = result.slice(-limit);
  }

  return result;
}


export async function runTaskLogs(id: string, options: LogsOptions = {}, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): resolution + the
  // existence-check/fetch board reads are retried as one unit. `--follow`
  // mode is INTENTIONALLY long-lived (infinite tail until SIGINT) — per the
  // Step 1 audit decision, the store is kept open for the life of the
  // follow session (not retry-wrapped further) and closed explicitly in the
  // SIGINT handler, since `process.exit()` skips pending `finally` blocks.
  const context = await resolveBoardContext(projectName, id, "resolve project");

  let entries: AgentLogEntry[];
  try {
    entries = await retryBoardCall(context, id, "read agent logs", async () => {
      // Verify task exists
      try {
        await context.store.getTask(id);
      } catch {
        throw new Error(`Task ${id} not found`);
      }
      return context.store.getAgentLogs(id);
    });
  } catch (error) {
    await closeProjectStore(context).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  if (entries.length === 0 && !options.follow) {
    await closeProjectStore(context);
    console.log(`No agent logs found for ${id}`);
    return;
  }

  if (context.projectName && projectName) {
    console.log(`  Logs for project '${context.projectName}':`);
  }

  // Print existing entries (filtered)
  const filteredEntries = filterEntries(entries, options);
  printEntries(filteredEntries);

  // Follow mode: watch for new entries
  if (options.follow) {
    const projectPath = context.projectPath ?? process.cwd();
    const logPath = join(projectPath, ".fusion", "tasks", id, "agent.log");

    if (!existsSync(logPath)) {
      console.log(`\n  Waiting for log file to be created...`);
    }

    let lastPosition = 0;
    let lastSize = 0;

    // Try to get initial file size
    try {
      const stats = statSync(logPath);
      lastSize = stats.size;
      lastPosition = lastSize;
    } catch {
      // File doesn't exist yet, will watch for creation
    }

    // Track if we're shutting down
    let isShuttingDown = false;

    // Set up SIGINT handler for clean exit
    const sigintHandler = () => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      unwatchFile(logPath);
      console.log("\n  (stopped following logs)");
      void closeProjectStore(context).catch(() => {}).finally(() => {
        try {
          process.exit(0);
        } catch {
          // process.exit is mocked (non-throwing in production) in some test harnesses.
        }
      });
    };

    process.on("SIGINT", sigintHandler);

    // Start watching the file
    watchFile(logPath, { interval: 1000 }, () => {
      if (isShuttingDown) return;

      try {
        const stats = statSync(logPath);

        // File was truncated or recreated
        if (stats.size < lastPosition) {
          lastPosition = 0;
        }

        // New content available
        if (stats.size > lastPosition) {
          const content = readFileSync(logPath, "utf-8");
          const lines = content.slice(lastPosition).split("\n");

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line) as AgentLogEntry;
              // Apply type filter if specified
              if (!options.type || entry.type === options.type) {
                console.log(formatLogEntry(entry));
              }
            } catch {
              // Skip malformed lines
            }
          }

          lastPosition = stats.size;
        }

        lastSize = stats.size;
      } catch {
        // File may have been deleted, ignore
      }
    });

    // Keep process alive
    await new Promise(() => {
      // Infinite wait - SIGINT handler will exit
    });
    return;
  }

  await closeProjectStore(context);
}

export async function runTaskSetNode(id: string, nodeNameOrId: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): getTask+updateTask are
  // treated as ONE logical board write via `withBoardWrite`; the in-progress
  // guard exit and node-resolution failure exit both occur AFTER context
  // resolution, so they close the store explicitly before `process.exit()`
  // (finally does not run past `process.exit()` — MEMORY.md).
  await withBoardWrite(projectName, { id, action: "set node override" }, async (context) => {
    const task = await context.store.getTask(id);

    if (task.column === "in-progress") {
      console.error(`Cannot change node override: task ${id} is in progress`);
      await closeBoardContextAndExit(context, 1);
      return;
    }

    let resolvedNode: { id: string; name?: string };
    try {
      resolvedNode = await resolveNodeByNameOrId(nodeNameOrId);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      await closeBoardContextAndExit(context, 1);
      return;
    }

    await context.store.updateTask(id, { nodeId: resolvedNode.id });
    console.log(`✓ Set node override for ${id}: ${resolvedNode.name || resolvedNode.id}`);
  });
}

export async function runTaskClearNode(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): same shape as
  // runTaskSetNode above.
  await withBoardWrite(projectName, { id, action: "clear node override" }, async (context) => {
    const task = await context.store.getTask(id);

    if (task.column === "in-progress") {
      console.error(`Cannot change node override: task ${id} is in progress`);
      await closeBoardContextAndExit(context, 1);
      return;
    }

    await context.store.updateTask(id, { nodeId: null });
    console.log(`✓ Cleared node override for ${id}`);
  });
}

export async function runTaskShow(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (generalized by FN-7734's
  // `withBoardWrite`): wrap the ENTIRE flow — project/store resolution
  // (`getBoardCommandContext`, which can itself hit `database is locked`
  // inside `TaskStore.init()` for the CWD-detected/unregistered fallback
  // branch) AND the board read — in a single retryable unit, not just
  // `store.getTask`. Each attempt resolves a fresh context and closes it in
  // an inner `finally` before the next retry, so a failed attempt never
  // leaks a store handle. Only SQLite lock errors are retried
  // (`retryOnLock`); not-found and other errors propagate immediately
  // without looping. FN-7734 promoted this shape into the shared
  // `withBoardWrite` helper so every other `fn task` subcommand reuses it.
  await withBoardWrite(projectName, { id, action: "read task" }, async (context) => {
    await runTaskShowWithStore(id, context.store);
  });
}

async function runTaskShowWithStore(id: string, store: TaskStore) {
  const task = await store.getTask(id);
  const settings: Partial<Settings> = "getSettings" in store ? await store.getSettings() : {};

  let nodeSummary = "(default local)";
  if (task.nodeId) {
    let nodeName: string | undefined;
    const central = new CentralCore();
    await central.init();
    try {
      nodeName = (await central.getNode(task.nodeId))?.name;
    } finally {
      await central.close();
    }
    nodeSummary = nodeName ? `${nodeName} (${task.nodeId})` : task.nodeId;
  } else if (settings.defaultNodeId) {
    nodeSummary = `project default: ${settings.defaultNodeId}`;
  }

  console.log();
  console.log(`  ${task.id}: ${task.title || task.description}`);
  console.log(`  Column: ${columnLabel(task.column)}${task.size ? ` · Size: ${task.size}` : ""}${task.reviewLevel !== undefined ? ` · Review: ${task.reviewLevel}` : ""}`);
  if (task.dependencies.length) {
    console.log(`  Dependencies: ${task.dependencies.join(", ")}`);
  }
  console.log(`  Node: ${nodeSummary}`);
  if (settings.unavailableNodePolicy) {
    console.log(`  Unavailable Node Policy: ${settings.unavailableNodePolicy}`);
  }
  const sourceSummary = formatTaskSource(task);
  if (sourceSummary) {
    console.log(`  Source: ${sourceSummary}`);
  }
  const duplicateLineage = await formatTaskDuplicateLineage(task, store);
  if (duplicateLineage) {
    console.log(`  Duplicate of: ${duplicateLineage}`);
  }
  console.log();

  // Steps
  if (task.steps.length > 0) {
    console.log(`  Steps (${task.steps.filter((s) => s.status === "done").length}/${task.steps.length}):`);
    for (let i = 0; i < task.steps.length; i++) {
      const s = task.steps[i];
      const icon = s.status === "done" ? "✓"
        : s.status === "in-progress" ? "▸"
        : s.status === "skipped" ? "–"
        : " ";
      const marker = i === task.currentStep && s.status !== "done" ? " ◀" : "";
      console.log(`    [${icon}] ${i}: ${s.name}${marker}`);
    }
    console.log();
  }

  // Recent log
  if (task.log.length > 0) {
    const recent = task.log.slice(-5);
    console.log(`  Log (last ${recent.length}):`);
    for (const l of recent) {
      const ts = new Date(l.timestamp).toLocaleTimeString();
      console.log(`    ${ts}  ${l.action}${l.outcome ? ` → ${l.outcome}` : ""}`);
    }
    console.log();
  }
}

export async function runTaskMerge(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): resolve context ONCE
  // (retried — replaces the previous double resolution via `getStore` +
  // `getProjectPath`, each of which independently called `getCommandContext`)
  // and close it in a `finally` covering EVERY exit path, including the
  // `process.exit(1)` calls below. The AI merge (`runAiMerge`) and
  // workspace-land (`landWorkspaceTask`) subflows are deliberately NOT
  // retry-wrapped — they drive non-idempotent external git/AI operations,
  // so retrying the whole flow on a lock blip could double-drive a merge or
  // land (Step 1 audit decision).
  const context = await resolveBoardContext(projectName, id, "resolve project");
  const store = context.store;
  const projectPath = context.projectPath;

  console.log(`\n  Merging ${id} with AI...\n`);

  try {
    /*
    FNXC:GrokCliRouting 2026-07-15-10:17:
    `fn task merge` is a bare CLI door: ProjectContext only has store/path, not a live ProjectEngine, so no engine.getPluginRunner() is available. Do not invent a full PluginRunner bootstrap here (that belongs to InProcessRuntime / ProjectEngineManager). Omitting pluginRunner is intentional — grok-cli/no-key merge selections surface the dual-remediation error. Engine-backed merge already forwards this.getPluginRunner().
    */

    // FNXC:Workspace 2026-06-21-23:40 (Phase C U1, KTD2):
    // User-triggered `fn task merge`. A workspace-mode task routes through the
    // ENGINE per-repo merge loop `landWorkspaceTask` (each sub-repo lands on its own
    // LOCAL integration ref, no push) instead of throwing — manual merge works in
    // Phase C (user decision). U0's R7 throw is replaced here by routing; the
    // engine chokepoint + store.mergeTask/aiMergeTask keep throwing.
    const mergeTaskRecord = await store.getTask(id).catch(() => null);
    // FNXC:Workspace 2026-06-22-09:30 (Phase C review B10): use the exported `isWorkspaceTask`
    // (the engine/CLI canonical predicate) instead of re-inlining the workspaceWorktrees check.
    const isWorkspaceMerge = !!mergeTaskRecord && isWorkspaceTask(mergeTaskRecord);
    if (isWorkspaceMerge) {
      const workspaceResult = await landWorkspaceTask(store, mergeTaskRecord!, projectPath, {
        onAgentText: (delta) => process.stdout.write(delta),
      });
      console.log();
      for (const repo of workspaceResult.repos) {
        const label =
          repo.status === "landed" ? `landed ${repo.landedSha?.slice(0, 8) ?? ""} → ${repo.integrationBranch}`
          : repo.status === "empty" ? "no net changes"
          : `failed: ${repo.error ?? "unknown"}`;
        console.log(`  ${repo.status === "failed" ? "✗" : "✓"} ${repo.repo}: ${label}`);
      }
      // FNXC:Workspace 2026-06-22-05:10 (Phase C review B3):
      // landWorkspaceTask now finalizes the workspace task to done on allLanded (Phase C U2),
      // so report it as merged rather than "remains in review until U2". A partial land leaves
      // the task in review (landed repos stay landed locally) and exits non-zero.
      console.log(
        `\n  ${workspaceResult.allLanded ? "✓ All sub-repos landed — task finalized to done" : "✗ Partial land — see failures above (task remains in review; landed repos stay landed locally)"}\n`,
      );
      if (!workspaceResult.allLanded) await closeBoardContextAndExit(context, 1);
      return;
    }

    const result = await runAiMerge(store, projectPath, id, {
      onAgentText: (delta) => process.stdout.write(delta),
    });

    console.log();
    if (result.merged) {
      console.log(`  ✓ Merged ${result.task.id}`);
      console.log(`    Branch:   ${result.branch}`);
      console.log(`    Worktree: ${result.worktreeRemoved ? "removed" : "not found"}`);
      console.log(`    Branch:   ${result.branchDeleted ? "deleted" : "kept"}`);
    } else {
      console.log(`  ✓ Closed ${result.task.id} (${result.error})`);
    }
    console.log(`    Status:   done`);
    console.log();
  } catch (err) {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    await closeBoardContextAndExit(context, 1);
  } finally {
    await closeProjectStore(context).catch(() => {});
  }
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

export async function runTaskAttach(id: string, filePath: string, projectName?: string) {
  const { readFile } = await import("node:fs/promises");
  const { basename, extname } = await import("node:path");
  const { resolve } = await import("node:path");

  const resolvedPath = resolve(filePath);
  const filename = basename(resolvedPath);
  const ext = extname(filename).toLowerCase();
  const mimeType = MIME_TYPES[ext];

  if (!mimeType) {
    console.error(`Unsupported file type: ${ext}`);
    console.error(`Supported: ${Object.keys(MIME_TYPES).join(", ")}`);
    process.exit(1);
  }

  let content: Buffer;
  try {
    content = await readFile(resolvedPath);
  } catch {
    console.error(`Cannot read file: ${filePath}`);
    process.exit(1);
  }

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): the file read happens
  // BEFORE store resolution (as before), so only the single board write
  // (`addAttachment`) needs retry+close.
  await withBoardWrite(projectName, { id, action: "attach file" }, async (context) => {
    const attachment = await context.store.addAttachment(id, filename, content, mimeType);

    const sizeKB = (attachment.size / 1024).toFixed(1);
    console.log();
    console.log(`  ✓ Attached to ${id}: ${attachment.originalName}`);
    console.log(`    File: ${attachment.filename} (${sizeKB} KB)`);
    console.log(`    Path: .fusion/tasks/${id}/attachments/${attachment.filename}`);
    console.log();
  });
}

export async function runTaskPause(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write.
  await withBoardWrite(projectName, { id, action: "pause task" }, async (context) => {
    const task = await context.store.pauseTask(id, true);

    console.log();
    console.log(`  ✓ Paused ${task.id}`);
    console.log();
  });
}

export async function runTaskUnpause(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write.
  await withBoardWrite(projectName, { id, action: "unpause task" }, async (context) => {
    const task = await context.store.pauseTask(id, false);

    console.log();
    console.log(`  ✓ Unpaused ${task.id}`);
    console.log();
  });
}

export async function runTaskMove(id: string, column: string, projectName?: string) {
  if (!COLUMNS.includes(column as Column)) {
    console.error(`Invalid column: ${column}`);
    console.error(`Valid columns: ${COLUMNS.join(", ")}`);
    process.exit(1);
  }

  // FNXC:CliBoardMutation 2026-07-09-00:00 (generalized by FN-7734's
  // `withBoardWrite`): same rationale as runTaskShow above — wrap project/
  // store resolution (`getBoardCommandContext`, which can itself hit
  // `database is locked` inside `TaskStore.init()`) AND the write in one
  // retryable unit, closing the resolved store in an inner `finally` on
  // every attempt. Only `database is locked`/SQLITE_BUSY|LOCKED errors are
  // retried; a genuinely invalid move (bad column, missing task) propagates
  // immediately without looping.
  await withBoardWrite(projectName, { id, action: "move task" }, async (context) => {
    const task = await context.store.moveTask(id, column as Column);
    console.log();
    console.log(`  ✓ Moved ${task.id} → ${columnLabel(task.column)}`);
    console.log();
  });
}

export async function runTaskDuplicate(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write.
  await withBoardWrite(projectName, { id, action: "duplicate task" }, async (context) => {
    const newTask = await context.store.duplicateTask(id);

    console.log();
    console.log(`  ✓ Duplicated ${id} → ${newTask.id}`);
    console.log(`    Path: .fusion/tasks/${newTask.id}/`);
    console.log();
  });
}

export async function runTaskRefine(id: string, feedbackArg?: string, projectName?: string) {
  // Get feedback interactively only if not provided (undefined) — BEFORE
  // store resolution, since this is not a board call.
  let feedback = feedbackArg;
  if (feedback === undefined) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    feedback = await rl.question("What needs to be refined? ");
    rl.close();
  }

  if (!feedback?.trim()) {
    console.error("Feedback is required");
    process.exit(1);
  }

  // Validate length (matches API validation)
  if (feedback.length > 2000) {
    console.error("Feedback must be 2000 characters or less");
    process.exit(1);
  }

  const trimmedFeedback = feedback.trim();

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write.
  await withBoardWrite(projectName, { id, action: "refine task" }, async (context) => {
    const newTask = await context.store.refineTask(id, trimmedFeedback);

    console.log();
    console.log(`  ✓ Created refinement ${newTask.id} for ${id}`);
    console.log(`    Column: triage`);
    console.log(`    Dependency: ${id}`);
    console.log(`    Path: .fusion/tasks/${newTask.id}/`);
    console.log();
  });
}

export async function runTaskArchive(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write.
  await withBoardWrite(projectName, { id, action: "archive task" }, async (context) => {
    const task = await context.store.archiveTask(id);

    console.log();
    console.log(`  ✓ Archived ${task.id} → ${columnLabel(task.column)}`);
    console.log();
  });
}

export async function runTaskUnarchive(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write.
  await withBoardWrite(projectName, { id, action: "unarchive task" }, async (context) => {
    const task = await context.store.unarchiveTask(id);

    console.log();
    console.log(`  ✓ Unarchived ${task.id} → ${columnLabel(task.column)}`);
    console.log();
  });
}

export async function runTaskRetry(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): MULTI-STEP mutation
  // (moveTask + updateTask + logEntry, in one of three branches). Resolution
  // is retried once via `resolveBoardContext`; each discrete write is
  // retried independently via `retryBoardCall` rather than retrying the
  // WHOLE sequence, so a lock error on a LATER write does not redo an
  // already-committed earlier one (e.g. double-moving to todo or
  // double-logging the retry entry). The store is closed in a `finally`
  // covering every return path.
  const context = await resolveBoardContext(projectName, id, "resolve project");
  try {
    // Fetch task and validate it exists
    let task;
    try {
      task = await retryBoardCall(context, id, "read task", () => context.store.getTask(id));
    } catch {
      throw new Error(`Task ${id} not found`);
    }

    const isInReviewStatusNone =
      task.column === "in-review" && (task.status === null || task.status === undefined);
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
      task.column === "in-review" &&
      (task.status === "failed" ||
        task.status === "stuck-killed" ||
        isInReviewExecutionStall ||
        isInReviewMergeRetryStall);
    /*
    FNXC:MissingWorktreeRetry 2026-07-10-18:28:
    Upstream #1992 requires operator retry to recover an in-review task whose session start refused a missing/incomplete/unregistered worktree even when the row is stuck in an invalid merge-active status. This signature-only bypass clears stale session metadata instead of requiring a valid `merging` transition.
    */
    const isMissingWorktreeSessionRetry = isInReviewMissingWorktreeSessionStartFailure(task);

    // Validate task is in a retryable state
    if (task.status !== 'failed' && task.status !== 'stuck-killed' && !isInReviewRetry && !isMissingWorktreeSessionRetry) {
      throw new Error(`Task ${id} is not in a retryable state (status: ${task.status || 'none'})`);
    }

    const autoPauseClearPatch = buildAutoPauseClearPatch(task);
    const clearedDeadlockAutoPause = Object.keys(autoPauseClearPatch).length > 0;
    const retryLogSuffix = clearedDeadlockAutoPause ? ", cleared deadlock auto-pause" : "";

    if (isMissingWorktreeSessionRetry) {
      await retryBoardCall(context, id, "move task", () => context.store.moveTask(id, "todo", { preserveProgress: true }));
      await retryBoardCall(context, id, "update task", () => context.store.updateTask(id, {
        status: null,
        error: null,
        worktree: null,
        branch: null,
        sessionFile: null,
        ...autoPauseClearPatch,
        ...buildManualRetryResetPatch({ resetMergeRetries: true }),
      }));
      await retryBoardCall(context, id, "log entry", () => context.store.logEntry(id, `Retry requested from CLI (unusable worktree session-start recovery → todo, preserving progress${retryLogSuffix})`));

      console.log();
      console.log(`  ✓ Retried ${id} → todo (unusable worktree session metadata cleared)`);
      console.log();
      return;
    }

    // In-review retry: distinguish between execution failures (incomplete steps)
    // and merge failures (all steps done).
    if (isInReviewRetry) {
      if (isExecutionFailureInReview) {
        await retryBoardCall(context, id, "move task", () => context.store.moveTask(id, "todo", { preserveProgress: true }));
        await retryBoardCall(context, id, "update task", () => context.store.updateTask(id, {
          status: null,
          error: null,
          ...autoPauseClearPatch,
          ...buildManualRetryResetPatch(),
        }));
        await retryBoardCall(context, id, "log entry", () => context.store.logEntry(
          id,
          isInReviewExecutionStall
            ? `Retry requested from CLI (stranded in-review execution retry → todo, preserving progress${retryLogSuffix})`
            : `Retry requested from CLI (execution failure in-review → todo, preserving progress${retryLogSuffix})`,
        ));

        console.log();
        console.log(`  ✓ Retried ${id} → todo (execution failure, preserving step progress)`);
        console.log();
        return;
      }

      await retryBoardCall(context, id, "move task", () => context.store.moveTask(id, "todo"));
      await retryBoardCall(context, id, "update task", () => context.store.updateTask(id, {
        status: null,
        error: null,
        ...autoPauseClearPatch,
        ...buildManualRetryResetPatch({ resetMergeRetries: true }),
      }));
      await retryBoardCall(context, id, "log entry", () => context.store.logEntry(id, `Retry requested from CLI (merge retry → todo, mergeRetries reset${retryLogSuffix})`));

      console.log();
      console.log(`  ✓ Retried ${id} → todo (merge retry state cleared)`);
      console.log();
      return;
    }

    // Move to todo column before applying retry resets. `moveTask` reads from the
    // store's durable index and may overwrite task.json-only updates, so apply the
    // manual retry reset patch after the move to make the cleared counters stick.
    await retryBoardCall(context, id, "move task", () => context.store.moveTask(id, 'todo'));

    // Clear failure state and stale branch refs so retry can choose a fresh base.
    await retryBoardCall(context, id, "update task", () => context.store.updateTask(id, {
      status: null,
      error: null,
      worktree: null,
      branch: null,
      baseBranch: null,
      baseCommitSha: null,
      ...autoPauseClearPatch,
      ...buildManualRetryResetPatch({ resetMergeRetries: true }),
    }));

    // Log the retry action
    await retryBoardCall(context, id, "log entry", () => context.store.logEntry(
      id,
      clearedDeadlockAutoPause ? "Retry requested from CLI (cleared deadlock auto-pause)" : "Retry requested from CLI",
      "Task reset to todo for retry",
    ));

    console.log();
    console.log(`  ✓ Retried ${id} → todo (failure state cleared)`);
    console.log();
  } finally {
    await closeProjectStore(context).catch(() => {});
  }
}

export async function runTaskDelete(id: string, force?: boolean, allowResurrection?: boolean, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): MULTI-STEP mutation
  // (existence check, interactive confirm prompt, delete). Resolution and
  // the existence check are retried together; the interactive confirm
  // prompt runs with the context still open (no board call inside it, so no
  // retry is needed there); the terminal `deleteTask` write is retried
  // independently. Every exit path (not-found, cancel, delete failure,
  // success) closes the context first, since `process.exit()` skips pending
  // `finally` blocks.
  const context = await resolveBoardContext(projectName, id, "resolve project");

  // Check if task exists first
  try {
    await retryBoardCall(context, id, "read task", () => context.store.getTask(id));
  } catch {
    console.error(`✗ Task ${id} not found`);
    await closeBoardContextAndExit(context, 1);
    return;
  }

  // Prompt for confirmation unless force is used
  if (!force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Are you sure you want to delete ${id}? [y/N] `);
    rl.close();

    const trimmed = answer.trim().toLowerCase();
    if (trimmed !== "y" && trimmed !== "yes") {
      console.log("Cancelled.");
      await closeBoardContextAndExit(context, 0);
      return;
    }
  }

  try {
    await retryBoardCall(context, id, "delete task", () => context.store.deleteTask(id, {
      allowResurrection: allowResurrection === true,
      auditContext: {
        agentId: "cli",
        runId: `synthetic-cli-delete-${id}-${Date.now()}`,
      },
    }));
    console.log();
    console.log(`  ✓ Deleted ${id}`);
    console.log();
    await closeProjectStore(context);
  } catch (err) {
    console.error(`✗ Failed to delete ${id}: ${err instanceof Error ? err.message : String(err)}`);
    await closeBoardContextAndExit(context, 1);
    return;
  }
}

export async function runTaskImportGitHubInteractive(
  ownerRepo: string,
  options: TaskImportOptions = {},
  projectName?: string
): Promise<void> {
  // Parse owner/repo
  const match = ownerRepo.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    console.error(`Invalid owner/repo format: ${ownerRepo}`);
    console.error(`Expected format: owner/repo (e.g., dustinbyrne/fusion)`);
    process.exit(1);
  }

  const [, owner, repo] = match;
  const { limit = 30, labels } = options;

  console.log(`\n  Fetching issues from ${owner}/${repo}...\n`);

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): INTENTIONALLY
  // interactive (issue-selection prompt) — per the Step 1 audit decision,
  // resolution happens once and the store stays open for the interactive
  // selection prompt (no board call inside the prompt itself, so no retry
  // is needed there); only discrete board calls (the initial `listTasks`
  // and each per-issue `createTask`) are retried. The store is closed in a
  // `finally` covering every exit path.
  const context = await resolveBoardContext(projectName, "import", "resolve project");
  const store = context.store;
  try {
    const existingTasks = await retryBoardCall(context, "import", "list tasks", () => store.listTasks({ slim: false }));

    let issues: GitHubIssue[];
    try {
      issues = await fetchGitHubIssues(owner, repo, { limit, labels });
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
      await closeBoardContextAndExit(context, 1);
      return;
    }

    if (issues.length === 0) {
      console.log(`  No open issues found in ${owner}/${repo}.\n`);
      return;
    }

    // Display issues with numbers
    console.log(`  Found ${issues.length} issues:\n`);
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const importedTask = existingTasks.find((task) => dashboard.isGitHubIssueAlreadyImported(task, {
        owner,
        repo,
        issueNumber: issue.number,
        sourceUrl: issue.html_url,
      }));
      const status = importedTask ? ` [Imported as ${importedTask.id}]` : "";
      console.log(`  ${i + 1}. #${issue.number} ${issue.title.slice(0, 80)}${issue.title.length > 80 ? "…" : ""}${status}`);
    }

    console.log();

    // Create readline interface for interactive selection
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    let selectedIndices: number[] = [];
    let validInput = false;

    while (!validInput) {
      const answer = await rl.question('  Enter numbers to import (comma-separated) or "all": ');
      const trimmed = answer.trim().toLowerCase();

      if (trimmed === "all") {
        selectedIndices = issues.map((_, i) => i);
        validInput = true;
      } else {
        const nums = trimmed
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n));

        if (nums.length === 0) {
          console.log("  Please enter at least one number or 'all'");
          continue;
        }

        const outOfRange = nums.filter((n) => n < 1 || n > issues.length);
        if (outOfRange.length > 0) {
          console.log(`  Invalid selection: ${outOfRange.join(", ")} (range: 1-${issues.length})`);
          continue;
        }

        selectedIndices = nums.map((n) => n - 1); // Convert to 0-based
        validInput = true;
      }
    }

    rl.close();

    console.log();

    const importedIssueGithubTracking = await retryBoardCall(context, "import", "resolve github tracking", () => resolveImportedIssueGithubTracking(store));

    let created = 0;
    let skipped = 0;

    for (const idx of selectedIndices) {
      const issue = issues[idx];

      // Re-evaluate the shared dedup helper against tasks created earlier in this run.
      const importedTask = existingTasks.find((task) => dashboard.isGitHubIssueAlreadyImported(task, {
        owner,
        repo,
        issueNumber: issue.number,
        sourceUrl: issue.html_url,
      }));
      if (importedTask) {
        console.log(`  → Skipping #${issue.number}: already imported as ${importedTask.id}`);
        skipped++;
        continue;
      }

      // Prepare title (truncate to 200 chars)
      const title = issue.title.slice(0, 200);

      // Prepare description
      const body = issue.body?.trim() || "(no description)";
      const description = `${body}\n\nSource: ${issue.html_url}`;

      // Create the task
      // FN-5060: intentional same-content sibling; deterministic guard skipped here.
      const source = dashboard.buildGitHubIssueSource(owner, repo, issue);
      const task = await retryBoardCall(context, "import", "create task", () => store.createTask({
        title: title || undefined,
        description,
        column: "triage",
        dependencies: [],
        sourceIssue: source.sourceIssue,
        source: {
          sourceType: "github_import",
          sourceMetadata: source.sourceMetadata,
        },
        ...(importedIssueGithubTracking ? { githubTracking: importedIssueGithubTracking } : {}),
      }));

      const label = task.title || task.description.slice(0, 60) + (task.description.length > 60 ? "…" : "");
      console.log(`  ✓ Created ${task.id}: ${label}`);
      existingTasks.push(task);
      created++;
    }

    console.log();
    console.log(`  ✓ Imported ${created} tasks from ${owner}/${repo}${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
    console.log();
  } finally {
    await closeProjectStore(context).catch(() => {});
  }
}

// ── GitHub Issue Import ───────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
}

export interface FetchGitHubIssuesOptions {
  limit?: number;
  labels?: string[];
  since?: string;
}

export async function fetchGitHubIssues(
  owner: string,
  repo: string,
  options: FetchGitHubIssuesOptions = {}
): Promise<GitHubIssue[]> {
  const { limit = 30, labels, since } = options;

  if (!isGhAvailable() || !isGhAuthenticated()) {
    throw new Error("GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.");
  }

  // Build query parameters - only open issues, no PRs
  const params = new URLSearchParams();
  params.append("state", "open");
  params.append("per_page", String(Math.min(limit, 100)));
  if (labels && labels.length > 0) {
    params.append("labels", labels.join(","));
  }
  if (since) {
    params.append("since", since);
  }

  const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`;

  try {
    const issues = await runGhJsonAsync<Array<GitHubIssue & { pull_request?: unknown }>>(["api", path]);
    return issues.filter((issue) => !issue.pull_request).slice(0, limit);
  } catch (error) {
    throw new Error(getGhErrorMessage(error));
  }
}

export interface TaskImportOptions {
  limit?: number;
  labels?: string[];
}

async function resolveImportedIssueGithubTracking(store: TaskStore): Promise<{ enabled: true } | undefined> {
  const projectSettings = await store.getSettings();
  if (projectSettings.githubLinkImportedIssuesToTracking === true) {
    /*
    FNXC:GithubImportTracking 2026-07-01-00:00:
    The import-only linking setting deliberately bypasses ordinary new-task defaults for GitHub issue imports only. CLI import paths set githubTracking.enabled so the tracking hook adopts the sourceIssue instead of creating another issue.
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

export async function runTaskImportFromGitHub(
  ownerRepo: string,
  options: TaskImportOptions = {},
  projectName?: string
): Promise<void> {
  // Parse owner/repo
  const match = ownerRepo.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    console.error(`Invalid owner/repo format: ${ownerRepo}`);
    console.error(`Expected format: owner/repo (e.g., dustinbyrne/fusion)`);
    process.exit(1);
  }

  const [, owner, repo] = match;
  const { limit = 30, labels } = options;

  console.log(`\n  Importing issues from ${owner}/${repo}...\n`);

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): MULTI-STEP mutation
  // (loop of creates, no interactivity). Resolution + initial list are
  // retried once; each `createTask` call in the loop is retried
  // independently — self-correcting on retry via the shared helper against
  // the growing existing-task set, so redoing an earlier iteration after a LATER
  // one's lock error is harmless. Store closed in a `finally`.
  const context = await resolveBoardContext(projectName, "import", "resolve project");
  const store = context.store;
  try {
    const existingTasks = await retryBoardCall(context, "import", "list tasks", () => store.listTasks({ slim: false }));

    let issues: GitHubIssue[];
    try {
      issues = await fetchGitHubIssues(owner, repo, { limit, labels });
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
      await closeBoardContextAndExit(context, 1);
      return;
    }

    if (issues.length === 0) {
      console.log(`  No open issues found in ${owner}/${repo}.\n`);
      return;
    }

    const importedIssueGithubTracking = await retryBoardCall(context, "import", "resolve github tracking", () => resolveImportedIssueGithubTracking(store));

    let created = 0;
    let skipped = 0;

    for (const issue of issues) {
      // Re-evaluate the shared dedup helper against tasks created earlier in this run.
      const importedTask = existingTasks.find((task) => dashboard.isGitHubIssueAlreadyImported(task, {
        owner,
        repo,
        issueNumber: issue.number,
        sourceUrl: issue.html_url,
      }));
      if (importedTask) {
        console.log(`  → Skipping #${issue.number}: already imported as ${importedTask.id}`);
        skipped++;
        continue;
      }

      // Prepare title (truncate to 200 chars)
      const title = issue.title.slice(0, 200);

      // Prepare description
      const body = issue.body?.trim() || "(no description)";
      const description = `${body}\n\nSource: ${issue.html_url}`;

      // Create the task
      // FN-5060: intentional same-content sibling; deterministic guard skipped here.
      const source = dashboard.buildGitHubIssueSource(owner, repo, issue);
      const task = await retryBoardCall(context, "import", "create task", () => store.createTask({
        title: title || undefined,
        description,
        column: "triage",
        dependencies: [],
        sourceIssue: source.sourceIssue,
        source: {
          sourceType: "github_import",
          sourceMetadata: source.sourceMetadata,
        },
        ...(importedIssueGithubTracking ? { githubTracking: importedIssueGithubTracking } : {}),
      }));

      const label = task.title || task.description.slice(0, 60) + (task.description.length > 60 ? "…" : "");
      console.log(`  ✓ Created ${task.id}: ${label}`);
      existingTasks.push(task);
      created++;
    }

    console.log();
    console.log(`  ✓ Imported ${created} tasks from ${owner}/${repo}${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
    console.log();
  } finally {
    await closeProjectStore(context).catch(() => {});
  }
}

export type GitLabImportResource = "project-issues" | "group-issues" | "merge-requests";

async function createGitLabClientForStore(store: TaskStore): Promise<dashboard.GitLabClient> {
  const projectSettings = await store.getSettings();
  const globalSettings = await store.getGlobalSettingsStore().getSettings();
  const auth = dashboard.resolveGitlabAuth({ projectSettings, globalSettings });
  if (!auth.ok) throw new Error(auth.message);
  return new dashboard.GitLabClient(auth.auth);
}

export async function runTaskImportFromGitLab(
  target: string,
  options: TaskImportOptions & { resource?: GitLabImportResource } = {},
  projectName?: string,
): Promise<void> {
  const resource = options.resource ?? "project-issues";
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): MULTI-STEP mutation
  // (loop of creates+logs, no interactivity). Resolution + initial list are
  // retried once; each per-item create+log pair is retried independently —
  // self-correcting via the `isGitLabAlreadyImported` check, so redoing an
  // earlier iteration after a LATER one's lock error is harmless. Store
  // closed in a `finally`.
  const context = await resolveBoardContext(projectName, "import", "resolve project");
  const store = context.store;
  try {
    const client = await createGitLabClientForStore(store);
    console.log(`\n  Importing GitLab ${resource} from ${target}...\n`);
    const labelArray = options.labels ?? [];
    const items = resource === "project-issues"
      ? await client.listProjectIssues(target, { limit: options.limit, labels: labelArray })
      : resource === "group-issues"
        ? await client.listGroupIssues(target, { limit: options.limit, labels: labelArray })
        : await client.listMergeRequests(target, { limit: options.limit, labels: labelArray });
    if (items.length === 0) {
      console.log("  No GitLab resources found.\n");
      return;
    }
    const existingTasks = await retryBoardCall(context, "import", "list tasks", () => store.listTasks({ slim: false, includeArchived: false }));
    let created = 0;
    let skipped = 0;
    for (const item of items) {
      const provenance = dashboard.buildGitLabTaskProvenance({ auth: client.auth, resourceType: resource === "merge-requests" ? "merge_request" : resource === "group-issues" ? "group_issue" : "project_issue", item, projectInput: resource !== "group-issues" ? target : undefined, groupInput: resource === "group-issues" ? target : undefined });
      if (existingTasks.some((task) => dashboard.isGitLabAlreadyImported(task, provenance))) {
        console.log(`  → Skipping #${item.iid}: already imported`);
        skipped += 1;
        continue;
      }
      const title = resource === "merge-requests" ? `Review MR !${item.iid}: ${item.title.slice(0, 180)}` : item.title.slice(0, 200);
      const task = await retryBoardCall(context, "import", "create task", () => store.createTask({
        title: title || undefined,
        description: dashboard.buildGitLabTaskDescription(item),
        column: "triage",
        dependencies: [],
        sourceIssue: provenance.sourceIssue,
        gitlabTracking: provenance.gitlabTracking,
        source: { sourceType: "gitlab_import", sourceMetadata: provenance.sourceMetadata },
      }));
      await retryBoardCall(context, task.id, "log entry", () => store.logEntry(task.id, resource === "merge-requests" ? "Imported merge request from GitLab" : "Imported from GitLab", item.webUrl));
      existingTasks.push(task);
      created += 1;
      console.log(`  ✓ Created ${task.id}: ${task.title}`);
    }
    console.log(`\n  ✓ Imported ${created} GitLab tasks${skipped > 0 ? ` (${skipped} skipped)` : ""}\n`);
  } finally {
    await closeProjectStore(context).catch(() => {});
  }
}

export async function runTaskComment(id: string, message?: string, author = "user", projectName?: string) {
  // Interactive prompt runs BEFORE store resolution (not a board call).
  let text = message;
  if (text === undefined) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    text = await rl.question("Comment: ");
    rl.close();
  }

  if (!text || text.trim().length === 0) {
    console.error("Error: Comment is required");
    process.exit(1);
  }

  const trimmed = text.trim();
  if (trimmed.length > 2000) {
    console.error("Error: Comment must be between 1 and 2000 characters");
    process.exit(1);
  }

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write.
  await withBoardWrite(projectName, { id, action: "add comment" }, async (context) => {
    const task = await context.store.addTaskComment(id, trimmed, author || "user");
    const latestComment = task.comments?.[task.comments.length - 1];

    console.log();
    console.log(`  ✓ Comment added to ${task.id}`);
    if (latestComment) {
      console.log(`    ID: ${latestComment.id}`);
    }
    console.log();
  });
}

export async function runTaskComments(id: string, projectName?: string) {
  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board read.
  await withBoardWrite(projectName, { id, action: "read comments" }, async (context) => {
    const task = await context.store.getTask(id);
    const comments = task.comments || [];

    console.log();
    if (comments.length === 0) {
      console.log(`  No comments on ${id}`);
      console.log();
      return;
    }

    console.log(`  Comments for ${id}:`);
    for (const comment of comments) {
      console.log(`    ${comment.id} · ${comment.author} · ${new Date(comment.updatedAt || comment.createdAt).toLocaleString()}`);
      console.log(`    ${comment.text}`);
    }
    console.log();
  });
}

export async function runTaskSteer(id: string, message?: string, projectName?: string) {
  // Get message interactively if not provided as argument — BEFORE store
  // resolution (not a board call).
  let text = message;
  if (text === undefined) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    text = await rl.question("Message: ");
    rl.close();
  }

  // Validate message
  if (!text || text.trim().length === 0) {
    console.error("Error: Message is required");
    process.exit(1);
  }

  const trimmed = text.trim();
  if (trimmed.length > 2000) {
    console.error("Error: Message must be between 1 and 2000 characters");
    process.exit(1);
  }

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): single board write;
  // preserves the existing ENOENT→not-found translation (a non-lock error,
  // so it propagates immediately without retry-looping).
  await withBoardWrite(projectName, { id, action: "add steering comment" }, async (context) => {
    let task;
    try {
      task = await context.store.addSteeringComment(id, trimmed, "user");
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as Record<string, unknown>).code === "ENOENT") {
        console.error(`Error: Task not found: ${id}`);
        await closeBoardContextAndExit(context, 1);
      }
      throw err;
    }

    // Show success with preview
    const preview = trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed;
    console.log();
    console.log(`  ✓ Steering comment added to ${task.id}`);
    console.log(`    "${preview}"`);
    console.log();
  });
}

// ── PR Creation ─────────────────────────────────────────────────────────────
//
// The PR-creation implementation moved to commands/pr.ts as `runPrCreate` when
// the per-task `fn task pr-create` command was retired in favor of the unified
// `fn pr` namespace (U8, R13). These re-exports are kept ONLY so existing
// importers/tests that referenced the old symbols keep resolving; `fn task
// pr-create` no longer dispatches from bin.ts. Prefer `runPrCreate` / `fn pr
// create` for new code.
export type { PrCreateOptions } from "./pr.js";
export { runPrCreate as runTaskPrCreate } from "./pr.js";

// ── Planning Mode ───────────────────────────────────────────────────────────

/** Helper to display thinking indicator */
function showThinking(): void {
  process.stdout.write("  AI is thinking...");
}

/** Helper to clear thinking indicator */
function clearThinking(): void {
  process.stdout.write("\r" + " ".repeat(20) + "\r");
}

/** Prompt for text (multi-line) question */
async function promptText(question: PlanningQuestion): Promise<string> {
  console.log(`\n  ${question.question}`);
  if (question.description) {
    console.log(`  ${question.description}`);
  }
  console.log("  (Enter your response. Type DONE on its own line when finished):\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];

  return new Promise((resolve) => {
    const askLine = () => {
      rl.question("  ").then((line) => {
        if (line.trim() === "DONE") {
          rl.close();
          resolve(lines.join("\n"));
        } else {
          lines.push(line);
          askLine();
        }
      });
    };
    askLine();
  });
}

/** Prompt for single_select question */
async function promptSingleSelect(question: PlanningQuestion): Promise<string> {
  console.log(`\n  ${question.question}`);
  if (question.description) {
    console.log(`  ${question.description}`);
  }
  console.log();

  if (!question.options || question.options.length === 0) {
    throw new Error("Single select question has no options");
  }

  for (let i = 0; i < question.options.length; i++) {
    const opt = question.options[i];
    console.log(`  ${i + 1}. ${opt.label}`);
    if (opt.description) {
      console.log(`     ${opt.description}`);
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const answer = await rl.question("\n  Select (1-" + question.options.length + "): ");
    const num = parseInt(answer.trim(), 10);

    if (!isNaN(num) && num >= 1 && num <= question.options.length) {
      rl.close();
      return question.options[num - 1].id;
    }

    console.log(`  Invalid selection. Please enter a number between 1 and ${question.options.length}`);
  }
}

/** Prompt for multi_select question */
async function promptMultiSelect(question: PlanningQuestion): Promise<string[]> {
  console.log(`\n  ${question.question}`);
  if (question.description) {
    console.log(`  ${question.description}`);
  }
  console.log("  (Enter comma-separated numbers, e.g., 1,3,4):\n");

  if (!question.options || question.options.length === 0) {
    throw new Error("Multi select question has no options");
  }

  for (let i = 0; i < question.options.length; i++) {
    const opt = question.options[i];
    console.log(`  ${i + 1}. ${opt.label}`);
    if (opt.description) {
      console.log(`     ${opt.description}`);
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const answer = await rl.question("\n  Select (comma-separated): ");
    const nums = answer
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));

    if (nums.length === 0) {
      console.log("  Please select at least one option");
      continue;
    }

    const invalid = nums.filter((n) => n < 1 || n > question.options!.length);
    if (invalid.length > 0) {
      console.log(`  Invalid selection: ${invalid.join(", ")}. Range: 1-${question.options.length}`);
      continue;
    }

    rl.close();
    return nums.map((n) => question.options![n - 1].id);
  }
}

/** Prompt for confirm question */
async function promptConfirm(question: PlanningQuestion): Promise<boolean> {
  console.log(`\n  ${question.question}`);
  if (question.description) {
    console.log(`  ${question.description}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("\n  [Y/n]: ");
  rl.close();

  const trimmed = answer.trim().toLowerCase();
  return trimmed === "" || trimmed === "y" || trimmed === "yes";
}

/** Display planning summary */
function displaySummary(summary: PlanningSummary): void {
  console.log();
  console.log("  ╔══════════════════════════════════════════════════════════════╗");
  console.log("  ║                    Planning Summary                            ║");
  console.log("  ╠══════════════════════════════════════════════════════════════╣");
  console.log(`  ║ Title: ${summary.title.slice(0, 55).padEnd(55)} ║`);
  console.log("  ╠══════════════════════════════════════════════════════════════╣");

  // Description (wrapped to box width)
  const descLines = wrapText(summary.description, 58);
  for (const line of descLines.slice(0, 10)) {
    console.log(`  ║ ${line.padEnd(58)} ║`);
  }
  if (descLines.length > 10) {
    console.log(`  ║ ... (${descLines.length - 10} more lines) ...`.padEnd(62) + " ║");
  }

  console.log("  ╠══════════════════════════════════════════════════════════════╣");
  console.log(`  ║ Size: ${summary.suggestedSize.padEnd(52)} ║`);

  if (summary.suggestedDependencies.length > 0) {
    console.log(`  ║ Dependencies: ${summary.suggestedDependencies.join(", ").slice(0, 45).padEnd(45)} ║`);
  } else {
    console.log(`  ║ Dependencies: none`.padEnd(62) + " ║");
  }

  console.log("  ╠══════════════════════════════════════════════════════════════╣");
  console.log("  ║ Key Deliverables:                                              ║");
  for (const deliverable of summary.keyDeliverables) {
    console.log(`  ║   • ${deliverable.slice(0, 54).padEnd(54)} ║`);
  }
  console.log("  ╚══════════════════════════════════════════════════════════════╝");
  console.log();
}

/** Wrap text to specified width */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }

    let remaining = paragraph.trim();
    while (remaining.length > 0) {
      if (remaining.length <= width) {
        lines.push(remaining);
        break;
      }

      let breakPoint = width;
      while (breakPoint > 0 && remaining[breakPoint] !== " ") {
        breakPoint--;
      }

      if (breakPoint === 0) {
        // No space found, force break
        breakPoint = width;
      }

      lines.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trim();
    }
  }

  return lines;
}

/** Run the planning mode */
export async function runTaskPlan(
  initialPlanArg?: string,
  yesFlag = false,
  projectName?: string,
  baseBranch?: string,
): Promise<string | undefined> {
  let initialPlan = initialPlanArg;

  // If no initial plan, prompt interactively
  if (!initialPlan) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n  Let's plan your task. What would you like to accomplish?\n");
    initialPlan = await rl.question("  Describe your idea: ");
    rl.close();

    if (!initialPlan?.trim()) {
      console.error("\n  Description is required");
      process.exit(1);
    }
  }

  // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): INTENTIONALLY
  // long-lived/interactive (multi-turn planning Q&A loop with network
  // planning-session calls) — per the Step 1 audit decision, the Q&A loop
  // itself is NOT retry-wrapped (forbidden by this task's "Do NOT" list);
  // only the ONE discrete board write (`store.createTask` on confirm) is
  // retried via `retryBoardCall`. The resolved context is closed explicitly
  // on every exit path (all `process.exit()` calls, the SIGINT handler, and
  // both `return` paths), since `process.exit()` skips pending `finally`
  // blocks (MEMORY.md).
  const context = await resolveBoardContext(projectName, "plan", "resolve project");
  const store = context.store;

  // Create planning session
  let sessionId: string;
  let firstQuestion: PlanningQuestion;

  try {
    showThinking();
    const projectPath = context.projectPath;
    const result = await createSession("127.0.0.1", initialPlan.trim(), store, projectPath);
    clearThinking();
    sessionId = result.sessionId;
    firstQuestion = result.firstQuestion;
  } catch (err) {
    clearThinking();

    if (err instanceof RateLimitError) {
      console.error("\n  Rate limit exceeded. Maximum 1000 planning sessions per hour.\n");
      await closeBoardContextAndExit(context, 1);
      return undefined;
    }

    console.error(`\n  Failed to start planning session: ${err instanceof Error ? err.message : String(err)}\n`);
    await closeBoardContextAndExit(context, 1);
    return undefined;
  }

  // Interactive Q&A loop
  let currentQuestion = firstQuestion;
  let cancelled = false;

  // Handle Ctrl+C gracefully
  const handleSigint = () => {
    cancelled = true;
    console.log("\n\n  Planning session cancelled.\n");
    void closeProjectStore(context).catch(() => {}).finally(() => {
        try {
          process.exit(0);
        } catch {
          // process.exit is mocked (non-throwing in production) in some test harnesses.
        }
      });
  };

  process.on("SIGINT", handleSigint);

  try {
    while (!cancelled) {
      // Get user response based on question type
      let response: Record<string, unknown>;

      try {
        switch (currentQuestion.type) {
          case "text": {
            const textResponse = await promptText(currentQuestion);
            response = { [currentQuestion.id]: textResponse };
            break;
          }
          case "single_select": {
            const selectResponse = await promptSingleSelect(currentQuestion);
            response = { [currentQuestion.id]: selectResponse };
            break;
          }
          case "multi_select": {
            const multiResponse = await promptMultiSelect(currentQuestion);
            response = { [currentQuestion.id]: multiResponse };
            break;
          }
          case "confirm": {
            const confirmResponse = await promptConfirm(currentQuestion);
            response = { [currentQuestion.id]: confirmResponse };
            break;
          }
          default: {
            console.error(`\n  Unknown question type: ${String((currentQuestion as unknown as Record<string, unknown>).type)}`);
            await closeBoardContextAndExit(context, 1);
            return undefined;
          }
        }
      } catch (promptErr) {
        // Prompt was cancelled (Ctrl+C handled above)
        if (cancelled) {
          return undefined;
        }
        throw promptErr;
      }

      // `/validate` is an explicit user command available in every text answer.
      // The session never auto-finalizes: only this command calls validateSession.
      let result: { type: "question"; data: PlanningQuestion } | { type: "complete"; data: PlanningSummary };

      try {
        const requestedValidation = Object.values(response).some((value) =>
          typeof value === "string" && value.trim().toLowerCase() === "/validate",
        );
        showThinking();
        result = requestedValidation
          ? { type: "complete", data: await validateSession(sessionId) }
          : await submitResponse(sessionId, response) as typeof result;
        clearThinking();
      } catch (err) {
        clearThinking();

        if (err instanceof SessionNotFoundError) {
          console.error("\n  Session expired. Please start again.\n");
          await closeBoardContextAndExit(context, 1);
          return undefined;
        }
        if (err instanceof InvalidSessionStateError) {
          console.error(`\n  Invalid session state: ${err.message}\n`);
          await closeBoardContextAndExit(context, 1);
          return undefined;
        }

        console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
        await closeBoardContextAndExit(context, 1);
        return undefined;
      }

      if (result.type === "complete") {
        // Display summary
        displaySummary(result.data);

        // Ask for confirmation (unless --yes flag)
        let confirmed = yesFlag;
        if (!yesFlag) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question("  Create this task? [Y/n]: ");
          rl.close();
          const trimmed = answer.trim().toLowerCase();
          confirmed = trimmed === "" || trimmed === "y" || trimmed === "yes";
        }

        if (confirmed) {
          // Create the task — the ONE discrete board write in this flow,
          // retried independently (FN-7734).
          // FN-5060: intentional same-content sibling; deterministic guard skipped here.
          const task = await retryBoardCall(context, "plan", "create task", () => store.createTask({
            title: result.data.title,
            description: result.data.description,
            column: "triage",
            dependencies: result.data.suggestedDependencies,
            baseBranch: baseBranch?.trim() || undefined,
            source: { sourceType: "cli" },
          }));

          console.log();
          console.log(`  ✓ Created ${task.id}: ${task.title || task.description.slice(0, 60)}${task.description.length > 60 ? "…" : ""}`);
          console.log(`    Column: triage`);
          if (task.dependencies.length > 0) {
            console.log(`    Dependencies: ${task.dependencies.join(", ")}`);
          }
          console.log(`    Path:   .fusion/tasks/${task.id}/`);
          console.log();

          return task.id;
        }

        console.log("\n  Task creation cancelled.\n");
        return undefined;
      }

      // Next question
      currentQuestion = result.data;
    }
  } finally {
    process.off("SIGINT", handleSigint);
    await closeProjectStore(context).catch(() => {});
  }
}
