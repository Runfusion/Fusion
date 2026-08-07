/**
 * FNXC:CodeOrganization 2026-08-03-14:35:
 * planSquashImportFromDep peeled from TaskExecutor (U4 Slice B).
 * Inject rootDir + settings reader; no class state.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";
import { quoteShellArg } from "./shell-quote.js";

const execAsync = promisify(exec);

export type SquashImportPlanStore = {
  getSettings: () => Promise<Settings | Partial<Settings>>;
};

/**
 * Decide whether a task's declared dep base should be squash-imported
 * (instead of forked from). Returns the planned operation's data when the
 * dep tip differs from the resolvable main base; returns null when no
 * import is needed (dep is already at main) or when no main base is
 * resolvable (caller falls back to legacy fork-from-dep).
 *
 * `originalStartPoint` is the user-facing label (typically the branch name
 * like `fusion/fn-2729`) used purely for log messages. `depTip` is the
 * resolved SHA of the dep's tip — that's what gets squash-merged.
 */
export async function planSquashImportFromDep(
  rootDir: string,
  store: SquashImportPlanStore,
  _taskId: string,
  depTip: string,
  originalStartPoint: string | undefined,
): Promise<{ depTip: string; mainBase: string; label: string } | null> {
  let settings;
  try {
    settings = await store.getSettings();
  } catch {
    return null;
  }

  // Resolve the main base. Preference order:
  //   1. <remote>/<defaultBranch> when worktreeRebaseBeforeMerge is enabled
  //      and a remote is resolvable (settings.worktreeRebaseRemote wins;
  //      otherwise fall back to "origin" or the lone remote).
  //   2. rootDir's HEAD (i.e., whatever local main is currently checked out
  //      to). Used when remote rebase is disabled or no remote exists.
  let mainBase = "";

  if (settings.worktreeRebaseBeforeMerge !== false) {
    let remote = settings.worktreeRebaseRemote?.trim() || "";
    if (!remote) {
      try {
        const { stdout } = await execAsync("git remote", { cwd: rootDir });
        const remotes = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        if (remotes.includes("origin")) remote = "origin";
        else if (remotes.length === 1) remote = remotes[0];
      } catch {
        // No remote resolvable.
      }
    }
    if (remote) {
      let defaultBranch = "";
      try {
        const { stdout } = await execAsync(
          `git rev-parse --abbrev-ref ${quoteShellArg(remote)}/HEAD`,
          { cwd: rootDir },
        );
        defaultBranch = stdout.trim().replace(new RegExp(`^${remote}/`), "");
      } catch {
        // origin/HEAD not set; will fall through to local HEAD below.
      }
      if (defaultBranch && defaultBranch !== "HEAD") {
        // Fetch best-effort so the remote ref reflects upstream tip.
        await execAsync(
          `git fetch ${quoteShellArg(remote)} ${quoteShellArg(defaultBranch)}`,
          { cwd: rootDir },
        ).catch(() => undefined);
        try {
          const { stdout } = await execAsync(
            `git rev-parse --verify "${remote}/${defaultBranch}^{commit}"`,
            { cwd: rootDir, encoding: "utf-8" },
          );
          mainBase = stdout.trim();
        } catch {
          // Couldn't resolve remote ref — fall through.
        }
      }
    }
  }

  if (!mainBase) {
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      mainBase = stdout.trim();
    } catch {
      return null;
    }
  }
  if (!mainBase) return null;

  // If the dep tip is already an ancestor of main, no squash import is
  // needed — the dep's content is already represented in main.
  try {
    await execAsync(
      `git merge-base --is-ancestor ${quoteShellArg(depTip)} ${quoteShellArg(mainBase)}`,
      { cwd: rootDir },
    );
    // Exit code 0 → ancestor → no import needed; legacy fork-from-main is fine.
    // Returning the plan with mainBase but signalling "no work" via dep===main.
    if (depTip === mainBase) return null;
    // Dep is ancestor of main but its tip SHA differs from main's tip; the
    // worktree should still branch off main, no squash needed.
    return { depTip: mainBase, mainBase, label: originalStartPoint || depTip.slice(0, 8) };
  } catch {
    // Not an ancestor — squash-import is the safer path.
  }

  return { depTip, mainBase, label: originalStartPoint || depTip.slice(0, 8) };
}
