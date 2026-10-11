/*
FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306):
One blocker sentence covered two states with opposite remedies, and the engine could not tell them
apart. `has not reported` means the node never ran — recoverable by seeding a real run.
`is not approved` means a verdict exists and said no — re-running it would be a machine overruling a
gate. Production 2026-09-25 had cards of the first kind parked forever (DGXS-313, ROZV-290,
RUFU-220, ROZV-286), so the distinction is now expressed in code, and the blocker TEXT is pinned to
stay byte-stable because operators and existing consumers match on it.
*/
import { describe, expect, it } from "vitest";
import {
  getPostMergeEvidenceGateStatuses,
  getRequiredPostMergeEvidenceBlocker,
  getRequiredPostMergeEvidenceDecision,
  isNotRunPostMergeEvidence,
  resolveRequiredPostMergeGateIds,
} from "../merge/confirmed-merge-reconciliation.js";
import { FAST_MODE_BYPASS_ACTOR } from "../workflows/workflow-fast-lane.js";
import { derivePostMergeEvidenceContract, type PostMergeEvidenceContract } from "../merge/post-merge-evidence-contract.js";
import type { Task, WorkflowIr } from "../types.js";

const GATE_ID = "post-merge-verification";

function irWithPostMergeGate(defaultOn: boolean, evidence?: { kind: string }): WorkflowIr {
  return {
    version: "v2",
    id: "builtin:coding",
    name: "Coding",
    nodes: [
      { id: "merge-attempt", kind: "action", column: "in-review" },
      {
        id: GATE_ID,
        kind: "optional-group",
        column: "in-review",
        config: {
          phase: "post-merge",
          defaultOn,
          ...(evidence ? { evidence } : {}),
          template: { nodes: [{ id: "post-merge-check", kind: "prompt", config: { gateMode: "gate" } }] },
        },
      },
    ],
    edges: [],
    columns: [{ id: "in-review", label: "In review", traits: [] }],
  } as unknown as WorkflowIr;
}

function taskWith(enabledWorkflowSteps?: string[]): Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults"> {
  return { id: "RUFU-306", enabledWorkflowSteps, workflowStepResults: [] };
}

function storeFor(ir: WorkflowIr) {
  return {
    getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir }),
  };
}

describe("post-merge evidence gate states", () => {
  /*
  FNXC:PostMergeGateDeliveryShape 2026-09-30-13:09 (RUFU-429):
  The requirement is only real when the lane that delivered the card can report the evidence. These cases
  pin BOTH sides of the invariant in one place, so the exemption cannot be widened into a general
  post-merge bypass: the same IR and the same enabled gate must still block a singular-delivery card, and
  must still block a workspace card that carries a real negative verdict.
  */
  it("does not hold a workspace-shaped card out of completion for evidence its lane cannot produce", async () => {
    const ir = irWithPostMergeGate(true);
    const workspaceTask = {
      ...taskWith([GATE_ID]),
      workspaceWorktrees: { app: { path: "/repo/.worktrees/app" } },
    } as never;

    /*
    FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
    `not-applicable` gained a second cause, so the status now names which one. The workspace exemption this
    test guards is unchanged in behavior — the added field is `delivery-shape`, RUFU-429's own fact.
    */
    expect(getPostMergeEvidenceGateStatuses(workspaceTask, ir))
      .toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "delivery-shape" }]);
    // No blocker sentence means the finalizer completes instead of parking on
    // `[post-merge gate unreachable: workspace]`, which is what the waiver stream existed for.
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, workspaceTask)).toBeUndefined();

    // The same gate on a singular-delivery card is still owed.
    expect(getPostMergeEvidenceGateStatuses(taskWith([GATE_ID]), ir))
      .toEqual([{ gateId: GATE_ID, state: "missing" }]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, taskWith([GATE_ID])))
      .toBe(`required post-merge evidence gate '${GATE_ID}' has not reported`);
  });

  it("still honours a real negative post-merge verdict on a workspace-shaped card", async () => {
    const ir = irWithPostMergeGate(true);
    const workspaceTask = {
      id: "SANE-447",
      enabledWorkflowSteps: [GATE_ID],
      workspaceWorktrees: { app: { path: "/repo/.worktrees/app" } },
      workflowStepResults: [{ workflowStepId: GATE_ID, status: "failed", phase: "post-merge" }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(workspaceTask, ir))
      .toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, workspaceTask))
      .toBe(`required post-merge evidence gate '${GATE_ID}' is not approved`);
  });

  it("names an enabled gate-mode post-merge group as required", () => {
    expect(resolveRequiredPostMergeGateIds(taskWith(), irWithPostMergeGate(true))).toEqual([GATE_ID]);
    expect(resolveRequiredPostMergeGateIds(taskWith(), irWithPostMergeGate(false))).toEqual([]);
  });

  it("leaves an explicitly disabled group non-blocking", () => {
    const ir = irWithPostMergeGate(true);
    // An explicit selection array that omits the group is the operator switching it off; `undefined`
    // is the "never chosen" case that falls back to config.defaultOn.
    expect(resolveRequiredPostMergeGateIds({ enabledWorkflowSteps: [] }, ir)).toEqual([]);
    expect(resolveRequiredPostMergeGateIds({ enabledWorkflowSteps: [GATE_ID] }, ir)).toEqual([GATE_ID]);
  });

  it("reports a gate with no result row as missing, not as unapproved", async () => {
    const ir = irWithPostMergeGate(true);
    const task = taskWith([GATE_ID]);

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([{ gateId: GATE_ID, state: "missing" }]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, task))
      .toBe(`required post-merge evidence gate '${GATE_ID}' has not reported`);
  });

  it("reports a gate whose row did not approve as not-approved", () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{ workflowStepId: GATE_ID, status: "passed", verdict: "REVISE" }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });

  it("clears once the gate reports an approving verdict", async () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{ workflowStepId: GATE_ID, status: "passed", verdict: "APPROVE" }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, task)).toBeUndefined();
  });

  /*
  FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408):
  The RUFU-370 handoff notice promises "an operator bypass of the gate", and on the saneca board that
  promise was unfulfillable twice over: `bypassFailedPreMergeReviewStep` looked only at pre-merge gates
  (`no failed pre-merge review step found`), and even a written waiver row would not have satisfied this
  resolver, because `skipped` is not `passed`. Seven merge-CONFIRMED cards therefore sat in `in-review`
  with a recorded human decision on them and emitted 5,319
  `task:auto-merge-finalize-post-merge-gate-unreachable` rows in a single day (measured 2026-09-29,
  saneca proj_e70af3a5554a4f03).

  The waiver is accepted through the SAME predicate the pre-merge door uses
  (`isAuditedOperatorBypass`), so the automated fast-mode actor stays excluded: a bypass is a named
  human decision or it is not a waiver at all. The two negative cases below are what keep this from
  becoming a way to walk a landed card into `done` without a human signing anything.
  */
  it("treats an audited operator waiver as satisfying evidence, not as a reviewer verdict", async () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{
        workflowStepId: GATE_ID,
        workflowStepName: GATE_ID,
        phase: "post-merge",
        status: "skipped",
        bypassedBy: "dashboard-operator",
        bypassedAt: "2026-09-29T15:00:00.000Z",
        bypassReason: "gate cannot run on this project",
        bypassedFromStatus: "absent",
      }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, task)).toBeUndefined();
  });

  it("refuses a skipped row that carries no waiver metadata (an automated skip is not a human decision)", () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{ workflowStepId: GATE_ID, phase: "post-merge", status: "skipped" }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });

  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-06:51 (RUFU-457):
  The seam's key is the CONTRACT, never the host: these cases hand this function a contract object and nothing
  else, so a hostname cannot reach it even by accident. What they pin is the pair of outcomes that RUFU-430
  could not express — an OneDev/GitLab board OWES its CI-shaped gate (it can produce the evidence, so an
  absence is a real gap and not an exemption), while a GitHub board's statuses are identical to the pre-change
  ones whether the contract is supplied or not. RUFU-179's lesson is the shape of the assertion: an affordance
  and an acceptance gate diverge when each re-derives the kind locally, so every consumer reads these statuses.
  */
  describe("under a OneDev/GitLab evidence contract", () => {
    const onedevContract = derivePostMergeEvidenceContract({
      repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
      endpoints: [{ provider: "onedev", baseUrl: "http://192.168.12.60:6610", credentialConfigured: true }],
      observedAt: "2026-10-01T06:00:00.000Z",
    });
    const gitlabContract = derivePostMergeEvidenceContract({
      repo: {
        factsReadable: true,
        remoteUrl: "https://gitlab.digitalsystems.eu/ai/test_banks.git",
        githubWorkflowFileCount: 0,
      },
      endpoints: [{ provider: "gitlab", baseUrl: "https://gitlab.digitalsystems.eu" }],
      observedAt: "2026-10-01T06:00:00.000Z",
    });
    const githubContract: PostMergeEvidenceContract = derivePostMergeEvidenceContract({
      repo: {
        factsReadable: true,
        remoteUrl: "https://github.com/Runfusion/Fusion.git",
        githubWorkflowFileCount: 11,
      },
      observedAt: "2026-10-01T06:00:00.000Z",
    });

    it.each([
      ["onedev", onedevContract],
      ["gitlab", gitlabContract],
    ] as const)("leaves a %s board's CI-shaped gate owed, not exempt", (_provider, contract) => {
      const ir = irWithPostMergeGate(true);
      expect(getPostMergeEvidenceGateStatuses(taskWith([GATE_ID]), ir, contract)).toEqual([
        { gateId: GATE_ID, state: "missing" },
      ]);
    });

    it.each([onedevContract, gitlabContract])(
      "keeps the blocker sentence on a reporter board until the gate reports (%s.provider)",
      async (contract) => {
        const ir = irWithPostMergeGate(true);
        await expect(getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, taskWith([GATE_ID]), contract))
          .resolves.toBe(`required post-merge evidence gate '${GATE_ID}' has not reported`);
      },
    );

    it("holds a GitHub board's statuses byte-identical to the no-contract reading", () => {
      const ir = irWithPostMergeGate(true);
      const shapes: Array<Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults">> = [
        taskWith([GATE_ID]),
        { ...taskWith([GATE_ID]), workflowStepResults: [{ workflowStepId: GATE_ID, status: "failed" }] } as never,
        {
          ...taskWith([GATE_ID]),
          workflowStepResults: [{ workflowStepId: GATE_ID, status: "passed", verdict: "APPROVE" }],
        } as never,
      ];
      for (const task of shapes) {
        expect(getPostMergeEvidenceGateStatuses(task, ir, githubContract)).toEqual(
          getPostMergeEvidenceGateStatuses(task, ir),
        );
      }
    });

    it("keeps an authored kind above the platform default in both directions", () => {
      // A repo whose contract is the integration lane stays owed on an OneDev board: authored wins.
      const authored = irWithPostMergeGate(true, { kind: "integration-only" });
      expect(getPostMergeEvidenceGateStatuses(taskWith([GATE_ID]), authored, onedevContract)).toEqual([
        { gateId: GATE_ID, state: "missing" },
      ]);

      // And a board with NO reporter that authored a CI-shaped kind is still exempt — the `none` path is
      // decided by the reporter fact, not by which kind the prompt asks for.
      const noneContract = derivePostMergeEvidenceContract({
        declared: { provider: "none" },
        repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
        observedAt: "2026-10-01T06:00:00.000Z",
      });
      expect(getPostMergeEvidenceGateStatuses(taskWith([GATE_ID]), irWithPostMergeGate(true), noneContract)).toEqual([
        { gateId: GATE_ID, state: "not-applicable", notApplicableReason: "no-evidence-reporter" },
      ]);
    });

    /*
    FNXC:PostMergeEvidenceContract 2026-10-01-07:20 (RUFU-457):
    RUFU-430's history cutoff is the one place a NEGATIVE verdict can be forgiven, so adding providers had to
    leave both of its guards provably intact: the row is only excused while the contract is unreportable AND
    derived AND the refusal predates the observation. A reporter board can never reach it — the ladder answers
    `not-approved` there — while the exemption keeps working for a `none` board exactly as before, which is
    what makes "adding a provider silently forgave a real refusal" impossible to ship by accident.
    */
    it.each([["onedev", onedevContract], ["gitlab", gitlabContract]] as const)(
      "keeps a durable %s refusal at not-approved instead of laundering it through the history cutoff",
      (_provider, contract) => {
        const reviseBeforeObservation = {
          ...taskWith([GATE_ID]),
          workflowStepResults: [{
            workflowStepId: GATE_ID,
            phase: "post-merge",
            status: "failed",
            verdict: "REVISE",
            completedAt: "2026-09-30T20:00:00.000Z",
          }],
        } as never;

        expect(getPostMergeEvidenceGateStatuses(reviseBeforeObservation, irWithPostMergeGate(true), contract))
          .toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
      },
    );

    it("still excuses a pre-observation refusal on a board with no reporter (RUFU-430 cutoff unchanged)", () => {
      const derivedNone = derivePostMergeEvidenceContract({
        repo: { factsReadable: true, remoteUrl: "https://git.example.org/x.git", githubWorkflowFileCount: 0 },
        observedAt: "2026-10-01T06:00:00.000Z",
      });
      expect(derivedNone.reason).toBe("non-github-remote");
      const reviseBeforeObservation = {
        ...taskWith([GATE_ID]),
        workflowStepResults: [{
          workflowStepId: GATE_ID,
          phase: "post-merge",
          status: "failed",
          verdict: "REVISE",
          completedAt: "2026-09-30T20:00:00.000Z",
        }],
      } as never;

      expect(getPostMergeEvidenceGateStatuses(reviseBeforeObservation, irWithPostMergeGate(true), derivedNone))
        .toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "verdict-precedes-contract" }]);
    });

    it("never lets an operator-declared 'none' launder a refusal that predates the declaration", () => {
      const declaredNone = derivePostMergeEvidenceContract({
        declared: { provider: "none" },
        repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
        observedAt: "2026-10-01T06:00:00.000Z",
      });
      const reviseBeforeDeclaration = {
        ...taskWith([GATE_ID]),
        workflowStepResults: [{
          workflowStepId: GATE_ID,
          phase: "post-merge",
          status: "failed",
          verdict: "REVISE",
          completedAt: "2026-09-30T20:00:00.000Z",
        }],
      } as never;

      expect(getPostMergeEvidenceGateStatuses(reviseBeforeDeclaration, irWithPostMergeGate(true), declaredNone))
        .toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
    });
  });

  it("refuses the automated fast-mode actor's waiver metadata on a post-merge gate", () => {
    const ir = irWithPostMergeGate(true);
    const task = {
      ...taskWith([GATE_ID]),
      workflowStepResults: [{
        workflowStepId: GATE_ID,
        phase: "post-merge",
        status: "skipped",
        bypassedBy: FAST_MODE_BYPASS_ACTOR,
        bypassedAt: "2026-09-29T15:00:00.000Z",
        bypassReason: "fast lane",
      }],
    } as never;

    expect(getPostMergeEvidenceGateStatuses(task, ir)).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });
});

/*
FNXC:PostMergeCiRepository 2026-10-11-04:00 (RUFU-375, Code Review finding P0):
A gate that REFUSED TO RUN left a row behind, and that row's `skipped` status made this resolver answer
`not-approved` — the veto of a verdict it never authored. The veto was then unlift-able by the very operator
the refusal named: `blocked` reaches neither the re-seed lane nor the finalizer's missing-evidence deferral,
so Retry could not re-run the gate after the missing `postMergeCiRepo` was finally set. RUFU-348's twelve
refusals were twelve landed cards in that state. These cases pin the widened reading and, more importantly,
the carriers that keep it from laundering a real decision into completion.
*/
describe("a post-merge row that records an honest not-run cause is judged as an absence", () => {
  const notRunRow = {
    workflowStepId: GATE_ID,
    workflowStepName: GATE_ID,
    phase: "post-merge",
    status: "skipped",
    notRunReason: "ci-repository-unresolved",
    completedAt: "2026-10-11T00:00:00.000Z",
  };

  function taskWithRow(row: Record<string, unknown>) {
    return { ...taskWith([GATE_ID]), workflowStepResults: [row] } as never;
  }

  it("reports the same state, sentence, and decision as a gate whose row was never written", async () => {
    const ir = irWithPostMergeGate(true);
    const refused = taskWithRow(notRunRow);
    const neverReported = taskWith([GATE_ID]);

    expect(isNotRunPostMergeEvidence(notRunRow as never)).toBe(true);
    // The claim stated as parity: a refused-to-run gate may never carry a stricter status than one that was
    // never given the chance, or the operator's remedy stops matching the card's real state.
    expect(getPostMergeEvidenceGateStatuses(refused, ir))
      .toEqual(getPostMergeEvidenceGateStatuses(neverReported, ir));
    expect(getPostMergeEvidenceGateStatuses(refused, ir)).toEqual([{ gateId: GATE_ID, state: "missing" }]);
    expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir) as never, refused))
      .toBe(`required post-merge evidence gate '${GATE_ID}' has not reported`);
    expect(await getRequiredPostMergeEvidenceDecision(storeFor(ir) as never, refused))
      .toEqual({ outcome: "resumable", gateId: GATE_ID });
  });

  it("keeps every carrier that already speaks for the delivery above the not-run reading", async () => {
    const ir = irWithPostMergeGate(true);
    const carriers = {
      // A verdict is a report ABOUT the delivery, whatever else the row says (the pinned RUFU-306 shape).
      authoredVerdict: { ...notRunRow, verdict: "REVISE" },
      // RUFU-408: an audited human waiver is satisfied evidence, never re-run over the operator's decision.
      auditedWaiver: {
        ...notRunRow,
        bypassedBy: "dashboard-operator",
        bypassedAt: "2026-10-11T01:00:00.000Z",
        bypassReason: "gate cannot run on this project",
      },
      // FN-295: an archived remediation carrier is an unconditional veto whose owned remedy is the restore sweep.
      archivedRemediation: { ...notRunRow, remediationArchivedAt: "2026-10-11T02:00:00Z", remediationArchivedFromStatus: "failed" },
      // RUFU-408's negative half: automated waiver metadata is not a human decision either.
      automatedWaiver: {
        ...notRunRow,
        bypassedBy: FAST_MODE_BYPASS_ACTOR,
        bypassedAt: "2026-10-11T01:00:00.000Z",
        bypassReason: "fast lane",
      },
    };

    for (const [name, row] of Object.entries(carriers)) {
      expect(isNotRunPostMergeEvidence(row as never), name).toBe(false);
      const statuses = getPostMergeEvidenceGateStatuses(taskWithRow(row), ir);
      const decision = await getRequiredPostMergeEvidenceDecision(storeFor(ir) as never, taskWithRow(row));
      if (name === "auditedWaiver") {
        expect([statuses, decision], name).toEqual([[], { outcome: "finalizable" }]);
        continue;
      }
      expect(statuses, name).toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
      expect(decision, name).toEqual({ outcome: "blocked", gateId: GATE_ID, reason: "skipped" });
    }
  });

  it("stays exempt where the requirement itself is exempt, so a doomed re-seed is never scheduled", async () => {
    const ir = irWithPostMergeGate(true);
    const unreportable = derivePostMergeEvidenceContract({
      declared: { provider: "none" },
      repo: { factsReadable: true, remoteUrl: "http://192.168.12.60:6610/saneca.git", githubWorkflowFileCount: 0 },
      observedAt: "2026-10-11T00:00:00.000Z",
    });

    // The re-seed seam refuses workspace cards by construction (`reason: "workspace"`), so classifying such
    // a row as `missing` would have it retry forever against a refusal it can never satisfy.
    expect(getPostMergeEvidenceGateStatuses({
      ...taskWithRow(notRunRow),
      workspaceWorktrees: { app: { path: "/repo/.worktrees/app" } },
    } as never, ir)).toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "delivery-shape" }]);
    expect(getPostMergeEvidenceGateStatuses(taskWithRow(notRunRow) as never, ir, unreportable))
      .toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "no-evidence-reporter" }]);
  });
});
