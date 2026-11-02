import { describe, expect, it } from "vitest";
import { resolveWorkspaceMergeReadiness, workspaceObligationRepositories } from "../merge/workspace-merge-readiness.js";

const task = {
  id: "FN-106",
  repositoryScope: { state: "confirmed" as const, repositories: ["Merge-Auth"] },
  workspaceWorktrees: {
    "Merge-Auth": { worktreePath: "/workspace/Merge-Auth/.worktrees/fn-106", branch: "fusion/fn-106", landedSha: "a".repeat(40) },
  },
  modifiedFiles: ["Merge-Auth/src/auth.ts"],
};

describe("workspace merge readiness", () => {
  it("keeps an already-landed confirmed repository as the second-pass obligation", () => {
    expect(resolveWorkspaceMergeReadiness(task, new Set(), new Set())).toEqual({
      kind: "ready",
      repositories: ["Merge-Auth"],
      preservedFiles: ["Merge-Auth/src/auth.ts"],
    });
  });

  it("fails closed instead of deriving all-landed from unexplained emptiness", () => {
    expect(resolveWorkspaceMergeReadiness({ ...task, workspaceWorktrees: { "Merge-Auth": { ...task.workspaceWorktrees["Merge-Auth"], landedSha: undefined } } }, new Set(), new Set())).toMatchObject({ kind: "blocked" });
  });

  it("rejects malformed persisted duplicate declarations and worktree paths", () => {
    expect(resolveWorkspaceMergeReadiness({
      ...task,
      repositoryScope: { state: "confirmed", repositories: ["Merge-Auth", "Merge-Auth"] },
    }, new Set(), new Set())).toMatchObject({ kind: "blocked", reason: expect.stringContaining("duplicate") });

    expect(resolveWorkspaceMergeReadiness({
      ...task,
      repositoryScope: { state: "confirmed", repositories: ["Merge", "Merge-Auth"] },
      workspaceWorktrees: {
        Merge: { worktreePath: "/workspace/shared/.worktrees/fn-106", branch: "fusion/fn-106" },
        "Merge-Auth": { worktreePath: "/workspace/shared/.worktrees/fn-106", branch: "fusion/fn-106", landedSha: "a".repeat(40) },
      },
    }, new Set(), new Set())).toMatchObject({ kind: "blocked", reason: expect.stringContaining("duplicate worktree") });
  });

  it("permits only an explicit commit-free task to take the no-op path", () => {
    expect(resolveWorkspaceMergeReadiness({ ...task, noCommitsExpected: true, workspaceWorktrees: {} }, new Set(), new Set())).toMatchObject({ kind: "blocked" });
    expect(resolveWorkspaceMergeReadiness({ ...task, noCommitsExpected: true, repositoryScope: { state: "confirmed", repositories: [] }, workspaceWorktrees: {} }, new Set(), new Set())).toMatchObject({ kind: "no-op" });
  });

  /*
  FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-19:05 (RUFU-451):
  The three refusals above must stay reachable FOR AN AUTHORIZED CARD, not merely for an unauthorized one.
  A widening that only checks the unauthorized negative control cannot tell "proof-gated exit" from "the
  declaration now opens every door", so each operator-repair refusal is re-asserted with
  `noCommitsExpected: true` and with an empty absence set — the shape where nothing has been proven.
  */
  describe("authorized card keeps every operator-repair refusal it had", () => {
    it("refuses an unresolved repository scope", () => {
      expect(resolveWorkspaceMergeReadiness(
        { ...task, noCommitsExpected: true, workspaceWorktrees: {}, repositoryScope: { state: "unresolved", repositories: ["Merge-Auth"] } as never },
        new Set(), new Set(), new Set(),
      )).toMatchObject({ kind: "blocked", reason: expect.stringContaining("unresolved") });
    });

    it("refuses duplicate declarations even when the card owes no commits", () => {
      expect(resolveWorkspaceMergeReadiness(
        { ...task, noCommitsExpected: true, workspaceWorktrees: {}, repositoryScope: { state: "confirmed", repositories: ["Merge-Auth", "Merge-Auth"] } },
        new Set(), new Set(), new Set(),
      )).toMatchObject({ kind: "blocked", reason: expect.stringContaining("duplicate") });
    });

    it("refuses an unacquired declaration the caller could not prove absent", () => {
      // `workspaceWorktrees: {}` with a declared member and NO absence evidence: the unacquired
      // repository is not in the proof set, so the completeness refusal must survive byte-identically.
      expect(resolveWorkspaceMergeReadiness(
        { ...task, noCommitsExpected: true, workspaceWorktrees: {} },
        new Set(), new Set(), new Set(),
      )).toMatchObject({ kind: "blocked", reason: expect.stringContaining("no acquired repositories") });
    });

    it("refuses zero obligations for a card that never made the declaration", () => {
      // Two shapes of the same refusal, both with the absence set populated to prove the set alone
      // discharges nothing: an unacquired declaration and an acquired-but-unexplained one.
      expect(resolveWorkspaceMergeReadiness(
        { ...task, workspaceWorktrees: {} },
        new Set(), new Set(), new Set(["Merge-Auth"]),
      )).toMatchObject({ kind: "blocked", reason: expect.stringContaining("no acquired repositories") });
      expect(resolveWorkspaceMergeReadiness(
        { ...task, workspaceWorktrees: { "Merge-Auth": { worktreePath: "/workspace/Merge-Auth/.worktrees/fn-106", branch: "fusion/fn-106" } } },
        new Set(), new Set(), new Set(["Merge-Auth"]),
      )).toMatchObject({ kind: "blocked", reason: expect.stringContaining("no evidenced landing obligations") });
    });

    /*
    FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-21:50 (RUFU-451) — the obligation set is ONE rule:
    SANE-509 held three acquired member entries against a confirmed scope naming no repository. The merge door
    called that shape obligation-free and closed it without measuring a member; `reconcileLandedReviewTask`, over
    the same row, took the acquired set as its obligation set. `workspaceObligationRepositories` is now the single
    rule both doors read, and the classification carries the set so the closing lane cannot invent its own.
    */
    describe("the obligation set a card owes proof about", () => {
      const sane509 = {
        id: "SANE-509",
        noCommitsExpected: true,
        repositoryScope: { state: "confirmed" as const, repositories: [] as string[] },
        workspaceWorktrees: {
          saneca: { worktreePath: ".worktrees/sane-509/saneca", branch: "fusion/sane-509", baseBranch: "main" },
          "lager-manager": { worktreePath: ".worktrees/sane-509/lager-manager", branch: "fusion/sane-509", baseBranch: "main" },
        },
        modifiedFiles: [] as string[],
      };

      it("names the checkouts a zero-declaration card holds instead of claiming there is nothing to prove", () => {
        const result = resolveWorkspaceMergeReadiness(sane509, new Set(), new Set());
        // Still `no-op` — no repository may be LANDED by an obligation-free close. The set is what must be
        // PROVED empty first, and the lane that can run git is the one that has to do it.
        expect(result).toEqual({
          kind: "no-op",
          repositories: [],
          preservedFiles: [],
          obligationRepositories: ["saneca", "lager-manager"],
        });
      });

      it("omits the obligation key entirely when the card declared nothing and holds nothing", () => {
        // The shipped zero-obligation shape stays byte-identical, RUFU-504's exact-`toEqual` contract included.
        expect(resolveWorkspaceMergeReadiness({ ...sane509, workspaceWorktrees: {} }, new Set(), new Set())).toEqual({
          kind: "no-op", repositories: [], preservedFiles: [],
        });
      });

      it("takes the declaration when there is one, in declared order, and the acquired set only in its absence", () => {
        expect(workspaceObligationRepositories({
          noCommitsExpected: true,
          repositoryScope: { state: "confirmed", repositories: ["lager-2026", "lager-manager"] },
          workspaceWorktrees: { "lager-manager": { worktreePath: "/x", branch: "fusion/x" } },
        })).toEqual(["lager-2026", "lager-manager"]);
        expect(workspaceObligationRepositories({
          noCommitsExpected: true,
          repositoryScope: { state: "confirmed", repositories: [] },
          workspaceWorktrees: { "lager-manager": { worktreePath: "/x", branch: "fusion/x" } },
        })).toEqual(["lager-manager"]);
      });

      it("never substitutes the acquired set for a card that owes commits — an empty declaration stays unreconciled", () => {
        // The asymmetry is the whole safety property: without the declaration, acquired entries prove checkout
        // policy and nothing about delivery, so the set stays empty and the operator-repair refusal stands.
        expect(workspaceObligationRepositories({
          repositoryScope: { state: "confirmed", repositories: [] },
          workspaceWorktrees: { "lager-manager": { worktreePath: "/x", branch: "fusion/x" } },
        })).toEqual([]);
        expect(resolveWorkspaceMergeReadiness(
          { ...sane509, noCommitsExpected: undefined },
          new Set(), new Set(),
        )).toMatchObject({ kind: "blocked", reason: expect.stringContaining("no acquired repositories") });
      });

      it("treats an unconfirmed scope as no obligation set at all, whatever the card holds", () => {
        expect(workspaceObligationRepositories({
          noCommitsExpected: true,
          repositoryScope: { state: "unresolved", repositories: ["lager-manager"] } as never,
          workspaceWorktrees: { "lager-manager": { worktreePath: "/x", branch: "fusion/x" } },
        })).toEqual([]);
      });
    });
  });

  /*
  FNXC:WorkspaceFinalization 2026-10-02-19:51 (RUFU-504):
  The reported shape. A commit-free workspace whose member branches sit exactly on their merge-base has
  zero files (so no fresh obligation), zero commits ahead (so `netZero` is false, because
  `workspace-review-evidence.ts` computes `ahead` as a boolean), and no `landedSha`. Readiness used to
  refuse it as unexplained emptiness, and the card repeated one blocker sentence until the stall
  classifier parked it. Reproduce the original failure: the same fixture must no longer reach the
  "no evidenced landing obligations" sentence.
  */
  describe("commit-free workspace with acquired repositories", () => {
    const zeroDiffTask = {
      id: "SANE-463",
      noCommitsExpected: true,
      repositoryScope: { state: "confirmed" as const, repositories: ["lager-manager", "lager-2026"] },
      workspaceWorktrees: {
        "lager-manager": { worktreePath: "/saneca/.fusion/worktrees/sane-463/lager-manager", branch: "fusion/sane-463", baseCommitSha: "b".repeat(40) },
        "lager-2026": { worktreePath: "/saneca/.fusion/worktrees/sane-463/lager-2026", branch: "fusion/sane-463", baseCommitSha: "b".repeat(40) },
      },
      modifiedFiles: [] as string[],
    };

    it("lands each acquired repository as an obligation instead of refusing the whole workspace", () => {
      const result = resolveWorkspaceMergeReadiness(zeroDiffTask, new Set(), new Set());
      expect(result).toEqual({
        kind: "ready",
        repositories: ["lager-2026", "lager-manager"],
        preservedFiles: [],
      });
      expect(result.kind === "blocked" ? result.reason : "").not.toContain("no evidenced landing obligations");
    });

    it("refuses a commit-free workspace that declared two repositories and acquired only one", () => {
      const partial = {
        ...zeroDiffTask,
        workspaceWorktrees: { "lager-manager": zeroDiffTask.workspaceWorktrees["lager-manager"] },
      };
      const result = resolveWorkspaceMergeReadiness(partial, new Set(), new Set());
      /*
      The invariant a partial acquisition must hold is that it is never admitted as a delivery, not which
      refusal sentence names it: with one of two declared repositories present, `knownEntries` is non-empty,
      so the generic landing-obligation refusal is the honest owner. Pinning the sentence would make this
      test a copy of the message rather than a guard on the door.
      */
      expect(result.kind).not.toBe("ready");
      expect(result).toMatchObject({ kind: "blocked", reason: expect.stringContaining("SANE-463") });
    });

    /*
    FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-19:05 (RUFU-451):
    The evidence-gated pair that replaced the flat refusal above. The same partial acquisition is a
    refusal or a discharge depending on ONE fact the caller can only learn from git: whether the
    unacquired repository holds any artifact of this card. Asserting only one half of this pair is how a
    proof gate silently becomes a waiver.
    */
    describe("declared-but-unacquired repository, gated on absence proof", () => {
      const partial = {
        ...zeroDiffTask,
        workspaceWorktrees: { "lager-manager": zeroDiffTask.workspaceWorktrees["lager-manager"] },
      };

      it("discharges the obligation set when the unacquired repository is provably absent", () => {
        const result = resolveWorkspaceMergeReadiness(partial, new Set(), new Set(), new Set(["lager-2026"]));
        expect(result).toEqual({
          kind: "ready",
          repositories: ["lager-manager"],
          preservedFiles: [],
          absentRepositories: ["lager-2026"],
        });
      });

      it("carries the absence into the terminal decision instead of dropping the repository", () => {
        const result = resolveWorkspaceMergeReadiness(partial, new Set(), new Set(), new Set(["lager-2026"]));
        // The declared repository must still be COUNTED: a discharge that silently shrinks the obligation
        // set is RUFU-504's vacuous-truth failure reintroduced through the back door.
        expect(result.kind === "ready" || result.kind === "no-op"
          ? [...result.repositories, ...(result.absentRepositories ?? [])].sort()
          : []).toEqual(["lager-2026", "lager-manager"]);
      });

      it("resolves a wholly-absent declaration to the commit-free no-op, not to a land", () => {
        // RUFU-451 G2 at its extreme: the card declared members and acquired none of them.
        const result = resolveWorkspaceMergeReadiness(
          { ...zeroDiffTask, workspaceWorktrees: {} },
          new Set(), new Set(), new Set(["lager-manager", "lager-2026"]),
        );
        expect(result).toEqual({ kind: "no-op", repositories: [], preservedFiles: [], absentRepositories: ["lager-2026", "lager-manager"] });
      });

      it("still refuses when only one of two declared repositories is proven absent", () => {
        // Partial PROOF is partial acquisition by another name: the second declared member is unmeasured,
        // so nothing may be discharged on the strength of the first one's absence.
        const result = resolveWorkspaceMergeReadiness(
          { ...zeroDiffTask, workspaceWorktrees: {} },
          new Set(), new Set(), new Set(["lager-manager"]),
        );
        expect(result).toMatchObject({ kind: "blocked", reason: expect.stringContaining("SANE-463") });
        expect(result.kind).not.toBe("no-op");
      });

      it("omits the absence key entirely for a fully-acquired declaration", () => {
        // RUFU-504's shipped assertion is an exact `toEqual`, and the widened arm must not answer a
        // fully-acquired card with a new key: the absence list appears exactly when a repository was
        // declared, not acquired, and proven empty — never as an always-present empty field.
        const withLanded = {
          ...zeroDiffTask,
          workspaceWorktrees: {
            ...zeroDiffTask.workspaceWorktrees,
            "lager-2026": { ...zeroDiffTask.workspaceWorktrees["lager-2026"], landedSha: "c".repeat(40) },
          },
        };
        expect(resolveWorkspaceMergeReadiness(withLanded, new Set(), new Set(), new Set(["lager-manager"])))
          .toEqual({ kind: "ready", repositories: ["lager-2026"], preservedFiles: [] });
      });
    });

    it("keeps refusing an unexplained empty workspace that never declared a commit-free contract", () => {
      const { noCommitsExpected: _omitted, ...undeclared } = zeroDiffTask;
      expect(resolveWorkspaceMergeReadiness(undeclared, new Set(), new Set())).toMatchObject({
        kind: "blocked",
        reason: expect.stringContaining("no evidenced landing obligations"),
      });
    });

    it("leaves a fresh-diff obligation on the ready path it already had", () => {
      expect(resolveWorkspaceMergeReadiness(zeroDiffTask, new Set(["lager-manager"]), new Set())).toMatchObject({
        kind: "ready",
        repositories: ["lager-manager"],
      });
    });
  });
});
