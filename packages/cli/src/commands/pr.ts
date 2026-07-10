import {
  TaskStore,
  isPrEntityActive,
  isPrEntityActionable,
  autoMergeGateReason,
  type PrEntity,
  type PrThreadState,
} from "@fusion/core";
import { classifyGhError, getGhErrorMessage, getCurrentRepo, isGhAuthenticated, isGhAvailable } from "@fusion/core/gh-cli";
import { releaseHeldTaskByEvent } from "@fusion/engine";
import * as dashboard from "@fusion/dashboard";
import { resolveProject, createLocalStore, closeProjectStore, asLocalProjectContext, type ProjectContext } from "../project-context.js";
import { retryOnLock, LockRetryExhaustedError } from "../lock-retry.js";

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * FN-7738 audit finding: `getPrContext` resolves a `TaskStore` (cached via
 * `resolveProject`, OR an UNCACHED `new TaskStore(process.cwd())`
 * CWD-fallback) and, before this change, NO `runPr*` handler ever closed it
 * — the same leaked-handle class FN-7731 fixed for `fn task show`/`move`.
 * None of the board mutations here (`updatePrInfo`, `ensurePrEntityForSource`,
 * `updatePrEntity`, `releaseHeldTaskByEvent`, `reconcileLegacyAutoMergeStamps`)
 * retried through a momentary `database is locked` either. The fix below
 * reuses the SAME `retryOnLock`/`closeProjectStore` helpers (no forked
 * second implementation), scoped to the discrete store read/write calls —
 * NOT the GitHub API calls (`client.createPr`, `dashboard.generatePrMetadata`)
 * or `releaseHeldTaskByEvent` (which itself owns further workflow/GitHub side
 * effects) — to avoid re-issuing an already-completed external side effect on
 * a later lock-triggered retry. The resolved store is closed on every exit
 * path, including guard/not-found `process.exit()` calls (closed explicitly
 * before the exit, since a pending `finally` does not run after
 * `process.exit()` — see project memory) and including the uncached
 * CWD-fallback branch via `asLocalProjectContext`.
 */

/**
 * Agent-native parity (R13, U8): expose the SAME unified-PR-entity surface and
 * user-controlled actions a dashboard user gets (the U7
 * `GET/POST /api/pull-requests/*` routes) from the CLI, via `fn pr <subcommand>`.
 *
 * Capability → path mapping (kept identical to the dashboard so the two surfaces
 * can never diverge — register-integrated-routers.ts wires the route callbacks to
 * exactly these primitives):
 *
 *   create    → store.ensurePrEntityForSource (same store path the pr-create
 *               workflow node uses) + the actual GitHub PR via GitHubClient
 *   show/list → store.getPrEntity / store.listActivePrEntities
 *   approve   → releaseHeldTaskByEvent(store, entity.sourceId, "pr-approve")
 *   respond   → releaseHeldTaskByEvent(store, entity.sourceId, "pr-respond")
 *   retry     → releaseHeldTaskByEvent(store, entity.sourceId, "pr-retry")
 *   merge     → releaseHeldTaskByEvent(store, entity.sourceId, "pr-merge")
 *   close     → releaseHeldTaskByEvent(store, entity.sourceId, "pr-close")
 *   automerge → store.updatePrEntity(id, { autoMerge })
 *
 * The release actions fire the workflow's user-controlled release edges — the
 * same hold-release authority the dashboard routes and the scheduler sweep use —
 * so the GitHub side effects are owned by the workflow, not duplicated here.
 *
 * This mirrors the established CLI convention (branch-group.ts) of operating
 * against the resolved `TaskStore` and engine helpers directly rather than
 * calling the dashboard HTTP API.
 */

async function getPrContext(projectName?: string): Promise<ProjectContext> {
  try {
    const context = await resolveProject(projectName);
    if (context) {
      return context;
    }
  } catch {
    // fall through to a local store rooted at cwd
  }
  if (projectName) {
    throw new Error(`Project ${projectName} not found`);
  }
  // FNXC:PostgresCutover 2026-07-05-12:00: boot the cwd fallback through the
  // PostgreSQL startup factory; bare `new TaskStore` throws in backend mode.
  const store = await createLocalStore(process.cwd());
  return asLocalProjectContext(store);
}

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Translate a `LockRetryExhaustedError` (or any other error) from a PR board
 * interaction into the CLI's standard "print + exit(1)" failure shape,
 * matching `task.ts`'s `failBoardCommand`. When `context` is still open,
 * close it BEFORE exiting.
 */
async function failPrCommand(error: unknown, context?: ProjectContext): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n  \u2717 ${message}\n`);
  if (context) {
    await closeProjectStore(context);
  }
  return process.exit(1);
}

function formatGhErrorForCli(err: unknown): string {
  const structured = classifyGhError(err);
  const lines = [`GitHub error: ${structured.message}`];
  if (structured.hint) lines.push(`  Hint: ${structured.hint}`);
  if (structured.action?.kind === "shell") lines.push(`  Action: run \`${structured.action.command}\``);
  if (structured.action?.kind === "open") lines.push(`  Action: open ${structured.action.url}`);
  if (structured.action?.kind === "retry") lines.push("  Action: retry the command");
  if (structured.retryable) lines.push("  (retryable — re-run `fn pr create <task-id>` to try again)");
  return lines.join("\n") + "\n";
}

// ── PR creation (the retired `fn task pr-create`, now `fn pr create`) ─────────

export interface PrCreateOptions {
  title?: string;
  base?: string;
  body?: string;
  draft?: boolean;
  /** When true (default), call generatePrMetadata for title/body unless user provided both. */
  ai?: boolean;
  /** Repeatable --reviewer flag values. */
  reviewers?: string[];
}

export async function runPrCreate(id: string, options: PrCreateOptions = {}, projectName?: string) {
  let context: ProjectContext | undefined;
  try {
    context = await retryOnLock(() => getPrContext(projectName), { id, action: "resolve project" });
    const { store, projectPath } = context;

    // Fetch task and validate it exists
    let task;
    try {
      task = await retryOnLock(async () => store.getTask(id), { id, action: "read task" });
    } catch (err) {
      if (err instanceof LockRetryExhaustedError) {
        throw err;
      }
      if (typeof err === "object" && err !== null && (err as Record<string, unknown>).code === "ENOENT") {
        console.error(`Error: Task ${id} not found`);
        await closeProjectStore(context);
        process.exit(1);
      }
      throw err;
    }
    if (!task) {
      console.error(`Error: Task ${id} not found`);
      await closeProjectStore(context);
      process.exit(1);
    }

    // Validate task is in 'in-review' column
    if (task.column !== "in-review") {
      console.error(`Error: Task must be in 'in-review' column to create a PR (current: ${task.column})`);
      await closeProjectStore(context);
      process.exit(1);
    }

    // Check if task already has PR info
    if (task.prInfo) {
      console.error(`Error: Task already has PR #${task.prInfo.number}: ${task.prInfo.url}`);
      await closeProjectStore(context);
      process.exit(1);
    }

    // Determine owner/repo from GITHUB_REPOSITORY env or git remote
    let owner: string;
    let repo: string;

    const envRepo = process.env.GITHUB_REPOSITORY;
    if (envRepo) {
      const [o, r] = envRepo.split("/");
      if (!o || !r) {
        console.error("Error: GITHUB_REPOSITORY format is invalid (expected: owner/repo)");
        await closeProjectStore(context);
        process.exit(1);
      }
      owner = o;
      repo = r;
    } else {
      const gitRepo = getCurrentRepo(projectPath);
      if (!gitRepo) {
        console.error("Error: Could not determine GitHub repository. Set GITHUB_REPOSITORY env var or configure git remote.");
        await closeProjectStore(context);
        process.exit(1);
      }
      owner = gitRepo.owner;
      repo = gitRepo.repo;
    }

    // Validate GitHub auth
    if (!isGhAvailable() || !isGhAuthenticated()) {
      console.error("Error: GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.");
      await closeProjectStore(context);
      process.exit(1);
    }

    // Build branch name using the established project convention
    const branchName = `fusion/${id.toLowerCase()}`;

    // Build deterministic fallback PR title
    const fallbackTitle = options.title
      ? options.title
      : task.title
        ? task.title
        : (() => {
          const desc = task.description.trim();
          let derived = desc.charAt(0).toUpperCase() + desc.slice(1, 50);
          if (desc.length > 50) {
            derived += "…";
          }
          return derived;
        })();

    let resolvedTitle = fallbackTitle;
    let resolvedBody = options.body;

    const shouldUseAi = options.ai !== false && !(options.title && options.body);
    if (shouldUseAi) {
      try {
        const settings = ("getSettings" in store
          ? await retryOnLock(async () => store.getSettings(), { id, action: "read settings" })
          : {}) as Parameters<typeof dashboard.generatePrMetadata>[0]["settings"];
        const generated = await dashboard.generatePrMetadata({ task, repoRoot: projectPath, settings });
        if (!options.title) {
          resolvedTitle = generated.title;
        }
        if (!options.body) {
          resolvedBody = generated.body;
        }
        console.log("  → Using AI-generated title/body (use --no-ai to skip)");
      } catch (err) {
        process.stderr.write(`AI metadata generation failed; using fallback PR metadata. ${getGhErrorMessage(err)}\n`);
      }
    }

    // Create PR via GitHubClient
    const client = new dashboard.GitHubClient();

    try {
      // NOT retried as a whole — `client.createPr` is a GitHub network call with a
      // real, non-idempotent side effect (opening a PR); only the discrete store
      // writes afterward are wrapped in retryOnLock.
      const prInfo = await client.createPr({
        owner,
        repo,
        title: resolvedTitle,
        body: resolvedBody,
        head: branchName,
        base: options.base,
        draft: options.draft,
        reviewers: options.reviewers,
      });

      await retryOnLock(
        async () => {
          // Store PR info (legacy field, still read by some surfaces during migration).
          await store.updatePrInfo(task.id, prInfo);

          // Also write the unified PR entity via the SAME store path the pr-create
          // workflow node uses (mirrors pr-nodes.ts: ensure → flip to open with the
          // persisted PR number/url). Without this the PR would be invisible to
          // `fn pr list/show`, the reconciler, and the workflow nodes (R13 parity).
          const entity = await store.ensurePrEntityForSource({
            sourceType: "task",
            sourceId: task.id,
            repo: `${owner}/${repo}`,
            headBranch: branchName,
            baseBranch: prInfo.baseBranch,
            state: "creating",
          });
          await store.updatePrEntity(entity.id, {
            state: "open",
            prNumber: prInfo.number,
            prUrl: prInfo.url,
          });

          await store.logEntry(task.id, "Created PR", `PR #${prInfo.number}: ${prInfo.url}`);
        },
        { id, action: "record created PR" },
      );

      console.log();
      console.log(`  ✓ Created PR for ${task.id}`);
      console.log(`    PR #${prInfo.number}: ${prInfo.url}`);
      console.log(`    Branch: ${branchName} → ${prInfo.baseBranch}`);
      console.log();
    } catch (err) {
      if (err instanceof LockRetryExhaustedError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        console.error(`Error: A pull request already exists for ${owner}/${repo}:${branchName}`);
      } else if (msg.includes("No commits between")) {
        console.error(`Error: No commits between ${options.base || "default base"} and ${branchName}. Push changes before creating PR.`);
      } else {
        process.stderr.write(formatGhErrorForCli(err));
      }
      await closeProjectStore(context);
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failPrCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

// ── Entity read commands (parity with GET /api/pull-requests[/:id]) ───────────

/**
 * Resolve a PR entity by its id (or 404-style exit). Wraps the discrete read
 * in `retryOnLock` and, on not-found, closes `context`'s store BEFORE calling
 * `process.exit(1)` (a pending `finally` does not run after `process.exit()`).
 */
async function requireEntity(context: ProjectContext, id: string): Promise<PrEntity> {
  const entity = await retryOnLock(async () => context.store.getPrEntity(id), { id, action: "read PR entity" });
  if (!entity) {
    console.error(`\n  \u2717 PR entity ${id} not found\n`);
    await closeProjectStore(context);
    process.exit(1);
  }
  return entity;
}

export async function runPrList(projectName?: string) {
  try {
    await retryOnLock(
      async () => {
        const context = await getPrContext(projectName);
        try {
          const { store } = context;
          const entities = await store.listActivePrEntities();

          if (entities.length === 0) {
            console.log("\n  No active pull requests.\n");
            return;
          }

          console.log();
          for (const entity of entities) {
            const num = entity.prNumber != null ? `#${entity.prNumber}` : "(no #)";
            const am = entity.autoMerge ? " auto-merge" : "";
            console.log(`  ${entity.id}  ${num}  ${entity.repo}  [${entity.state}]${am}`);
          }
          console.log();
        } finally {
          await closeProjectStore(context);
        }
      },
      { id: "pull-requests", action: "list PR entities" },
    );
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failPrCommand(error);
    }
    throw error;
  }
}

export async function runPrShow(id: string, projectName?: string) {
  if (!id) {
    console.error("Usage: fn pr show <pr-entity-id>");
    process.exit(1);
  }
  let context: ProjectContext | undefined;
  try {
    context = await retryOnLock(() => getPrContext(projectName), { id, action: "resolve project" });
    const entity = await requireEntity(context, id);
    const threads: PrThreadState[] = await retryOnLock(async () => context!.store.listPrThreadStates(entity.id), { id, action: "read PR thread states" });
    const pending = threads.filter((t) => t.outcome === "pending").length;
    const disagreed = threads.filter((t) => t.outcome === "disagreed").length;

    console.log();
    console.log(`  PR entity ${entity.id}`);
    console.log(`    Source:    ${entity.sourceType}/${entity.sourceId}`);
    console.log(`    Repo:      ${entity.repo}`);
    console.log(`    Branch:    ${entity.headBranch}${entity.baseBranch ? ` → ${entity.baseBranch}` : ""}`);
    console.log(`    State:     ${entity.state}${entity.prNumber != null ? ` (#${entity.prNumber})` : ""}`);
    if (entity.prUrl) console.log(`    URL:       ${entity.prUrl}`);
    console.log(`    Mergeable: ${entity.mergeable ?? "unknown"}`);
    console.log(`    Review:    ${entity.reviewDecision ?? "none"}`);
    console.log(`    Checks:    ${entity.checksRollup ?? "none"}`);
    console.log(`    Auto-merge: ${entity.autoMerge ? "on" : "off"} (${autoMergeGateReason(entity)})`);
    console.log(`    Active:    ${isPrEntityActive(entity) ? "yes" : "no"}; actionable: ${isPrEntityActionable(entity) ? "yes" : "no"}`);
    console.log(`    Rounds:    ${entity.responseRounds}; threads: ${threads.length} (${pending} pending, ${disagreed} disagreed)`);
    console.log();
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failPrCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

// ── User-controlled actions (parity with POST /api/pull-requests/:id/*) ───────

/**
 * Shared release action: re-read the AUTHORITATIVE entity (never trust a stale
 * copy), gate it the same way the dashboard route does, then fire the workflow's
 * user-controlled release edge via the SAME engine primitive the route uses.
 */
async function runReleaseAction(
  id: string,
  eventTag: string,
  label: string,
  opts: { rejectConflict?: boolean },
  projectName?: string,
) {
  if (!id) {
    console.error(`Usage: fn pr ${label} <pr-entity-id>`);
    process.exit(1);
  }
  let context: ProjectContext | undefined;
  try {
    context = await retryOnLock(() => getPrContext(projectName), { id, action: "resolve project" });
    const { store } = context;
    const entity = await requireEntity(context, id);

    if (!isPrEntityActive(entity)) {
      console.error(`\n  \u2717 PR ${id} is already terminal (merged/closed/failed)\n`);
      await closeProjectStore(context);
      process.exit(1);
    }
    if (opts.rejectConflict && entity.mergeable === "conflicting") {
      console.error(`\n  \u2717 Resolve conflicts on GitHub before merging\n`);
      await closeProjectStore(context);
      process.exit(1);
    }

    // NOT wrapped in retryOnLock: `releaseHeldTaskByEvent` fires the workflow's
    // user-controlled release edge, owning further engine/GitHub side effects —
    // retrying it on a later lock error would risk re-firing an already-applied
    // release.
    const result = await releaseHeldTaskByEvent(store, entity.sourceId, eventTag);
    if (!result.released) {
      console.error(`\n  \u2717 ${label} did not release ${id}: ${result.rejection ?? "unknown"}\n`);
      await closeProjectStore(context);
      process.exit(1);
    }
    console.log(`\n  \u2713 ${label} fired for ${id}${result.toColumn ? ` → ${result.toColumn}` : ""}\n`);
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failPrCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

export async function runPrApprove(id: string, projectName?: string) {
  await runReleaseAction(id, "pr-approve", "approve", {}, projectName);
}

export async function runPrRespond(id: string, projectName?: string) {
  await runReleaseAction(id, "pr-respond", "respond", {}, projectName);
}

export async function runPrRetry(id: string, projectName?: string) {
  await runReleaseAction(id, "pr-retry", "retry", {}, projectName);
}

export async function runPrMerge(id: string, projectName?: string) {
  await runReleaseAction(id, "pr-merge", "merge", { rejectConflict: true }, projectName);
}

export async function runPrClose(id: string, projectName?: string) {
  await runReleaseAction(id, "pr-close", "close", {}, projectName);
}

export async function runPrAutomerge(id: string, enabled: boolean | undefined, projectName?: string) {
  if (!id) {
    console.error("Usage: fn pr automerge <pr-entity-id> [on|off]");
    process.exit(1);
  }
  let context: ProjectContext | undefined;
  try {
    context = await retryOnLock(() => getPrContext(projectName), { id, action: "resolve project" });
    const { store } = context;
    const entity = await requireEntity(context, id);

    if (!isPrEntityActive(entity)) {
      console.error(`\n  \u2717 PR ${id} is already terminal (merged/closed/failed)\n`);
      await closeProjectStore(context);
      process.exit(1);
    }

    const next = typeof enabled === "boolean" ? enabled : !entity.autoMerge;
    const updated = await retryOnLock(async () => store.updatePrEntity(id, { autoMerge: next }), { id, action: "update PR auto-merge" });
    console.log(`\n  \u2713 Auto-merge ${updated.autoMerge ? "enabled" : "disabled"} for ${id} (${autoMergeGateReason(updated)})\n`);
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failPrCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

export interface PrAutomergeCleanupOptions {
  apply?: boolean;
  json?: boolean;
}

export async function runPrAutomergeCleanup(options: PrAutomergeCleanupOptions = {}, projectName?: string) {
  let context: ProjectContext | undefined;
  try {
    context = await retryOnLock(() => getPrContext(projectName), { id: "pr-automerge-cleanup", action: "resolve project" });
    const { store } = context;
    const results = await retryOnLock(
      async () =>
        options.apply
          ? store.reconcileLegacyAutoMergeStamps({ apply: true })
          : store.reconcileLegacyAutoMergeStamps(),
      { id: "pr-automerge-cleanup", action: "reconcile legacy auto-merge stamps" },
    );
    printAutomergeCleanupResults(results, options);
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failPrCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

function printAutomergeCleanupResults(
  results: Awaited<ReturnType<TaskStore["reconcileLegacyAutoMergeStamps"]>>,
  options: PrAutomergeCleanupOptions,
): void {
  if (options.json) {
    console.log(JSON.stringify({
      mode: options.apply ? "apply" : "dry-run",
      count: results.length,
      candidates: options.apply ? undefined : results,
      cleared: options.apply ? results : undefined,
    }, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log("\n  ✓ No legacy auto-merge stamps to clean up.\n");
    return;
  }

  if (options.apply) {
    console.log(`\n  ✓ Cleared ${results.length} legacy auto-merge stamp${results.length === 1 ? "" : "s"}:`);
  } else {
    console.log(`\n  Legacy auto-merge stamp candidate${results.length === 1 ? "" : "s"} (${results.length}):`);
  }
  for (const result of results) {
    console.log(`  - ${result.taskId} (${result.column})`);
  }
  if (!options.apply) {
    console.log("\n  Re-run with --apply to clear these legacy non-override stamps. Genuine per-task overrides are preserved.\n");
  } else {
    console.log("");
  }
}
