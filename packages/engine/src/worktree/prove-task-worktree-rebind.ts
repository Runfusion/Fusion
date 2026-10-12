import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { Task, TaskStore } from "@fusion/core";
import { activeSessionRegistry, type ActiveSessionKind } from "../agents/active-session-registry.js";
import { getCommitTaskOwnership } from "../merge/already-merged-detector.js";

const execFileAsync = promisify(execFile);
// Exhaustive so a new session kind cannot silently bypass adoption exclusion.
const sessionKinds: Record<ActiveSessionKind, true> = {
  executor: true, planning: true, "step-session": true, "workflow-step": true,
  "step-session-parallel": true, "ai-merge": true,
  "workspace-repo-acquire": true, "workspace-repo-land": true,
  /* FNXC:WorktreeRebindAdoption 2026-10-05-09:43 (merge origin/main): the map is exhaustive over
  ActiveSessionKind on purpose, so a newly added session kind cannot silently skip adoption exclusion.
  A running task-deletion-cleanup session still owns the task, so it excludes adoption like any other. */
  "task-deletion-cleanup": true,
};

/** Read-only proof for adopting a renamed task branch; no checkout or content mutation. */
export async function proveTaskWorktreeRebind(input: {
  rootDir: string;
  worktreePath: string;
  task: Pick<Task, "id" | "lineageId">;
  integrationBranch: string;
  store: Pick<TaskStore, "listTasks">;
}): Promise<{ branch: string; head: string }> {
  const { rootDir, worktreePath, task, integrationBranch, store } = input;
  const refuse = (): never => { throw new Error(`preserving ${worktreePath}: task-owned branch rebind could not be proven`); };
  const deadline = Date.now() + 10_000;
  const git = async (...args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return refuse();
    return (await execFileAsync("git", args, {
      cwd: rootDir, encoding: "utf8", timeout: remaining, maxBuffer: 2 * 1024 * 1024,
    })).stdout.trim();
  };
  const canonical = await realpath(worktreePath);
  if (canonical === await realpath(rootDir)) refuse();
  const registrations = (await git("worktree", "list", "--porcelain")).split("\n\n");
  const matches = registrations.filter((entry) => entry.split("\n").includes(`worktree ${canonical}`));
  if (matches.length !== 1) refuse();
  const branch = matches[0].split("\n").find((line) => line.startsWith("branch refs/heads/"))?.slice(18);
  const head = matches[0].split("\n").find((line) => line.startsWith("HEAD "))?.slice(5);
  if (!branch || !head) return refuse();
  const assertUnclaimed = async () => {
    if (activeSessionRegistry.isPathActive(worktreePath) || activeSessionRegistry.isPathActive(canonical)) refuse();
    for (const kind of Object.keys(sessionKinds) as ActiveSessionKind[]) {
      for (const entry of activeSessionRegistry.entriesByKind(kind)) {
        if (await realpath(entry.path).catch(() => entry.path) === canonical) refuse();
      }
    }
    // FNXC:ListTasksExcludeLog 2026-10-12-16:20 (RUFU-615 tranche 4): this scan never reads task log or markers (no non-logger `.log` token in the file), so `slim` must not pay for hydrating the whole board's log. See list-tasks-slim-excludes-log.test.ts.
    for (const other of await store.listTasks({ slim: true, includeArchived: false, excludeLog: true })) {
      if (other.id === task.id) continue;
      const assignments = [
        { branch: other.branch, worktreePath: other.worktree },
        ...Object.values(other.workspaceWorktrees ?? {}),
      ];
      for (const assignment of assignments) {
        if (assignment.branch === branch) refuse();
        if (assignment.worktreePath
          && await realpath(assignment.worktreePath).catch(() => assignment.worktreePath) === canonical) refuse();
      }
    }
  };
  await assertUnclaimed();
  const base = await git("rev-parse", "--verify", `${integrationBranch}^{commit}`);
  const commits = (await git("rev-list", `${base}..${head}`)).split("\n").filter(Boolean);
  if (!commits.length || commits.length > 256) refuse();
  for (const sha of commits) {
    const message = await git("show", "-s", "--format=%s%n%b", sha);
    const split = message.indexOf("\n");
    const body = message.slice(split + 1);
    const taskIds = [...body.matchAll(/^Fusion-Task-Id:[\t ]*([^\r\n]*)\r?$/gm)].map((match) => match[1].trim());
    const lineages = [...body.matchAll(/^Fusion-Task-Lineage:[\t ]*([^\r\n]*)\r?$/gm)].map((match) => match[1].trim());
    if (taskIds.some((id) => id !== task.id) || new Set(lineages).size > 1
      || (task.lineageId && lineages.some((lineage) => lineage !== task.lineageId))) refuse();
    const ownership = getCommitTaskOwnership(task.id, task.lineageId, message.slice(0, split), body);
    if (!ownership.owned || ownership.proof === "subject-anchor") refuse();
  }
  // Recheck after awaited ownership reads before returning authority to the caller.
  await assertUnclaimed();
  if (await git("-C", canonical, "rev-parse", "HEAD") !== head
    || await git("-C", canonical, "symbolic-ref", "--short", "HEAD") !== branch) refuse();
  return { branch, head };
}
