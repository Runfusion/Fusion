/*
FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
A long-lived Fusion deployment answers "the fix landed on main and nothing changed" the same way it
answers "we are running an old build": silence. Measured on the operator's live install, the deploy
worktree's branch sat 5 commits behind `main`, its `packages/cli/dist/bin.js` bundle carried no
embedded revision at all (`BUILD_GIT_SHA` / `buildGitSha` / `buildProvenance` have zero hits across
the `packages` source tree), and the 80 MB boot log contained no version or age line. So every
investigation started from zero and several open cards reasoned about a defect that was not in the
running code.

This module turns that question into one measurement and one verdict. The comparison is deliberately
between the LOADED artifact's file mtime and HEAD's committer time — not an embedded build sha,
because stamping a sha means touching `packages/cli/tsup.config.ts` build plumbing and would itself
need a rebuild to be observable. mtime-vs-HEAD answers the operator's question with zero
build-pipeline risk. (`BUILD_GIT_SHA` and `buildGitSha` measured zero hits across `packages` when this
card was planned; the names this file adds are the mtime probe, not an embedded revision.)

Two invariants the rest of this file exists to protect:
1. Silence is the correct output for anything but a proven-stale, proven-owned installation. Startup
   stays exactly as quiet as it is today for fresh builds, package-installed copies, and CI clones.
2. Nothing here may ever block startup, rebuild, install, restart, or reject. Rebuild and restart
   cross a shutdown boundary and stay operator-side (AGENTS.md); this file only observes.
*/

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { basename, dirname, join, resolve as pathResolve, sep } from "node:path";
import { promisify } from "node:util";
import { invalidateGitBinaryCache, isSpawnGitEnoent, resolveGitBinary } from "./cli/git-binary.js";
import { emitBoundedRunAudit } from "./run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * HEAD must be newer than the loaded artifact by MORE than this to be called stale.
 *
 * FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
 * A build is not instantaneous and `git commit` then `pnpm build` is the normal order of operations,
 * so a HEAD inside the build window is not staleness — it is the same commit being built. The grace
 * has to absorb checkout-then-build tooling noise without absorbing a genuine "deployed yesterday's
 * tree" gap, which is measured in hours, not seconds.
 */
export const BUILD_STALE_GRACE_MS = 60_000;

/** Per-subprocess bound. A boot probe must never wait on a wedged git; two seconds is already late. */
export const BUILD_PROVENANCE_GIT_TIMEOUT_MS = 2_000;

/**
 * The root workspace manifest name that proves a directory tree is a Fusion source checkout.
 * Mirrors the literal in root `package.json`; see `resolveFusionWorkspaceRoot` for why it must match.
 */
export const FUSION_WORKSPACE_PACKAGE_NAME = "fusion-workspace";

/**
 * FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
 * `unknown` is deliberately NOT `fresh` and NOT an error. `fresh` is a claim that the running code
 * matches this repository, and a published `@runfusion/fusion` installed under a host project's
 * `node_modules` has no Fusion history to compare against — worse, the git probe there does not
 * fail, it answers the HOST repository, whose HEAD is newer than the installed bundle and would
 * print a STALE warning about commits Fusion has nothing to do with. So the unprovable case gets its
 * own verdict and stays silent: no boot line, no audit row, and no subprocess. An error would be
 * wrong in the other direction — a missing `dist`, a missing git, or a vendored checkout is normal,
 * not a fault.
 */
export type BuildProvenanceVerdict = "fresh" | "stale" | "unknown";

/** The measured comparison between one loaded artifact and one repository HEAD. */
export interface BuildProvenance {
  /** The artifact this verdict was measured from (a module filename, never a cwd). */
  artifactPath: string;
  /** ISO-8601 mtime of the artifact; absent when the artifact could not be stat'ed. */
  bundleMtime?: string;
  /** Full HEAD commit sha; absent when HEAD could not be read. */
  headSha?: string;
  /** HEAD committer time exactly as git printed it (ISO-8601 with offset); absent when unreadable. */
  headTime?: string;
  /** Commits reachable from HEAD since the artifact was built; absent when `rev-list` failed. */
  commitsBehind?: number;
  /** HEAD-vs-artifact gap in ms (wall clock when HEAD was unreadable); 0 when nothing was measurable. */
  ageMs: number;
  verdict: BuildProvenanceVerdict;
}

/** Every probe input is injectable so the pure decision path is testable without disk or git. */
export interface BuildProvenanceProbeOptions {
  artifactPath: string;
  now?: () => Date;
  /** Returns `null` for any stat failure (no `dist` yet is normal, not an error). */
  statFile?: (path: string) => Promise<{ mtimeMs: number } | null>;
  /** Returns `null` for any git failure; never throws and never returns error text. */
  runGit?: (args: string[], cwd: string) => Promise<string | null>;
  resolveWorkspaceRoot?: (startDir: string) => string | null;
  gitTimeoutMs?: number;
}

/** Audit sink shape accepted by `reportBuildProvenance`; a `TaskStore` satisfies it structurally. */
export type BuildProvenanceAuditSink = {
  recordRunAuditEvent?: (input: RunAuditEventInput) => unknown;
} | null | undefined;

/** Boot-output channel; the call site owns its own `[engine]`/`dashboard` prefix. */
export type BuildProvenanceLogger = { warn: (message: string) => void };

const WORKSPACE_WALK_MAX_LEVELS = 10;
const BUILD_PROVENANCE_AUDIT_TIMEOUT_MS = 2_000;
const HEAD_SHA_DISPLAY_LENGTH = 9;

/**
 * Decide whether a directory tree is a Fusion source workspace, walking up from `startDir`.
 *
 * FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
 * This mirrors `resolveFusionSourceWorkspaceRoot()` in `packages/cli/src/commands/dashboard.ts`
 * (its FNXC:SystemPanel block already names the misdetection: without the package-name guard, a
 * globally-installed `@runfusion/fusion` nested under an unrelated pnpm workspace is misdetected as
 * a rebuildable checkout). It is MIRRORED, not imported, because `@fusion/core` cannot import CLI
 * modules — the documented `@fusion/*` dependency cycle — so the rule has two bodies that must stay
 * in step, and both require BOTH signals: a `pnpm-workspace.yaml` AND a root `package.json` whose
 * parsed name is exactly `fusion-workspace`. A future change to one rule must be made to the other.
 */
export function resolveFusionWorkspaceRoot(startDir: string): string | null {
  try {
    let dir = pathResolve(startDir);
    for (let depth = 0; depth < WORKSPACE_WALK_MAX_LEVELS; depth += 1) {
      if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
        try {
          const raw = readFileSync(join(dir, "package.json"), "utf8");
          const pkg = JSON.parse(raw) as { name?: unknown };
          return pkg?.name === FUSION_WORKSPACE_PACKAGE_NAME ? dir : null;
        } catch {
          // A workspace marker whose manifest cannot be read or parsed proves nothing — stay silent.
          return null;
        }
      }
      const parent = pathResolve(dir, "..");
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    // Best-effort ownership probe only; it must never throw into a boot path.
  }
  return null;
}

/**
 * The pure verdict rule. `stale` requires a readable HEAD time strictly outside the grace window.
 *
 * `ageMs` falls back to the wall clock when HEAD was unreadable, so a caller can still report how
 * old the artifact is even though it cannot prove HEAD is newer.
 */
export function evaluateBuildProvenance(inputs: {
  bundleMtimeMs: number;
  headCommitTimeMs?: number;
  commitsBehind?: number;
  artifactPath: string;
  nowMs: number;
}): BuildProvenance {
  const { bundleMtimeMs, headCommitTimeMs, commitsBehind, artifactPath, nowMs } = inputs;
  const headReadable = headCommitTimeMs !== undefined && Number.isFinite(headCommitTimeMs);
  const ageMs = (headReadable ? (headCommitTimeMs as number) : nowMs) - bundleMtimeMs;
  const verdict: BuildProvenanceVerdict = !headReadable
    ? "unknown"
    : (headCommitTimeMs as number) > bundleMtimeMs + BUILD_STALE_GRACE_MS
      ? "stale"
      : "fresh";
  const result: BuildProvenance = { artifactPath, ageMs, verdict };
  if (commitsBehind !== undefined) result.commitsBehind = commitsBehind;
  return result;
}

/** Largest single human unit (`Nd`/`Nh`/`Nm`/`Ns`); an age is a signal, not a timestamp. */
function formatHumanAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "0s";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/**
 * The operator-visible line. Prefix-free on purpose: each call site owns its own channel prefix
 * (`[engine] ` on the daemon, the `dashboard` logSink channel elsewhere).
 *
 * FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
 * Both timestamps are printed, not just the bundle's, because the whole value of the line is the
 * pair — an operator who sees only `bundle 2026-10-09T22:45:21.000Z` still cannot tell whether HEAD
 * moved an hour ago or last Tuesday. The head timestamp is appended to the sha token
 * (`<sha>@<iso>`) so the `<humanAge>[, ~<n> commits]` paren keeps its documented shape. The
 * `~<n> commits` segment is OMITTED, never rendered as `~0`, when `rev-list` failed: `~0` would
 * assert "no commits behind" in the same breath as `STALE`, which is a contradiction, whereas a
 * missing segment reads as "this count is unavailable". The remedy sentence is fixed and names the
 * actor (`operator action`) so no agent reads it as its own instruction.
 */
export function formatBuildProvenanceWarning(p: BuildProvenance): string {
  const bundle = p.bundleMtime ?? "unknown";
  const sha = p.headSha ? p.headSha.slice(0, HEAD_SHA_DISPLAY_LENGTH) : "unknown";
  const head = p.headTime ? `${sha}@${p.headTime}` : sha;
  const age = formatHumanAge(p.ageMs);
  const behind = p.commitsBehind === undefined ? "" : `, ~${p.commitsBehind} commits`;
  return (
    `build provenance: bundle ${bundle} vs HEAD ${head} (${age}${behind}) — STALE — `
    + "run `pnpm build` in the running checkout and restart (operator action)"
  );
}

/** Default probe: git plumbing through core's resolved binary, async, per-call timeout, ENOENT-aware. */
async function defaultRunGit(args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  try {
    const git = await resolveGitBinary();
    const { stdout } = await execFileAsync(git, args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1 << 20,
    });
    return stdout;
  } catch (error) {
    // Mirror `git-repository.ts`: a spawn ENOENT invalidates the cached resolution so a git
    // installed mid-session is found by the next probe instead of after a restart.
    if (isSpawnGitEnoent(error)) invalidateGitBinaryCache();
    return null;
  }
}

async function defaultStatFile(path: string): Promise<{ mtimeMs: number } | null> {
  try {
    const info = await fsStat(path);
    return { mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/** True when `candidate` is `root` itself or nested inside it (path-boundary correct). */
function isSameOrInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Measure the running artifact against the repository that owns it. Never rejects.
 *
 * FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
 * The probe ORDER is the false-positive defence, not an optimisation: ownership is settled before a
 * single subprocess exists, so an unowned installation (the documented npm/pi/pnpm path, where the
 * live artifact is `<host-project>/node_modules/@runfusion/fusion/dist/bin.js`) provably cannot
 * spawn git against the host's repository. Each later probe degrades only its own field: a failed
 * `rev-list` costs the commit count and nothing else, so the STALE line still renders.
 */
export async function collectBuildProvenance(
  opts: BuildProvenanceProbeOptions,
): Promise<BuildProvenance> {
  const { artifactPath } = opts;
  const now = opts.now?.() ?? new Date();
  const statFile = opts.statFile ?? defaultStatFile;
  const gitTimeoutMs = opts.gitTimeoutMs ?? BUILD_PROVENANCE_GIT_TIMEOUT_MS;
  const runGitRaw = opts.runGit ?? ((args, cwd) => defaultRunGit(args, cwd, gitTimeoutMs));
  /*
  FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
  A rejected probe is the same event as a probe that reported failure, so every git call is funnelled
  through one wrapper. Without it, `collectBuildProvenance` would reject on an injected or
  unexpectedly-throwing runner, and the contract "this function never rejects" would hold only at the
  `reportBuildProvenance` layer — where the caller has already lost which field failed.
  */
  const runGit = async (args: string[], cwd: string): Promise<string | null> => {
    try {
      return await runGitRaw(args, cwd);
    } catch {
      return null;
    }
  };
  const resolveWorkspaceRoot = opts.resolveWorkspaceRoot ?? resolveFusionWorkspaceRoot;
  const startDir = dirname(artifactPath);

  // (1) Ownership first. Unproven → `unknown` with zero stat and zero git work.
  let workspaceRoot: string | null = null;
  try {
    workspaceRoot = resolveWorkspaceRoot(startDir);
  } catch {
    workspaceRoot = null;
  }
  if (!workspaceRoot) return { artifactPath, ageMs: 0, verdict: "unknown" };

  // (2) The artifact itself — a source checkout with no `dist` yet is normal, not stale.
  const stats = await statFile(artifactPath).catch(() => null);
  if (!stats || !Number.isFinite(stats.mtimeMs)) {
    return { artifactPath, ageMs: 0, verdict: "unknown" };
  }
  const bundleMtimeIso = new Date(stats.mtimeMs).toISOString();

  // (3) The repository identity check. `--show-toplevel` from the artifact's own directory must be
  // the verified workspace root or something inside it, so a Fusion checkout vendored inside a
  // different repository is never compared against the OUTER repository's HEAD.
  const topLevelRaw = await runGit(["rev-parse", "--show-toplevel"], startDir);
  if (topLevelRaw === null) return { artifactPath, ageMs: 0, verdict: "unknown" };
  const topLevel = pathResolve(topLevelRaw.trim());
  if (!topLevel || !isSameOrInside(topLevel, workspaceRoot)) {
    return { artifactPath, bundleMtime: bundleMtimeIso, ageMs: 0, verdict: "unknown" };
  }

  // (4) HEAD identity + committer time. `%cI` (committer ISO strict) is the clock that matters:
  // the question is when the code being compared was committed, not when it was authored.
  const headRaw = await runGit(["log", "-1", "--format=%H%x09%cI"], workspaceRoot);
  if (headRaw === null) {
    return evaluateWithStrings({
      artifactPath, bundleMtimeMs: stats.mtimeMs, bundleMtimeIso, nowMs: now.getTime(),
    });
  }
  const [headSha, headTime, ...rest] = headRaw.trim().split("\t");
  const headCommitTimeMs = rest.length === 0 && headSha && headTime
    ? Date.parse(headTime)
    : Number.NaN;
  if (!headSha || !Number.isFinite(headCommitTimeMs)) {
    return evaluateWithStrings({
      artifactPath, bundleMtimeMs: stats.mtimeMs, bundleMtimeIso, nowMs: now.getTime(),
    });
  }

  // (5) Commit count is decoration, never a precondition: failure leaves it undefined.
  const behindRaw = await runGit(
    ["rev-list", "--count", "HEAD", `--since=${bundleMtimeIso}`],
    workspaceRoot,
  );
  const commitsBehind = behindRaw === null ? undefined : parseCommitCount(behindRaw);

  const evaluated = evaluateBuildProvenance({
    bundleMtimeMs: stats.mtimeMs,
    headCommitTimeMs,
    commitsBehind,
    artifactPath,
    nowMs: now.getTime(),
  });
  return { ...evaluated, bundleMtime: bundleMtimeIso, headSha, headTime };
}

/** Shared `unknown`-verdict exit that still reports the artifact age it did manage to measure. */
function evaluateWithStrings(input: {
  artifactPath: string;
  bundleMtimeMs: number;
  bundleMtimeIso: string;
  nowMs: number;
}): BuildProvenance {
  const evaluated = evaluateBuildProvenance({
    bundleMtimeMs: input.bundleMtimeMs,
    artifactPath: input.artifactPath,
    nowMs: input.nowMs,
  });
  return { ...evaluated, bundleMtime: input.bundleMtimeIso };
}

/** A non-numeric or negative `rev-list` answer is "no count", never `0`. */
function parseCommitCount(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Observe, log, and record — on exactly one verdict.
 *
 * FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
 * `fresh` and `unknown` are silent by design: a boot line that appears on every start is a boot line
 * nobody reads, and silence is what makes STALE mean something. The audit row shares the same rule,
 * so "this deployment warned" and "this deployment is current" are distinguishable from the audit
 * store alone. Everything is catch-all: a throwing log sink or audit sink resolves to `unknown`
 * rather than reaching the operator as an error, because a diagnostic that can break boot is a
 * defect, not a diagnostic.
 */
export async function reportBuildProvenance(
  opts: BuildProvenanceProbeOptions & { sink?: BuildProvenanceAuditSink; log: BuildProvenanceLogger },
): Promise<BuildProvenance> {
  try {
    const provenance = await collectBuildProvenance(opts);
    if (provenance.verdict !== "stale") return provenance;

    opts.log.warn(formatBuildProvenanceWarning(provenance));
    await emitBoundedRunAudit(
      opts.sink ?? {},
      {
        agentId: "boot",
        runId: "build-provenance",
        /*
        FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
        `RunAuditDomain` is a CLOSED four-member set and widening it is out of scope for an
        observability card. "git" is reused on the strength of its own definition — the verdict is
        computed entirely from git plumbing (`rev-parse`, `log`, `rev-list`), which is the only
        domain that describes what this row measured. The reuse is safe for readers too: every
        existing `domain: "git"` query is `taskId`-scoped, and a boot-time row has no task to be
        scoped to, so no existing surface inherits it. `verification-resource-bound.ts` is the
        precedent for reusing a domain plus a synthetic agentId/runId pair instead of growing the set.
        */
        domain: "git",
        mutationType: "build:provenance-stale",
        // Basename only: the row must not carry the operator's absolute paths.
        target: basename(opts.artifactPath),
        metadata: {
          bundleMtime: provenance.bundleMtime ?? "unknown",
          headSha: provenance.headSha ?? "unknown",
          headTime: provenance.headTime ?? "unknown",
          ageMs: provenance.ageMs,
          commitsBehind: provenance.commitsBehind ?? "unavailable",
        },
      },
      { timeoutMs: BUILD_PROVENANCE_AUDIT_TIMEOUT_MS },
    );
    return provenance;
  } catch {
    return { artifactPath: opts.artifactPath, ageMs: 0, verdict: "unknown" };
  }
}
