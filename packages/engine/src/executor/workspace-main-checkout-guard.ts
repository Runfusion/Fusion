/*
 * FNXC:Workspace 2026-08-15-07:05:
 * Completion, review, and merge inspect only acquired workspace worktrees. Probe every configured
 * main checkout so direct edits cannot bypass those surfaces. Classification uses execution time,
 * not File Scope: unenumerated and unscoped paths must not become an escape hatch.
 *
 * FNXC:WorkspaceFinalization 2026-08-27-08:42:
 * Only COMMITS in a main checkout are a completion violation. Uncommitted status entries warn.
 * Two measured reasons. (1) The very next pipeline stage absorbs a dirty main checkout: workspace
 * lands call the same `landOneRepo`/`landSquash` mechanic as single-repo with `projectRootDir` set
 * to the sub-repo main checkout, so a dirty tree there is stashed (untracked included) -> ff ->
 * restored under `merger.allowDirtyLocalCheckoutSync`, or the ref advances atomically and the tree
 * is left alone when the stash is impossible. Refusing completion for a state the merger is built
 * to handle stops the board for nothing. (2) Attribution had no evidence: a File Scope match was
 * treated as task work with NO timing test, so an operator editing the same feature in the shared
 * checkout was indistinguishable from an agent that skipped `fn_acquire_repo_worktree` — and the
 * refusal named an operator-only remedy, so the card could only loop.
 * The dangerous cases keep hard refusals elsewhere: a task-attributed commit still returns
 * `main_checkout_edit` (it would reach the shared branch unreviewed), and work that exists ONLY in
 * the main checkout now falls through to the acquired-worktree `no_commits` invariant, which
 * refuses because the acquired worktree carries no commits.
 */
import { exec } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Settings, Task } from "@fusion/core";
import { normalizeRepoRelPath, resolveRepoDeclaredScope } from "../worktree/workspace-paths.js";
import { resolveWorktreesDir } from "../worktree/worktree-paths.js";
import { isAlwaysAllowedScopeLeakPath, workflowPathMatchesDeclaredScope } from "./workflow-feedback-paths.js";

const execAsync = promisify(exec);
const probeOptions = { encoding: "utf-8" as const, timeout: 10_000, maxBuffer: 1024 * 1024 };
export type MainCheckoutEvidence = "task-era-change" | "declared-scope-change" | "task-attributed-commit" | "post-anchor-commit";
/** `uncommitted-only`: task-era or in-scope status entries with no commit behind them (2026-08-27). */
export type MainCheckoutWarningReason = "pre-existing-dirt" | "anchor-unresolved" | "commit-scan-unavailable" | "uncommitted-only";
export type MainCheckoutFinding = { repo: string; files: string[]; commits: string[]; evidence: MainCheckoutEvidence };
/** `evidence` is retained on downgraded findings so telemetry keeps the classification it had. */
export type MainCheckoutWarning = { repo: string; files: string[]; commits: string[]; reason: MainCheckoutWarningReason; evidence?: MainCheckoutEvidence };
export type MainCheckoutGuardResult = { violations: MainCheckoutFinding[]; warnings: MainCheckoutWarning[]; skipped: string[] };

/** Earliest durable attempt timestamp, with a small filesystem clock tolerance. */
export function workspaceExecutionAnchor(task: Task): number | null {
  const executionValues = [task.firstExecutionAt, task.executionStartedAt]
    .map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  const values = executionValues.length
    ? executionValues
    : [typeof task.createdAt === "string" ? Date.parse(task.createdAt) : Number.NaN].filter(Number.isFinite);
  return values.length ? Math.min(...values) - 5_000 : null;
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function nearestMtime(filePath: string): Promise<number | null> {
  let candidate = filePath;
  while (true) {
    try { return (await fs.stat(candidate)).mtimeMs; } catch { /* climb for deletions */ }
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

function parseStatus(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3)).filter(Boolean);
}

function parseCommits(stdout: string): Array<{ sha: string; committedAt: number; body: string }> {
  return stdout.split("\x1e").filter(Boolean).flatMap((record) => {
    const [sha, timestamp, ...body] = record.split("\x1f");
    const committedAt = Number(timestamp) * 1000;
    return sha && Number.isFinite(committedAt) ? [{ sha, committedAt, body: body.join("\x1f") }] : [];
  });
}

/**
 * Read-only evidence collector for task-era writes in configured workspace main checkouts.
 * It intentionally scans status with untracked files and a bounded HEAD window rather than a
 * diff-base range: a main checkout's branch advances with the bypass commit, making base..HEAD empty.
 */
export async function detectWorkspaceMainCheckoutWork(
  deps: { rootDir: string; settings: Settings },
  task: Task,
  repos: readonly string[],
  declaredScope: readonly string[],
): Promise<MainCheckoutGuardResult> {
  const violations: MainCheckoutFinding[] = [];
  const warnings: MainCheckoutWarning[] = [];
  const skipped: string[] = [];
  const anchor = workspaceExecutionAnchor(task);
  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  const repoKeys = [...new Set([...repos, ...Object.keys(workspaceWorktrees)])].map(normalizeRepoRelPath).filter(Boolean).sort();
  const recordedPaths = Object.values(workspaceWorktrees).map((entry) => path.resolve(entry.worktreePath));
  for (const repo of repoKeys) {
    const checkout = path.resolve(deps.rootDir, repo);
    if (!existsSync(checkout) || recordedPaths.some((candidate) => candidate === checkout)) { skipped.push(repo); continue; }
    try {
      const { stdout: insideWorkTree } = await execAsync("git rev-parse --is-inside-work-tree", { ...probeOptions, cwd: checkout });
      const { stdout: topLevel } = await execAsync("git rev-parse --show-toplevel", { ...probeOptions, cwd: checkout });
      // FNXC:Workspace 2026-08-15-07:27:
      // A configured path can sit inside an enclosing Git checkout without being a repository itself.
      // Require its canonical top-level to be itself so an invalid repo entry cannot inspect unrelated
      // operator work or consume fn_task_done's bounded refusal budget.
      if (insideWorkTree.trim() !== "true" || await fs.realpath(topLevel.trim()) !== await fs.realpath(checkout)) {
        skipped.push(repo);
        continue;
      }
    } catch { skipped.push(repo); continue; }
    const repoScope = resolveRepoDeclaredScope(declaredScope, repo, repoKeys).scope;
    const worktreesDir = path.resolve(resolveWorktreesDir(checkout, deps.settings, { workspaceRootDir: deps.rootDir, repoRelPath: repo }));
    const excluded = (file: string) => {
      const absolute = path.resolve(checkout, file);
      return file === ".fusion" || file.startsWith(".fusion/") || isWithin(absolute, worktreesDir) || recordedPaths.some((candidate) => isWithin(absolute, candidate));
    };
    let statusFiles: string[] = [];
    try {
      const { stdout } = await execAsync("git status --porcelain=v1 -uall --no-renames -z", { ...probeOptions, cwd: checkout });
      statusFiles = parseStatus(stdout).filter((file) => !excluded(file));
    } catch { skipped.push(repo); continue; }
    const taskFiles: string[] = [];
    const oldFiles: string[] = [];
    for (const file of statusFiles) {
      const mtime = await nearestMtime(path.resolve(checkout, file));
      const inScope = !isAlwaysAllowedScopeLeakPath(file) && workflowPathMatchesDeclaredScope(file, repoScope);
      if (inScope) taskFiles.push(file);
      else if (anchor !== null && mtime !== null && mtime >= anchor) taskFiles.push(file);
      else oldFiles.push(file);
    }
    // FNXC:WorkspaceFinalization 2026-08-27-08:42: status-only evidence is reported, never refused (see header).
    if (taskFiles.length) {
      warnings.push({
        repo,
        files: taskFiles,
        commits: [],
        reason: "uncommitted-only",
        evidence: repoScope.length && taskFiles.some((file) => workflowPathMatchesDeclaredScope(file, repoScope)) ? "declared-scope-change" : "task-era-change",
      });
    }
    if (oldFiles.length) warnings.push({ repo, files: oldFiles, commits: [], reason: anchor === null ? "anchor-unresolved" : "pre-existing-dirt" });
    if (anchor === null && statusFiles.length && !oldFiles.length) warnings.push({ repo, files: statusFiles, commits: [], reason: "anchor-unresolved" });
    try {
      const { stdout } = await execAsync("git log -n 200 --format=%H%x1f%ct%x1f%B%x1e HEAD", { ...probeOptions, cwd: checkout });
      const attributed = new RegExp(`(?:${task.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|Fusion-Task-Id:\\s*${task.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i");
      for (const commit of parseCommits(stdout)) {
        const entry = workspaceWorktrees[repo];
        const recordedLanding = entry?.landedSha === commit.sha
          || task.mergeDetails?.workspaceLandedShas?.[repo] === commit.sha
          || task.mergeDetails?.commitSha === commit.sha;
        let reachableFromBaseline = false;
        if (entry?.baseCommitSha) {
          try {
            await execAsync(`git merge-base --is-ancestor ${commit.sha} ${entry.baseCommitSha}`, { ...probeOptions, cwd: checkout });
            reachableFromBaseline = true;
          } catch {
            // A missing/unreadable base is handled by the timestamp fallback below.
          }
        }
        /*
        FNXC:WorkspaceFinalization 2026-08-21-08:52:
        Main-checkout refusal needs task ownership plus post-baseline evidence. A commit already
        reachable from the acquired repository base, or durable prior landing proof, is historical
        task prose rather than a direct edit; foreign post-anchor commits remain warnings.
        */
        if (attributed.test(commit.body) && !recordedLanding && !reachableFromBaseline && anchor !== null && commit.committedAt >= anchor) {
          violations.push({ repo, files: [], commits: [commit.sha], evidence: "task-attributed-commit" });
        } else if (!recordedLanding && !reachableFromBaseline && anchor !== null && commit.committedAt >= anchor) {
          warnings.push({ repo, files: [], commits: [commit.sha], reason: "pre-existing-dirt" });
        }
      }
    } catch { warnings.push({ repo, files: [], commits: [], reason: "commit-scan-unavailable" }); }
  }
  return { violations, warnings, skipped };
}
