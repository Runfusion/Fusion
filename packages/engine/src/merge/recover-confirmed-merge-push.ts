import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { allowsAutoMergeProcessing, getPostMergeFinalizeBlocker, type Settings, type Task, type TaskStore } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";
import { isPushAfterMergeEnabled } from "./push-after-merge-policy.js";
import { createMergeWriteFence, type MergeWriteFence } from "./merge-write-fence.js";

const execFileAsync = promisify(execFile);
const COOLDOWN_MS = 5 * 60_000;
const branchAttempts = new Map<string, number>();
type Run = (args: string[], cwd: string, timeout: number, signal?: AbortSignal) => Promise<string>;
const runGit: Run = async (args, cwd, timeout, signal) => (await execFileAsync("git", args, {
  cwd, timeout, signal, maxBuffer: 1024 * 1024, encoding: "utf8",
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
})).stdout.trim();

function eligible(task: Task, settings: Settings): boolean {
  const leaseAge = Date.now() - Date.parse(task.checkoutLeaseRenewedAt ?? "");
  const leased = !!task.checkoutRunId && Number.isFinite(leaseAge) && leaseAge >= 0
    && leaseAge < (settings.taskStuckTimeoutMs ?? 10 * 60_000) * 3;
  return task.mergeDetails?.mergeConfirmed === true && !task.workspaceWorktrees
    && task.branchContext?.assignmentMode !== "shared"
    && !task.paused && !task.userPaused && !task.deletedAt && task.autoMerge !== false
    && !settings.globalPause && !settings.enginePaused
    && isPushAfterMergeEnabled(settings) && allowsAutoMergeProcessing(task, settings)
    && !getPostMergeFinalizeBlocker(task)
    && !leased && !isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock });
}

/** Retry remote delivery of proven landing only; never merge, rebase, or force-push. */
export async function recoverConfirmedMergePush(
  store: TaskStore,
  task: Task,
  settings: Settings,
  run: Run = runGit,
  suppliedFence?: MergeWriteFence,
): Promise<void> {
  if (!store.rootDir || !eligible(task, settings)) return;
  const details = task.mergeDetails!;
  const branch = details.mergeTargetBranch;
  const sha = details.commitSha;
  if (!branch || !sha || !/^[a-f0-9]{40,64}$/i.test(sha)) return;
  const [remote = "origin", ...targetParts] = (settings.pushRemote?.trim() || "origin").split(/\s+/);
  const targetBranch = targetParts.join(" ") || branch;
  // Only configured remote names, never arbitrary URLs, options, or shell expressions.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) return;
  const target = `${remote}/${targetBranch}`;
  const recorded = details.pushRecovery;
  const now = Date.now();
  if (recorded?.target === target && recorded.commitSha === sha
    && (recorded.pushedAt || Date.parse(recorded.nextAttemptAt) > now)) return;
  for (const [key, until] of branchAttempts) if (until <= now) branchAttempts.delete(key);
  const key = `${store.rootDir}\0${target}`;
  if (branchAttempts.has(key)) return;
  branchAttempts.set(key, now + COOLDOWN_MS);
  const nextAttemptAt = new Date(now + COOLDOWN_MS).toISOString();
  const deadline = now + 10_000;
  const fence = suppliedFence ?? createMergeWriteFence({ taskId: task.id });
  const git = (args: string[]) => {
    fence.assertOwned();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Remote delivery recovery timed out.");
    return fence.signal ? run(args, store.rootDir, remaining, fence.signal) : run(args, store.rootDir, remaining);
  };
  let claimed = false;
  let failed = false;
  const ownsAttempt = (live: Task) => live.mergeDetails?.commitSha === sha
    && live.mergeDetails.mergeTargetBranch === branch
    && live.mergeDetails.pushRecovery?.target === target
    && live.mergeDetails.pushRecovery.commitSha === sha
    && live.mergeDetails.pushRecovery.nextAttemptAt === nextAttemptAt;
  try {
    await git(["check-ref-format", `refs/heads/${branch}`]);
    await git(["check-ref-format", `refs/heads/${targetBranch}`]);
    await git(["merge-base", "--is-ancestor", sha, `refs/heads/${branch}`]);
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => {
      if (live.updatedAt !== task.updatedAt || !eligible(live, settings)
        || live.mergeDetails?.commitSha !== sha || live.mergeDetails.mergeTargetBranch !== branch) return null;
      claimed = true;
      return { mergeDetails: { ...live.mergeDetails, pushRecovery: { target, commitSha: sha, nextAttemptAt } } };
    }));
    if (!claimed) return;
    const current = await store.getTask(task.id);
    const currentSettings = await store.getSettings();
    if (!eligible(current, currentSettings) || currentSettings.pushRemote !== settings.pushRemote || !ownsAttempt(current)) return;
    const advertised = await git(["ls-remote", "--heads", remote, `refs/heads/${targetBranch}`]);
    const remoteSha = advertised.split(/\s+/)[0];
    let delivered = remoteSha === sha;
    if (!delivered && /^[a-f0-9]{40,64}$/i.test(remoteSha)) {
      // A newer remote tip may already contain this task; missing objects fall through to safe push.
      try {
        await git(["cat-file", "-e", `${remoteSha}^{commit}`]);
      } catch {
        await git(["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/heads/${targetBranch}`]);
      }
      try { await git(["merge-base", "--is-ancestor", sha, remoteSha]); delivered = true; } catch { /* non-force push decides */ }
    }
    if (!delivered) {
      const beforePush = await store.getTask(task.id);
      const beforePushSettings = await store.getSettings();
      if (!eligible(beforePush, beforePushSettings) || beforePushSettings.pushRemote !== settings.pushRemote || !ownsAttempt(beforePush)) return;
      await git(["push", remote, `${sha}:refs/heads/${targetBranch}`]);
    }
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => ownsAttempt(live)
      ? { mergeDetails: { ...live.mergeDetails, pushRecovery: { target, commitSha: sha, nextAttemptAt, pushedAt: new Date().toISOString() } } }
      : null));
    await fence.write("log", () => store.logEntry(task.id, `[post-merge] Confirmed landed commit ${sha.slice(0, 12)} is available on ${target}; verification may collect hosted CI evidence.`));
  } catch (error) {
    failed = true;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => (claimed ? ownsAttempt(live) : live.updatedAt === task.updatedAt && eligible(live, settings))
      ? { mergeDetails: { ...live.mergeDetails, pushRecovery: { target, commitSha: sha, nextAttemptAt, error: message } } }
      : null)).catch(() => undefined);
    await fence.write("log", () => store.logEntry(task.id, `[post-merge] Remote delivery recovery failed for ${target}; retry after ${nextAttemptAt}. ${message}`)).catch(() => undefined);
  } finally {
    if (!failed) branchAttempts.delete(key);
  }
}
