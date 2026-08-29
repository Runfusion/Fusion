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
  /**
   * True when the checkout is at a known-good commit and a session may run there.
   * FNXC:WorktreeBaseRefresh 2026-08-09-23:49: this is a TREE-INTEGRITY verdict, not a base-freshness one.
   * A skipped refresh is execution-safe; only an unproven tree (failed compensation) is not.
   */
  kind: WorktreeBaseRefreshKind;
  executionSafe: boolean;
  /** True when the refresh was declined and the worktree kept its existing base untouched. */
  skipped?: boolean;
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
existing worktrees. It resolves integration C1 independently on every reuse and aligns durable baseCommitSha
to C1; a rebased own-commit HEAD C2 is preserved and is never stored as the baseline. Git mutations are
compensated back to C0 when baseline persistence fails; a later process can statelessly reconcile C0 versus
clean C1/C2 from durable metadata and git proof alone.

FNXC:WorktreeBaseRefresh 2026-08-09-23:49:
Refreshing the base is an OPTIMIZATION (start on landed dependency commits), never a correctness gate — so it
must never block execution. The original design refused dirty/conflicting/unresolvable states with
`executionSafe: false`, and every such refusal reached the executor's terminal sink: 99 tasks were parked
`failed` and paged the operator between 2026-08-01 and 2026-08-09 (74 dirty-worktree, 25 stale-base-conflict),
while the bounded non-parking lane built for them fired 0 times. 82 of the 99 landed within five minutes of
"Task marked done by agent" — they were code-review-remediation re-entries into `execute()` on the task's own
warm worktree, i.e. exactly the checkout the refresh must leave alone.

`executionSafe` now means "the tree is at a known-good commit with the session's work intact", not "the base is
current". Every outcome that leaves the tree provably at C0/C1/C2 is safe and execution proceeds on whatever
base it has; only an UNPROVEN tree (compensation failed, so a half-rebased checkout may be on disk) still
blocks, because running an agent there would corrupt real work. This matches the policy already used when a
FRESH worktree cannot rebase onto origin/main: keep the local base and let the merge-time rebase retry with
conflict resolution — the merge lane owns conflict arbitration and deliberately leaves `refreshStaleBase` off
(see merger.ts). Dispatch-time rebase had no conflict resolution at all, so it could only ever fail.
*/
export async function refreshReusedWorktreeBase(input: RefreshReusedWorktreeBaseInput): Promise<WorktreeBaseRefreshResult> {
  const { task, rootDir, worktreePath, store, settings, audit, logger } = input;
  if (settings.worktrunk?.enabled) {
    return { kind: "worktrunk-refresh-unsupported", executionSafe: true, skipped: true, durableBaseSha: task.baseCommitSha ?? null };
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
    /*
    FNXC:WorktreeBaseRefresh 2026-08-09-23:49:
    Nothing was mutated, so the checkout is untouched and safe to run on its existing base. A genuinely broken
    worktree still fails at session start and routes to the unusable-worktree recovery, which owns that repair.
    */
    return { kind: "base-unresolvable", executionSafe: true, skipped: true, durableBaseSha: task.baseCommitSha ?? null, detail: error instanceof Error ? error.message : String(error) };
  }
  const common = { integrationBranch, baseSha, originalHead, durableBaseSha: task.baseCommitSha ?? null };

  /*
  FNXC:WorktreeBaseRefresh 2026-08-09-23:49:
  Decide whether a git mutation is even needed BEFORE consulting the working tree. The original order refused
  every dirty checkout up front, so a worktree already sitting on the current base — where the refresh is a
  no-op and uncommitted work is irrelevant — was still blocked from executing.
  */
  const baselineMatches = task.baseCommitSha === baseSha;
  const headCurrent = await isAncestor(worktreePath, baseSha, originalHead);
  if (headCurrent) {
    if (baselineMatches) return { kind: "up-to-date", executionSafe: true, observedHead: originalHead, ...common };
    try {
      await store.updateTask(task.id, { baseCommitSha: baseSha });
      await audit?.git?.({ type: "worktree:base-refresh-reconciled", target: worktreePath, metadata: { taskId: task.id, outcome: "reconciled" } });
      return { kind: "up-to-date", executionSafe: true, observedHead: originalHead, ...common };
    } catch (error) {
      /*
      FNXC:WorktreeBaseRefresh 2026-08-09-23:49:
      Only the durable baseline write failed; no git command ran, so HEAD is still the verified-current C1.
      Execution proceeds and a later reuse re-reconciles the baseline statelessly from git proof.
      */
      return { kind: "base-reconciliation-required", executionSafe: true, skipped: true, observedHead: originalHead, ...common, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /*
  FNXC:WorktreeBaseRefresh 2026-08-09-23:49:
  A mutation is required from here on, so uncommitted work now matters: `reset --hard`/`rebase` would destroy
  the session's in-flight edits. Decline and keep the existing base — never move ground under live work.
  */
  if (dirty) return { kind: "dirty-worktree", executionSafe: true, skipped: true, observedHead: originalHead, ...common };

  let mergeBase: string;
  try {
    mergeBase = await git(worktreePath, `merge-base HEAD ${quote(baseSha)}`);
  } catch (error) {
    return { kind: "git-refresh-failed", executionSafe: true, skipped: true, observedHead: originalHead, ...common, detail: error instanceof Error ? error.message : String(error) };
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
        /*
        FNXC:WorktreeBaseRefresh 2026-08-09-23:49:
        A conflict rebasing the task's OWN commits onto a moved integration tip is expected on a busy main, and
        dispatch has no conflict resolution to offer. Once compensation proves the tree is back at C0 the work is
        intact, so keep the local base and defer to the merge-time rebase, which does have AI conflict arbitration.
        Only a FAILED compensation still blocks: a half-rebased checkout is unproven and unsafe to hand an agent.
        */
        const restored = await compensate(worktreePath, originalHead);
        return {
          kind: restored ? "stale-base-conflict" : "base-reconciliation-required",
          executionSafe: restored,
          skipped: restored,
          observedHead: originalHead,
          ...common,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  } catch (error) {
    const restored = await compensate(worktreePath, originalHead);
    return {
      kind: restored ? "git-refresh-failed" : "base-reconciliation-required",
      executionSafe: restored,
      skipped: restored,
      observedHead: originalHead,
      ...common,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const observedHead = await git(worktreePath, "rev-parse HEAD").catch(() => undefined);
  try {
    await store.updateTask(task.id, { baseCommitSha: baseSha });
    await audit?.git?.({ type: "worktree:base-refreshed", target: worktreePath, metadata: { taskId: task.id, outcome: kind } });
    return { kind, executionSafe: true, observedHead, ...common };
  } catch (error) {
    const restored = await compensate(worktreePath, originalHead);
    await audit?.git?.({ type: restored ? "worktree:base-refresh-persistence-failed-compensated" : "worktree:base-refresh-blocked", target: worktreePath, metadata: { taskId: task.id, outcome: restored ? "compensated" : "reconciliation-required" } }).catch(() => undefined);
    // FNXC:WorktreeBaseRefresh 2026-08-09-23:49: a proven restore to C0 leaves the work intact — run on the old base.
    return { kind: restored ? "base-persistence-failed-compensated" : "base-reconciliation-required", executionSafe: restored, skipped: restored, observedHead, ...common, detail: error instanceof Error ? error.message : String(error) };
  }
}
