import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

export type SyncMode = "ff-only" | "stash-and-ff";

export interface WorktreeSyncAuditEvent {
  mutationType: "pull:fast-forward" | "stash:push" | "stash:pop" | "stash:pop-conflict";
  metadata: Record<string, unknown>;
}

export type WorktreeSyncAuditEmitter = (event: WorktreeSyncAuditEvent) => void | Promise<void>;

export interface SyncWorktreeInput {
  worktreePath: string;
  integrationBranch: string;
  previousSha: string;
  newSha: string;
  mode: SyncMode;
  taskId?: string;
  emit?: WorktreeSyncAuditEmitter;
}

export type SyncWorktreeResult =
  | { kind: "clean-sync"; fromSha: string; toSha: string }
  | { kind: "synced-with-edits-restored"; fromSha: string; toSha: string; stashedFiles: string[]; untrackedRestored: string[]; untrackedSkippedAsTracked: string[] }
  | { kind: "synced-with-pop-conflict"; fromSha: string; toSha: string; stashedFiles: string[]; conflictedFiles: string[]; patchPath: string; untrackedSkippedAsTracked: string[] }
  | { kind: "skipped-dirty"; fromSha: string; reason: "ff-only-mode-requires-clean-tree"; dirtyFiles: string[]; untrackedFiles: string[] }
  | { kind: "skipped-not-on-branch"; currentBranch: string }
  | { kind: "skipped-head-not-at-new-sha"; currentSha: string; expectedNewSha: string }
  | { kind: "failed"; stage: "snapshot" | "reset" | "apply" | "untracked-restore"; error: string };

/**
 * Run a git command with `core.quotePath=false` always set so path-listing
 * commands (`ls-files`, `diff --name-only`, patch headers from `diff
 * --binary`) emit raw UTF-8 paths instead of backslash-escaped octal — required
 * for round-tripping non-ASCII filenames through copyFileSync / fs paths.
 */
async function runGit(args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf-8",
  });
  if (typeof result === "string") return { stdout: result, stderr: "" };
  if (result && typeof result === "object") {
    return {
      stdout: String((result as { stdout?: unknown }).stdout ?? ""),
      stderr: String((result as { stderr?: unknown }).stderr ?? ""),
    };
  }
  return { stdout: "", stderr: "" };
}

function commandError(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as Error & { stdout?: string; stderr?: string };
    return [anyErr.stderr, anyErr.stdout, anyErr.message].filter(Boolean).join("\n").trim() || anyErr.message;
  }
  return String(err);
}

async function listFiles(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await runGit(args, cwd, 10_000);
    return stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Parse `diff --git a/<path> b/<path>` headers out of a patch produced with
 * `git diff --binary`. Used as a fallback for populating `conflictedFiles`
 * when `git apply --3way` fails without staging unmerged index entries — e.g.
 * the patch references a file deleted or renamed at the new tip.
 */
function extractFilesFromPatch(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) out.add(m[2]);
  }
  return [...out];
}

/**
 * Bring a worktree's index + files forward to its current HEAD after the
 * integration-branch ref was advanced *locally* (typically by the merger via
 * `git update-ref`). This is NOT a `git pull` — origin may still be at the old
 * tip, so a pull would be a no-op and would leave the worktree pinned to the
 * stale state.
 *
 * Strategy:
 *   1. Compare worktree contents against `previousSha` to isolate the user's
 *      *real* edits from the stale-index "phantom diff" against the new HEAD.
 *   2. If no real edits and no untracked files exist, `git reset --hard HEAD`
 *      cleanly snaps both the index and the working tree forward to `newSha`.
 *   3. With real edits in `stash-and-ff` mode, capture them as a binary patch
 *      against `previousSha`, copy untracked files to a temp dir, snap to
 *      HEAD, then reapply (`git apply --3way`) and restore untracked. Patch
 *      conflicts surface as `synced-with-pop-conflict` and the patch is left
 *      on disk for manual recovery. Untracked files whose paths collide with
 *      newly-tracked files at HEAD are NOT overwritten — they are reported in
 *      `untrackedSkippedAsTracked` and remain in the temp dir.
 *
 * The stash-and-ff path re-verifies `rev-parse HEAD === newSha` immediately
 * before the destructive `reset --hard HEAD` so that a concurrent merger
 * advance (which would move HEAD past `newSha` between snapshot and reset)
 * can't trick us into applying the patch against the wrong tree.
 *
 * In `ff-only` mode any real edits cause the function to bail with
 * `skipped-dirty`; the caller is expected to surface the Merge Advance Notice
 * banner so the user can handle the worktree by hand.
 */
export async function syncWorktreeToHead(input: SyncWorktreeInput): Promise<SyncWorktreeResult> {
  const { worktreePath, integrationBranch, previousSha, newSha, mode, taskId, emit } = input;
  const emitSafe = async (event: WorktreeSyncAuditEvent): Promise<void> => {
    if (!emit) return;
    try {
      await emit(event);
    } catch {
      // never let audit emission abort the sync
    }
  };

  // Guards.
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath, 5_000)).stdout.trim();
  if (branch !== integrationBranch) {
    return { kind: "skipped-not-on-branch", currentBranch: branch };
  }
  const headSha = (await runGit(["rev-parse", "HEAD"], worktreePath, 5_000)).stdout.trim();
  if (headSha !== newSha) {
    return { kind: "skipped-head-not-at-new-sha", currentSha: headSha, expectedNewSha: newSha };
  }

  // Snapshot real edits against `previousSha`.
  let dirtyFiles: string[];
  let untrackedFiles: string[];
  try {
    dirtyFiles = await listFiles(worktreePath, ["diff", "--name-only", previousSha]);
    untrackedFiles = await listFiles(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  } catch (err: unknown) {
    return { kind: "failed", stage: "snapshot", error: commandError(err) };
  }
  const hasRealEdits = dirtyFiles.length > 0 || untrackedFiles.length > 0;

  if (!hasRealEdits) {
    // Re-check HEAD right before destructive reset (TOCTOU: another merger
    // could have advanced past newSha while we were enumerating).
    const headSha2 = (await runGit(["rev-parse", "HEAD"], worktreePath, 5_000)).stdout.trim();
    if (headSha2 !== newSha) {
      return { kind: "skipped-head-not-at-new-sha", currentSha: headSha2, expectedNewSha: newSha };
    }
    try {
      await runGit(["reset", "--hard", "HEAD"], worktreePath, 30_000);
    } catch (err: unknown) {
      return { kind: "failed", stage: "reset", error: commandError(err) };
    }
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha: previousSha, toSha: newSha, succeeded: true, kind: "clean-sync" },
    });
    return { kind: "clean-sync", fromSha: previousSha, toSha: newSha };
  }

  if (mode === "ff-only") {
    return { kind: "skipped-dirty", fromSha: previousSha, reason: "ff-only-mode-requires-clean-tree", dirtyFiles, untrackedFiles };
  }

  // ── stash-and-ff path ───────────────────────────────────────────────────
  const stageDir = mkdtempSync(join(tmpdir(), "fusion-worktree-sync-"));
  const patchPath = join(stageDir, "edits.patch");
  const untrackedDir = join(stageDir, "untracked");
  let preserveStageDir = false;
  try {
    mkdirSync(untrackedDir, { recursive: true });

    // 1. Capture real edits as a binary patch against previousSha.
    let patch = "";
    try {
      if (dirtyFiles.length > 0) {
        const { stdout } = await runGit(["diff", "--binary", "--no-color", previousSha], worktreePath, 60_000);
        patch = stdout;
      }
    } catch (err: unknown) {
      return { kind: "failed", stage: "snapshot", error: commandError(err) };
    }

    // 2. Save untracked files to the stage dir. Persist the patch alongside
    //    them now (not only on conflict) so a crash between this point and
    //    `git apply` doesn't lose the user's edits.
    if (patch.length > 0) {
      try {
        writeFileSync(patchPath, patch);
      } catch {
        // best-effort; patch still lives in memory for the apply attempt
      }
    }
    for (const rel of untrackedFiles) {
      const src = join(worktreePath, rel);
      const dst = join(untrackedDir, rel);
      try {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      } catch {
        // best-effort; missing / unreadable entries skipped
      }
    }

    await emitSafe({
      mutationType: "stash:push",
      metadata: {
        taskId,
        worktreePath,
        stashedFiles: dirtyFiles,
        untrackedCount: untrackedFiles.length,
        patchPath,
        kind: "patch-snapshot",
      },
    });

    // 3. Re-check HEAD immediately before destructive reset — a concurrent
    //    merger could have advanced past newSha while we were snapshotting
    //    (`git diff --binary` can take seconds on large patches).
    const headSha3 = (await runGit(["rev-parse", "HEAD"], worktreePath, 5_000)).stdout.trim();
    if (headSha3 !== newSha) {
      preserveStageDir = true; // patch + untracked saved; user can recover by hand
      return { kind: "skipped-head-not-at-new-sha", currentSha: headSha3, expectedNewSha: newSha };
    }
    try {
      await runGit(["reset", "--hard", "HEAD"], worktreePath, 30_000);
    } catch (err: unknown) {
      preserveStageDir = true; // patch saved on disk for manual recovery
      return { kind: "failed", stage: "reset", error: commandError(err) };
    }
    await emitSafe({
      mutationType: "pull:fast-forward",
      metadata: { taskId, worktreePath, integrationBranch, fromSha: previousSha, toSha: newSha, succeeded: true, kind: "snap-after-snapshot" },
    });

    // 4. Reapply the captured patch via `git apply --3way`.
    let popConflict = false;
    let conflictedFiles: string[] = [];
    let applyError: string | undefined;
    if (patch.length > 0) {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("git", ["apply", "--3way", "--whitespace=nowarn"], { cwd: worktreePath });
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`git apply exited with code ${code}: ${stderr}`));
          });
          child.stdin.write(patch);
          child.stdin.end();
        });
      } catch (err: unknown) {
        popConflict = true;
        applyError = commandError(err);
        // Index-staged unmerged paths take priority; fall back to patch-header
        // parsing when git apply failed too early to stage anything (e.g. the
        // patch referenced a file deleted or renamed at the new tip).
        const stagedConflicts = await listFiles(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
        conflictedFiles = stagedConflicts.length > 0 ? stagedConflicts : extractFilesFromPatch(patch);
      }
    }

    // 5. Restore untracked files — but NEVER overwrite a path that is now
    //    tracked at HEAD (the new tip may have added that path as a tracked
    //    file; clobbering it with the user's stale untracked bytes silently
    //    erases the merge content). Note: `reset --hard HEAD` does not touch
    //    untracked files, so `existsSync(dst)` is true for paths that the
    //    user already had on disk — only the tracked-at-HEAD check
    //    distinguishes a genuine collision from a survivor.
    const trackedAtHead = new Set(await listFiles(worktreePath, ["ls-tree", "-r", "--name-only", "HEAD"]));
    const restored: string[] = [];
    const untrackedSkippedAsTracked: string[] = [];
    for (const rel of untrackedFiles) {
      const src = join(untrackedDir, rel);
      if (!existsSync(src)) continue;
      if (trackedAtHead.has(rel)) {
        // NEW introduced a tracked file at this path. Don't clobber it; user's
        // bytes remain in stageDir/untracked/ for manual recovery.
        untrackedSkippedAsTracked.push(rel);
        continue;
      }
      const dst = join(worktreePath, rel);
      try {
        mkdirSync(dirname(dst), { recursive: true });
        const data = readFileSync(src);
        writeFileSync(dst, data);
        restored.push(rel);
      } catch {
        // best-effort
      }
    }

    if (popConflict) {
      preserveStageDir = true;
      await emitSafe({
        mutationType: "stash:pop-conflict",
        metadata: {
          taskId,
          worktreePath,
          patchPath,
          conflictedFiles,
          untrackedSkippedAsTracked,
          kind: "patch-apply-conflict",
          error: applyError,
          advice: `Real edits were saved to ${patchPath}. Apply manually with \`git apply --3way ${patchPath}\` after resolving conflicts.`,
        },
      });
      return { kind: "synced-with-pop-conflict", fromSha: previousSha, toSha: newSha, stashedFiles: dirtyFiles, conflictedFiles, patchPath, untrackedSkippedAsTracked };
    }

    if (untrackedSkippedAsTracked.length > 0) {
      // Patch applied cleanly but at least one untracked file collided with a
      // newly-tracked path. Preserve the stage dir so the user can recover
      // those bytes — and surface a stash:pop-conflict so the dashboard's
      // existing conflict UI hooks fire.
      preserveStageDir = true;
      await emitSafe({
        mutationType: "stash:pop-conflict",
        metadata: {
          taskId,
          worktreePath,
          patchPath,
          conflictedFiles: untrackedSkippedAsTracked,
          untrackedSkippedAsTracked,
          kind: "untracked-collides-with-tracked",
          advice: `Saved local copies of ${untrackedSkippedAsTracked.length} untracked file(s) that collide with newly-tracked paths at ${stageDir}/untracked/. Compare against the worktree before deleting.`,
        },
      });
      return { kind: "synced-with-pop-conflict", fromSha: previousSha, toSha: newSha, stashedFiles: dirtyFiles, conflictedFiles: untrackedSkippedAsTracked, patchPath, untrackedSkippedAsTracked };
    }

    await emitSafe({
      mutationType: "stash:pop",
      metadata: { taskId, worktreePath, stashedFiles: dirtyFiles, untrackedRestored: restored, kind: "patch-applied" },
    });
    return { kind: "synced-with-edits-restored", fromSha: previousSha, toSha: newSha, stashedFiles: dirtyFiles, untrackedRestored: restored, untrackedSkippedAsTracked };
  } catch (err: unknown) {
    preserveStageDir = true; // patch already on disk; keep it for the user
    return { kind: "failed", stage: "apply", error: commandError(err) };
  } finally {
    if (!preserveStageDir) {
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}
