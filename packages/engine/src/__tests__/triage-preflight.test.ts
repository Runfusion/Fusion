import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { createGhostBugProbeExec } from "../triage.js";
import {
  GHOST_BUG_ARCHIVE_REASON,
  classifyWorktreePresence,
  extractCitedConstructs,
  reResolveProbeRevisionAtBoundary,
  runGhostBugPreflightAtTarget,
  isBugFixShape,
  probeCitedConstructs,
  reResolveProbeRevision,
  resolveProbeTarget,
  resolveGhostBugPreflightTarget,
  runGhostBugPreflight,
  runProbePositiveControl,
  toSafeFullyQualifiedHeadRef,
  type GhostBugDecision,
} from "../triage-domain/triage-preflight.js";

const task = { title: "fix: typecheck error", description: "desc" };
const REVISION = { sha: "a".repeat(40), source: "task-branch" as const, refName: "refs/heads/fusion/T-1", resolvedForRunId: "run-1" };

/*
FNXC:GhostBugPreflight 2026-10-11-13:40 (GhostBug):
The preflight is revision-scoped now, so a fake git responder must answer PER REVISION rather than
per worktree. Keying on `argv[1]` alone (the pre-GhostBug shape) silently certified the old
checkout-root contract: `ls-files`/`show`/`grep` all read whatever happened to be checked out, so a
fixture could not express "absent on main, present on the unmerged branch" at all.
*/
interface FakeGitConfig {
  /** Fully-qualified ref name → commit sha. */
  refs?: Record<string, string>;
  /** Commit shas that exist as objects. Defaults to every sha mentioned in `refs`. */
  objects?: string[];
  /** Per-cwd `--git-common-dir` answer, keyed by the cwd the command actually ran in. */
  commonDirFor?: (cwd: string) => string | undefined;
  /** Per-cwd HEAD sha. */
  headFor?: (cwd: string) => string | undefined;
  /** Per-cwd `git status --porcelain` stdout. */
  statusFor?: (cwd: string) => string;
  /** Does the cited raw value exist at the given revision? */
  grep?: (raw: string, rev: string) => "hit" | "miss" | "error";
  /** Revision tree listing (for the positive control). */
  tree?: string[];
  /** Content served for `<rev>:<path>`. */
  show?: string;
  /** Files whose `<rev>:<path>` object exists (the file-existence probe). */
  blobPaths?: string[];
}

const DEFAULT_COMMON_DIR = "/repo/.git";

function fakeGit(config: FakeGitConfig) {
  const calls: { argv: string[]; cwd?: string }[] = [];
  const objects = new Set(config.objects ?? Object.values(config.refs ?? {}));

  const exec = async (argv: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    calls.push({ argv, cwd: options?.cwd });
    const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
    const miss = () => ({ stdout: "", stderr: "", exitCode: 1 });
    const err = (stderr = "fatal") => ({ stdout: "", stderr, exitCode: 128 });

    switch (argv[1]) {
      case "for-each-ref": {
        const refName = argv[3];
        const listed = Object.entries(config.refs ?? {}).filter(([name]) => name === refName || name.startsWith(`${refName}/`));
        return ok(listed.map(([name, sha]) => `${name} ${sha}`).join("\n"));
      }
      case "rev-parse": {
        const spec = argv[2] ?? "";
        if (spec === "--git-common-dir") {
          const cwd = options?.cwd ?? "";
          return ok(config.commonDirFor ? (config.commonDirFor(cwd) ?? "") : DEFAULT_COMMON_DIR);
        }
        if (spec === "HEAD^{commit}") {
          const sha = config.headFor?.(options?.cwd ?? "");
          return sha && objects.has(sha) ? ok(sha) : err();
        }
        /*
        Rev-parse answers the NAMING question only; `cat-file -e` is what proves the object exists.
        Folding the object check in here would make `revision_missing_object` unreachable, which is
        exactly the state a caller must be able to distinguish from "no such ref".
        */
        const bare = spec.replace(/\^\{commit\}$/, "");
        const sha = config.refs?.[bare] ?? (/^[0-9a-f]{40,64}$/.test(bare) ? bare : undefined);
        return sha ? ok(sha) : err();
      }
      case "cat-file": {
        const target = argv[3] ?? "";
        if (target.endsWith("^{commit}")) return objects.has(target.slice(0, -"^{commit}".length)) ? ok() : miss();
        return (config.blobPaths ?? []).includes(target.split(":").slice(1).join(":")) ? ok() : miss();
      }
      case "status":
        return ok(config.statusFor?.(options?.cwd ?? "") ?? "");
      case "ls-tree":
        return ok((config.tree ?? []).join("\n"));
      case "show":
        return config.show !== undefined ? ok(config.show) : miss();
      case "grep": {
        const raw = argv[4] ?? "";
        const rev = argv[5] ?? "";
        const verdict = config.grep?.(raw, rev) ?? "miss";
        if (verdict === "hit") return ok(`src/a.ts:1:${raw}`);
        return verdict === "error" ? err() : miss();
      }
      default:
        return err("unsupported");
    }
  };
  return { exec, calls };
}

/** The minimum fake that resolves a task branch and passes ownership with no worktree declared. */
function branchOnly(config: FakeGitConfig = {}) {
  return fakeGit({
    refs: { "refs/heads/fusion/T-1": REVISION.sha },
    grep: () => "miss",
    tree: ["src/App.ts"],
    show: "export const knownControl = true;",
    ...config,
  });
}

const provenance = { branch: "fusion/T-1" };

function preflight(
  git: ReturnType<typeof fakeGit>,
  prompt = "`foo_bar`",
  overrides: Record<string, unknown> = {},
): Promise<GhostBugDecision> {
  return runGhostBugPreflight(task, prompt, {
    rootDir: "/repo",
    exec: git.exec,
    resolvedForRunId: REVISION.resolvedForRunId,
    ...provenance,
    ...overrides,
  });
}

describe("triage-preflight", () => {
  /* ── pure extraction / shape gates (unchanged contracts) ───────────────────── */

  it("isBugFixShape matrix", () => {
    expect(isBugFixShape({ title: "fix: broken typecheck", description: "x" })).toBe(true);
    expect(isBugFixShape({ title: "chore", description: "compile error appears" })).toBe(true);
    expect(isBugFixShape({ title: "refactor", description: "cleanup" })).toBe(false);
    expect(isBugFixShape({ title: null, description: "" })).toBe(false);
  });

  it("extracts constructs and dedupes", () => {
    const prompt = [
      "Use `secrets_sync.handle()` and `foo_bar` in packages/core/src/secrets-sync.ts:12",
      "```ts",
      "import { x } from 'y'",
      "const a = b",
      "```",
      "pnpm --filter @fusion/core test",
      "pnpm --filter @fusion/core test",
    ].join("\n");

    const constructs = extractCitedConstructs(prompt);
    expect(constructs.some((c) => c.kind === "identifier" && c.raw === "secrets_sync.handle()")).toBe(true);
    expect(constructs.some((c) => c.filePath === "packages/core/src/secrets-sync.ts" && c.line === 12)).toBe(true);
    expect(constructs.some((c) => c.kind === "snippet" && c.raw.includes("import"))).toBe(true);
    expect(constructs.filter((c) => c.kind === "command")).toHaveLength(1);
  });

  it("caps extracted constructs at 20", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `\`value_${i}.x\``).join("\n");
    expect(extractCitedConstructs(lines)).toHaveLength(20);
  });

  it("skips the subprocesses entirely for a non bug-shape task and for no constructs", async () => {
    const git = branchOnly();
    const notBug = await runGhostBugPreflight({ title: "docs", description: "desc" }, "`foo_bar`", {
      rootDir: "/repo", exec: git.exec, ...provenance,
    });
    expect(notBug).toMatchObject({ decision: "pass", passKind: "not-applicable", reason: "not_bug_fix_shape" });
    expect(git.calls).toEqual([]);

    const noConstructs = await runGhostBugPreflight(task, "nothing citable here", {
      rootDir: "/repo", exec: git.exec, ...provenance,
    });
    expect(noConstructs).toMatchObject({ decision: "pass", passKind: "not-applicable", reason: "no_constructs" });
    expect(git.calls).toEqual([]);
  });

  /* ── argv safety (unchanged contracts, revision-scoped shapes) ─────────────── */

  it("uses shell-free repository-wide argv at the RESOLVED revision, never a packages/-scoped shell string", async () => {
    const git = branchOnly({ grep: () => "hit" });
    const decision = await preflight(git, "`Task.CompletedTask`");
    expect(decision).toMatchObject({ decision: "pass", passKind: "verified-present", reason: "construct_found_on_proven_revision" });

    const greps = git.calls.filter(({ argv }) => argv[1] === "grep");
    expect(greps.length).toBeGreaterThan(0);
    for (const { argv } of greps) {
      // The revision is a discrete positional element BEFORE the `--` pathspec separator, and every
      // argv entry is discrete data — nothing shell-interpolated could smuggle a pipe or subshell.
      expect(argv.slice(0, 6)).toEqual(["git", "grep", "-nF", "-e", expect.any(String), REVISION.sha]);
      expect(argv[6]).toBe("--");
      expect(argv.join(" ")).not.toMatch(/packages\/|\|\| true|\||&&|;|\$\(/);
    }
  });

  it("classifies exit codes and never treats stderr output as a match", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: "hit", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "fatal: bad pathspec", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "fatal", exitCode: 128 })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const findings = await probeCitedConstructs([
      { kind: "identifier", raw: "found_item" },
      { kind: "identifier", raw: "missing_item" },
      { kind: "snippet", raw: "bad pathspec" },
      { kind: "snippet", raw: "not a repository" },
      { kind: "snippet", raw: "legacy result" },
    ], { cwd: "/repo", exec, revision: REVISION });
    expect(findings.map(({ matched, probeError }) => ({ matched, probeError }))).toEqual([
      { matched: true, probeError: undefined },
      { matched: false, probeError: undefined },
      { matched: false, probeError: "probe_command_failed" },
      { matched: false, probeError: "probe_command_failed" },
      { matched: false, probeError: "exit_code_unavailable" },
    ]);
  });

  it("refuses to probe at all without a proven revision — the main-fallback defect stays closed", async () => {
    const exec = vi.fn();
    const findings = await probeCitedConstructs([{ kind: "identifier", raw: "foo_bar" }], { cwd: "/repo", exec });
    expect(findings[0]).toMatchObject({ matched: false, probeError: "revision_unproven" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("never executes command citations and reports them as incomplete evidence, not as a pass", async () => {
    const git = branchOnly();
    const decision = await preflight(git, "pnpm dangerous");
    expect(decision).toMatchObject({ decision: "unverified", reason: "probe_evidence_incomplete" });
    expect(git.calls.filter(({ argv }) => argv[1] === "grep")).toEqual([]);
  });

  it("keeps a leading-dash raw value as pure data and refuses genuinely unsafe values without executing", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });
    const leadingDash = await probeCitedConstructs([{ kind: "snippet", raw: "-not-an-option" }], { cwd: "/repo", exec, revision: REVISION });
    expect(leadingDash[0].probeError).toBeUndefined();
    expect(exec.mock.calls[0][0].slice(0, 7)).toEqual(["git", "grep", "-nF", "-e", "-not-an-option", REVISION.sha, "--"]);
    exec.mockClear();
    const unsafe = await probeCitedConstructs([
      { kind: "snippet", raw: "bad\ninput" },
      { kind: "identifier", raw: "file", filePath: "src/../secret.ts" },
    ], { cwd: "/repo", exec, revision: REVISION });
    expect(unsafe.every((finding) => finding.probeError === "unsafe_construct")).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("truncates oversized stdout before retaining a finding", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "x".repeat(200 * 1024), stderr: "", exitCode: 0 });
    const [finding] = await probeCitedConstructs([{ kind: "identifier", raw: "large_output" }], { cwd: "/repo", exec, revision: REVISION });
    expect(finding.output).toHaveLength(512);
    expect(finding.output?.endsWith("…[truncated]")).toBe(true);
  });

  /* ── revision precedence (GhostBug) ─────────────────────────────────────────── */

  it("resolves a task branch to its exact fully-qualified local head tip", async () => {
    const git = branchOnly();
    const decision = await preflight(git, "`foo_bar`", { worktree: null });
    expect(decision.revision).toMatchObject({
      sha: REVISION.sha,
      source: "task-branch",
      refName: "refs/heads/fusion/T-1",
      resolvedForRunId: "run-1",
    });
    const forEachRef = git.calls.find(({ argv }) => argv[1] === "for-each-ref")!;
    expect(forEachRef.argv).toEqual(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/fusion/T-1"]);
    // Never a bare prefix/namespace lookup that could resolve a remote or tag instead.
    expect(git.calls.some(({ argv }) => argv[1] === "rev-parse" && argv[2] === "fusion/T-1")).toBe(false);
  });

  it("refuses an unsafe or option-looking branch value WITHOUT invoking git", async () => {
    /*
    FNXC:GhostBugPreflight 2026-10-11-14:10 (GhostBug):
    No empty string here on purpose: an ABSENT branch is "this task has no branch", which the
    precedence table handles by falling through to the recorded base commit / proven baseline. Only a
    branch VALUE that is present but unusable is `revision_unsafe_ref`.
    */
    for (const branch of ["-b", "--help", "feat ual", "refs/heads/..", "a\nb", "refs/heads/x.lock", ".hidden", "a//b", "refs/heads/", "~head"]) {
      const git = branchOnly();
      const decision = await preflight(git, "`foo_bar`", { branch });
      expect(decision, branch).toMatchObject({ decision: "unverified", reason: "revision_unsafe_ref" });
      expect(toSafeFullyQualifiedHeadRef(branch), branch).toBeNull();
      expect(git.calls.filter(({ argv }) => argv[1] === "for-each-ref"), branch).toEqual([]);
    }
    expect(toSafeFullyQualifiedHeadRef("refs/heads/fusion/T-1")).toBe("refs/heads/fusion/T-1");
    expect(toSafeFullyQualifiedHeadRef("fusion/T-1")).toBe("refs/heads/fusion/T-1");
  });

  it("maps zero ref matches to revision_unresolved rather than falling back to main", async () => {
    const git = fakeGit({ refs: {}, grep: () => "miss" });
    const decision = await preflight(git);
    expect(decision).toMatchObject({ decision: "unverified", reason: "revision_unresolved" });
    // The whole point: no grep is issued at any revision, so nothing can be "proven missing" on main.
    expect(git.calls.filter(({ argv }) => argv[1] === "grep")).toEqual([]);
  });

  it("maps a namespace ambiguity (exact ref alongside nested refs) to revision_ambiguous", async () => {
    const git = fakeGit({
      refs: { "refs/heads/fusion/T-1": REVISION.sha, "refs/heads/fusion/T-1/nested": "b".repeat(40) },
      grep: () => "miss",
    });
    expect(await preflight(git)).toMatchObject({ decision: "unverified", reason: "revision_ambiguous" });
  });

  it("reports revision_missing_object when the resolved sha has no commit object", async () => {
    const git = fakeGit({ refs: { "refs/heads/fusion/T-1": REVISION.sha }, objects: [], grep: () => "miss" });
    expect(await preflight(git)).toMatchObject({ decision: "unverified", reason: "revision_missing_object" });
  });

  it("prefers a recorded base commit over the baseline and validates its shape and existence", async () => {
    const base = "c".repeat(40);
    const ok = fakeGit({
      refs: {},
      objects: [base],
      grep: (raw) => (raw === "export const knownControl = true;" ? "hit" : "miss"),
      tree: ["src/App.ts"],
      show: "export const knownControl = true;",
    });
    const resolved = await runGhostBugPreflight(task, "`foo_bar`", {
      rootDir: "/repo", exec: ok.exec, baseCommitSha: base,
    });
    // Base commit chosen over the baseline, and the detector still reaches its legitimate archive on
    // complete evidence: an existing recorded base is NOT itself a blocker.
    expect(resolved).toMatchObject({ decision: "archive", revision: { source: "task-base-commit", sha: base } });

    const malformed = branchOnly();
    expect(await preflight(malformed, "`foo_bar`", { branch: null, baseCommitSha: "not-a-sha" }))
      .toMatchObject({ decision: "unverified", reason: "task_base_commit_invalid" });

    const missing = fakeGit({ refs: {}, objects: [], grep: () => "miss" });
    expect(await runGhostBugPreflight(task, "`foo_bar`", { rootDir: "/repo", exec: missing.exec, baseCommitSha: base }))
      .toMatchObject({ decision: "unverified", reason: "task_base_commit_invalid" });
  });

  it("proves the baseline identity for a never-executed task and refuses an unproven repository", async () => {
    const baseline = "d".repeat(40);
    const ok = fakeGit({
      refs: {}, objects: [baseline], headFor: () => baseline,
      grep: () => "miss", tree: ["src/App.ts"], show: "export const knownControl = true;",
    });
    const decision = await runGhostBugPreflight(task, "`foo_bar`", { rootDir: "/repo", exec: ok.exec });
    expect(decision).toMatchObject({ revision: { source: "baseline-head", sha: baseline } });
    // The repository-identity proof runs BEFORE HEAD is trusted.
    expect(ok.calls[0]?.argv).toEqual(["git", "rev-parse", "--git-common-dir"]);

    const notARepo = fakeGit({ refs: {}, commonDirFor: () => undefined, grep: () => "miss" });
    expect(await runGhostBugPreflight(task, "`foo_bar`", { rootDir: "/repo", exec: notARepo.exec }))
      .toMatchObject({ decision: "unverified", reason: "baseline_unproven" });
  });

  /* ── worktree ownership gates (GhostBug) ────────────────────────────────────── */

  it("Gate 1: rejects an unsafe declared path with pure string checks and ZERO filesystem or containment access", async () => {
    for (const worktree of ["relative/dir", "/has space/dir", "/nul\0dir", "/trailing space/", "\n/etc"]) {
      const git = branchOnly();
      const decision = await preflight(git, "`foo_bar`", {
        worktree,
        isOwnedWorktreePath: () => { throw new Error("containment must not be consulted for a lexical rejection"); },
      });
      expect(decision, worktree).toMatchObject({ decision: "unverified", reason: "worktree_provenance_unsafe_path" });
      // Rejected before the filesystem: the only commands ever taken belong to provenance at the root.
      expect(git.calls.every(({ cwd }) => cwd === "/repo"), worktree).toBe(true);
    }

    // An EMPTY declared value is "no worktree recorded" (a cleared field), which is a different state
    // from a hostile one: it proceeds against the proven revision at the project root.
    const cleared = branchOnly({ grep: () => "hit" });
    expect(await preflight(cleared, "`foo_bar`", { worktree: "" }))
      .toMatchObject({ decision: "pass", passKind: "verified-present" });
  });

  it("Gate 2: rejects a non-contained resolved worktree and never runs a command outside the owned roots", async () => {
    const git = branchOnly();
    const decision = await preflight(git, "`foo_bar`", {
      worktree: "/elsewhere/project/.fusion/worktrees/t1",
      isOwnedWorktreePath: () => false,
    });
    expect(decision).toMatchObject({ decision: "unverified", reason: "worktree_provenance_foreign_path" });
    // Proving "foreign" is a pure computation against the OWNED registry: no command is ever issued
    // at the foreign path, so another project's tree is never inspected.
    expect(git.calls.filter(({ argv }) => argv[1] === "grep")).toEqual([]);
    expect(git.calls.every(({ cwd }) => cwd === "/repo")).toBe(true);
  });

  it("Gate 2: a re-pointed declared ALIAS is inert because only the resolved target is consumed", async () => {
    const roots: string[] = [];
    try {
      const root = await mkdtemp(join(tmpdir(), "fusion-ghost-alias-"));
      roots.push(root);
      const owned = join(root, "worktrees", "T-1");
      const foreign = join(root, "foreign");
      await mkdir(owned, { recursive: true });
      await mkdir(join(foreign, ".git"), { recursive: true });
      const alias = join(root, "worktrees", "alias");
      await symlink(owned, alias, process.platform === "win32" ? "junction" : "dir");

      const git = branchOnly({
        commonDirFor: () => join(root, ".git"),
        headFor: (cwd) => (cwd === owned ? REVISION.sha : undefined),
        grep: () => "hit",
      });
      const ownedCwds = new Set<string>();
      const decision = await runGhostBugPreflight(task, "`foo_bar`", {
        rootDir: root,
        exec: async (argv, options) => {
          const cwd = options?.cwd;
          if (cwd) ownedCwds.add(cwd);
          return git.exec(argv, options);
        },
        branch: "fusion/T-1",
        worktree: alias,
        isOwnedWorktreePath: (candidate) => candidate === owned || candidate === join(root, "worktrees"),
      });

      // Re-point the DECLARED ALIAS at the foreign directory after resolution.
      await rm(alias, { force: true });
      await symlink(foreign, alias, process.platform === "win32" ? "junction" : "dir");
      for (const { argv } of git.calls) expect(argv[0]).toBe("git");
      // Every observed cwd is the resolved owned target — never the (now-foreign) alias path.
      expect([...ownedCwds].every((cwd) => cwd !== alias)).toBe(true);
      expect(decision).toMatchObject({ decision: "pass", passKind: "verified-present" });
    } finally {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  /*
  FNXC:GhostBugPreflight 2026-10-11-14:05 (GhostBug):
  The ownership gates inspect the FILESYSTEM (`statSync` on the resolved target), so these fixtures
  use REAL temp directories rather than a synthetic path string. A fake-cwd fixture cannot express
  "the resolved target exists" at all, and an absent-path fixture silently turns every ownership test
  into the declared-but-absent branch.
  */
  describe("with a real owned worktree directory", () => {
    let root = "";
    let owned = "";

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "fusion-ghost-own-")));
      owned = join(root, ".fusion", "worktrees", "T-1");
      await mkdir(owned, { recursive: true });
    });
    afterEach(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });

    /** The shared-repository wiring: every cwd reports the SAME common dir, HEAD matches the revision. */
    const ownedGit = (overrides: Partial<FakeGitConfig> = {}) => branchOnly({
      commonDirFor: () => join(root, ".git"),
      headFor: (cwd) => (cwd === owned ? REVISION.sha : undefined),
      ...overrides,
    });

    it("probes at the resolved owned worktree once every gate passes", async () => {
      const git = ownedGit({ grep: () => "hit" });
      const decision = await preflight(git, "`foo_bar`", {
        worktree: owned,
        isOwnedWorktreePath: () => true,
      });
      expect(decision).toMatchObject({ decision: "pass", passKind: "verified-present" });
      expect(git.calls.filter(({ cwd }) => cwd === owned).length).toBeGreaterThan(0);
    });

    it("Gate 3: a Git common-dir mismatch fails closed with NO probe commands executed", async () => {
      const foreignCommonDir = join(root, "foreign-git");
      const git = ownedGit({ commonDirFor: (cwd) => (cwd === owned ? foreignCommonDir : join(root, ".git")) });
      const decision = await preflight(git, "`foo_bar`", { worktree: owned, isOwnedWorktreePath: () => true });
      expect(decision).toMatchObject({ decision: "unverified", reason: "worktree_provenance_repo_conflict" });
      expect(git.calls.filter(({ argv }) => argv[1] === "grep")).toEqual([]);
    });

    it("detects a HEAD-conflicting worktree", async () => {
      const git = ownedGit({ headFor: () => "e".repeat(40), objects: ["e".repeat(40), REVISION.sha] });
      expect(await preflight(git, "`foo_bar`", { worktree: owned, isOwnedWorktreePath: () => true }))
        .toMatchObject({ decision: "unverified", reason: "worktree_provenance_conflict" });
    });

    it("detects a dirty worktree", async () => {
      const git = ownedGit({ statusFor: (cwd) => (cwd === owned ? " M src/App.ts" : "") });
      expect(await preflight(git, "`foo_bar`", { worktree: owned, isOwnedWorktreePath: () => true }))
        .toMatchObject({ decision: "unverified", reason: "worktree_provenance_dirty" });
    });

    it("blocks a declared-but-absent worktree unless an immutable commit object independently proves the snapshot", async () => {
      const absent = join(root, ".fusion", "worktrees", "gone");

      /*
      FNXC:GhostBugPreflight 2026-10-11-14:05 (GhostBug):
      Baseline-sourced with an absent worktree is the BLOCKED case: a baseline HEAD is a property of
      the checkout, not a task-specific snapshot proof, so nothing independently identifies the exact
      task snapshot and an absent worktree leaves no way to check it.
      */
      const baseline = "d".repeat(40);
      const blocked = fakeGit({
        refs: {}, objects: [baseline],
        commonDirFor: () => join(root, ".git"),
        headFor: () => baseline,
        grep: () => "miss",
      });
      expect(await runGhostBugPreflight(task, "`foo_bar`", {
        rootDir: root, exec: blocked.exec, worktree: absent, isOwnedWorktreePath: () => true,
      })).toMatchObject({ decision: "unverified", reason: "worktree_provenance_absent" });

      // A proven branch-tip commit OBJECT needs no working tree: probing proceeds against immutable
      // objects, and the resolution records that the absent worktree is NOT relied upon.
      const proven = ownedGit({ grep: () => "hit" });
      const target = await resolveProbeTarget({ branch: "fusion/T-1", worktree: absent }, {
        rootDir: root,
        exec: proven.exec,
        resolvedForRunId: "run-absent",
        isOwnedWorktreePath: () => true,
      });
      expect(target).toMatchObject({ ok: true, cwd: root, declaredWorktreeUnreliedUpon: true });
    });
  });

  /*
  FNXC:GhostBugPreflightTest 2026-10-11-16:50 (GhostBug, review validation personal-evidence counterexample):
  REAL-spawn ownership regressions. A prior revision of these gates ran the repository-identity
  observation BEFORE the presence check, and a real spawn at a nonexistent cwd fails ENOENT at the
  OS boundary — so the approved absent-worktree immutable-object fallback was UNREACHABLE under the
  production exec, and only a mocked ProbeExec that answers at missing cwds could ever have passed
  it. These fixtures therefore use a REAL repository and the REAL default spawn adapter: an `ok:true`
  from a fake that ignores a nonexistent cwd proves nothing here, and the positive resolutions below
  are themselves the proof that no command is ever spawned at the absent path.
  */
  describe("real-spawn ownership regressions via the production exec (review validation)", () => {
    let root = "";
    let baselineSha = "";

    const gitSetup = (args: string[], cwd?: string) => execFileSync("git", args, { cwd: cwd ?? root, encoding: "utf8" }).trim();

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "fusion-ghost-real-")));
      gitSetup(["init", "-b", "main"]);
      gitSetup(["config", "user.email", "zp-002@example.invalid"]);
      gitSetup(["config", "user.name", "GhostBug"]);
      // `.py` (not `.txt`): the positive control only samples TEXTISH_EXTENSIONS files, and the
      // legitimate-archive regression below needs the control to genuinely match on real git.
      await writeFile(join(root, "src.py"), "baseline_value = 1\n");
      gitSetup(["add", "."]);
      gitSetup(["commit", "-m", "baseline"]);
      baselineSha = gitSetup(["rev-parse", "HEAD^{commit}"]);
      gitSetup(["checkout", "-b", "fusion/T-1"]);
      await writeFile(join(root, "ghost.py"), "ghost_target_fn = 1\n");
      gitSetup(["add", "."]);
      gitSetup(["commit", "-m", "branch work"]);
      // Back on main, matching the reported incident shape: the checkout root sits on the WRONG
      // revision while the task's own branch carries the cited construct.
      gitSetup(["checkout", "main"]);
    });
    afterEach(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });

    const ownedWorktreesRoot = () => join(root, ".fusion", "worktrees");
    const isOwned = (candidate: string) => candidate === ownedWorktreesRoot() || candidate.startsWith(`${ownedWorktreesRoot()}${sep}`);

    it("positive rule: a proven task branch with an absent owned worktree resolves to immutable objects at the proven root", async () => {
      const target = await resolveProbeTarget(
        { branch: "fusion/T-1", worktree: join(ownedWorktreesRoot(), "gone") },
        { rootDir: root, exec: createGhostBugProbeExec(), resolvedForRunId: "run-real-branch-absent", isOwnedWorktreePath: isOwned },
      );
      expect(target.ok).toBe(true);
      if (target.ok) {
        expect(target.cwd).toBe(root);
        expect(target.declaredWorktreeUnreliedUpon).toBe(true);
        expect(target.revision.source).toBe("task-branch");
        expect(target.revision.sha).toMatch(/^[0-9a-f]{40,64}$/);
      }
    });

    it("positive rule: a recorded base commit with an absent owned worktree resolves against the proven object", async () => {
      const target = await resolveProbeTarget(
        { baseCommitSha: baselineSha, worktree: join(ownedWorktreesRoot(), "gone") },
        { rootDir: root, exec: createGhostBugProbeExec(), resolvedForRunId: "run-real-base-absent", isOwnedWorktreePath: isOwned },
      );
      expect(target).toMatchObject({ ok: true, cwd: root, declaredWorktreeUnreliedUpon: true, revision: { source: "task-base-commit", sha: baselineSha } });
    });

    it("control: a baseline-sourced task with an absent declared worktree still blocks", async () => {
      const target = await resolveProbeTarget(
        { worktree: join(ownedWorktreesRoot(), "gone") },
        { rootDir: root, exec: createGhostBugProbeExec(), resolvedForRunId: "run-real-baseline-absent", isOwnedWorktreePath: isOwned },
      );
      expect(target).toEqual({ ok: false, reason: "worktree_provenance_absent" });
    });

    it("control: an existing NON-directory at the owned path is a contradiction, never the absent fallback", async () => {
      await mkdir(ownedWorktreesRoot(), { recursive: true });
      const asFile = join(ownedWorktreesRoot(), "as-file");
      await writeFile(asFile, "not a directory\n");
      const target = await resolveProbeTarget(
        { branch: "fusion/T-1", worktree: asFile },
        { rootDir: root, exec: createGhostBugProbeExec(), resolvedForRunId: "run-real-wrong-type", isOwnedWorktreePath: isOwned },
      );
      expect(target).toEqual({ ok: false, reason: "worktree_provenance_conflict" });
    });

    // Windows chmod does not implement POSIX directory traversal permissions. Error-code
    // classification is covered independently by the injectable stat tests on every platform.
    it.skipIf(process.platform === "win32")("control: a permission-opaque path is UNOBSERVABLE — never conflated with absence", async () => {
      await mkdir(ownedWorktreesRoot(), { recursive: true });
      const blocked = join(ownedWorktreesRoot(), "blocked");
      await mkdir(blocked);
      await chmod(blocked, 0o000);
      try {
        const target = await resolveProbeTarget(
          { branch: "fusion/T-1", worktree: join(blocked, "inside") },
          { rootDir: root, exec: createGhostBugProbeExec(), resolvedForRunId: "run-real-eacces", isOwnedWorktreePath: isOwned },
        );
        expect(target).toEqual({ ok: false, reason: "worktree_provenance_unobservable" });
      } finally {
        await chmod(blocked, 0o755);
      }
    });

    it("control: a foreign declared path is rejected by the owned registry with zero commands at that path", async () => {
      const foreign = await realpath(await mkdtemp(join(tmpdir(), "fusion-ghost-foreign-")));
      try {
        const cwds: string[] = [];
        const production = createGhostBugProbeExec();
        const target = await resolveProbeTarget(
          { branch: "fusion/T-1", worktree: foreign },
          {
            rootDir: root,
            exec: async (argv, options) => {
              if (options?.cwd) cwds.push(options.cwd);
              return production(argv, options);
            },
            resolvedForRunId: "run-real-foreign",
            isOwnedWorktreePath: isOwned,
          },
        );
        expect(target).toEqual({ ok: false, reason: "worktree_provenance_foreign_path" });
        expect(cwds.every((cwd) => cwd === root)).toBe(true);
      } finally {
        await rm(foreign, { recursive: true, force: true });
      }
    });

    it("an EXISTING owned worktree keeps the real identity, exact-HEAD, and dirty guards under real spawns", async () => {
      await mkdir(ownedWorktreesRoot(), { recursive: true });
      const wt = join(ownedWorktreesRoot(), "T-1");
      gitSetup(["worktree", "add", wt, "fusion/T-1"]);
      const target = await resolveProbeTarget(
        { branch: "fusion/T-1", worktree: wt },
        { rootDir: root, exec: createGhostBugProbeExec(), resolvedForRunId: "run-real-wt", isOwnedWorktreePath: isOwned },
      );
      // Real linked-worktree wiring: shared common dir, HEAD exactly at the branch tip, clean.
      expect(target.ok).toBe(true);
      if (target.ok) {
        expect(target.cwd).toBe(await realpath(wt));
        expect(target.declaredWorktreeUnreliedUpon).toBe(false);
      }

      // Dirty guard: one untracked file, and the same pass must now refuse the working tree.
      await writeFile(join(wt, "dirty.txt"), "x\n");
      const dirty = await resolveProbeTarget(
        { branch: "fusion/T-1", worktree: wt },
        { rootDir: root, exec: createGhostBugProbeExec(), resolvedForRunId: "run-real-wt-dirty", isOwnedWorktreePath: isOwned },
      );
      expect(dirty).toEqual({ ok: false, reason: "worktree_provenance_dirty" });

      // Contradictory-identity guard: a SEPARATE real repository at an owned-looking path never
      // passes as this project's worktree (its common dir genuinely differs).
      const imposter = join(ownedWorktreesRoot(), "imposter");
      gitSetup(["init", imposter]);
      const conflict = await resolveProbeTarget(
        { branch: "fusion/T-1", worktree: imposter },
        { rootDir: root, exec: createGhostBugProbeExec(), resolvedForRunId: "run-real-wt-conflict", isOwnedWorktreePath: isOwned },
      );
      expect(conflict).toEqual({ ok: false, reason: "worktree_provenance_repo_conflict" });
    });

    it("classifies presence states without conflating them", () => {
      expect(classifyWorktreePresence("/any", () => ({ isDirectory: () => true }))).toBe("directory");
      expect(classifyWorktreePresence("/any", () => ({ isDirectory: () => false }))).toBe("non-directory");
      expect(classifyWorktreePresence("/any", () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); })).toBe("absent");
      expect(classifyWorktreePresence("/any", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); })).toBe("unknown");
      expect(classifyWorktreePresence("/any", () => { throw new Error("bare"); })).toBe("unknown");
    });

    /*
    FNXC:GhostBugPreflightTest 2026-10-11-17:20 (GhostBug, review validation personal production review):
    THE GROUP-BOUNDARY IDENTITY FENCE IS PROVEN ON THE PRODUCTION PATH, NOT ON AN UNUSED HELPER.
    Each case below first resolves a GENUINE owned linked worktree, then performs a DETERMINISTIC
    between-phase replacement of that owned directory with a symlink to a real clone of the SAME
    repository (intentionally the same commit bytes — this proves a repository-provenance violation,
    not a content difference). A cwd-string spy cannot prove a child process did not run in the
    substitute, so the assertions are about which COMMANDS the real adapter actually executed.
    */

    /** Create the genuine owned linked worktree at the branch tip. */
    async function addOwnedWorktree(): Promise<string> {
      await mkdir(ownedWorktreesRoot(), { recursive: true });
      const wt = join(ownedWorktreesRoot(), "T-1");
      gitSetup(["worktree", "add", wt, "fusion/T-1"]);
      return wt;
    }

    /**
     * Deterministic phase-replacement: delete the owned worktree directory and put a symlink to a
     * fresh CLONE of the same repository at its exact path. Returns the clone's real directory and a
     * cleanup for the out-of-root clone fixture.
     */
    async function replaceWithOwnRepoCloneSymlink(wt: string): Promise<{ cloneDir: string; cleanup: () => Promise<void> }> {
      const parent = await mkdtemp(join(tmpdir(), "fusion-ghost-clone-"));
      const cloneDir = join(parent, "clone");
      execFileSync("git", ["clone", "--", root, cloneDir], { encoding: "utf8" });
      await rm(wt, { recursive: true, force: true });
      await symlink(await realpath(cloneDir), wt, process.platform === "win32" ? "junction" : "dir");
      return { cloneDir, cleanup: () => rm(parent, { recursive: true, force: true }) };
    }

    it("positive: a genuine owned worktree passes verified-present through the full real-git preflight WITH the wired group boundaries", async () => {
      const wt = await addOwnedWorktree();
      const decision = await runGhostBugPreflight(task, "`ghost_target_fn`", {
        rootDir: root, exec: createGhostBugProbeExec(), branch: "fusion/T-1", worktree: wt, isOwnedWorktreePath: isOwned,
      });
      // The wired identity boundaries must not obstruct legitimate work: the construct is on the
      // task's own revision, so this releases as verified-present — the wired checks passed, not fired.
      expect(decision).toMatchObject({ decision: "pass", passKind: "verified-present", reason: "construct_found_on_proven_revision" });
    });

    it("positive: an absent owned worktree with a proven branch completes the full preflight against immutable objects", async () => {
      const decision = await runGhostBugPreflight(task, "`ghost_target_fn`", {
        rootDir: root, exec: createGhostBugProbeExec(), branch: "fusion/T-1", worktree: join(ownedWorktreesRoot(), "gone"), isOwnedWorktreePath: isOwned,
      });
      // The immutable-object fallback is a WORKING path (probes ran at the proven root against the
      // branch-tip commit), not just a resolvable one.
      expect(decision).toMatchObject({ decision: "pass", passKind: "verified-present" });
    });

    it("deterministic replacement between resolution and the probe group fails closed before ANY content command", async () => {
      const wt = await addOwnedWorktree();
      const production = createGhostBugProbeExec();
      const calls: { cwd: string; argv: string[] }[] = [];
      const spy = async (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => {
        calls.push({ cwd: options?.cwd ?? "", argv });
        return production(argv, options);
      };

      const outcome = await resolveGhostBugPreflightTarget(
        task,
        "`ghost_target_fn`",
        { branch: "fusion/T-1", worktree: wt },
        { rootDir: root, exec: spy, resolvedForRunId: "run-substitute-probe", isOwnedWorktreePath: isOwned },
      );
      expect(outcome.kind).toBe("target");
      if (outcome.kind !== "target") return;
      expect(outcome.target.worktreeCwd).toBeDefined();
      // Resolution legitimately ran provenance commands (for-each-ref/rev-parse/cat-file); the claim
      // under test starts at the SUBSTITUTION: no content command may run after it.
      const afterResolution = calls.length;

      const { cleanup } = await replaceWithOwnRepoCloneSymlink(wt);
      try {
        const constructs = extractCitedConstructs("`ghost_target_fn`");
        const decision = await runGhostBugPreflightAtTarget(constructs, outcome.target, { exec: spy, rootDir: root });
        expect(decision).toMatchObject({ decision: "unverified", reason: "worktree_provenance_repo_conflict" });
        // Not one content command — no grep, no cat-file, no ls-tree, no show — ran at or beyond the
        // substituted path. Only identity observations were permitted.
        expect(calls.slice(afterResolution).filter(({ argv }) => ["grep", "cat-file", "ls-tree", "show"].includes(argv[1] ?? ""))).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("deterministic replacement between the probe group and the control group stops the control before it runs", async () => {
      const wt = await addOwnedWorktree();
      const production = createGhostBugProbeExec();
      let identityAtWorktree = 0;
      let replaced = false;
      // Resolution ITSELF observes identity at the worktree (Gate 3); counting only starts once the
      // target is resolved, so the first armed observation is the PROBE-GROUP boundary and the second
      // is the CONTROL-GROUP boundary — the replacement lands deterministically before the latter.
      let armed = false;
      let cleanupClone: (() => Promise<void>) | undefined;
      const calls: { cwd: string; argv: string[] }[] = [];
      const spy = async (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => {
        const cwd = options?.cwd ?? "";
        calls.push({ cwd, argv });
        if (armed && !replaced && argv[1] === "rev-parse" && argv[2] === "--git-common-dir" && cwd === wt && ++identityAtWorktree === 2) {
          replaced = true;
          cleanupClone = (await replaceWithOwnRepoCloneSymlink(wt)).cleanup;
        }
        return production(argv, options);
      };

      const outcome = await resolveGhostBugPreflightTarget(
        task,
        "`never_cited_xyz`",
        { branch: "fusion/T-1", worktree: wt },
        { rootDir: root, exec: spy, resolvedForRunId: "run-substitute-control", isOwnedWorktreePath: isOwned },
      );
      expect(outcome.kind).toBe("target");
      if (outcome.kind !== "target") return;
      armed = true;

      try {
        const constructs = extractCitedConstructs("`never_cited_xyz`");
        const decision = await runGhostBugPreflightAtTarget(constructs, outcome.target, { exec: spy, rootDir: root });
        expect(replaced).toBe(true);
        expect(decision).toMatchObject({ decision: "unverified", reason: "worktree_provenance_repo_conflict" });
        // The probe group's work is RETAINED (one definitive-missing finding, no probe error), and the
        // control — the last gate before an archive — never executed in the substitute.
        expect(decision.findings).toHaveLength(1);
        expect(decision.findings[0]?.matched).toBe(false);
        expect(decision.findings[0]?.probeError).toBeUndefined();
        expect(calls.filter(({ argv }) => argv[1] === "ls-tree" || argv[1] === "show")).toEqual([]);
      } finally {
        await cleanupClone?.();
        await rm(wt, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it("the legitimate detector archives on real git, then the archive-boundary re-resolve refuses in a substituted repository", async () => {
      const wt = await addOwnedWorktree();
      const production = createGhostBugProbeExec();

      const target = await resolveProbeTarget(
        { branch: "fusion/T-1", worktree: wt },
        { rootDir: root, exec: production, resolvedForRunId: "run-substitute-archive", isOwnedWorktreePath: isOwned },
      );
      expect(target.ok).toBe(true);
      if (!target.ok) return;

      // First: the preserved detector genuinely ARCHIVES on real git (cited construct absent, control
      // matched, every group-boundary identity observation passed while the worktree was authentic).
      const constructs = extractCitedConstructs("`never_cited_xyz`");
      const decision = await runGhostBugPreflightAtTarget(constructs, target, { exec: production, rootDir: root });
      expect(decision).toMatchObject({ decision: "archive", reason: GHOST_BUG_ARCHIVE_REASON });
      const revision = decision.decision === "archive" ? decision.revision : undefined;
      expect(revision).toBeDefined();

      // Then the destructive boundary: a replacement landing AFTER the archive decision but BEFORE
      // the re-resolution must make the re-resolution itself untrustworthy — it refuses rather than
      // approve or deny the archive target from a foreign repository.
      const { cleanup } = await replaceWithOwnRepoCloneSymlink(wt);
      try {
        const boundary = await reResolveProbeRevisionAtBoundary(revision!, {
          rootDir: root,
          exec: production,
          target: { cwd: target.cwd, worktreeCwd: target.worktreeCwd },
        });
        expect(boundary).toEqual({ ok: false, reason: "worktree_provenance_repo_conflict" });
      } finally {
        await cleanup();
      }
    });
  });

  /* ── decision taxonomy: the reversed fail-opens (GhostBug) ──────────────────── */

  it("archives only when every probe is definitively missing at the PROVEN revision AND the revision-scoped control matches", async () => {
    const git = branchOnly({ grep: (raw) => (raw === "export const knownControl = true;" ? "hit" : "miss") });
    const decision = await preflight(git);
    expect(decision).toMatchObject({ decision: "archive", reason: GHOST_BUG_ARCHIVE_REASON });
    expect(decision.revision).toMatchObject({ sha: REVISION.sha, source: "task-branch" });
  });

  it("releases normally when the construct is present on the task's own revision — the corrected primary outcome", async () => {
    const git = branchOnly({ grep: (raw) => (raw === "foo_bar" ? "hit" : "miss") });
    const decision = await preflight(git);
    expect(decision).toMatchObject({ decision: "pass", passKind: "verified-present", reason: "construct_found_on_proven_revision" });
    // The control is unnecessary once something matched — it must not run.
    expect(git.calls.filter(({ argv }) => argv[1] === "ls-tree")).toEqual([]);
  });

  it("holds (never passes) when every probe errored, and when errors sit alongside definitive-missing", async () => {
    const allErrored = branchOnly({ grep: () => "error" });
    expect(await preflight(allErrored)).toMatchObject({ decision: "unverified", reason: "probe_evidence_incomplete" });

    // Two constructs, one definitively missing and one errored: the old code reduced this to
    // "all missing" and archived. That reduction is what destroyed valid work.
    const git = branchOnly({ grep: (raw) => (raw === "second_item" ? "error" : "miss"), tree: ["src/App.ts"], show: "export const knownControl = true;" });
    const decision = await preflight(git, "`foo_bar`\n`second_item`");
    expect(decision).toMatchObject({ decision: "unverified", reason: "probe_evidence_incomplete" });
    // And it must not be summarized as an archive-eligible all-missing set.
    expect(decision.findings.some((finding) => Boolean(finding.probeError))).toBe(true);
  });

  it("holds (never passes) when the revision-scoped positive control is unmatched or unavailable", async () => {
    const unmatched = branchOnly({ grep: () => "miss" });
    expect(await preflight(unmatched)).toMatchObject({ decision: "unverified", reason: "probe_control_failed" });

    for (const tree of [["src/App.ts"], []]) {
      const unavailable = branchOnly({ grep: () => "miss", tree, show: "tiny" });
      expect(await preflight(unavailable)).toMatchObject({ decision: "unverified", reason: "probe_control_failed" });
    }
  });

  it("runs the positive control against the RESOLVED revision, never the checkout's index", async () => {
    const git = branchOnly({ grep: (raw) => (raw === "export const knownControl = true;" ? "hit" : "miss") });
    await preflight(git);
    const listing = git.calls.find(({ argv }) => argv[1] === "ls-tree")!;
    expect(listing.argv).toEqual(["git", "ls-tree", "-r", "--name-only", REVISION.sha]);
    const show = git.calls.find(({ argv }) => argv[1] === "show")!;
    expect(show.argv).toEqual(["git", "show", `${REVISION.sha}:src/App.ts`]);
    // `git ls-files` reads the checked-out INDEX — using it would certify a pipeline the probes do not use.
    expect(git.calls.some(({ argv }) => argv[1] === "ls-files")).toBe(false);
  });

  it("makes a failed `git show` and unusable sampled content report the control as unavailable", async () => {
    const showFails = vi.fn((argv: string[]) => (argv[1] === "ls-tree"
      ? { stdout: "src/App.ts\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 1 }));
    expect(await runProbePositiveControl({ cwd: "/repo", exec: showFails, revision: REVISION })).toBe("unavailable");

    const noUsableSample = vi.fn((argv: string[]) => (argv[1] === "ls-tree"
      ? { stdout: "src/App.ts\n", stderr: "", exitCode: 0 }
      : { stdout: "tiny\n", stderr: "", exitCode: 0 }));
    expect(await runProbePositiveControl({ cwd: "/repo", exec: noUsableSample, revision: REVISION })).toBe("unavailable");
  });

  it("reports an unproven revision as an unavailable control rather than sampling HEAD", async () => {
    const exec = vi.fn();
    expect(await runProbePositiveControl({ cwd: "/repo", exec })).toBe("unavailable");
    expect(exec).not.toHaveBeenCalled();
  });

  /* ── boundary re-resolve ──────────────────────────────────────────────────── */

  it("re-resolves the branch target at a destructive boundary and surfaces a moved/removed ref", async () => {
    const same = branchOnly();
    expect(await reResolveProbeRevision(REVISION, { cwd: "/repo", exec: same.exec })).toEqual({ ok: true, sha: REVISION.sha });

    const moved = fakeGit({ refs: { "refs/heads/fusion/T-1": "f".repeat(40) } });
    expect(await reResolveProbeRevision(REVISION, { cwd: "/repo", exec: moved.exec })).toMatchObject({ ok: true, sha: "f".repeat(40) });

    const gone = fakeGit({ refs: {} });
    expect(await reResolveProbeRevision(REVISION, { cwd: "/repo", exec: gone.exec })).toMatchObject({ ok: false });
  });

  it("surfaces a provenance-phase throw as an unverified git error, never as missing constructs", async () => {
    const exec = vi.fn(async (argv: string[]) => {
      if (argv[1] === "for-each-ref") throw new Error("spawn git ENOENT");
      return { stdout: "", stderr: "", exitCode: 1 };
    });
    const decision = await runGhostBugPreflight(task, "`foo_bar`", { rootDir: "/repo", exec, branch: "fusion/T-1" });
    expect(decision).toMatchObject({ decision: "unverified", reason: "provenance_git_error" });
    expect(exec.mock.calls.filter(([argv]) => (argv as string[])[1] === "grep")).toEqual([]);
  });

  it("short-circuits the target phase before any probe when provenance fails", async () => {
    const git = fakeGit({ refs: {}, grep: () => "hit" });
    const outcome = await resolveGhostBugPreflightTarget(
      task,
      "`foo_bar`",
      { branch: "fusion/T-1" },
      { rootDir: "/repo", exec: git.exec, resolvedForRunId: "run-x" },
    );
    expect(outcome).toMatchObject({ kind: "decision", decision: { decision: "unverified", reason: "revision_unresolved" } });
  });

  it("adapts execFile rejections into exit-code results without a shell", async () => {
    const rejecting = vi.fn().mockRejectedValue({ code: 1, stdout: "", stderr: "" });
    const probe = createGhostBugProbeExec(rejecting);
    await expect(probe(["git", "grep", "needle"], { cwd: "/repo", timeoutMs: 123 })).resolves.toEqual({ stdout: "", stderr: "", exitCode: 1 });
    expect(rejecting).toHaveBeenCalledWith("git", ["grep", "needle"], expect.objectContaining({ cwd: "/repo", timeout: 123, maxBuffer: 1024 * 1024, shell: false }));
    await expect(createGhostBugProbeExec(vi.fn().mockRejectedValue({ stdout: "", stderr: "fatal" }))(["git", "status"])).resolves.toEqual({ stdout: "", stderr: "fatal" });
  });
});
