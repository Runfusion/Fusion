import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MergeDetails, MergeResult, Task } from "@fusion/core";
import {
  COMMIT_FREE_DELIVERY_REASON,
  createTipAncestryProbe,
  decideWorkspaceDelivery,
  evaluateCommitFreeRepositoryAbsence,
  evaluateWorkspaceReconcileDischarge,
  probeWorkspaceCommitFree,
  provablyAbsentRepositories,
  reposNeedingCommitFreeProbe,
  summarizeCommitFreeEvidence,
  type WorkspaceCommitFreeRepoEvidence,
  type CommitFreeAbsenceInput,
  type WorkspaceReconcileDischargeInput,
  type GitTextRunner,
} from "../merge/workspace-commit-free-delivery.js";
import { validateWorkflowDoneMergeProof } from "../merge/auto-merge-finalization.js";

/*
FNXC:WorkspaceMergeFinalization 2026-10-02-21:52 (RUFU-504):
A workspace card whose repositories were all already integrated produces zero commits in every repo. The
lane used to have two states — "a repo landed with a sha" or "nothing happened" — so it wrote
`mergeConfirmed: anyLanded` (false), and the shared finalizer refused the card with the generic
`missing-merge-confirmation`. That refusal is self-sustaining: the stale `failed` row it leaves is itself a
merge blocker, so removing the cause does not release the cards it already terminalised. Measured on the
saneca review lane: 15 parked siblings, one sentence.
*/

function evidence(
  repo: string,
  basis: WorkspaceCommitFreeRepoEvidence["basis"],
  branchTipSha?: string,
): WorkspaceCommitFreeRepoEvidence {
  return {
    repo,
    repoRootDir: `/tmp/unused/${repo}`,
    branch: "fusion/RUFU-000",
    integrationBranch: "main",
    basis,
    ...(branchTipSha ? { branchTipSha } : {}),
  };
}

describe("workspace commit-free delivery decision", () => {
  it("certifies a zero-commit workspace only when every repository is proven zero-ahead", () => {
    const decision = decideWorkspaceDelivery({
      repoCount: 2,
      landedCount: 0,
      evidence: [evidence("lager-manager", "zero-ahead", "a".repeat(40)), evidence("lager-2026", "zero-ahead", "b".repeat(40))],
    });
    expect(decision.kind).toBe("commit-free-delivery");
    expect(decision.mergeConfirmed).toBe(true);
    expect(decision.noOpReason).toBe(COMMIT_FREE_DELIVERY_REASON);
    expect(decision.commitFreeBasis).toEqual({ "lager-manager": "zero-ahead", "lager-2026": "zero-ahead" });
  });

  it("withholds the delivery when one repository is not proven, even if the other is", () => {
    const decision = decideWorkspaceDelivery({
      repoCount: 2,
      landedCount: 0,
      evidence: [evidence("lager-manager", "zero-ahead"), evidence("lager-2026", "unproven")],
    });
    expect(decision.kind).toBe("undelivered");
    expect(decision.mergeConfirmed).toBe(false);
    // The unproven basis is still recorded so the refusal is explainable after the fact.
    expect(decision.commitFreeBasis).toEqual({ "lager-manager": "zero-ahead", "lager-2026": "unproven" });
  });

  it("withholds the delivery when evidence is missing for a declared repository", () => {
    // A repo that FAILED never reaches the probe, so partial evidence must not certify the aggregate:
    // 2 declared, 1 observed is not "every repository proven".
    const decision = decideWorkspaceDelivery({ repoCount: 2, landedCount: 0, evidence: [evidence("lager-manager", "zero-ahead")] });
    expect(decision.kind).toBe("undelivered");
    expect(decision.mergeConfirmed).toBe(false);
  });

  it("treats a workspace with no acquired repository as undelivered", () => {
    const decision = decideWorkspaceDelivery({ repoCount: 0, landedCount: 0, evidence: [] });
    expect(decision.kind).toBe("undelivered");
    expect(decision.mergeConfirmed).toBe(false);
  });

  it("keeps a landed repository the primary proof and never reports a commit-free reason beside it", () => {
    const decision = decideWorkspaceDelivery({ repoCount: 2, landedCount: 1, evidence: [evidence("lager-2026", "unproven")] });
    expect(decision.kind).toBe("landed-delivery");
    expect(decision.mergeConfirmed).toBe(true);
    expect(decision.noOpReason).toBeUndefined();
  });

  it("records no landing sha for a commit-free delivery", () => {
    // The claim that keeps RUFU-504 honest: a branch tip equal to the merge-base must not be written as a
    // landing sha, because that would assert this card authored a commit it did not author.
    const decision = decideWorkspaceDelivery({ repoCount: 1, landedCount: 0, evidence: [evidence("lager-manager", "zero-ahead", "c".repeat(40))] });
    const details: MergeDetails = {
      mergeConfirmed: decision.mergeConfirmed,
      ...(decision.kind === "commit-free-delivery" ? { noOpMerge: true, noOpReason: decision.noOpReason } : {}),
      ...(decision.commitFreeBasis ? { workspaceCommitFreeBasis: decision.commitFreeBasis } : {}),
      ...(decision.commitFreeBranchTipShas ? { workspaceCommitFreeBranchTipShas: decision.commitFreeBranchTipShas } : {}),
    };
    expect(details.commitSha).toBeUndefined();
    expect(details.workspaceLandedShas).toBeUndefined();
    expect(details.workspaceCommitFreeBranchTipShas).toEqual({ "lager-manager": "c".repeat(40) });
  });
});

describe("commit-free probe plumbing", () => {
  it("skips repositories that produced a landing sha", () => {
    const picked = reposNeedingCommitFreeProbe([
      { repo: "a", repoRootDir: "/x", branch: "fusion/1", integrationBranch: "main", status: "landed" },
      { repo: "b", repoRootDir: "/y", branch: "fusion/1", integrationBranch: "main", status: "empty" },
      { repo: "c", repoRootDir: "/z", branch: "fusion/1", integrationBranch: "main", status: "failed" },
    ]);
    expect(picked.map((r) => r.repo)).toEqual(["b", "c"]);
  });

  it("maps an ancestry refusal to unproven while keeping the observed tip", async () => {
    const calls: string[][] = [];
    const runner: GitTextRunner = async (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return "d".repeat(40);
      throw new Error("merge-base exited 1");
    };
    const evidence = await probeWorkspaceCommitFree(
      [{ repo: "lager-2026", repoRootDir: "/r", branch: "fusion/RUFU-504", integrationBranch: "main" }],
      createTipAncestryProbe(runner),
    );
    expect(evidence[0].basis).toBe("unproven");
    expect(evidence[0].branchTipSha).toBe("d".repeat(40));
    expect(calls).toEqual([
      ["rev-parse", "--verify", "refs/heads/fusion/RUFU-504"],
      ["merge-base", "--is-ancestor", "d".repeat(40), "main"],
    ]);
  });

  it("reports unproven without consulting ancestry when the branch does not resolve", async () => {
    const seen: string[] = [];
    const runner: GitTextRunner = async (args) => {
      seen.push(args[0]!);
      throw new Error("unknown revision");
    };
    const probe = createTipAncestryProbe(runner);
    const result = await probe({ repo: "r", repoRootDir: "/r", branch: "fusion/gone", integrationBranch: "main" });
    expect(result).toEqual({ basis: "unproven" });
    expect(seen).toEqual(["rev-parse"]);
  });
});

/*
FNXC:WorkspaceMergeFinalization 2026-10-02-21:52 (RUFU-504):
Symptom Verification — the exact reported failure, asserted as a real test rather than a green build.
Original symptom: a workspace card with zero commits per repo was refused at finalization with
`missing-merge-confirmation`. Exact reproduction: hand the shared proof validator a commit-free finalization
row (no commitSha, mergeConfirmed from the commit-free basis) and ask whether finalization is allowed.
Assertion it is gone: the commit-free shape is allowed; the pre-fix shape (mergeConfirmed false) is still
refused with the very sentence from the incident, so the door itself was not weakened.
*/
describe("finalization wall that stranded the workspace cards (RUFU-504 symptom)", () => {
  const reviewTask = (mergeDetails: MergeDetails): Task =>
    ({ id: "SANE-463", column: "review", steps: [{ status: "done" }], mergeDetails }) as unknown as Task;
  const commitFreeResult = (mergeConfirmed: boolean): MergeResult =>
    ({ ok: true, merged: false, noOp: true, reason: COMMIT_FREE_DELIVERY_REASON, mergeConfirmed }) as unknown as MergeResult;

  it("allows a proven commit-free workspace delivery through the merge-proof door", async () => {
    const decision = decideWorkspaceDelivery({ repoCount: 1, landedCount: 0, evidence: [evidence("lager-manager", "zero-ahead")] });
    const mergeDetails: MergeDetails = {
      mergeConfirmed: decision.mergeConfirmed,
      noOpMerge: true,
      noOpReason: decision.noOpReason,
      workspaceCommitFreeBasis: decision.commitFreeBasis,
      workspaceLandedFiles: { "lager-manager": [] },
    };
    const verdict = await validateWorkflowDoneMergeProof(reviewTask(mergeDetails), {
      result: commitFreeResult(true),
      checkWorkflowSteps: false,
    });
    expect(verdict.ok).toBe(true);
  });

  it("still refuses the unproven shape with the incident's own sentence", async () => {
    const verdict = await validateWorkflowDoneMergeProof(reviewTask({ workspaceLandedFiles: { "lager-manager": [] } }), {
      result: commitFreeResult(false),
      checkWorkflowSteps: false,
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason?: string }).reason).toBe("missing-merge-confirmation");
  });

  it("keeps the no-op-cannot-claim-files rule intact for a commit-free delivery", async () => {
    const verdict = await validateWorkflowDoneMergeProof(
      reviewTask({ mergeConfirmed: true, noOpMerge: true, noOpReason: COMMIT_FREE_DELIVERY_REASON, landedFiles: ["src/a.ts"] }),
      { result: commitFreeResult(true), checkWorkflowSteps: false },
    );
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason?: string }).reason).toBe("noop-merge-with-landed-files");
  });
});

describe("ancestry probe against a real repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-commit-free-"));
  const runner: GitTextRunner = async (args, cwd) =>
    execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();

  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.ts"), "1\n");
  git("add", "a.ts");
  git("commit", "-m", "seed");
  git("branch", "fusion/integrated");
  // A second branch that carries its own commit: ahead, but with no reason to be believed.
  writeFileSync(join(dir, "b.ts"), "2\n");
  git("add", "b.ts");
  git("commit", "-m", "work on main so the next branch is ahead");
  git("branch", "fusion/lost");
  git("reset", "--hard", "HEAD~1");
  git("branch", "fusion/gone-marker");
  git("branch", "-D", "fusion/gone-marker");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const probe = createTipAncestryProbe(runner);
  const input = (branch: string) => ({ repo: "sub", repoRootDir: dir, branch, integrationBranch: "main" });

  it("proves zero-ahead for a branch already inside the integration branch", async () => {
    expect(await probe(input("fusion/integrated"))).toMatchObject({ basis: "zero-ahead" });
  });

  it("refuses a branch whose tip is not contained in the integration branch", async () => {
    const result = await probe(input("fusion/lost"));
    expect(result.basis).toBe("unproven");
    expect(result.branchTipSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses a deleted branch", async () => {
    expect(await probe(input("fusion/gone-marker"))).toEqual({ basis: "unproven" });
  });

  it("names the basis and tip in the card's own summary line", () => {
    const summary = summarizeCommitFreeEvidence([evidence("lager-manager", "zero-ahead", "e".repeat(40)), evidence("lager-2026", "unproven")]);
    expect(summary).toContain("lager-manager {basis=zero-ahead; tip=eeeeeeeeeeee");
    expect(summary).toContain("lager-2026 {basis=unproven; tip=none}");
  });
});

/*
FNXC:WorkspaceLandedReconcile 2026-11-01-08:10 (RUFU-357):
The reconcile-side discharge predicate, tested with an injected probe/table and no repository —
the decision is what is under test, not git. These cases pin the two vocabulary rules the saneca
population turned on: `zero-ahead` (ancestor + corroborated count 0) discharges, while the
`net-zero` reverted shape, an unreadable count (`null`), an unresolvable base, and a proven-absent
branch are all refusals; an empty obligation set never discharges.
*/
describe("workspace reconcile discharge evaluation", () => {
  const TIP_A = "a".repeat(40);
  const TIP_B = "b".repeat(40);

  interface Table {
    entries?: Record<string, { branch: string; landedSha?: string } | undefined>;
    missingDirs?: string[];
    bases?: Record<string, string | undefined>;
    landed?: string[];
    probes?: Record<string, { basis: "zero-ahead" | "unproven"; branchTipSha?: string }>;
    counts?: Record<string, number | null>;
    branchStates?: Record<string, "present" | "absent" | "unknown">;
    diagnoses?: Record<string, { evidence: "proven" | "contradicted" | "unknown"; proof?: "ancestor" | "net-zero"; aheadCount?: number }>;
  }

  function harness(repoKeys: string[], table: Table = {}) {
    let probeCalls = 0;
    const input: WorkspaceReconcileDischargeInput = {
      repoKeys,
      entries: Object.fromEntries(repoKeys.map((repo) => [repo, table.entries && repo in table.entries ? table.entries[repo] : { branch: "fusion/RUFU-357" }])),
      resolveRepoRootDir: (repo) => (table.missingDirs?.includes(repo) ? undefined : `/checkout/${repo}`),
      probeIntegrationBranch: async (repo) => (table.bases && repo in table.bases ? table.bases[repo] : "main"),
      isLanded: async ({ repo }) => table.landed?.includes(repo) ?? false,
      probe: async ({ repo }) => {
        probeCalls++;
        return table.probes?.[repo] ?? { basis: "zero-ahead", branchTipSha: repo === "lager-2026" ? TIP_B : TIP_A };
      },
      measureAhead: async ({ repoDir }) => {
        const repo = repoDir.replace("/checkout/", "");
        return table.counts && repo in table.counts ? table.counts[repo] : 0;
      },
      ...(table.branchStates
        ? { probeBranch: async (repoDir: string) => table.branchStates![repoDir.replace("/checkout/", "")] ?? ("present" as const) }
        : {}),
      ...(table.diagnoses
        ? { diagnoseAhead: async ({ repo }: { repo: string }) => table.diagnoses![repo] ?? { evidence: "unknown" as const } }
        : {}),
    };
    return { run: () => evaluateWorkspaceReconcileDischarge(input), probeCalls: () => probeCalls };
  }

  it("discharges when every repository is proven zero-ahead and corroborated by count 0", async () => {
    const { run } = harness(["saneca", "lager-2026"]);
    const result = await run();
    expect(result.discharge).toBe(true);
    expect(result.scopeEmpty).toBe(false);
    expect(result.repos.every((r) => r.kind === "discharged" && r.basis === "zero-ahead")).toBe(true);
    expect(result.commitFreeBasis).toEqual({ saneca: "zero-ahead", "lager-2026": "zero-ahead" });
    expect(result.commitFreeBranchTipShas).toEqual({ saneca: TIP_A, "lager-2026": TIP_B });
  });

  it("refuses naming the repository whose count is ahead", async () => {
    const { run } = harness(["saneca", "lager-2026"], {
      probes: { "lager-2026": { basis: "unproven", branchTipSha: TIP_B } },
      counts: { "lager-2026": 1 },
    });
    const result = await run();
    expect(result.discharge).toBe(false);
    expect(result.heldRepos).toEqual([{ repo: "lager-2026", kind: "held", basis: "ahead", uniqueCommitCount: 1 }]);
    expect(result.repos[0]).toMatchObject({ repo: "saneca", kind: "discharged", basis: "zero-ahead" });
  });

  it("refuses the mixed landed + held shape naming the held repository (decideWorkspaceDelivery cannot judge it)", async () => {
    const { run } = harness(["lager-manager", "lager-2026"], {
      landed: ["lager-manager"],
      probes: { "lager-2026": { basis: "unproven", branchTipSha: TIP_B } },
      counts: { "lager-2026": 2 },
    });
    const result = await run();
    expect(result.discharge).toBe(false);
    expect(result.repos[0]).toMatchObject({ repo: "lager-manager", kind: "discharged", basis: "landed" });
    expect(result.heldRepos.map((r) => r.repo)).toEqual(["lager-2026"]);
    // A landed repository contributes no probe row, so the persisted basis never calls it unproven.
    expect(result.commitFreeBasis).toEqual({ "lager-2026": "unproven" });
  });

  it("refuses when the canonical ahead count is null — unproven zero-ness is never a discharge", async () => {
    const { run } = harness(["saneca"], { counts: { saneca: null } });
    const result = await run();
    expect(result.discharge).toBe(false);
    expect(result.heldRepos).toEqual([{ repo: "saneca", kind: "held", basis: "unproven", uniqueCommitCount: null }]);
  });

  it("discharges all-landed without spending an ancestry probe", async () => {
    const { run, probeCalls } = harness(["saneca", "lager-2026"], { landed: ["saneca", "lager-2026"] });
    const result = await run();
    expect(result.discharge).toBe(true);
    expect(probeCalls()).toBe(0);
    expect(result.commitFreeBasis).toBeUndefined();
    expect(result.repos.every((r) => r.kind === "discharged" && r.basis === "landed")).toBe(true);
  });

  it("refuses an empty obligation set — never an empty-set discharge", async () => {
    const { run } = harness([]);
    const result = await run();
    expect(result.discharge).toBe(false);
    expect(result.scopeEmpty).toBe(true);
  });

  it("maps the net-zero (ahead, empty contribution) shape to `reverted`, never to a discharge", async () => {
    const { run } = harness(["lager-2026"], {
      probes: { "lager-2026": { basis: "unproven", branchTipSha: TIP_B } },
      counts: { "lager-2026": 1 },
      diagnoses: { "lager-2026": { evidence: "proven", proof: "net-zero", aheadCount: 1 } },
    });
    const result = await run();
    expect(result.discharge).toBe(false);
    expect(result.heldRepos[0]).toMatchObject({ repo: "lager-2026", basis: "reverted", uniqueCommitCount: 1 });
  });

  it("refuses a proven-absent branch without a landed proof as `branch-absent`", async () => {
    const { run } = harness(["lager-2026"], {
      probes: { "lager-2026": { basis: "unproven" } },
      branchStates: { "lager-2026": "absent" },
    });
    const result = await run();
    expect(result.discharge).toBe(false);
    expect(result.heldRepos[0]).toMatchObject({ repo: "lager-2026", basis: "branch-absent", uniqueCommitCount: null });
  });

  it("refuses an unresolvable per-repository base as `base-unresolvable`", async () => {
    const { run } = harness(["lager-2026"], { bases: { "lager-2026": undefined } });
    const result = await run();
    expect(result.discharge).toBe(false);
    expect(result.heldRepos[0]).toMatchObject({ repo: "lager-2026", basis: "base-unresolvable" });
  });

  it("refuses a key with no workspaceWorktrees entry as unproven (never an assumed discharge)", async () => {
    const { run } = harness(["lager-2026"], { entries: { "lager-2026": undefined } });
    const result = await run();
    expect(result.discharge).toBe(false);
    expect(result.heldRepos[0]).toMatchObject({ repo: "lager-2026", basis: "unproven" });
  });

  it("discharges the mixed landed + zero-ahead shape from per-repo verdicts without consulting decideWorkspaceDelivery", async () => {
    const { run } = harness(["lager-manager", "lager-2026"], { landed: ["lager-manager"] });
    const result = await run();
    expect(result.discharge).toBe(true);
    expect(result.repos.map((r) => r.basis)).toEqual(["landed", "zero-ahead"]);
    // The probed half keeps its basis; the landed half contributes none.
    expect(result.commitFreeBasis).toEqual({ "lager-2026": "zero-ahead" });
  });

  it("recovers the count and the ahead wording from the classifier when the canonical measure reads null", async () => {
    const { run } = harness(["lager-2026"], {
      probes: { "lager-2026": { basis: "unproven", branchTipSha: TIP_B } },
      // `measureAhead` cannot read the count; the diagnosis still proves the branch contributes content.
      counts: { "lager-2026": null },
      diagnoses: { "lager-2026": { evidence: "contradicted", aheadCount: 3 } },
    });
    const result = await run();
    expect(result.discharge).toBe(false);
    // A contradicted empty-land claim is real content ahead, with the classifier's count — never the
    // reverted wording, and never a discharge.
    expect(result.heldRepos[0]).toMatchObject({ repo: "lager-2026", basis: "ahead", uniqueCommitCount: 3 });
  });

  it("names the reverted shape from the classifier even when the canonical count could not be read", async () => {
    const { run } = harness(["lager-2026"], {
      probes: { "lager-2026": { basis: "unproven", branchTipSha: TIP_B } },
      counts: { "lager-2026": null },
      diagnoses: { "lager-2026": { evidence: "proven", proof: "net-zero", aheadCount: 2 } },
    });
    const result = await run();
    expect(result.discharge).toBe(false);
    expect(result.heldRepos[0]).toMatchObject({ repo: "lager-2026", basis: "reverted", uniqueCommitCount: 2 });
  });
});

/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-22:00 (RUFU-451):
The source-free workspace card. RUFU-504 discharges a repository by measuring its branch tip against that
repository's own integration branch, which requires the card to HAVE acquired the repository — so a card that
acquired nothing (a `noCommitsExpected` investigation or reconcile card) had no exit at all: the merge lane threw
`WorkspacePartialLandError`, the reconcile fence refused `workspace-obligations-empty`, and every retry burned one
auto-merge unit. These cases pin the only widening that is allowed — an unacquired declared member, or a wholly
empty obligation set, discharges when ABSENCE is proven — and assert that every refusal a card owing commits
already faced still stands.
*/
describe("commit-free repository absence (RUFU-451)", () => {
  function absenceInput(overrides: Partial<CommitFreeAbsenceInput> = {}): CommitFreeAbsenceInput {
    return {
      repo: "lager-manager",
      entry: undefined,
      recordedLandedSha: undefined,
      repoRootDir: "checkout/lager-manager",
      worktreePathExists: () => false,
      taskBranch: "fusion/RUFU-451",
      declaresContentInRepository: false,
      ...overrides,
    };
  }

  const probe = (answer: "present" | "absent" | "unknown") => async (): Promise<"present" | "absent" | "unknown"> => answer;

  it("reports absence only when the ref read answers \"no such ref\"", async () => {
    const verdicts = await evaluateCommitFreeRepositoryAbsence([absenceInput()], probe("absent"));
    expect(verdicts).toEqual([{ repo: "lager-manager", basis: "absent" }]);
    expect(provablyAbsentRepositories(verdicts)).toEqual(["lager-manager"]);
  });

  it("never infers absence from a read it could not take", async () => {
    // `unknown` is the three-valued probe's "I could not ask" answer (missing directory, unqueryable git).
    const verdicts = await evaluateCommitFreeRepositoryAbsence([absenceInput()], probe("unknown"));
    expect(verdicts).toEqual([{ repo: "lager-manager", basis: "unproven" }]);
    expect(provablyAbsentRepositories(verdicts)).toEqual([]);
  });

  it("treats a missing branch name or an unresolvable member directory as an absent probe", async () => {
    const noBranch = await evaluateCommitFreeRepositoryAbsence([absenceInput({ taskBranch: undefined })], probe("absent"));
    const noDir = await evaluateCommitFreeRepositoryAbsence([absenceInput({ repoRootDir: undefined })], probe("absent"));
    expect(noBranch[0]).toEqual({ repo: "lager-manager", basis: "unproven" });
    expect(noDir[0]).toEqual({ repo: "lager-manager", basis: "unproven" });
  });

  it("refuses absence for a repository holding ANY artifact of the card, even while git says the ref is gone", async () => {
    /*
    RUFU-262's lost-work fence and RUFU-504's "a deleted branch is never folded into a delivery" both live here.
    The acquisition record, the surviving checkout directory, the branch the row names, a recorded landing sha,
    and files the row declares in that member are each independently disqualifying — a repository git says holds
    no ref is exactly where deleted work hides.
    */
    const artifacts: Array<[string, Partial<CommitFreeAbsenceInput>]> = [
      ["acquisition record", { entry: { branch: "fusion/RUFU-451" } }],
      ["surviving checkout", { entry: { worktreePath: "worktrees/rufu-451" }, worktreePathExists: () => true }],
      ["recorded landing sha", { recordedLandedSha: "c".repeat(40) }],
      ["declared content", { declaresContentInRepository: true }],
      // A branch the row RECORDS that git no longer resolves is lost-work suspicion, never an absence.
      ["recorded branch whose ref vanished", { entry: { branch: "fusion/RUFU-451" }, repoRootDir: "checkout/lager-manager" }],
    ];
    for (const [name, override] of artifacts) {
      const verdicts = await evaluateCommitFreeRepositoryAbsence([absenceInput(override)], probe("absent"));
      expect(verdicts, name).toEqual([{ repo: "lager-manager", basis: "recorded" }]);
    }
    expect(provablyAbsentRepositories(await evaluateCommitFreeRepositoryAbsence(
      [absenceInput({ entry: { branch: "fusion/RUFU-451" } })], probe("absent"),
    ))).toEqual([]);
  });

  it("reports a present ref as recorded content, not absence", async () => {
    const verdicts = await evaluateCommitFreeRepositoryAbsence([absenceInput()], probe("present"));
    expect(verdicts).toEqual([{ repo: "lager-manager", basis: "recorded" }]);
  });

  it("never consults git for a repository that already holds an artifact", async () => {
    let probeCalls = 0;
    await evaluateCommitFreeRepositoryAbsence(
      [absenceInput({ entry: { branch: "fusion/RUFU-451" } })],
      async () => { probeCalls++; return "absent"; },
    );
    expect(probeCalls).toBe(0);
  });

  it("classifies each member independently instead of letting one artifact poison the set", async () => {
    const verdicts = await evaluateCommitFreeRepositoryAbsence([
      absenceInput({ repo: "lager-manager" }),
      absenceInput({ repo: "lager-2026", entry: { branch: "fusion/RUFU-451" } }),
    ], probe("absent"));
    expect(verdicts.map((verdict) => `${verdict.repo}:${verdict.basis}`)).toEqual([
      "lager-manager:absent", "lager-2026:recorded",
    ]);
  });
});

describe("workspace delivery decision with an obligation-free proof (RUFU-451)", () => {
  /*
  FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-21:35 (RUFU-451):
  Every call site below now names its OBLIGATION SET (`obligationRepositories`), not just a declared count: the
  accounting that keeps a repository from being dropped silently has to count the repositories the card is
  accountable for, and for an authorized card that holds checkouts under an empty declaration that set is what it
  holds, not what it said. `declaredRepositoryCount` survives as PROVENANCE — it is what decides whether the
  persisted sentence has to explain where the set came from.
  */
  it("certifies a delivery with no repository obligation at all, naming the basis as absence", () => {
    const decision = decideWorkspaceDelivery({
      repoCount: 0, landedCount: 0, evidence: [],
      obligationFreeProof: { authorized: true, obligationRepositories: ["lager-manager"], absentRepositories: ["lager-manager"], declaredRepositoryCount: 1 },
    });
    expect(decision.kind).toBe("commit-free-delivery");
    expect(decision.noOpReason).toContain("lager-manager");
    expect(decision.commitFreeBasis).toEqual({ "lager-manager": "absent" });
    expect(decision.mergeConfirmed).toBe(true);
  });

  it("does not certify an obligation-free delivery for a card that owes commits", () => {
    /*
    The proof's `authorized` flag IS the row's zero-commit declaration, so a lane that cannot assert it falls
    through to the pre-existing undelivered arm — the same refusal `workspace-merger-idempotency.slow.test.ts`
    pins (via the thrown error's sentence) for the unauthorized shape.
    */
    const decision = decideWorkspaceDelivery({
      repoCount: 0, landedCount: 0, evidence: [],
      obligationFreeProof: { authorized: false, obligationRepositories: ["lager-manager"], absentRepositories: ["lager-manager"], declaredRepositoryCount: 1 },
    });
    expect(decision.kind).toBe("undelivered");
    expect(decision.mergeConfirmed).toBe(false);
  });

  it("does not certify while any repository in the obligation set is unaccounted for", () => {
    // Two obligations, one proven absent, nothing probed: the other member may hold work, so nothing is claimed.
    const partial = decideWorkspaceDelivery({
      repoCount: 0, landedCount: 0, evidence: [],
      obligationFreeProof: { authorized: true, obligationRepositories: ["lager-manager", "lager-2026"], absentRepositories: ["lager-manager"], declaredRepositoryCount: 2 },
    });
    expect(partial.kind).toBe("undelivered");
    expect(partial.mergeConfirmed).toBe(false);
  });

  it("does not certify over an obligation set narrower than the card's own declaration", () => {
    /*
    The obligation set is a claim by the caller, so it is checked against the declaration it is supposed to
    implement: a caller that handed over one obligation for a five-repository card has dropped four members from
    the accounting, which is the vacuous-truth RUFU-504 deleted, arriving by a new route.
    */
    const decision = decideWorkspaceDelivery({
      repoCount: 0, landedCount: 0, evidence: [],
      obligationFreeProof: { authorized: true, obligationRepositories: ["lager-manager"], absentRepositories: ["lager-manager"], declaredRepositoryCount: 5 },
    });
    expect(decision.kind).toBe("undelivered");
  });

  it("does not certify an obligation-free delivery over an unproven probe claim", () => {
    const decision = decideWorkspaceDelivery({
      repoCount: 0, landedCount: 0,
      evidence: [evidence("lager-2026", "unproven")],
      obligationFreeProof: { authorized: true, obligationRepositories: ["lager-2026"], absentRepositories: [] },
    });
    expect(decision.kind).toBe("undelivered");
  });

  it("keeps RUFU-504's ancestry wording byte-identically when nothing was discharged by absence", () => {
    const decision = decideWorkspaceDelivery({
      repoCount: 2, landedCount: 0,
      evidence: [evidence("lager-manager", "zero-ahead", "a".repeat(40)), evidence("lager-2026", "zero-ahead", "b".repeat(40))],
      obligationFreeProof: { authorized: true, obligationRepositories: ["lager-manager", "lager-2026"], absentRepositories: [], declaredRepositoryCount: 2 },
    });
    expect(decision.kind).toBe("commit-free-delivery");
    expect(decision.noOpReason).toBe(COMMIT_FREE_DELIVERY_REASON);
    expect(decision.commitFreeBranchTipShas).toEqual({
      "lager-manager": "a".repeat(40), "lager-2026": "b".repeat(40),
    });
  });

  it("states both kinds of proof when a mixed obligation set discharges", () => {
    const decision = decideWorkspaceDelivery({
      repoCount: 1, landedCount: 0,
      evidence: [evidence("lager-manager", "zero-ahead", "a".repeat(40))],
      obligationFreeProof: { authorized: true, obligationRepositories: ["lager-manager", "lager-2026"], absentRepositories: ["lager-2026"], declaredRepositoryCount: 2 },
    });
    expect(decision.kind).toBe("commit-free-delivery");
    expect(decision.noOpReason).toMatch(/zero commits ahead/);
    expect(decision.noOpReason).toMatch(/lager-2026/);
    // Both members must reach the persisted basis map: an absent row without the probed row would erase the
    // only git observation this card has.
    expect(decision.commitFreeBasis).toEqual({ "lager-manager": "zero-ahead", "lager-2026": "absent" });
    expect(decision.commitFreeBranchTipShas).toEqual({ "lager-manager": "a".repeat(40) });
  });

  it("leaves a real landing the strongest claim, unupgraded by an absence next to it", () => {
    const decision = decideWorkspaceDelivery({
      repoCount: 1, landedCount: 1, evidence: [],
      obligationFreeProof: { authorized: true, obligationRepositories: ["lager-manager", "lager-2026"], absentRepositories: ["lager-2026"], declaredRepositoryCount: 2 },
    });
    expect(decision.kind).toBe("landed-delivery");
  });

  it("refuses to fold absence into a landing and invents no sha", () => {
    const decision = decideWorkspaceDelivery({
      repoCount: 0, landedCount: 0, evidence: [],
      obligationFreeProof: { authorized: true, obligationRepositories: ["lager-manager"], absentRepositories: ["lager-manager"], declaredRepositoryCount: 1 },
    });
    expect(decision.landedSha).toBeUndefined();
    expect(JSON.stringify(decision)).not.toMatch(/[0-9a-f]{40}/);
  });

  it("says where an obligation set that came from the checkouts the card holds came from", () => {
    /*
    FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-21:35 (RUFU-451) — the P2 the code review named:
    SANE-509's row carries `repositoryScope: { repositories: [] }` beside a two-entry basis map. Without the
    provenance clause a reader of the terminal record sees the sentence claiming a per-DECLARED-repository fact
    the row contradicts, and the only way to reconcile them is to re-derive the rule from source. The clause is
    DERIVED from `declaredRepositoryCount === 0`, so it cannot be forgotten by a caller the way a hand-passed
    boolean could.
    */
    const decision = decideWorkspaceDelivery({
      repoCount: 2, landedCount: 0,
      evidence: [evidence("lager-manager", "zero-ahead", "a".repeat(40)), evidence("lager-2026", "zero-ahead", "b".repeat(40))],
      obligationFreeProof: {
        authorized: true,
        obligationRepositories: ["lager-manager", "lager-2026"],
        absentRepositories: [],
        declaredRepositoryCount: 0,
      },
    });
    expect(decision.kind).toBe("commit-free-delivery");
    expect(decision.noOpReason).toContain("the card's confirmed scope named no repository");
    expect(decision.commitFreeBasis).toEqual({ "lager-manager": "zero-ahead", "lager-2026": "zero-ahead" });
  });

  it("asserts no ancestry read at all when nothing was measured anywhere", () => {
    /*
    The shape with no obligation to measure closes on the declaration plus the empty reads around it, and the
    sentence must describe THAT — RUFU-504's ancestry wording asserts a tip comparison for every repository, and
    with zero repositories examined it is a claim about a git read that never happened.
    */
    const decision = decideWorkspaceDelivery({
      repoCount: 0, landedCount: 0, evidence: [],
      obligationFreeProof: { authorized: true, obligationRepositories: [], absentRepositories: [] },
    });
    expect(decision.kind).toBe("commit-free-delivery");
    expect(decision.noOpReason).not.toMatch(/task branch tip is an ancestor/);
    expect(decision.noOpReason).toContain("no repository was acquired");
  });
});

describe("workspace reconcile discharge with proven-absent members (RUFU-451)", () => {
  /**
   * `unacquired` = declared members with no `workspaceWorktrees` entry; `absent` = the subset the absence
   * predicate proved. Keeping them separate is the point: an unacquired member the caller did NOT prove absent
   * must still be held, so a caller cannot widen the gate by forgetting to look.
   */
  function absentHarness(repoKeys: string[], unacquired: string[], absent: string[], authorized: boolean) {
    return evaluateWorkspaceReconcileDischarge({
      repoKeys,
      entries: Object.fromEntries(repoKeys.map((repo) => [repo, unacquired.includes(repo) ? undefined : { branch: "fusion/RUFU-451" }])),
      resolveRepoRootDir: (repo) => `checkout/${repo}`,
      probeIntegrationBranch: async () => "main",
      isLanded: async () => false,
      probe: async () => ({ basis: "zero-ahead" as const, branchTipSha: "a".repeat(40) }),
      measureAhead: async () => 0,
      probeBranch: async () => "absent" as const,
      zeroCommitAuthorized: authorized,
      provablyAbsentRepositories: new Set(absent),
    });
  }

  it("discharges an unacquired member proven absent, with absence as its basis", async () => {
    const result = await absentHarness(["lager-manager", "lager-2026"], ["lager-2026"], ["lager-2026"], true);
    expect(result.discharge).toBe(true);
    expect(result.repos.find((verdict) => verdict.repo === "lager-2026")).toMatchObject({ kind: "discharged", basis: "absent" });
    expect(result.commitFreeBasis).toEqual({ "lager-manager": "zero-ahead", "lager-2026": "absent" });
    // No tip may be recorded for an absence: there was no branch to read a tip from.
    expect(result.commitFreeBranchTipShas ?? {}).not.toHaveProperty("lager-2026");
  });

  it("holds the unacquired member for a card that never declared a zero-commit contract", async () => {
    // Byte-identical to the pre-RUFU-451 refusal: the authorization is the first gate, not the git read.
    const result = await absentHarness(["lager-manager", "lager-2026"], ["lager-2026"], ["lager-2026"], false);
    expect(result.discharge).toBe(false);
    expect(result.heldRepos[0]).toMatchObject({ repo: "lager-2026", basis: "unproven" });
  });

  it("holds an unacquired member the caller did not prove absent", async () => {
    const result = await absentHarness(["lager-2026"], ["lager-2026"], [], true);
    expect(result.discharge).toBe(false);
    expect(result.heldRepos[0]).toMatchObject({ repo: "lager-2026", basis: "unproven" });
  });

  it("lets the decideWorkspaceDelivery mirror see the absence shape", async () => {
    /*
    `discharge` ANDs the mirror, so a true result proves the mirror agreed. Before RUFU-451 the mirror counted
    every declared repository as an unproven obligation, which would have vetoed a delivery the merge lane itself
    certifies — the two lanes disagreeing about one card is the failure this repo keeps paying for.
    */
    const result = await absentHarness(["lager-manager", "lager-2026"], ["lager-2026"], ["lager-2026"], true);
    expect(result.scopeEmpty).toBe(false);
    expect(result.discharge).toBe(true);
  });
});
