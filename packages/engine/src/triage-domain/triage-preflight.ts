import { basename, dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { realpathSync, statSync } from "node:fs";
import type { Task } from "@fusion/core";

export interface CitedConstruct {
  kind: "identifier" | "snippet" | "command";
  raw: string;
  filePath?: string;
  line?: number;
}

export interface GhostBugProbeResult {
  construct: CitedConstruct;
  matched: boolean;
  probeError?: string;
  output?: string;
}

/*
FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
THREE decisions, not two. The two-decision shape is what made an unprovable check indistinguishable
from a verified one: every non-archive outcome — an all-probes-errored run, a failed positive control,
a timeout — was reported as `pass`, and the caller released the card to execution as if the cited code
had been confirmed present.

`pass` now carries a `passKind`, because "this check does not apply" and "this check ran and proved
the code is present" are both legitimate releases but must never be conflated with "this check
attempted and failed to prove anything" (which is `unverified`, and holds the card).
*/
/** Why a non-destructive release is legitimate. Fixed enum — never a free string. */
export type GhostBugPassKind = "not-applicable" | "verified-present";

export interface GhostBugDecision {
  decision: "archive" | "pass" | "unverified";
  /**
   * Kept as `string` (not a literal union) deliberately: the out-of-scope
   * `ghost-bug-archive-visibility.test.ts` suite constructs decision literals with free-form
   * reasons and must keep compiling unchanged. Use `isGhostBugUnverifiedReason` to narrow.
   */
  reason: string;
  findings: GhostBugProbeResult[];
  /** Present exactly when `decision === "pass"`. */
  passKind?: GhostBugPassKind;
  /** Present when a revision was resolved for an `archive` / `unverified` decision. */
  revision?: ResolvedProbeRevision;
}

/** Reason string retained for the archive decision: revision-accurate, not "main". */
export const GHOST_BUG_ARCHIVE_REASON = "all_cited_constructs_missing_on_proven_revision";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * Probe "matched" is an exit-code fact, not a printed-bytes heuristic. Plan text that names the
 * allegedly-missing construct originates in agent-authored prose, so it is only ever handed to a
 * fixed `git` argv array — never interpolated into a shell string — and the caller classifies the
 * result from `exitCode`/`stderr`, not from whether stdout happened to be non-empty.
 */
export type ProbeExec = (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

const BUG_FIX_REGEX = /typecheck error|compile error|broken|regression|lint error/i;

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * Bounds on what an untrusted construct raw value may look like before it is allowed anywhere near
 * `exec`. 200 chars keeps a single argv entry sane; a newline/NUL would otherwise let a multi-line
 * "identifier" smuggle a second logical argument past argv-based (not shell-based) execution.
 */
const MAX_CONSTRUCT_LENGTH = 200;
const MAX_OUTPUT_LENGTH = 500;

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * The positive control samples a line of TRACKED, TEXTUAL repository content and re-greps for it.
 * Restricting the sample to obviously-textual extensions avoids picking a binary/lockfile line whose
 * bytes can't round-trip through `git grep -F` as a stable single-line needle.
 */
const TEXTISH_EXTENSIONS = new Set([
  "ts", "tsx", "js", "mjs", "cjs", "md", "json", "yml", "yaml", "toml", "cs", "csproj", "go", "py",
  "java", "rb", "rs", "php", "swift", "kt", "kts", "c", "cc", "cpp", "h", "hpp", "html", "css", "scss",
  "vue", "svelte", "sh",
]);

/** FNXC:GhostBugPreflight 2026-10-19-11:20: Recognize corrective tasks from their title or description before running Git probes. */
export function isBugFixShape(task: { title: string | null; description: string }): boolean {
  const title = task.title?.trim() ?? "";
  const description = task.description?.trim() ?? "";
  if (!title && !description) return false;
  if (/^\s*fix\b/i.test(title)) return true;
  return BUG_FIX_REGEX.test(`${title}\n${description}`);
}

/** FNXC:GhostBugPreflight 2026-10-19-11:20: Extract a bounded, deduplicated set of cited code constructs from the accepted prompt. */
export function extractCitedConstructs(prompt: string): CitedConstruct[] {
  const seen = new Set<string>();
  const constructs: CitedConstruct[] = [];
  const add = (construct: CitedConstruct) => {
    if (construct.raw.trim().length === 0) return;
    const key = `${construct.kind}:${construct.raw}:${construct.filePath ?? ""}:${construct.line ?? ""}`;
    if (seen.has(key) || constructs.length >= 20) return;
    seen.add(key);
    constructs.push(construct);
  };

  const identifierRegex = /`([A-Za-z_][A-Za-z0-9_.]*\([^`]*\)|[A-Za-z_][\w.]{2,})`/g;
  for (const match of prompt.matchAll(identifierRegex)) {
    const raw = match[1].trim();
    if (raw.includes("(") || raw.includes(".") || raw.includes("_")) {
      add({ kind: "identifier", raw });
    }
  }

  const fileRegex = /(packages\/[\w./-]+\.(?:ts|tsx|js|mjs|cjs|md))(?::(\d+))?/g;
  for (const match of prompt.matchAll(fileRegex)) {
    const filePath = match[1];
    const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
    add({ kind: "identifier", raw: filePath, filePath, line });
  }

  const fenceRegex = /```(?:\w+)?\n([\s\S]*?)```/g;
  for (const match of prompt.matchAll(fenceRegex)) {
    const lines = match[1].split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.includes("(") || line.includes("=") || line.includes("import")) {
        add({ kind: "snippet", raw: line });
      }
    }
  }

  for (const line of prompt.split("\n")) {
    if (/^\s*(?:pnpm|npm|yarn|tsc|node|eslint)\b[^\n]+/m.test(line)) {
      add({ kind: "command", raw: line.trim() });
    }
  }

  return constructs;
}

/** FNXC:GhostBugPreflight 2026-10-19-11:20: Bound retained probe diagnostics without changing the exit-status verdict. */
function truncateOutput(stdout: string): string {
  const trimmed = stdout.trim();
  return trimmed.length <= MAX_OUTPUT_LENGTH ? trimmed : `${trimmed.slice(0, MAX_OUTPUT_LENGTH)}…[truncated]`;
}

/** A raw value is safe to pass as a single argv entry: bounded length, no embedded line breaks/NUL. */
function isSafeRaw(raw: string): boolean {
  return raw.length <= MAX_CONSTRUCT_LENGTH && !/[\0\n\r]/.test(raw);
}

/**
 * A cited file path is safe to interpolate into `HEAD:<path>`: repo-relative (no leading `/`), not an
 * option-injection attempt (no leading `-`), no traversal segments, and no embedded line breaks/NUL.
 */
function isSafeFilePath(filePath: string): boolean {
  return !filePath.startsWith("/")
    && !filePath.startsWith("-")
    && !/[\0\n\r]/.test(filePath)
    && !filePath.split("/").includes("..");
}

/* ───────────────────────────────────────────────────────────────────────────────
 * Proven task target revision (GhostBug)
 *
 * FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
 * THE GHOST-BUG DETECTOR MUST PROBE THE REVISION THE TASK'S OWN WORK LIVES AT.
 *
 * The original defect: the preflight probed at the checkout root (effectively `main`), so a
 * returned/replanned task whose cited constructs exist only on its own UNMERGED branch looked
 * "all missing", the worktree-root-scoped positive control still matched, and the card was
 * silently archived as a phantom bug. Real-world instance: a project task was
 * archived while a `git show` on the preserved commit proves the cited constructs exist there.
 * Probing main is therefore not a conservative default — it is the reported bug. A task with
 * its own identity sources (branch, recorded base commit) must be verified AT those, and a
 * main/checkout-root fallback for such a task is never permitted.
 *
 * The second GhostBug defect is the mirror image: every non-archive outcome — a 15s timeout, a
 * thrown preflight, an all-probes-errored run, a failed positive control — used to release the
 * card to execution AS IF VERIFIED. An incomplete proof is not a pass; it is an explicit
 * `unverified` decision that holds the card (Step 4).
 * ─────────────────────────────────────────────────────────────────────────── */

/** Which identity source produced the probe target. Fixed enum — never a free string. */
export type ProbeRevisionSource = "task-branch" | "task-base-commit" | "baseline-head";

/**
 * A resolved, object-proven commit sha safe to interpolate into a later git argv.
 *
 * FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
 * `resolvedForRunId` records WHICH finalize pass resolved this revision. It is audit/provenance
 * context ONLY: it explains which pass produced the sha, it is not an ownership receipt, and it
 * fences nothing. Episode ownership is bound at the caller from the actually-consumed dispatch
 * inputs (consumed-input snapshot + row snapshot + planning-attempt generation + PROMPT artifact).
 */
export interface ResolvedProbeRevision {
  /** Validated 40-64 hex commit object sha. */
  sha: string;
  source: ProbeRevisionSource;
  /** Fully-qualified local head ref (`refs/heads/...`) when the source was a branch. */
  refName?: string;
  resolvedForRunId: string;
}

/**
 * Every reason an attempted ghost-bug verification could not prove anything. Fixed enum, so an
 * operator/tooling can distinguish "the detector ran and proved absence" from "the detector could
 * not run meaningfully" without parsing prose.
 */
export const GHOST_BUG_UNVERIFIED_REASONS = [
  "preflight_timeout",
  "preflight_error",
  "dispatch_snapshot_unavailable",
  "revision_unsafe_ref",
  "revision_unresolved",
  "revision_ambiguous",
  "revision_missing_object",
  "task_base_commit_invalid",
  "baseline_unproven",
  "provenance_git_error",
  "worktree_provenance_unsafe_path",
  "worktree_provenance_absent",
  // FNXC:GhostBugPreflight 2026-10-11-16:45 (GhostBug): distinct from `absent` — a stat failure that is
  // NOT a positively-proven ENOENT (e.g. EACCES/ELOOP) says nothing about presence and must never be
  // routed into the absent-worktree immutable-object fallback.
  "worktree_provenance_unobservable",
  "worktree_provenance_foreign_path",
  "worktree_provenance_repo_conflict",
  "worktree_provenance_conflict",
  "worktree_provenance_dirty",
  "probe_evidence_incomplete",
  "probe_control_failed",
  "revision_moved_during_probe",
  "task_identity_changed_during_probe",
] as const;

export type GhostBugUnverifiedReason = (typeof GHOST_BUG_UNVERIFIED_REASONS)[number];

const UNVERIFIED_REASON_SET: ReadonlySet<string> = new Set<string>(GHOST_BUG_UNVERIFIED_REASONS);

/** FNXC:GhostBugPreflight 2026-10-19-11:20: Narrow persisted reason text to a recognized fail-closed outcome. */
export function isGhostBugUnverifiedReason(value: string): value is GhostBugUnverifiedReason {
  return UNVERIFIED_REASON_SET.has(value);
}

/** Task provenance fields the resolver needs. Absent/`null` on a never-executed initial task. */
export interface GhostBugProvenanceInput {
  branch?: string | null;
  baseCommitSha?: string | null;
  worktree?: string | null;
}

export type ProbeTargetResolution =
  | {
    ok: true;
    revision: ResolvedProbeRevision;
    /** The single cwd every later command must use (resolved owned worktree, else the project root). */
    cwd: string;
    /**
     * True when a DECLARED worktree could not be used and the decision instead rests solely on
     * immutable commit objects. Never a silent skip — the caller surfaces this fixed explanation.
     */
    declaredWorktreeUnreliedUpon: boolean;
    /**
     * FNXC:GhostBugPreflight 2026-10-11-17:05 (GhostBug, review validation personal-evidence counterexample):
     * Set ONLY when this target actually runs its commands inside an EXISTING declared worktree —
     * the path that every later command-group boundary must re-verify for repository identity.
     * `cwd` alone cannot serve this role after a substitution: the string stays owned-looking while
     * the directory behind it is foreign, which is exactly how a deterministic between-phase swap
     * (operator proof 2026-10-11, same commit bytes via a clone) ran four content commands in a
     * foreign repository and reached an archive. An absent-declared-worktree or no-worktree target
     * runs at the proven project root and has nothing extra to re-verify.
     */
    worktreeCwd?: string;
  }
  | { ok: false; reason: GhostBugUnverifiedReason };

/** A commit sha is only ever interpolated into argv after this shape check passes. */
function isHexCommitSha(value: string): boolean {
  return /^[0-9a-f]{40,64}$/.test(value.trim());
}

/*
FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
`git check-ref-format --branch` cannot be used as the guard because it would be a second subprocess
whose own exit-code semantics we would have to trust BEFORE we trust the value. The rejection is
therefore pure string logic implementing the load-bearing subset of git's ref-name rules, and it
runs BEFORE any subprocess: no whitespace/control/NUL bytes (argv-safe), no option injection via a
leading `-`, no `..` traversal, no git metacharacters, no empty or `.`/`..`-prefixed path component,
no `//`, no leading/trailing `/`, no `.lock` component, and no `@{` revision syntax.
*/
function isSafeRefPathComponent(branch: string): boolean {
  if (branch.length === 0 || branch.startsWith("-")) return false;
  // Whitespace, NUL, and DEL are never legal in a ref name and are the argv-injection surface.
  if (/[\0-\x20\x7f]/.test(branch)) return false;
  if (/[~^:?*[\\]|]/.test(branch)) return false;
  if (branch.includes("..") || branch.includes("@{") || branch.includes("//")) return false;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")) return false;
  return branch.split("/").every((component) => (
    component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock")
  ));
}

/** Returns the exact fully-qualified local head ref for a safe branch value, else `null`. */
export function toSafeFullyQualifiedHeadRef(branch: string | null | undefined): string | null {
  if (typeof branch !== "string") return null;
  /*
  FNXC:GhostBugPreflight 2026-10-11-13:55 (GhostBug):
  The option-injection guard has to run on the RAW value, BEFORE the `refs/heads/` prefix is added.
  Checking only the composed ref name defeats it entirely: `"-b"` becomes `"refs/heads/-b"`, which no
  longer starts with a dash, so a task-supplied branch shaped like a git option would reach argv as an
  option-looking token and silently resolve to `revision_unresolved` instead of being refused.
  */
  if (branch.startsWith("-")) return null;
  const value = branch.trim();
  if (value !== branch) return null;
  const refName = value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
  if (!isSafeRefPathComponent(refName)) return null;
  if (!refName.startsWith("refs/heads/") || refName.slice("refs/heads/".length).length === 0) return null;
  return refName;
}

/*
FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
ONE realpath-based canonicalization, mirroring `canonicalizePath`'s semantics from
`worktree-pool.ts` (`realpathSync`, falling back to the nearest-existing-ancestor + suffix rejoin
when the leaf is missing). It is mirrored rather than imported deliberately: the preflight module
stays free of the worktree-pool import graph, and the containment predicate the CALLER injects
(`isInsideConfiguredWorktreesDir`) re-canonicalizes internally — re-canonicalizing an already
canonical path is idempotent, so validating the target produced here is exact.
*/
function canonicalizeOnce(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    let dir = resolvePath(path);
    const suffix: string[] = [];
    for (;;) {
      try {
        return resolvePath(realpathSync(dir), ...suffix.reverse());
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        suffix.push(basename(dir));
        dir = parent;
      }
    }
    return resolvePath(path);
  }
}

/** A declared worktree path is only allowed anywhere near the filesystem after this pure check. */
function isLexicallySafeAbsolutePath(candidate: unknown): candidate is string {
  return typeof candidate === "string"
    && candidate.length > 0
    && !/[\x00-\x1f\x7f]/.test(candidate)
    && isAbsolute(candidate);
}

type WorktreePresence = "directory" | "absent" | "non-directory" | "unknown";

/**
 * FNXC:GhostBugPreflight 2026-10-11-16:45 (GhostBug, review validation real-spawn counterexample):
 * Classify the resolved worktree path WITHOUT spawning anything at it. The three negative states are
 * deliberately distinct and never conflated: a positively-proven `ENOENT` is ABSENT (the only case the
 * immutable-object fallback may consider); an existing path that is not a directory is CONTRADICTORY;
 * any other stat failure (permission, symlink-loop, ENOTDIR through a file ancestor) is UNKNOWN. The
 * stat function is injectable so the error-code mapping is unit-testable without a contrived
 * filesystem-permission fixture; production always uses `statSync`.
 */
export function classifyWorktreePresence(
  candidate: string,
  stat: (path: string) => { isDirectory(): boolean } = statSync,
): WorktreePresence {
  try {
    return stat(candidate).isDirectory() ? "directory" : "non-directory";
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "absent" : "unknown";
  }
}

/**
 * FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
 * One bounded repository-identity observation: `git rev-parse --git-common-dir` at `cwd`, resolved
 * RELATIVE to that cwd and then canonicalized. Two calls returning the same canonical directory is
 * the definition of "the same repository", and because this is a real subprocess at `cwd` it
 * OBSERVES through symlink substitution of the target (a substituted foreign checkout yields a
 * different common dir) — which is what makes the Gate-3 mismatch check meaningful rather than a
 * string comparison of a path we already chose not to trust.
 */
async function observeRepositoryIdentityDir(
  exec: ProbeExec,
  cwd: string,
  timeoutMs: number | undefined,
): Promise<{ ok: true; commonDir: string } | { ok: false }> {
  try {
    const result = await exec(["git", "rev-parse", "--git-common-dir"], { cwd, timeoutMs });
    if (result.exitCode !== 0) return { ok: false };
    const observed = result.stdout.trim();
    if (!observed) return { ok: false };
    return { ok: true, commonDir: canonicalizeOnce(resolvePath(cwd, observed)) };
  } catch {
    return { ok: false };
  }
}

/** FNXC:GhostBugPreflight 2026-10-19-11:20: Resolve and validate a commit object at the already selected repository directory. */
async function resolveCommitObjectAt(
  exec: ProbeExec,
  cwd: string,
  timeoutMs: number | undefined,
  revSpec: string,
): Promise<{ ok: true; sha: string } | { ok: false; reason: GhostBugUnverifiedReason }> {
  try {
    const resolved = await exec(["git", "rev-parse", revSpec], { cwd, timeoutMs });
    if (resolved.exitCode !== 0) {
      return { ok: false, reason: resolved.exitCode === 128 ? "provenance_git_error" : "revision_unresolved" };
    }
    const sha = resolved.stdout.trim();
    if (!isHexCommitSha(sha)) return { ok: false, reason: "revision_unresolved" };
    const exists = await exec(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd, timeoutMs });
    if (exists.exitCode !== 0) return { ok: false, reason: "revision_missing_object" };
    return { ok: true, sha };
  } catch {
    return { ok: false, reason: "provenance_git_error" };
  }
}

/**
 * Resolve the ONE revision this finalize pass may probe, then validate any declared task worktree
 * against it. Precedence is strict and never falls back to main for a task that has its own
 * identity sources — see the block comment at the top of this section.
 */
export async function resolveProbeTarget(
  provenance: GhostBugProvenanceInput,
  opts: {
    rootDir: string;
    exec: ProbeExec;
    resolvedForRunId: string;
    timeoutMs?: number;
    /** Caller-injected project-ownership containment test, wired to the configured worktree roots. */
    isOwnedWorktreePath?: (resolvedPath: string) => boolean | Promise<boolean>;
  },
): Promise<ProbeTargetResolution> {
  const { exec, rootDir, timeoutMs } = opts;

  // ── 1. Revision precedence: task branch → task base commit → proven baseline HEAD ──
  let revision: ResolvedProbeRevision | undefined;

  if (provenance.branch != null && provenance.branch !== "") {
    const refName = toSafeFullyQualifiedHeadRef(provenance.branch);
    if (!refName) return { ok: false, reason: "revision_unsafe_ref" };

    /*
    FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
    EXACT fully-qualified lookup with ONE command. `for-each-ref refs/heads/<branch>` lists the exact
    ref AND any nested `refs/heads/<branch>/...`, which is how a namespace ambiguity becomes
    observable instead of silently resolving the wrong commit. `git rev-parse <branch>` is the shape
    that caused the original class of wrong-revision resolution (prefix/remote/tag namespace match),
    so it is deliberately not used for selection.
    */
    let listed: Awaited<ReturnType<ProbeExec>>;
    try {
      listed = await exec(["git", "for-each-ref", "--format=%(refname) %(objectname)", refName], {
        cwd: rootDir,
        timeoutMs,
      });
    } catch {
      return { ok: false, reason: "provenance_git_error" };
    }
    if (listed.exitCode !== 0) {
      return { ok: false, reason: listed.exitCode === 128 ? "provenance_git_error" : "revision_unresolved" };
    }

    const entries = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(" ");
        return { ref: separator === -1 ? line : line.slice(0, separator), sha: separator === -1 ? "" : line.slice(separator + 1).trim() };
      });
    const exact = entries.filter((entry) => entry.ref === refName);
    const nested = entries.filter((entry) => entry.ref.startsWith(`${refName}/`));
    if (exact.length === 0) return { ok: false, reason: "revision_unresolved" };
    if (exact.length > 1 || nested.length > 0) return { ok: false, reason: "revision_ambiguous" };

    const resolved = await resolveCommitObjectAt(exec, rootDir, timeoutMs, `${refName}^{commit}`);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    revision = { sha: resolved.sha, source: "task-branch", refName, resolvedForRunId: opts.resolvedForRunId };
  } else if (provenance.baseCommitSha != null && provenance.baseCommitSha !== "") {
    const recorded = provenance.baseCommitSha.trim();
    if (!isHexCommitSha(recorded)) return { ok: false, reason: "task_base_commit_invalid" };
    const resolved = await resolveCommitObjectAt(exec, rootDir, timeoutMs, `${recorded}^{commit}`);
    if (!resolved.ok) {
      /*
      FNXC:GhostBugPreflight 2026-10-11-13:45 (GhostBug):
      A RECORDED base commit is a provenance claim the task already made, so an unresolvable or
      non-existent one is that claim being invalid — not a generic revision error. A thrown exec is the
      one case kept distinct, because it says nothing about the sha's validity.
      */
      return { ok: false, reason: resolved.reason === "provenance_git_error" ? "provenance_git_error" : "task_base_commit_invalid" };
    }
    revision = { sha: resolved.sha, source: "task-base-commit", resolvedForRunId: opts.resolvedForRunId };
  } else {
    /*
    FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
    A never-executed initial task has no branch and no recorded base commit, so its baseline identity
    must be PROVEN FOR THIS ATTEMPT rather than taken as an incidental checkout-root HEAD read. Two
    observations are required: the repository identity proof (`--git-common-dir` exit 0) and a
    hex-shaped HEAD. Anything else is `baseline_unproven` — not "missing", and not a pass.
    */
    const identity = await observeRepositoryIdentityDir(exec, rootDir, timeoutMs);
    if (!identity.ok) return { ok: false, reason: "baseline_unproven" };
    const resolved = await resolveCommitObjectAt(exec, rootDir, timeoutMs, "HEAD^{commit}");
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason === "provenance_git_error" ? "provenance_git_error" : "baseline_unproven" };
    }
    revision = { sha: resolved.sha, source: "baseline-head", resolvedForRunId: opts.resolvedForRunId };
  }

  // ── 2. Declared-worktree ownership (three ordered gates, then identity) ───────────
  const declared = provenance.worktree;
  if (declared == null || declared === "") {
    return { ok: true, revision, cwd: rootDir, declaredWorktreeUnreliedUpon: false };
  }

  /*
  FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug) GATE 1 — lexical only.
  A hostile declared string (empty, relative, NUL/newline, whitespace-bearing) is rejected by pure
  string checks with ZERO filesystem access, so a crafted `task.worktree` can never make this pass
  probe, stat, or list an arbitrary path.
  */
  if (!isLexicallySafeAbsolutePath(declared)) return { ok: false, reason: "worktree_provenance_unsafe_path" };

  /*
  FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug) GATE 2 — resolve exactly once, validate THAT target.
  One canonicalization; the containment test and every later cwd use the same resolved target. The
  raw declared path is never a cwd after this point, which is what makes re-pointing the DECLARED
  ALIAS (a symlink at the declared location swapped for a different foreign target) inert: nothing
  consumes the alias any more. Replacing the CANONICAL TARGET DIRECTORY itself is a different, OS-level
  race that no string fence can prevent — Gate 3's per-command observation is what bounds it.
  */
  const resolvedPath = canonicalizeOnce(declared);
  if (opts.isOwnedWorktreePath) {
    let owned: boolean;
    try {
      owned = await opts.isOwnedWorktreePath(resolvedPath);
    } catch {
      return { ok: false, reason: "worktree_provenance_foreign_path" };
    }
    /*
    FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
    Containment rejection is a pure computation against this project's OWNED registry. Proving a path
    is foreign by inspecting the other project's tree would be a cross-project read; it is prohibited,
    and it is not needed.
    */
    if (!owned) return { ok: false, reason: "worktree_provenance_foreign_path" };
  }

  /*
  FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug) GATE 3 — observable per-command-boundary identity.
  The ROOT observation runs first: it proves the project repository identity that every later branch
  (worktree identity comparison AND the absent-worktree immutable-object fallback) reasons about.
  Because it is a real subprocess AT the resolved path, a canonical target that was deleted and
  replaced by a foreign-target symlink is detected here (different common dir) and fails closed with
  no probe commands executed.
  */
  const rootIdentity = await observeRepositoryIdentityDir(exec, rootDir, timeoutMs);
  if (!rootIdentity.ok) return { ok: false, reason: "provenance_git_error" };

  /*
  FNXC:GhostBugPreflight 2026-10-11-16:45 (GhostBug, review validation real-spawn counterexample):
  Presence is classified BEFORE ANY spawn at the resolved path. Ordering matters at the process level,
  not just logically: spawning at a nonexistent cwd fails ENOENT at the OS boundary, so an
  identity-check-first ordering mis-routes EVERY owned-but-absent worktree to `provenance_git_error`
  and makes the approved absent-worktree immutable-object fallback unreachable under the REAL probe
  exec (measured: operator RESULT.json 2026-10-11T16:32 — actual spawn ENOENT; only a mocked
  ProbeExec that ignores a nonexistent cwd could ever have passed the old order). The root identity
  above is verified at the project root and is the identity the fallback relies on; the absent
  directory itself is never a cwd. Absence, wrong-type, and unknown are distinct states: a
  positively-proven ENOENT may reach the fallback (never for a `baseline-head` revision — a baseline
  HEAD is a property of a checkout, so a baseline-sourced task with an absent declared worktree stays
  blocked); an existing non-directory is a contradiction (`worktree_provenance_conflict`); any other
  stat failure proves nothing (`worktree_provenance_unobservable`). None of these is permission to
  probe elsewhere, and none is silently treated as the others.
  */
  const presence = classifyWorktreePresence(resolvedPath);
  if (presence === "absent") {
    /*
    FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
    DECLARED-BUT-ABSENT worktree. Blocked by default, unless a supported identity rule independently
    proves the exact snapshot: a `task-branch` / `task-base-commit` revision is a commit OBJECT already
    proven to exist in the proven repository, so probing it needs no working tree at all. In that case
    probing proceeds against immutable commit objects only (at the proven project root), and
    `declaredWorktreeUnreliedUpon` records the explicit fixed explanation rather than silently
    skipping the ownership evidence.
    */
    if (revision.source === "baseline-head") return { ok: false, reason: "worktree_provenance_absent" };
    return { ok: true, revision, cwd: rootDir, declaredWorktreeUnreliedUpon: true };
  }
  if (presence === "non-directory") return { ok: false, reason: "worktree_provenance_conflict" };
  if (presence === "unknown") return { ok: false, reason: "worktree_provenance_unobservable" };

  const worktreeIdentity = await observeRepositoryIdentityDir(exec, resolvedPath, timeoutMs);
  if (!worktreeIdentity.ok) return { ok: false, reason: "provenance_git_error" };
  if (worktreeIdentity.commonDir !== rootIdentity.commonDir) {
    return { ok: false, reason: "worktree_provenance_repo_conflict" };
  }

  const headAtWorktree = await resolveCommitObjectAt(exec, resolvedPath, timeoutMs, "HEAD^{commit}");
  if (!headAtWorktree.ok) return { ok: false, reason: "worktree_provenance_conflict" };
  if (headAtWorktree.sha !== revision.sha) return { ok: false, reason: "worktree_provenance_conflict" };

  try {
    const status = await exec(["git", "status", "--porcelain"], { cwd: resolvedPath, timeoutMs });
    if (status.exitCode !== 0) return { ok: false, reason: "provenance_git_error" };
    if (status.stdout.trim().length > 0) return { ok: false, reason: "worktree_provenance_dirty" };
  } catch {
    return { ok: false, reason: "provenance_git_error" };
  }

  return { ok: true, revision, cwd: resolvedPath, declaredWorktreeUnreliedUpon: false, worktreeCwd: resolvedPath };
}

/*
FNXC:GhostBugPreflight 2026-10-11-17:05 (GhostBug, review validation personal-evidence counterexample):
THE GROUP-BOUNDARY FENCE IS THE PRODUCTION GUARD, NOT AN UNUSED HELPER. `assertWorktreeIdentityUnchanged`
below must run before EVERY command group that executes at a relied-upon declared worktree — the
negative probes, the positive control, and the destructive archive-boundary re-resolution. An
ownership check at resolution time alone proves nothing about a LATER phase: the operator's
deterministic counterexample resolved a genuine owned worktree, replaced that directory with a
symlinked foreign clone BETWEEN phases, and the old wiring ran `grep`, `ls-tree`, `show` and the
control grep inside the substitute and archived. Content commands are never dispatched past a failed
boundary; the honest residual remains the OS-level micro-window between a COMPLETED identity check
and the immediate next spawn at the identical cwd string (a deterministic between-phase swap is NOT
that window and is caught here).
*/
async function assertProbeGroupBoundary(
  exec: ProbeExec,
  target: { worktreeCwd?: string },
  opts: { rootDir: string; timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; reason: GhostBugUnverifiedReason }> {
  if (!target.worktreeCwd) return { ok: true };
  return assertWorktreeIdentityUnchanged(exec, {
    rootDir: opts.rootDir,
    worktreeCwd: target.worktreeCwd,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
 * The per-command-boundary identity re-check used before each later command group at the worktree
 * cwd. Deliberately a group-level check (not per-argv) with the residual stated honestly: a
 * canonical-target replacement landing BETWEEN this check and the next spawn at the identical cwd
 * string is an OS-level race that no string-level fence prevents — the OS then gives that child the
 * substituted target as its effective cwd. The enforced bound is: every command targets the resolved
 * owned path, every command GROUP has an observable repository-identity check, and any anomaly
 * (mismatch, git error, thrown exec) fails closed to a fixed unverified reason code.
 */
export async function assertWorktreeIdentityUnchanged(
  exec: ProbeExec,
  opts: { rootDir: string; worktreeCwd: string; timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; reason: GhostBugUnverifiedReason }> {
  const rootIdentity = await observeRepositoryIdentityDir(exec, opts.rootDir, opts.timeoutMs);
  if (!rootIdentity.ok) return { ok: false, reason: "provenance_git_error" };
  const worktreeIdentity = await observeRepositoryIdentityDir(exec, opts.worktreeCwd, opts.timeoutMs);
  if (!worktreeIdentity.ok) return { ok: false, reason: "provenance_git_error" };
  return worktreeIdentity.commonDir === rootIdentity.commonDir
    ? { ok: true }
    : { ok: false, reason: "worktree_provenance_repo_conflict" };
}

/**
 * FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
 * Re-resolve the branch target at a destructive boundary. A moved/removed ref after the initial
 * capture is the SAME-EPISODE target-loss signal (never an archive and never a release); a
 * re-resolve that itself errors is fail-closed, and the caller maps it to the same hold.
 */
export async function reResolveProbeRevision(
  revision: ResolvedProbeRevision,
  opts: { cwd: string; exec: ProbeExec; timeoutMs?: number },
): Promise<{ ok: true; sha: string } | { ok: false; reason: GhostBugUnverifiedReason }> {
  const spec = revision.refName ? `${revision.refName}^{commit}` : `${revision.sha}^{commit}`;
  const resolved = await resolveCommitObjectAt(opts.exec, opts.cwd, opts.timeoutMs, spec);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true, sha: resolved.sha };
}

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * `git grep` exits 0 on a hit and 1 on a clean "no match" — both are definitive. Any other exit code
 * (128 = not a repo / bad pathspec, etc.) is a probe failure, not evidence of absence, and a non-empty
 * stderr alongside exit 1 means the command errored rather than genuinely finding nothing.
 */
function classifyProbe(construct: CitedConstruct, result: ExecResult): GhostBugProbeResult {
  const output = truncateOutput(result.stdout);
  if (result.exitCode === 0) return { construct, matched: true, output };
  if (result.exitCode === 1 && result.stderr.trim().length === 0) return { construct, matched: false, output };
  return {
    construct,
    matched: false,
    output,
    probeError: result.exitCode === undefined ? "exit_code_unavailable" : "probe_command_failed",
  };
}

export interface ProbeRevisionContext {
  /**
   * The resolved proven revision to probe. ABSENT means the caller has NOT proven a target, and
   * `probeCitedConstructs` refuses to run: an unproven revision is precisely how a task's own
   * unmerged work used to be misread as a phantom bug.
   */
  revision?: ResolvedProbeRevision;
}

/** FNXC:GhostBugPreflight 2026-10-19-11:20: Probe each cited construct against the pinned revision with bounded diagnostics. */
export async function probeCitedConstructs(
  constructs: CitedConstruct[],
  opts: { cwd: string; timeoutMs?: number; exec: ProbeExec } & ProbeRevisionContext,
): Promise<GhostBugProbeResult[]> {
  const findings: GhostBugProbeResult[] = [];
  const timeoutMs = opts.timeoutMs ?? 5000;

  for (const construct of constructs) {
    if (construct.kind === "command") {
      /*
      FNXC:GhostBugPreflight 2026-09-17-00:00:
      A command citation is plan prose that merely LOOKS like a shell line (e.g. "pnpm test"). Running
      it would be an execution surface with no evidential value about whether the cited code exists,
      so command probes are never executed — they are always treated as non-definitive.
      */
      findings.push({ construct, matched: false, probeError: "command_probes_not_executed" });
      continue;
    }
    if (!isSafeRaw(construct.raw) || (construct.filePath !== undefined && !isSafeFilePath(construct.filePath))) {
      findings.push({ construct, matched: false, probeError: "unsafe_construct" });
      continue;
    }
    if (!opts.revision || !isHexCommitSha(opts.revision.sha)) {
      /*
      FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
      Fail-closed guard, not a fallback. Without a proven revision there is nothing defensible to
      probe, and "probe HEAD at the checkout root" is the reported defect. The caller resolves (and
      thereby proves) a revision before probing; a missing one here means that proof was skipped.
      */
      findings.push({ construct, matched: false, probeError: "revision_unproven" });
      continue;
    }

    /*
    FNXC:GhostBugPreflight 2026-09-17-00:00:
    Repository-wide (`:/`), not `packages/`-scoped: the original scope assumed every construct lives
    under `packages/`, which false-negatived (and thus falsely archived) tasks citing code elsewhere
    in the tree (docs, scripts, non-`packages/` workspaces).

    FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
    REVISION-SCOPED. The resolved sha is a positional revision argument before the `--` pathspec
    separator, so `git grep` reads that commit's TREES — never the working tree, never HEAD, never
    main. Same for the file probe (`<rev>:<path>`). The sha is the only interpolated value and it has
    passed the 40-64 hex shape check, so it cannot carry an option or a revision expression; the
    cited raw value stays discrete argv data.
    */
    const revision = opts.revision.sha;
    const argv = construct.kind === "identifier" && construct.filePath
      ? ["git", "cat-file", "-e", `${revision}:${construct.filePath}`]
      : ["git", "grep", "-qF", "-e", construct.raw, revision, "--", ":/"];
    try {
      findings.push(classifyProbe(construct, await opts.exec(argv, { cwd: opts.cwd, timeoutMs })));
    } catch (error) {
      findings.push({
        construct,
        matched: false,
        probeError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return findings;
}

export type ProbeControlOutcome = "matched" | "unmatched" | "unavailable";

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * Archiving work the engine just planned demands positive proof the probe apparatus itself works —
 * a worktree with a detached HEAD, a missing `.git`, or a `git` binary that silently no-ops would
 * otherwise make every construct look "missing" and archive perfectly valid tasks. Sample one line of
 * genuinely-tracked content and confirm the SAME probe path can re-find it before trusting an
 * all-missing verdict.
 */
export async function runProbePositiveControl(
  opts: { cwd: string; timeoutMs?: number; exec: ProbeExec } & ProbeRevisionContext,
): Promise<ProbeControlOutcome> {
  const revision = opts.revision?.sha;
  if (!revision || !isHexCommitSha(revision)) return "unavailable";
  const exec = (argv: string[]) => opts.exec(argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 5000 });
  try {
    /*
    FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
    The control must sample the SAME revision the probes read. `git ls-files` lists the INDEX of the
    current checkout, so a worktree-level control could match while the revision-scoped probes are
    broken (or vice versa) — the control then certifies a pipeline it never exercised. `ls-tree -r`
    of the resolved commit is the revision's own tree listing.
    */
    const files = await exec(["git", "ls-tree", "-r", "--name-only", revision]);
    if (files.exitCode !== 0) return "unavailable";
    const path = files.stdout.split("\n").map((entry) => entry.trim()).find((entry) => {
      const extension = entry.split(".").pop()?.toLowerCase();
      return Boolean(extension && TEXTISH_EXTENSIONS.has(extension) && isSafeFilePath(entry));
    });
    if (!path) return "unavailable";

    const source = await exec(["git", "show", `${revision}:${path}`]);
    if (source.exitCode !== 0) return "unavailable";
    const line = source.stdout.split("\n").map((entry) => entry.trim()).find((entry) => (
      entry.length >= 8 && entry.length <= MAX_CONSTRUCT_LENGTH && !/[\0\r]/.test(entry)
    ));
    if (!line) return "unavailable";

    const probe = await exec(["git", "grep", "-qF", "-e", line, revision, "--", ":/"]);
    if (probe.exitCode === 0) return "matched";
    return probe.exitCode === 1 && probe.stderr.trim().length === 0 ? "unmatched" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export type GhostBugPreflightOutcome =
  | { kind: "inapplicable"; reason: "not_bug_fix_shape" | "no_constructs" }
  | { kind: "target"; target: Extract<ProbeTargetResolution, { ok: true }> }
  | { kind: "decision"; decision: GhostBugDecision };

/**
 * Phase 1 of the preflight: the gates that need NO subprocess at all, then provenance/ownership
 * resolution. Split out from {@link runGhostBugPreflightAtTarget} so the caller can capture its
 * episode snapshot between "the target is proven" and "the probes run" without re-running the
 * inapplicable gates twice.
 */
export async function resolveGhostBugPreflightTarget(
  task: Pick<Task, "title" | "description">,
  prompt: string,
  provenance: GhostBugProvenanceInput,
  opts: {
    rootDir: string;
    exec: ProbeExec;
    resolvedForRunId: string;
    timeoutMs?: number;
    isOwnedWorktreePath?: (resolvedPath: string) => boolean | Promise<boolean>;
  },
): Promise<GhostBugPreflightOutcome> {
  if (!isBugFixShape({ title: task.title ?? null, description: task.description ?? "" })) {
    return { kind: "inapplicable", reason: "not_bug_fix_shape" };
  }

  const constructs = extractCitedConstructs(prompt);
  if (constructs.length === 0) {
    return { kind: "inapplicable", reason: "no_constructs" };
  }

  const target = await resolveProbeTarget(provenance, {
    rootDir: opts.rootDir,
    exec: opts.exec,
    resolvedForRunId: opts.resolvedForRunId,
    timeoutMs: opts.timeoutMs,
    isOwnedWorktreePath: opts.isOwnedWorktreePath,
  });
  if (!target.ok) return { kind: "decision", decision: { decision: "unverified", reason: target.reason, findings: [] } };

  return { kind: "target", target };
}

/**
 * Phase 2: run the revision-scoped probes and the revision-scoped positive control against a
 * target that phase 1 already proved. A definitive match anywhere is a `verified-present` PASS —
 * the corrected primary outcome. An incomplete or errored evidence set is `unverified`, never a pass.
 */
export async function runGhostBugPreflightAtTarget(
  constructs: CitedConstruct[],
  target: Extract<ProbeTargetResolution, { ok: true }>,
  opts: { timeoutMs?: number; exec: ProbeExec; rootDir: string },
): Promise<GhostBugDecision> {
  const { revision } = target;

  /*
  FNXC:GhostBugPreflight 2026-10-11-17:05 (GhostBug, review validation): GROUP BOUNDARY — probe content group.
  Fail closed BEFORE any content probing in a substituted foreign repository: no negative probe,
  no match, no missing, no control may be produced from a repository whose identity is not this
  project's. The reason stays a fixed enum code from the identity observation itself.
  */
  const probeBoundary = await assertProbeGroupBoundary(opts.exec, target, { rootDir: opts.rootDir, timeoutMs: opts.timeoutMs });
  if (!probeBoundary.ok) {
    return { decision: "unverified", reason: probeBoundary.reason, findings: [], revision };
  }

  const probeOpts = { cwd: target.cwd, timeoutMs: opts.timeoutMs, exec: opts.exec, revision };
  const findings = await probeCitedConstructs(constructs, probeOpts);
  const definitive = findings.filter((finding) => !finding.probeError);

  /*
  FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
  A definitive match releases normally — no archive, no hold, no pause. This is THE corrected outcome
  for the wrong-revision class: the cited construct exists on the task's own unmerged branch, so the
  card must go to execution. A match alongside probe errors is still a pass, because a pass takes no
  destructive action that the errored probes could have invalidated.
  */
  if (definitive.some((finding) => finding.matched)) {
    return { decision: "pass", reason: "construct_found_on_proven_revision", passKind: "verified-present", findings, revision };
  }

  /*
  FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
  Both former fail-open passes are reversed here. Partial evidence can NEVER be reduced to
  "all definitively missing": with one probe unexecuted or errored, the all-missing premise is
  unproven and archiving on it is how valid work is destroyed. So every non-match path that is not
  fully definitive is an explicit `unverified`.
  */
  if (definitive.length === 0) {
    return { decision: "unverified", reason: "probe_evidence_incomplete", findings, revision };
  }
  if (definitive.length !== findings.length) {
    return { decision: "unverified", reason: "probe_evidence_incomplete", findings, revision };
  }

  /*
  FNXC:GhostBugPreflight 2026-10-11-17:05 (GhostBug, review validation): GROUP BOUNDARY — positive-control group.
  The control is the LAST gate before a destructive archive; a substitution landing after the probe
  group must not get to certify the machinery from a foreign tree either. Findings gathered while
  identity still held are retained; the control simply does not run.
  */
  const controlBoundary = await assertProbeGroupBoundary(opts.exec, target, { rootDir: opts.rootDir, timeoutMs: opts.timeoutMs });
  if (!controlBoundary.ok) {
    return { decision: "unverified", reason: controlBoundary.reason, findings, revision };
  }

  const controlOutcome = await runProbePositiveControl(probeOpts);
  if (controlOutcome === "matched") {
    return { decision: "archive", reason: GHOST_BUG_ARCHIVE_REASON, findings, revision };
  }

  return {
    decision: "unverified",
    reason: "probe_control_failed",
    revision,
    findings: [...findings, {
      construct: { kind: "identifier", raw: "positive_control" },
      matched: false,
      probeError: `probe_control_${controlOutcome}`,
    }],
  };
}

/** Constructs cited by `prompt`, or `null` when the check does not apply to this task at all. */
export function ghostBugPreflightConstructs(prompt: string): CitedConstruct[] | null {
  const constructs = extractCitedConstructs(prompt);
  return constructs.length === 0 ? null : constructs;
}

/**
 * FNXC:GhostBugPreflight 2026-10-11-13:05 (GhostBug):
 * THE DETECTOR IS PRESERVED, NOT DISABLED: a bug-fix task whose cited constructs are genuinely
 * absent FROM THE TASK'S OWN PROVEN REVISION, with complete probe evidence and a revision-scoped
 * positive control that matches, is still stale bookkeeping and still legitimately archives. What
 * changed is (a) WHICH revision is authoritative and (b) an unprovable run is now an explicit
 * `unverified` hold rather than a silent release. This wrapper is the direct-call shape (resolve
 * then run); the production triage caller uses the two phases so it can bind its episode between them.
 */
export async function runGhostBugPreflight(
  task: Pick<Task, "title" | "description">,
  prompt: string,
  opts: {
    rootDir: string;
    cwd?: string;
    timeoutMs?: number;
    exec: ProbeExec;
    resolvedForRunId?: string;
    isOwnedWorktreePath?: (resolvedPath: string) => boolean | Promise<boolean>;
  } & GhostBugProvenanceInput,
): Promise<GhostBugDecision> {
  const outcome = await resolveGhostBugPreflightTarget(task, prompt, {
    branch: opts.branch,
    baseCommitSha: opts.baseCommitSha,
    worktree: opts.worktree,
  }, {
    rootDir: opts.rootDir,
    exec: opts.exec,
    resolvedForRunId: opts.resolvedForRunId ?? "direct-call",
    timeoutMs: opts.timeoutMs,
    isOwnedWorktreePath: opts.isOwnedWorktreePath,
  });
  if (outcome.kind === "inapplicable") {
    return { decision: "pass", reason: outcome.reason, passKind: "not-applicable", findings: [] };
  }
  if (outcome.kind === "decision") return outcome.decision;

  const constructs = ghostBugPreflightConstructs(prompt);
  if (!constructs) {
    return { decision: "pass", reason: "no_constructs", passKind: "not-applicable", findings: [] };
  }
  return runGhostBugPreflightAtTarget(constructs, outcome.target, {
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
    rootDir: opts.rootDir,
  });
}

/**
 * FNXC:GhostBugPreflight 2026-10-11-17:05 (GhostBug, review validation): GROUP BOUNDARY — the destructive
 * archive-boundary re-resolution. `reResolveProbeRevision` is raw commit resolution with no hidden
 * fence, so the identity observation runs HERE, at the production boundary, before any command at a
 * relied-upon worktree cwd — a substituted foreign repository can neither approve nor deny the
 * archive target.
 */
export async function reResolveProbeRevisionAtBoundary(
  revision: ResolvedProbeRevision,
  opts: {
    rootDir: string;
    exec: ProbeExec;
    timeoutMs?: number;
    /** The resolved command target — the cwd to resolve at and the worktree path to re-verify (if any). */
    target: { cwd: string; worktreeCwd?: string };
  },
): Promise<{ ok: true; sha: string } | { ok: false; reason: GhostBugUnverifiedReason }> {
  const boundary = await assertProbeGroupBoundary(opts.exec, opts.target, { rootDir: opts.rootDir, timeoutMs: opts.timeoutMs });
  if (!boundary.ok) return boundary;
  return reResolveProbeRevision(revision, { cwd: opts.target.cwd, exec: opts.exec, timeoutMs: opts.timeoutMs });
}
