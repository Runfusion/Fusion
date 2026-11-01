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
  evaluateWorkspaceReconcileDischarge,
  probeWorkspaceCommitFree,
  reposNeedingCommitFreeProbe,
  summarizeCommitFreeEvidence,
  type WorkspaceCommitFreeRepoEvidence,
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
