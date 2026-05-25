import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SmartPullMode = "ff-only" | "stash-and-ff";

export interface SmartPullAuditEvent {
  mutationType: "pull:fast-forward" | "stash:push" | "stash:pop" | "stash:pop-conflict";
  metadata: Record<string, unknown>;
}

export type SmartPullAuditEmitter = (event: SmartPullAuditEvent) => void | Promise<void>;

export interface SmartPullInput {
  worktreePath: string;
  integrationBranch: string;
  mode: SmartPullMode;
  taskId?: string;
  emit?: SmartPullAuditEmitter;
}

export type SmartPullResult =
  | { kind: "clean-pull"; fromSha: string; toSha: string }
  | { kind: "stash-pull-pop"; fromSha: string; toSha: string; stashSha: string; stashLabel: string }
  | { kind: "stash-pop-conflict"; fromSha: string; toSha: string; stashSha: string; stashLabel: string; conflictedFiles: string[] }
  | { kind: "skipped-dirty"; fromSha: string; reason: "ff-only-mode-requires-clean-tree" }
  | { kind: "skipped-not-on-branch"; currentBranch: string }
  | { kind: "failed"; fromSha: string; stage: "stash" | "pull" | "pop"; error: string; stashSha?: string; stashLabel?: string };

async function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf-8",
  });
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "stdout" in result) {
    return String((result as { stdout?: unknown }).stdout ?? "");
  }
  return "";
}

function commandError(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as Error & { stdout?: string; stderr?: string };
    return [anyErr.stderr, anyErr.stdout, anyErr.message].filter(Boolean).join("\n").trim() || anyErr.message;
  }
  return String(err);
}

function isConflictMessage(message: string): boolean {
  return message.includes("CONFLICT") || message.includes("Merge conflict") || message.includes("could not apply");
}

async function findStashRefBySha(sha: string, cwd: string): Promise<string | null> {
  try {
    const output = await runGit(["stash", "list", "--format=%H|%gd"], cwd, 5_000);
    for (const line of output.split("\n")) {
      const [entrySha, ref] = line.trim().split("|");
      if (entrySha === sha && ref) return ref;
    }
  } catch {
    // best-effort
  }
  return null;
}

async function listConflictedFiles(cwd: string): Promise<string[]> {
  try {
    const out = await runGit(["diff", "--name-only", "--diff-filter=U"], cwd, 5_000);
    return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function hasLocalChanges(cwd: string): Promise<boolean> {
  const out = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd, 10_000);
  return out.trim().length > 0;
}

async function currentBranch(cwd: string): Promise<string> {
  return (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, 5_000)).trim();
}

async function headSha(cwd: string): Promise<string> {
  return (await runGit(["rev-parse", "HEAD"], cwd, 5_000)).trim();
}

/**
 * Stash-aware fast-forward pull for a single worktree on its integration branch.
 *
 * Mirrors the dashboard's `POST /api/git/smart-pull` semantics so both the user-
 * triggered Pull button and the merger's post-ref-advance auto-sync hook share
 * one implementation. Returns a discriminated result instead of throwing for
 * recoverable conditions (dirty tree in ff-only mode, stash-pop conflict). Only
 * truly unexpected failures throw.
 */
export async function smartPull(input: SmartPullInput): Promise<SmartPullResult> {
  const { worktreePath, integrationBranch, mode, taskId, emit } = input;
  const emitSafe = async (event: SmartPullAuditEvent): Promise<void> => {
    if (!emit) return;
    try {
      await emit(event);
    } catch {
      // never let audit emission break the pull pipeline
    }
  };

  const branch = await currentBranch(worktreePath);
  if (branch !== integrationBranch) {
    return { kind: "skipped-not-on-branch", currentBranch: branch };
  }

  const fromSha = await headSha(worktreePath);
  const dirty = await hasLocalChanges(worktreePath);

  if (!dirty) {
    await runGit(["pull", "--ff-only"], worktreePath, 30_000);
    const toSha = await headSha(worktreePath);
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha, toSha, succeeded: true },
    });
    return { kind: "clean-pull", fromSha, toSha };
  }

  if (mode === "ff-only") {
    return { kind: "skipped-dirty", fromSha, reason: "ff-only-mode-requires-clean-tree" };
  }

  // stash-and-ff path
  const stashLabel = `fusion-auto-stash-${taskId ?? Date.now()}`;
  let stashOutput: string;
  try {
    stashOutput = await runGit(["stash", "push", "--include-untracked", "-m", stashLabel], worktreePath, 15_000);
  } catch (err: unknown) {
    return { kind: "failed", fromSha, stage: "stash", error: commandError(err) };
  }

  if (stashOutput.includes("No local changes to save")) {
    // race: tree went clean between hasLocalChanges and stash push
    await runGit(["pull", "--ff-only"], worktreePath, 30_000);
    const toSha = await headSha(worktreePath);
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha, toSha, succeeded: true },
    });
    return { kind: "clean-pull", fromSha, toSha };
  }

  const stashSha = (await runGit(["rev-parse", "stash@{0}"], worktreePath, 5_000)).trim();
  await emitSafe({
    mutationType: "stash:push",
    metadata: { taskId, worktreePath, stashSha, stashLabel, untrackedIncluded: true },
  });

  try {
    await runGit(["pull", "--ff-only"], worktreePath, 30_000);
  } catch (pullErr: unknown) {
    const pullMessage = commandError(pullErr);
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha, toSha: fromSha, succeeded: false, error: pullMessage },
    });
    try {
      await runGit(["stash", "pop"], worktreePath, 20_000);
    } catch (popErr: unknown) {
      const popMessage = commandError(popErr);
      const stashRef = await findStashRefBySha(stashSha, worktreePath);
      if (isConflictMessage(popMessage) || stashRef) {
        const conflictedFiles = await listConflictedFiles(worktreePath);
        await emitSafe({
          mutationType: "stash:pop-conflict",
          metadata: { taskId, worktreePath, stashSha, stashLabel, conflictedFiles, advice: "Resolve conflicts, then drop stash when complete." },
        });
        const toSha = await headSha(worktreePath);
        return { kind: "stash-pop-conflict", fromSha, toSha, stashSha, stashLabel, conflictedFiles };
      }
      return { kind: "failed", fromSha, stage: "pop", error: popMessage, stashSha, stashLabel };
    }
    return { kind: "failed", fromSha, stage: "pull", error: pullMessage, stashSha, stashLabel };
  }

  const toSha = await headSha(worktreePath);
  await emitSafe({
    mutationType: "pull:fast-forward",
    metadata: { taskId, worktreePath, integrationBranch, fromSha, toSha, succeeded: true },
  });

  try {
    await runGit(["stash", "pop"], worktreePath, 20_000);
    await emitSafe({
      mutationType: "stash:pop",
      metadata: { taskId, worktreePath, stashSha, stashLabel },
    });
    return { kind: "stash-pull-pop", fromSha, toSha, stashSha, stashLabel };
  } catch (popErr: unknown) {
    const popMessage = commandError(popErr);
    const stashRef = await findStashRefBySha(stashSha, worktreePath);
    if (!isConflictMessage(popMessage) && !stashRef) {
      throw popErr;
    }
    const conflictedFiles = await listConflictedFiles(worktreePath);
    await emitSafe({
      mutationType: "stash:pop-conflict",
      metadata: { taskId, worktreePath, stashSha, stashLabel, conflictedFiles, advice: "Resolve conflicts, then drop stash when complete." },
    });
    return { kind: "stash-pop-conflict", fromSha, toSha, stashSha, stashLabel, conflictedFiles };
  }
}
