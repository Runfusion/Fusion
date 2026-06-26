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
import { resolveProject } from "../project-context.js";

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

interface PrCommandContext {
  store: TaskStore;
  projectPath: string;
}

async function getPrContext(projectName?: string): Promise<PrCommandContext> {
  try {
    const context = await resolveProject(projectName);
    if (context) {
      return { store: context.store, projectPath: context.projectPath };
    }
  } catch {
    // fall through to a local store rooted at cwd
  }
  if (projectName) {
    throw new Error(`Project ${projectName} not found`);
  }
  const store = new TaskStore(process.cwd());
  await store.init();
  return { store, projectPath: process.cwd() };
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
  const { store, projectPath } = await getPrContext(projectName);

  // Fetch task and validate it exists
  let task;
  try {
    task = await store.getTask(id);
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as Record<string, unknown>).code === "ENOENT") {
      console.error(`Error: Task ${id} not found`);
      process.exit(1);
    }
    throw err;
  }
  if (!task) {
    console.error(`Error: Task ${id} not found`);
    process.exit(1);
  }

  // Validate task is in 'in-review' column
  if (task.column !== "in-review") {
    console.error(`Error: Task must be in 'in-review' column to create a PR (current: ${task.column})`);
    process.exit(1);
  }

  // Check if task already has PR info
  if (task.prInfo) {
    console.error(`Error: Task already has PR #${task.prInfo.number}: ${task.prInfo.url}`);
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
      process.exit(1);
    }
    owner = o;
    repo = r;
  } else {
    const gitRepo = getCurrentRepo(projectPath);
    if (!gitRepo) {
      console.error("Error: Could not determine GitHub repository. Set GITHUB_REPOSITORY env var or configure git remote.");
      process.exit(1);
    }
    owner = gitRepo.owner;
    repo = gitRepo.repo;
  }

  // Validate GitHub auth
  if (!isGhAvailable() || !isGhAuthenticated()) {
    console.error("Error: GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.");
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
        ? await store.getSettings()
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

    console.log();
    console.log(`  ✓ Created PR for ${task.id}`);
    console.log(`    PR #${prInfo.number}: ${prInfo.url}`);
    console.log(`    Branch: ${branchName} → ${prInfo.baseBranch}`);
    console.log();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      console.error(`Error: A pull request already exists for ${owner}/${repo}:${branchName}`);
      process.exit(1);
    } else if (msg.includes("No commits between")) {
      console.error(`Error: No commits between ${options.base || "default base"} and ${branchName}. Push changes before creating PR.`);
      process.exit(1);
    } else {
      process.stderr.write(formatGhErrorForCli(err));
      process.exit(1);
    }
  }
}

// ── Entity read commands (parity with GET /api/pull-requests[/:id]) ───────────

/** Resolve a PR entity by its id (or 404-style exit). */
async function requireEntity(store: TaskStore, id: string): Promise<PrEntity> {
  const entity = await store.getPrEntity(id);
  if (!entity) {
    console.error(`\n  ✗ PR entity ${id} not found\n`);
    process.exit(1);
  }
  return entity;
}

export async function runPrList(projectName?: string) {
  const { store } = await getPrContext(projectName);
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
}

export async function runPrShow(id: string, projectName?: string) {
  if (!id) {
    console.error("Usage: fn pr show <pr-entity-id>");
    process.exit(1);
  }
  const { store } = await getPrContext(projectName);
  const entity = await requireEntity(store, id);
  const threads: PrThreadState[] = await store.listPrThreadStates(entity.id);
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
  const { store } = await getPrContext(projectName);
  const entity = await requireEntity(store, id);

  if (!isPrEntityActive(entity)) {
    console.error(`\n  ✗ PR ${id} is already terminal (merged/closed/failed)\n`);
    process.exit(1);
  }
  if (opts.rejectConflict && entity.mergeable === "conflicting") {
    console.error(`\n  ✗ Resolve conflicts on GitHub before merging\n`);
    process.exit(1);
  }

  const result = await releaseHeldTaskByEvent(store, entity.sourceId, eventTag);
  if (!result.released) {
    console.error(`\n  ✗ ${label} did not release ${id}: ${result.rejection ?? "unknown"}\n`);
    process.exit(1);
  }
  console.log(`\n  ✓ ${label} fired for ${id}${result.toColumn ? ` → ${result.toColumn}` : ""}\n`);
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
  const { store } = await getPrContext(projectName);
  const entity = await requireEntity(store, id);

  if (!isPrEntityActive(entity)) {
    console.error(`\n  ✗ PR ${id} is already terminal (merged/closed/failed)\n`);
    process.exit(1);
  }

  const next = typeof enabled === "boolean" ? enabled : !entity.autoMerge;
  const updated = await store.updatePrEntity(id, { autoMerge: next });
  console.log(`\n  ✓ Auto-merge ${updated.autoMerge ? "enabled" : "disabled"} for ${id} (${autoMergeGateReason(updated)})\n`);
}

export interface PrAutomergeCleanupOptions {
  apply?: boolean;
  json?: boolean;
}

export async function runPrAutomergeCleanup(options: PrAutomergeCleanupOptions = {}, projectName?: string) {
  const { store } = await getPrContext(projectName);
  const results = options.apply
    ? await store.reconcileLegacyAutoMergeStamps({ apply: true })
    : await store.reconcileLegacyAutoMergeStamps();

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
