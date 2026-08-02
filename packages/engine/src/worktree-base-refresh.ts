import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { resolveIntegrationBranch } from "./merge/integration-branch.js";
import type { GitAuditInput } from "./util/run-audit.js";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 120_000;

export type WorktreeBaseRefreshKind =
  | "up-to-date"
  | "reset-to-base"
  | "rebased"
  | "stale-base-conflict"
  | "dirty-worktree"
  | "base-unresolvable"
  | "worktrunk-refresh-unsupported"
  | "git-refresh-failed"
  | "base-persistence-failed-compensated"
  | "base-reconciliation-required";

export interface WorktreeBaseRefreshResult {
  kind: WorktreeBaseRefreshKind;
  executionSafe: boolean;
  integrationBranch?: string;
  baseSha?: string;
  originalHead?: string;
  observedHead?: string;
  durableBaseSha?: string | null;
  detail?: string;
}

export interface RefreshReusedWorktreeBaseInput {
  task: Task;
  rootDir: string;
  worktreePath: string;
  store: TaskStore;
  settings: Partial<Settings>;
  /** Audit is intentionally structural so acquisition can use its run-scoped auditor. */
  audit?: { git?: (event: GitAuditInput) => Promise<void> };
  logger?: { warn: (message: string) => void };
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function git(cwd: string, command: string): Promise<string> {
  const { stdout } = await execAsync(`git ${command}`, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, `merge-base --is-ancestor ${quote(ancestor)} ${quote(descendant)}`);
    return true;
  } catch {
    return false;
  }
}

async function compensate(cwd: string, originalHead: string): Promise<boolean> {
  try {
    await git(cwd, `rebase --abort`);
  } catch {
    // No rebase may be in progress; reset below is the proof-bearing restoration.
  }
  try {
    await git(cwd, `reset --hard ${quote(originalHead)}`);
    const [head, dirty] = await Promise.all([git(cwd, "rev-parse HEAD"), git(cwd, "status --porcelain")]);
    return head === originalHead && !dirty;
  } catch {
    return false;
  }
}

/*
FNXC:WorktreeBaseRefresh 2026-08-01-16:04:
Planning deliberately creates an isolated task worktree, but execution may begin after dependencies land.
Only refresh-enabled execution reuse reaches this primitive: planning, review, gates, and merge retain their
existing worktrees. The primitive refuses dirty, unresolved, worktrunk, conflict, git, persistence, and
reconciliation-unknown states with typed non-execution outcomes. It resolves integration C1 independently
on every reuse and aligns durable baseCommitSha to C1; a rebased own-commit HEAD C2 is preserved and is never
stored as the baseline. Git mutations are compensated back to C0 when baseline persistence fails; a later
process can statelessly reconcile C0 versus clean C1/C2 from durable metadata and git proof alone.
*/
export async function refreshReusedWorktreeBase(input: RefreshReusedWorktreeBaseInput): Promise<WorktreeBaseRefreshResult> {
  const { task, rootDir, worktreePath, store, settings, audit, logger } = input;
  if (settings.worktrunk?.enabled) {
    return { kind: "worktrunk-refresh-unsupported", executionSafe: false, durableBaseSha: task.baseCommitSha ?? null };
  }

  let integrationBranch: string;
  let baseSha: string;
  let originalHead: string;
  let dirty: string;
  try {
    integrationBranch = await resolveIntegrationBranch(rootDir, settings, { logger: logger ?? console });
    [baseSha, originalHead, dirty] = await Promise.all([
      git(rootDir, `rev-parse --verify ${quote(`${integrationBranch}^{commit}`)}`),
      git(worktreePath, "rev-parse HEAD"),
      git(worktreePath, "status --porcelain"),
    ]);
  } catch (error) {
    return { kind: "base-unresolvable", executionSafe: false, durableBaseSha: task.baseCommitSha ?? null, detail: error instanceof Error ? error.message : String(error) };
  }
  const common = { integrationBranch, baseSha, originalHead, durableBaseSha: task.baseCommitSha ?? null };
  if (dirty) return { kind: "dirty-worktree", executionSafe: false, observedHead: originalHead, ...common };

  const baselineMatches = task.baseCommitSha === baseSha;
  const headCurrent = await isAncestor(worktreePath, baseSha, originalHead);
  if (headCurrent) {
    if (baselineMatches) return { kind: "up-to-date", executionSafe: true, observedHead: originalHead, ...common };
    try {
      await store.updateTask(task.id, { baseCommitSha: baseSha });
      await audit?.git?.({ type: "worktree:base-refresh-reconciled", target: worktreePath, metadata: { taskId: task.id, outcome: "reconciled" } });
      return { kind: "up-to-date", executionSafe: true, observedHead: originalHead, ...common };
    } catch (error) {
      return { kind: "base-reconciliation-required", executionSafe: false, observedHead: originalHead, ...common, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  let mergeBase: string;
  try {
    mergeBase = await git(worktreePath, `merge-base HEAD ${quote(baseSha)}`);
  } catch (error) {
    return { kind: "git-refresh-failed", executionSafe: false, observedHead: originalHead, ...common, detail: error instanceof Error ? error.message : String(error) };
  }
  let kind: "reset-to-base" | "rebased";
  try {
    const ownCommits = await git(worktreePath, `rev-list --count ${quote(`${mergeBase}..HEAD`)}`);
    if (Number(ownCommits) === 0) {
      await git(worktreePath, `reset --hard ${quote(baseSha)}`);
      kind = "reset-to-base";
    } else {
      try {
        await git(worktreePath, `rebase ${quote(baseSha)}`);
        kind = "rebased";
      } catch (error) {
        const restored = await compensate(worktreePath, originalHead);
        return { kind: restored ? "stale-base-conflict" : "base-reconciliation-required", executionSafe: false, observedHead: originalHead, ...common, detail: error instanceof Error ? error.message : String(error) };
      }
    }
  } catch (error) {
    return { kind: "git-refresh-failed", executionSafe: false, observedHead: originalHead, ...common, detail: error instanceof Error ? error.message : String(error) };
  }

  const observedHead = await git(worktreePath, "rev-parse HEAD").catch(() => undefined);
  try {
    await store.updateTask(task.id, { baseCommitSha: baseSha });
    await audit?.git?.({ type: "worktree:base-refreshed", target: worktreePath, metadata: { taskId: task.id, outcome: kind } });
    return { kind, executionSafe: true, observedHead, ...common };
  } catch (error) {
    const restored = await compensate(worktreePath, originalHead);
    await audit?.git?.({ type: restored ? "worktree:base-refresh-persistence-failed-compensated" : "worktree:base-refresh-blocked", target: worktreePath, metadata: { taskId: task.id, outcome: restored ? "compensated" : "reconciliation-required" } }).catch(() => undefined);
    return { kind: restored ? "base-persistence-failed-compensated" : "base-reconciliation-required", executionSafe: false, observedHead, ...common, detail: error instanceof Error ? error.message : String(error) };
  }
}
