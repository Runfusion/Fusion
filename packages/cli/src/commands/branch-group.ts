import { TaskStore, isBranchGroupComplete, isBranchGroupMemberLanded, filterTasksByBranchGroup, type BranchGroup, type Settings, type Task } from "@fusion/core";
import { promoteBranchGroup, resolveIntegrationBranch } from "@fusion/engine";
import { GitHubClient, closeGroupPullRequest } from "@fusion/dashboard";
import { resolveProject } from "../project-context.js";
import { createGroupPrCallback } from "./task-lifecycle.js";

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

interface BranchGroupCommandContext {
  store: TaskStore;
  projectPath: string;
}

async function getBranchGroupContext(projectName?: string): Promise<BranchGroupCommandContext> {
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
  const { store } = await getBranchGroupContext(projectName);
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
}

export async function runBranchGroupShow(id: string, projectName?: string) {
  const { store } = await getBranchGroupContext(projectName);
  const group = await store.getBranchGroup(id);
  if (!group) {
    console.error(`\n  ✗ Branch group ${id} not found\n`);
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
    const mark = member.landed ? "✓" : "○";
    console.log(`      ${mark} ${member.taskId}  ${member.title} [${member.column}]`);
  }
  console.log();
}

export async function runBranchGroupAbandon(id: string, projectName?: string) {
  const { store } = await getBranchGroupContext(projectName);
  const group = await store.getBranchGroup(id);
  if (!group) {
    console.error(`\n  ✗ Branch group ${id} not found\n`);
    process.exit(1);
  }

  // Terminal-state guard — same semantics as the dashboard abandon route (Fix #2):
  // a finalized/merged or already-abandoned group cannot be abandoned.
  if (group.status === "abandoned" || group.status === "finalized" || group.prState === "merged") {
    console.error(`\n  ✗ Branch group ${id} is already ${group.status === "abandoned" ? "abandoned" : "finalized/merged"} and cannot be abandoned\n`);
    process.exit(1);
  }

  // A group with a PR abandons to "closed"; a group that never had a PR keeps
  // its existing prState — "closed" would falsely imply a PR existed.
  let prState: BranchGroup["prState"] = group.prNumber != null ? "closed" : group.prState;
  let prNumber = group.prNumber;
  let prUrl = group.prUrl;

  // Best-effort close of the single managed GitHub PR (R7). If it fails, still
  // mark the row abandoned/closed and leave the PR for out-of-band reconciliation.
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

  const updated = await store.updateBranchGroup(id, {
    status: "abandoned",
    prState,
    prNumber: prNumber ?? null,
    prUrl: prUrl ?? null,
  });

  console.log(`\n  ✓ Branch group ${updated.id} abandoned (status: ${updated.status}, prState: ${updated.prState})\n`);
}

export async function runBranchGroupPromote(id: string, projectName?: string) {
  const { store, projectPath } = await getBranchGroupContext(projectName);
  const group = await store.getBranchGroup(id);
  if (!group) {
    console.error(`\n  ✗ Branch group ${id} not found\n`);
    process.exit(1);
  }

  // Completion gate — mirror the dashboard `POST /:id/promote` gate (R8) so the
  // CLI rejects an incomplete group with the same message a dashboard user sees.
  const members = await store.listTasksByBranchGroup(group.id);
  if (!isBranchGroupComplete(members, group)) {
    console.error("\n  ✗ Branch group completion gate not satisfied\n");
    process.exit(1);
  }

  const settings = (await store.getSettings()) as Settings;
  const resolvedIntegrationBranch = await resolveIntegrationBranch(projectPath, settings);
  const githubClient = new GitHubClient(process.env.GITHUB_TOKEN);

  console.log(`\n  Promoting branch group ${group.id}…\n`);

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
      recordAudit: (event) => {
        void store.recordRunAuditEvent({
          agentId: "cli:branch-group-promote",
          runId: `cli-promote-${group.id}`,
          domain: event.domain as Parameters<TaskStore["recordRunAuditEvent"]>[0]["domain"],
          mutationType: event.mutationType as Parameters<TaskStore["recordRunAuditEvent"]>[0]["mutationType"],
          target: event.target,
          metadata: event.metadata,
        });
      },
    });

    if (result.prUrl) {
      console.log(`  ✓ Group ${result.groupId} — PR ${result.prState}: ${result.prUrl}`);
    } else {
      console.log(`  ✓ Group ${result.groupId} — ${result.reason} (status: ${result.status}, prState: ${result.prState})`);
    }
    console.log();
  } catch (err) {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
