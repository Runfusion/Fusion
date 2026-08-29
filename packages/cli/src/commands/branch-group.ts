import { TaskStore, isBranchGroupComplete, isBranchGroupMemberLanded, filterTasksByBranchGroup, type BranchGroup, type Settings, type Task } from "@fusion/core";
import { promoteBranchGroup, resolveIntegrationBranch } from "@fusion/engine";
import { GitHubClient, closeGroupPullRequest } from "@fusion/dashboard";
import { resolveProject, createLocalStore, closeProjectStore, asLocalProjectContext, type ProjectContext } from "../project-context.js";
import { createGroupPrCallback } from "./task-lifecycle.js";
import { retryOnLock, LockRetryExhaustedError } from "../lock-retry.js";

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * FN-7738 audit finding: `getBranchGroupContext` resolves a `TaskStore`
 * (cached via `resolveProject`, OR an UNCACHED `new TaskStore(process.cwd())`
 * CWD-fallback) and, before this change, NO `runBranchGroup*` handler ever
 * closed it — a leaked SQLite/WAL handle can keep the CLI process's event
 * loop alive after the command's real work is done. None of the board
 * mutations here (`updateBranchGroup`, `recordRunAuditEvent` via
 * `promoteBranchGroup`) retried through a momentary `database is locked`
 * either, so a promote/abandon racing an active engine/agent writer failed
 * outright. This mirrors the class FN-7731 fixed for `fn task show`/`move`
 * and FN-7704 fixed for `fn agent stop`/`start`; the fix below reuses the
 * SAME `retryOnLock`/`closeProjectStore` helpers (no forked second
 * implementation) scoped to the discrete store read/write calls — NOT the
 * external GitHub API calls or the `promoteBranchGroup` coordinator call
 * itself, since retrying those on a later lock error would risk re-issuing
 * an already-completed side effect (e.g. a second PR close). The resolved
 * store is closed on every exit path, including guard/not-found
 * `process.exit()` calls (closed explicitly BEFORE the exit, since a
 * pending `finally` does not run after `process.exit()` — see project
 * memory) and including the uncached CWD-fallback branch via
 * `asLocalProjectContext`.
 */

/**
 * Agent-native parity (R10): expose the same branch-group surfacing/controls a
 * dashboard user gets (`GET /api/branch-groups`, `GET /:id`, `POST /:id/promote`)
 * from the CLI.
 *
 * Pattern chosen: store-direct + the standalone `promoteBranchGroup` coordinator
 * (the same function the engine bridge method delegates to), with the
 * `createGroupPr` callback wired exactly as the dashboard/daemon construction
 * sites wire it (`createGroupPrCallback(githubClient)`). The dashboard route's
 * `promoteBranchGroup` option ultimately reaches this same coordinator function,
 * so the CLI promote produces the SAME single managed PR — parity of outcome.
 *
 * This matches the established CLI convention (`task merge`, `task pr-create`,
 * `git pull`) of operating against the resolved `TaskStore` and engine helpers
 * directly rather than calling the dashboard HTTP API.
 */

async function getBranchGroupContext(projectName?: string): Promise<ProjectContext> {
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
 * Translate a `LockRetryExhaustedError` (or any other error) from a
 * branch-group board interaction into the CLI's standard "print + exit(1)"
 * failure shape, matching `task.ts`'s `failBoardCommand`.
 */
async function failBranchGroupCommand(error: unknown, context?: ProjectContext): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n  \u2717 ${message}\n`);
  if (context) {
    await closeProjectStore(context);
  }
  return process.exit(1);
}

/**
 * Serialize a group's completion. Pass `allTasks` to filter membership in memory
 * from a single up-front `listTasks` call (list command — avoids the N+1 scan,
 * mirroring the dashboard list route Fix #8/#9); omit it to fall back to a
 * per-group `listTasksByBranchGroup` scan (show, where one scan is fine).
 */
async function serializeCompletion(store: TaskStore, group: BranchGroup, allTasks?: Task[]) {
  const members = allTasks
    ? filterTasksByBranchGroup(allTasks, group, group.id).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )
    : await store.listTasksByBranchGroup(group.id);
  const memberRows = members.map((task) => ({
    taskId: task.id,
    title: task.title ?? task.description,
    column: task.column,
    landed: isBranchGroupMemberLanded(task, group),
  }));
  const landed = memberRows.filter((member) => member.landed).length;
  return {
    members: memberRows,
    landed,
    total: memberRows.length,
    complete: isBranchGroupComplete(members, group),
  };
}

export async function runBranchGroupList(projectName?: string) {
  try {
    await retryOnLock(
      async () => {
        const context = await getBranchGroupContext(projectName);
        try {
          const { store } = context;
          const groups = await store.listBranchGroups();

          if (groups.length === 0) {
            console.log("\n  No branch groups yet.\n");
            return;
          }

          // Fix #8/#9 parity with the dashboard list route: fetch tasks ONCE and filter
          // per group in memory rather than one full scan per group (the old N+1).
          const allTasks = await store.listTasks({ includeArchived: false, slim: true });

          console.log();
          for (const group of groups) {
            const completion = await serializeCompletion(store, group, allTasks);
            const prState = group.prState === "none" ? "no PR" : `PR ${group.prState}`;
            const gate = completion.complete ? "complete" : `${completion.landed}/${completion.total}`;
            console.log(`  ${group.id}  ${group.branchName}  [${group.status}] (${gate}) ${prState}`);
          }
          console.log();
        } finally {
          await closeProjectStore(context);
        }
      },
      { id: "branch-groups", action: "list branch groups" },
    );
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failBranchGroupCommand(error);
    }
    throw error;
  }
}

export async function runBranchGroupShow(id: string, projectName?: string) {
  try {
    await retryOnLock(
      async () => {
        const context = await getBranchGroupContext(projectName);
        try {
          const { store } = context;
          const group = await store.getBranchGroup(id);
          if (!group) {
            console.error(`\n  \u2717 Branch group ${id} not found\n`);
            await closeProjectStore(context);
      process.exit(1);
          }

          const completion = await serializeCompletion(store, group);

          console.log();
          console.log(`  Branch group ${group.id}`);
          console.log(`    Branch:   ${group.branchName}`);
          console.log(`    Source:   ${group.sourceType}/${group.sourceId}`);
          console.log(`    Status:   ${group.status}`);
          console.log(`    PR state: ${group.prState}${group.prNumber != null ? ` (#${group.prNumber})` : ""}`);
          if (group.prUrl) {
            console.log(`    PR URL:   ${group.prUrl}`);
          }
          console.log(`    Progress: ${completion.landed} of ${completion.total} members finished${completion.complete ? " (complete)" : ""}`);
          console.log();
          console.log("    Members:");
          for (const member of completion.members) {
            const mark = member.landed ? "\u2713" : "\u25cb";
            console.log(`      ${mark} ${member.taskId}  ${member.title} [${member.column}]`);
          }
          console.log();
        } finally {
          await closeProjectStore(context);
        }
      },
      { id, action: "show branch group" },
    );
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failBranchGroupCommand(error);
    }
    throw error;
  }
}

export async function runBranchGroupAbandon(id: string, projectName?: string) {
  let context: ProjectContext | undefined;
  try {
    context = await retryOnLock(() => getBranchGroupContext(projectName), { id, action: "resolve project" });
    const { store } = context;

    const group = await retryOnLock(async () => store.getBranchGroup(id), { id, action: "read branch group" });
    if (!group) {
      console.error(`\n  \u2717 Branch group ${id} not found\n`);
      await closeProjectStore(context);
      process.exit(1);
    }

    // Terminal-state guard — same semantics as the dashboard abandon route (Fix #2):
    // a finalized/merged or already-abandoned group cannot be abandoned.
    if (group.status === "abandoned" || group.status === "finalized" || group.prState === "merged") {
      console.error(`\n  \u2717 Branch group ${id} is already ${group.status === "abandoned" ? "abandoned" : "finalized/merged"} and cannot be abandoned\n`);
      await closeProjectStore(context);
      process.exit(1);
    }

    // A group with a PR abandons to "closed"; a group that never had a PR keeps
    // its existing prState — "closed" would falsely imply a PR existed.
    let prState: BranchGroup["prState"] = group.prNumber != null ? "closed" : group.prState;
    let prNumber = group.prNumber;
    let prUrl = group.prUrl;

    // Best-effort close of the single managed GitHub PR (R7). If it fails, still
    // mark the row abandoned/closed and leave the PR for out-of-band reconciliation.
    // NOT retried through retryOnLock — this is a network call to GitHub, not a
    // board interaction, and it is already best-effort/non-blocking on failure.
    if (group.prState === "open" && group.prNumber != null) {
      try {
        const github = new GitHubClient(process.env.GITHUB_TOKEN);
        const reconciled = await closeGroupPullRequest(github, group);
        prState = reconciled.prState;
        prNumber = reconciled.prNumber;
        prUrl = reconciled.prUrl;
      } catch (err) {
        console.error(`  ! Could not close GitHub PR (left for out-of-band reconciliation): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const updated = await retryOnLock(
      async () =>
        store.updateBranchGroup(id, {
          status: "abandoned",
          prState,
          prNumber: prNumber ?? null,
          prUrl: prUrl ?? null,
        }),
      { id, action: "abandon branch group" },
    );

    console.log(`\n  \u2713 Branch group ${updated.id} abandoned (status: ${updated.status}, prState: ${updated.prState})\n`);
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failBranchGroupCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

export async function runBranchGroupPromote(id: string, projectName?: string) {
  let context: ProjectContext | undefined;
  try {
    context = await retryOnLock(() => getBranchGroupContext(projectName), { id, action: "resolve project" });
    const { store, projectPath } = context;

    const group = await retryOnLock(async () => store.getBranchGroup(id), { id, action: "read branch group" });
    if (!group) {
      console.error(`\n  \u2717 Branch group ${id} not found\n`);
      await closeProjectStore(context);
      process.exit(1);
    }

    // Completion gate — mirror the dashboard `POST /:id/promote` gate (R8) so the
    // CLI rejects an incomplete group with the same message a dashboard user sees.
    const members = await retryOnLock(async () => store.listTasksByBranchGroup(group.id), { id, action: "read branch group members" });
    if (!isBranchGroupComplete(members, group)) {
      console.error("\n  \u2717 Branch group completion gate not satisfied\n");
      await closeProjectStore(context);
      process.exit(1);
    }

    const settings = (await retryOnLock(async () => store.getSettings(), { id, action: "read settings" })) as Settings;
    const resolvedIntegrationBranch = await resolveIntegrationBranch(projectPath, settings);
    const githubClient = new GitHubClient(process.env.GITHUB_TOKEN);

    console.log(`\n  Promoting branch group ${group.id}…\n`);

    // NOT wrapped in retryOnLock as a whole: `promoteBranchGroup` performs its own
    // git/GitHub side effects (branch merge, PR creation) via `createGroupPr` and
    // `recordAudit`, so blanket-retrying the coordinator call on a later lock error
    // would risk re-issuing an already-completed side effect (e.g. a second PR).
    // The `recordAudit` callback below wraps ONLY the discrete store write.
    try {
      const result = await promoteBranchGroup({
        store,
        rootDir: projectPath,
        groupId: group.id,
        settings: {
          autoMerge: settings.autoMerge,
          globalPause: settings.globalPause,
          enginePaused: settings.enginePaused,
          mergeStrategy: settings.mergeStrategy,
          integrationBranch: resolvedIntegrationBranch,
          baseBranch: settings.baseBranch,
        },
        createGroupPr: createGroupPrCallback(githubClient),
        recordAudit: async (event) => {
          await retryOnLock(
            async () =>
              void store.recordRunAuditEvent({
                agentId: "cli:branch-group-promote",
                runId: `cli-promote-${group.id}`,
                domain: event.domain as Parameters<TaskStore["recordRunAuditEvent"]>[0]["domain"],
                mutationType: event.mutationType as Parameters<TaskStore["recordRunAuditEvent"]>[0]["mutationType"],
                target: event.target,
                metadata: event.metadata,
              }),
            { id, action: "record branch group promote audit event" },
          );
        },
      });

      if (result.prUrl) {
        console.log(`  \u2713 Group ${result.groupId} — PR ${result.prState}: ${result.prUrl}`);
      } else {
        console.log(`  \u2713 Group ${result.groupId} — ${result.reason} (status: ${result.status}, prState: ${result.prState})`);
      }
      console.log();
    } catch (err) {
      if (err instanceof LockRetryExhaustedError) {
        throw err;
      }
      console.error(`\n  \u2717 ${err instanceof Error ? err.message : String(err)}\n`);
      await closeProjectStore(context);
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failBranchGroupCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}
