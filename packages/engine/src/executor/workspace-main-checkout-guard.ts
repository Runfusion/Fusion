/*
 * FNXC:Workspace 2026-08-15-07:05:
 * Completion, review, and merge inspect only acquired workspace worktrees. Probe every configured
 * main checkout so direct edits cannot bypass those surfaces. Classification uses execution time,
 * not File Scope: unenumerated and unscoped paths must not become an escape hatch.
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
export type MainCheckoutWarningReason = "pre-existing-dirt" | "anchor-unresolved" | "commit-scan-unavailable";
export type MainCheckoutFinding = { repo: string; files: string[]; commits: string[]; evidence: MainCheckoutEvidence };
export type MainCheckoutWarning = { repo: string; files: string[]; commits: string[]; reason: MainCheckoutWarningReason };
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
    if (taskFiles.length) violations.push({ repo, files: taskFiles, commits: [], evidence: repoScope.length && taskFiles.some((file) => workflowPathMatchesDeclaredScope(file, repoScope)) ? "declared-scope-change" : "task-era-change" });
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
