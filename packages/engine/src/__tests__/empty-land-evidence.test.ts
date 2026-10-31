/*
FNXC:EmptyLandEvidence 2026-09-25-10:55 (RUFU-293):
Unit coverage for the single empty-land evidence classifier. Every case is driven by an injected git
table so the verdict logic is tested without shelling git — except the production adapter's exit-code
mapping, which needs a real repository because its whole job is translating a real git exit code.
*/
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EMPTY_LAND_CONTRADICTION_REASON,
  EMPTY_MERGE_NO_LANDED_PROOF_REASON,
  classifyEmptyLandEvidence,
  emptyLandContradictionAuditMetadata,
  evaluateWorkspaceEmptyLand,
  execEmptyLandGit,
  type EmptyLandEvidenceResult,
  type EmptyLandGitResult,
  type WorkspaceEmptyLandRepo,
} from "../merge/empty-land-evidence.js";

const execFileAsync = promisify(execFile);

type ScriptEntry = EmptyLandGitResult | Error;

/** Build an exec seam from a `git args -> result` table and record every call it receives. */
function scriptedGit(script: Array<{ match: string; result: ScriptEntry }>): {
  exec: (args: string[]) => Promise<EmptyLandGitResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (args: string[]) => {
      calls.push(args);
      const joined = args.join(" ");
      const entry = script.find((candidate) => joined.includes(candidate.match));
      if (!entry) throw new Error(`unexpected git invocation: ${joined}`);
      if (entry.result instanceof Error) throw entry.result;
      return entry.result;
    },
  };
  }

const ok = (stdout: string): EmptyLandGitResult => ({ ok: true, stdout, exitCode: 0 });
const fail = (exitCode: number, stdout = ""): EmptyLandGitResult => ({ ok: false, stdout, exitCode });

const TIP = "3f2a1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

const branchPresent = { match: "rev-parse --verify", result: ok(`${TIP}\n`) };

/* ── workspace decision helpers ────────────────────────────────────────────────────────── */

const repoA: WorkspaceEmptyLandRepo = { repo: "apps/one", branch: "fusion/rufu-x", integrationBranch: "main", repoRootDir: "worktrees/apps-one" };
const repoB: WorkspaceEmptyLandRepo = { repo: "apps/two", branch: "fusion/rufu-x", integrationBranch: "main", repoRootDir: "worktrees/apps-two" };

const ancestorProof: EmptyLandEvidenceResult = { evidence: "proven", proof: "ancestor", aheadCount: 0 };
const netZeroProof: EmptyLandEvidenceResult = { evidence: "proven", proof: "net-zero", aheadCount: 2, filesChanged: 0, insertions: 0, deletions: 0 };
const contradictedProof: EmptyLandEvidenceResult = { evidence: "contradicted", aheadCount: 4, filesChanged: 38, insertions: 2614, deletions: 331 };

/** Classify each repo from a per-repo scripted verdict, and record which repos were consulted. */
function scriptedWorkspace(verdicts: Record<string, EmptyLandEvidenceResult>) {
  const consulted: string[] = [];
  return {
    consulted,
    classify: async (repo: WorkspaceEmptyLandRepo) => {
      consulted.push(repo.repo);
      const verdict = verdicts[repo.repo];
      if (!verdict) throw new Error(`no scripted verdict for ${repo.repo}`);
      return verdict;
    },
  };
}

describe("classifyEmptyLandEvidence", () => {
  it("proves `ancestor` when the branch tip is contained in the integration tip", async () => {
    const git = scriptedGit([
      branchPresent,
      { match: "merge-base --is-ancestor", result: ok("") },
    ]);
    await expect(
      classifyEmptyLandEvidence({ branch: "fusion/rufu-293", integrationBranch: "main", exec: git.exec }),
    ).resolves.toEqual({ evidence: "proven", proof: "ancestor", aheadCount: 0 });
    // Containment is the strongest and cheapest proof: no range probes are needed after it.
    expect(git.calls.map((args) => args.join(" "))).toEqual([
      `rev-parse --verify refs/heads/fusion/rufu-293`,
      `merge-base --is-ancestor ${TIP} main`,
    ]);
  });

  it("proves `net-zero` for the FN-8141 ahead-but-reverted shape (commits + revert restoring the base tree)", async () => {
    const git = scriptedGit([
      branchPresent,
      { match: "merge-base --is-ancestor", result: fail(1) },
      { match: "rev-list --count", result: ok("4\n") },
      { match: "diff --shortstat", result: ok("") },
    ]);
    await expect(
      classifyEmptyLandEvidence({ branch: "fusion/rufu-267", integrationBranch: "main", exec: git.exec }),
    ).resolves.toEqual({ evidence: "proven", proof: "net-zero", aheadCount: 4, filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it("contradicts the empty verdict and reports the contribution size for the RUFU-267 shape", async () => {
    const git = scriptedGit([
      branchPresent,
      { match: "merge-base --is-ancestor", result: fail(1) },
      { match: "rev-list --count", result: ok("4\n") },
      { match: "diff --shortstat", result: ok(" 38 files changed, 2614 insertions(+), 331 deletions(-)\n") },
    ]);
    await expect(
      classifyEmptyLandEvidence({ branch: "fusion/rufu-267", integrationBranch: "main", exec: git.exec }),
    ).resolves.toEqual({ evidence: "contradicted", aheadCount: 4, filesChanged: 38, insertions: 2614, deletions: 331 });
  });

  it("contradicts on a content change with no line churn (mode-only diff), not net-zero", async () => {
    const git = scriptedGit([
      branchPresent,
      { match: "merge-base --is-ancestor", result: fail(1) },
      { match: "rev-list --count", result: ok("1\n") },
      { match: "diff --shortstat", result: ok(" 1 file changed\n") },
    ]);
    await expect(
      classifyEmptyLandEvidence({ branch: "fusion/x", integrationBranch: "main", exec: git.exec }),
    ).resolves.toMatchObject({ evidence: "contradicted", filesChanged: 1, insertions: 0, deletions: 0 });
  });

  it("measures the contribution with the THREE-DOT range and aheadness with the two-dot range", async () => {
    const git = scriptedGit([
      branchPresent,
      { match: "merge-base --is-ancestor", result: fail(1) },
      { match: "rev-list --count", result: ok("2\n") },
      { match: "diff --shortstat", result: ok("") },
    ]);
    await classifyEmptyLandEvidence({ branch: "fusion/rufu-267", integrationBranch: "main", exec: git.exec });
    const diff = git.calls.find((args) => args[0] === "diff")!.join(" ");
    const ahead = git.calls.find((args) => args[0] === "rev-list")!.join(" ");
    /*
     * Three-dot (merge-base → tip) is the branch's OWN contribution. A two-dot endpoint diff would
     * compare the branch tip against an integration tip that has advanced past the branch point, so
     * a genuinely net-zero branch that is merely BEHIND main would read as a huge diff and be
     * mislabelled contradicted — the false accusation this task exists to remove, pointed at the
     * opposite shape.
     */
    expect(diff).toBe("diff --shortstat main...fusion/rufu-267");
    expect(ahead).toBe("rev-list --count main..fusion/rufu-267");
  });

  it("stays `unknown` when the branch ref has vanished, so callers keep their conservative path", async () => {
    const git = scriptedGit([{ match: "rev-parse --verify", result: fail(1) }]);
    await expect(
      classifyEmptyLandEvidence({ branch: "fusion/gone", integrationBranch: "main", exec: git.exec }),
    ).resolves.toEqual({ evidence: "unknown" });
    expect(git.calls).toHaveLength(1);
  });

  it("stays `unknown` when the ancestry probe breaks (exit 128) instead of reading it as `not an ancestor`", async () => {
    const git = scriptedGit([branchPresent, { match: "merge-base --is-ancestor", result: fail(128, "fatal: Not a valid object name") }]);
    await expect(
      classifyEmptyLandEvidence({ branch: "fusion/x", integrationBranch: "main", exec: git.exec }),
    ).resolves.toEqual({ evidence: "unknown" });
  });

  it.each([
    ["rev-list", { match: "rev-list --count", result: fail(128) }],
    ["diff", { match: "diff --shortstat", result: fail(128) }],
    ["rev-list timeout", { match: "rev-list --count", result: new Error("killed") }],
    ["diff timeout", { match: "diff --shortstat", result: new Error("killed") }],
  ])("reports `unknown` when the %s probe fails, keeping any aheadness already measured", async (_name, entry) => {
    const git = scriptedGit([
      branchPresent,
      { match: "merge-base --is-ancestor", result: fail(1) },
      ...(entry.match === "diff" ? [{ match: "rev-list --count", result: ok("7\n") }] : []),
      entry,
    ]);
    const result = await classifyEmptyLandEvidence({ branch: "fusion/x", integrationBranch: "main", exec: git.exec });
    expect(result.evidence).toBe("unknown");
    if (entry.match === "diff") expect(result.aheadCount).toBe(7);
  });

  it("refuses a hostile ref name without invoking git at all", async () => {
    const git = scriptedGit([]);
    await expect(
      classifyEmptyLandEvidence({ branch: "main; rm -rf /", integrationBranch: "main", exec: git.exec }),
    ).resolves.toEqual({ evidence: "unknown" });
    expect(git.calls).toEqual([]);
  });

  it("keeps the FN-8141 sentence byte-identical and the contradiction sentence free of its wording", async () => {
    /*
     * Text-ownership pin: `hasPriorAiNoOpFinalizationProof`, the FN-8141 self-healing fixtures, and
     * the recovery sweeps key on the FN-8141 premise wording. The proven-net-zero lane must keep
     * writing it verbatim, and the new diagnostic must never be reachable by a text-keyed consumer
     * of the old premise.
     */
    expect(EMPTY_MERGE_NO_LANDED_PROOF_REASON).toBe(
      "branch had no net changes vs main — work may have been reverted or lost; operator review required",
    );
    expect(EMPTY_LAND_CONTRADICTION_REASON).toContain("merge-lane malfunction");
    expect(EMPTY_LAND_CONTRADICTION_REASON).not.toContain("reverted or lost");
    expect(EMPTY_LAND_CONTRADICTION_REASON).not.toContain("had no net changes");
    expect(EMPTY_LAND_CONTRADICTION_REASON).not.toContain(EMPTY_MERGE_NO_LANDED_PROOF_REASON);
  });

  it("builds contradiction audit metadata from ids, counts, and fixed enums only", async () => {
    const metadata = emptyLandContradictionAuditMetadata({
      taskId: "RUFU-267",
      lane: "ai-empty-merge",
      evidence: { evidence: "contradicted", aheadCount: 4, filesChanged: 38, insertions: 2614, deletions: 331 },
    });
    expect(metadata).toEqual({
      taskId: "RUFU-267",
      lane: "ai-empty-merge",
      evidence: "contradicted",
      aheadCount: 4,
      filesChanged: 38,
      insertions: 2614,
      deletions: 331,
    });
    // No free-text value can leak a branch name, path, or error sentence into run-audit.
    const stringValues = Object.values(metadata).filter((value) => typeof value === "string");
    expect(stringValues).toEqual(["RUFU-267", "ai-empty-merge", "contradicted"]);
    for (const value of stringValues) {
      expect(value).not.toContain(EMPTY_LAND_CONTRADICTION_REASON);
      expect(value).not.toContain(EMPTY_MERGE_NO_LANDED_PROOF_REASON);
    }
  });

  it("adds workspace counts to the contradiction metadata only when the caller supplies them", async () => {
    const without = emptyLandContradictionAuditMetadata({
      taskId: "RUFU-267",
      lane: "ai-empty-merge-workspace",
      evidence: { evidence: "contradicted", aheadCount: 1, filesChanged: 2, insertions: 3, deletions: 4 },
    });
    expect(Object.keys(without)).not.toContain("repoCount");
    const withCounts = emptyLandContradictionAuditMetadata({
      taskId: "RUFU-267",
      lane: "ai-empty-merge-workspace",
      evidence: { evidence: "contradicted", aheadCount: 1 },
      repoCount: 3,
      landedCount: 0,
    });
    expect(withCounts).toMatchObject({ repoCount: 3, landedCount: 0, aheadCount: 1, filesChanged: null });
  });
});

describe.skipIf(process.platform === "win32")("execEmptyLandGit + classifier against a real repository", () => {
  it("maps real git exit codes and separates the net-zero revert from a real contribution", async () => {
    const repo = await mkdtemp(join(tmpdir(), "empty-land-evidence-"));
    const run = async (args: string[]) => (await execFileAsync("git", args, { cwd: repo })).stdout;
    const git = execEmptyLandGit(repo);
    await run(["init", "-b", "main"]);
    await run(["config", "user.email", "test@example.com"]);
    await run(["config", "user.name", "Test"]);
    await writeFile(join(repo, "seed.txt"), "seed\n");
    await run(["add", "seed.txt"]);
    await run(["commit", "-m", "seed"]);

    // Adapter contract: a completed git run resolves whatever its exit code, so the classifier can
    // read the difference between git answering "no" (1) and git breaking (128).
    await run(["branch", "fusion/reverted"]);
    expect(await git(["merge-base", "--is-ancestor", "fusion/reverted", "main"])).toMatchObject({
      ok: true,
      exitCode: 0,
    });
    // Measured here: `rev-parse --verify` on a missing ref exits 128 on this git build and 1 on
    // others, which is exactly why the classifier reads this probe's STDOUT rather than its code.
    const missingRef = await git(["rev-parse", "--verify", "refs/heads/fusion/nope"]);
    expect(missingRef).toMatchObject({ ok: false, stdout: "" });
    expect(missingRef.exitCode).not.toBe(0);

    // FN-8141 shape: commits + a revert that restores the base tree → ahead but net-zero.
    await run(["checkout", "-q", "fusion/reverted"]);
    await writeFile(join(repo, "work.txt"), "work\n");
    await run(["add", "work.txt"]);
    await run(["commit", "-m", "deliverable"]);
    await run(["rm", "work.txt"]);
    await run(["commit", "-m", "revert"]);
    expect(await classifyEmptyLandEvidence({ branch: "fusion/reverted", integrationBranch: "main", exec: git })).toMatchObject({
      evidence: "proven",
      proof: "net-zero",
      aheadCount: 2,
    });

    // RUFU-267 shape: two commits ahead and the deliverable is still there → contradicted.
    await run(["checkout", "-q", "-b", "fusion/holds-work", "main"]);
    await writeFile(join(repo, "script.mjs"), "export const check = 1;\n");
    await run(["add", "script.mjs"]);
    await run(["commit", "-m", "add prompt-volatility check"]);
    await writeFile(join(repo, "seed.txt"), "seed\npatched\n");
    await run(["commit", "-am", "wire the checker"]);
    expect(await classifyEmptyLandEvidence({ branch: "fusion/holds-work", integrationBranch: "main", exec: git })).toMatchObject({
      evidence: "contradicted",
      aheadCount: 2,
      filesChanged: 2,
      insertions: 2,
      deletions: 0,
    });

    // Already-integrated branch → proven/ancestor without touching the range probes.
    await run(["checkout", "-q", "main"]);
    await run(["merge", "--ff-only", "fusion/holds-work"]);
    expect(await classifyEmptyLandEvidence({ branch: "fusion/holds-work", integrationBranch: "main", exec: git })).toEqual({
      evidence: "proven",
      proof: "ancestor",
      aheadCount: 0,
    });

    // A ref that does not exist is evidence loss, never a claim about the contribution.
    expect(await classifyEmptyLandEvidence({ branch: "fusion/gone", integrationBranch: "main", exec: git })).toEqual({
      evidence: "unknown",
    });
  }, 60_000);
});

/*
FNXC:EmptyLandEvidence 2026-09-25-10:55 (RUFU-293):
The workspace parity guard's decision table, tested through its injected `classify` seam so the routing
is proven without leasing a multi-repo workspace. Each case names the disposition the merge lane must
take, not just the returned shape: `blocksFinalize:false` with zero contradicted is the only
combination allowed to move the card to done.
*/
describe("evaluateWorkspaceEmptyLand", () => {
  it("does not question the verdict at all once any sub-repo has landed", async () => {
    const { consulted, classify } = scriptedWorkspace({});
    const decision = await evaluateWorkspaceEmptyLand({ repos: [repoA], landedCount: 1, classify });
    expect(decision).toEqual({ blocksFinalize: false, contradictedRepoCount: 0 });
    expect(consulted, "a landed sub-repo already proves delivery; git must not be consulted").toEqual([]);
  });

  it("skips the question for noCommitsExpected cards and for a card with no acquired repos", async () => {
    const { consulted, classify } = scriptedWorkspace({});
    expect(await evaluateWorkspaceEmptyLand({ noCommitsExpected: true, repos: [repoA], landedCount: 0, classify }))
      .toEqual({ blocksFinalize: false, contradictedRepoCount: 0 });
    expect(await evaluateWorkspaceEmptyLand({ repos: [], landedCount: 0, classify }))
      .toEqual({ blocksFinalize: false, contradictedRepoCount: 0 });
    expect(consulted).toEqual([]);
  });

  it("allows finalize when every empty sub-repo is already integrated (proven ancestor)", async () => {
    const { consulted, classify } = scriptedWorkspace({ "apps/one": ancestorProof, "apps/two": ancestorProof });
    const decision = await evaluateWorkspaceEmptyLand({ repos: [repoA, repoB], landedCount: 0, classify });
    expect(decision).toEqual({ blocksFinalize: false, contradictedRepoCount: 0 });
    expect(consulted).toEqual(["apps/one", "apps/two"]);
  });

  it("keeps blocking on the FN-8141 lane for an ahead-but-net-zero sub-repo", async () => {
    const { classify } = scriptedWorkspace({ "apps/one": netZeroProof });
    const decision = await evaluateWorkspaceEmptyLand({ repos: [repoA], landedCount: 0, classify });
    expect(decision.blocksFinalize).toBe(true);
    expect(decision.contradictedRepoCount, "net-zero is not a contradiction; the lost-work sentence stays").toBe(0);
    expect(decision.evidence).toBeUndefined();
  });

  it("blocks with the contradiction diagnosis when a sub-repo still holds unapplied content", async () => {
    const { classify } = scriptedWorkspace({ "apps/one": contradictedProof });
    const decision = await evaluateWorkspaceEmptyLand({ repos: [repoA], landedCount: 0, classify });
    expect(decision.blocksFinalize).toBe(true);
    expect(decision.contradictedRepoCount).toBe(1);
    expect(decision.evidence).toMatchObject({ filesChanged: 38, insertions: 2614, deletions: 331, aheadCount: 4 });
  });

  it("keeps scanning after a contradiction so a sibling lost-work sub-repo is not missed", async () => {
    const { consulted, classify } = scriptedWorkspace({ "apps/one": contradictedProof, "apps/two": netZeroProof });
    const decision = await evaluateWorkspaceEmptyLand({ repos: [repoA, repoB], landedCount: 0, classify });
    expect(consulted).toEqual(["apps/one", "apps/two"]);
    expect(decision.blocksFinalize).toBe(true);
    expect(decision.contradictedRepoCount, "the contradiction is the statement the operator must act on").toBe(1);
    expect(decision.evidence?.filesChanged).toBe(38);
  });

  it("treats a vanished branch or broken git (unknown) as the conservative lost-work lane", async () => {
    const unknown: EmptyLandEvidenceResult = { evidence: "unknown" };
    const { classify } = scriptedWorkspace({ "apps/one": unknown });
    const decision = await evaluateWorkspaceEmptyLand({ repos: [repoA], landedCount: 0, classify });
    expect(decision).toEqual({ blocksFinalize: true, contradictedRepoCount: 0 });
  });

  it("counts every contradicted sub-repo when all of them are", async () => {
    const { classify } = scriptedWorkspace({ "apps/one": contradictedProof, "apps/two": contradictedProof });
    const decision = await evaluateWorkspaceEmptyLand({ repos: [repoA, repoB], landedCount: 0, classify });
    expect(decision).toMatchObject({ blocksFinalize: true, contradictedRepoCount: 2 });
  });
});
