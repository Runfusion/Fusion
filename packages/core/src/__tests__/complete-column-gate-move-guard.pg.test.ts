import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { WorkflowStepResult } from "../types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { queryRunAuditEvents } from "../task-store/async/async-audit.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { CompleteColumnGateEvidenceRejectionError } from "../workflows/complete-column-gate-evidence.js";

/*
FNXC:CompleteColumnGateEvidence 2026-10-11-19:35 (RUFU-406):
Store-seam coverage for the complete-column gate-EVIDENCE guard — the half of the completion
boundary the merge door does not cover.

Measured on the real store before these tests were written:
- A card moved into `done` by an operator-intent move from a lane WITHOUT the `merge-blocker`
  trait (plain `in-progress → done`) succeeded with zero `code-review` rows: the merge-blocker
  invariant only consults `getTaskMergeBlocker` when the SOURCE column carries that trait, so the
  whole pre-merge evidence authority is skipped on that route. That is the RUFU-389 / RUFU-337 hole.
- The same card moved out of `in-review` (which does carry `merge-blocker`) is refused with
  `merge-blocked` ("enabled pre-merge workflow steps that never ran") before the new guard runs, so
  the canonical merge-door sentence keeps precedence and no second refusal competes with it.
- A public `moveTask` with no explicit source resolves to `moveSource: "engine"` (the emitted
  default) and therefore to `bypassGuards: true`; engine finalization, handoff, and recovery are
  untouched by this guard by construction, not by a special case added here.
*/

const APPROVED = (id: string, name: string, at = "2026-10-11T00:00:00.000Z"): WorkflowStepResult => ({
  workflowStepId: id,
  workflowStepName: name,
  phase: "pre-merge",
  status: "passed",
  verdict: "APPROVE",
  reviewInputFingerprint: `sha256:${id}-fingerprint`,
  completedAt: at,
});

pgDescribe("complete-column gate-evidence guard at the move seam (RUFU-406)", () => {
  /*
  The harness is project-BOUND on purpose: FN-227's Patchnode completion capture aborts a move into
  the complete lane on an unbound store, which would mask the guard under an unrelated abort.
  */
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_complete_gate_evidence",
    projectId: "core-complete-column-gate-evidence",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seed(id: string, column: string, rows: WorkflowStepResult[] | null) {
    await h.store().createTaskWithReservedId(
      { description: `gate evidence ${id}`, column, enabledWorkflowSteps: ["plan-review", "code-review"] },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await h.store().updateTask(id, { workflowStepResults: rows });
  }

  it("refuses an operator move into the complete lane when a required gate reported nothing", async () => {
    await seed("RUFU406-NO-ROW", "in-progress", [APPROVED("plan-review", "Plan Review")]);

    const error = await h.store()
      .moveTask("RUFU406-NO-ROW", "done", { moveSource: "user" })
      .then(() => null, (caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(CompleteColumnGateEvidenceRejectionError);
    expect((error as CompleteColumnGateEvidenceRejectionError).rejection.code).toBe("gate-evidence-missing");
    expect((error as CompleteColumnGateEvidenceRejectionError).gateFindings.map((finding) => finding.gateId))
      .toEqual(["code-review"]);
    expect(error?.message).toContain("code-review");

    const after = await h.store().getTask("RUFU406-NO-ROW");
    expect(after?.column).toBe("in-progress");
  });

  it("keeps the canonical merge-blocker refusal ahead of the new guard", async () => {
    await seed("RUFU406-MERGE-FIRST", "in-review", [APPROVED("plan-review", "Plan Review")]);

    const error = await h.store()
      .moveTask("RUFU406-MERGE-FIRST", "done", { moveSource: "user" })
      .then(() => null, (caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as CompleteColumnGateEvidenceRejectionError).rejection?.code).toBe("merge-blocked");
    expect(error?.message).toContain("never ran");
  });

  it("lets the same move through once every required gate reports approving evidence", async () => {
    await seed("RUFU406-APPROVED", "in-progress", [
      APPROVED("plan-review", "Plan Review"),
      APPROVED("code-review", "Code Review"),
    ]);

    const moved = await h.store().moveTask("RUFU406-APPROVED", "done", { moveSource: "user" });
    expect(moved.column).toBe("done");
  });

  it("accepts an audited operator waiver as the evidence the gate is waiting for", async () => {
    await seed("RUFU406-WAIVED", "in-progress", [
      APPROVED("plan-review", "Plan Review"),
      {
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "skipped",
        completedAt: "2026-10-11T00:00:00.000Z",
        bypassedBy: "operator-1",
        bypassedAt: "2026-10-11T00:00:00.000Z",
        bypassReason: "reviewer lane unavailable (Fusion#1946)",
        bypassedFromStatus: "failed",
      },
    ]);

    const moved = await h.store().moveTask("RUFU406-WAIVED", "done", { moveSource: "user" });
    expect(moved.column).toBe("done");
  });

  it("does not fire for an engine-sourced move, which is the merge-finalization shape", async () => {
    await seed("RUFU406-ENGINE", "in-progress", [APPROVED("plan-review", "Plan Review")]);

    const moved = await h.store().moveTask("RUFU406-ENGINE", "done", { moveSource: "engine" });
    expect(moved.column).toBe("done");

    /*
    A public call with NO options is the other half of the same exemption and the shape CLI merge
    finalization uses (`finalizePullRequestMerge`): the move seam resolves an unset source to the
    emitted default `"engine"`, which derives `bypassGuards`. Proven here rather than assumed, because
    the exemption is what keeps a real merged-PR finalization from being refused by this guard.
    */
    await seed("RUFU406-UNSET", "in-progress", [APPROVED("plan-review", "Plan Review")]);
    const finalized = await h.store().moveTask("RUFU406-UNSET", "done");
    expect(finalized.column).toBe("done");
  });

  it("binds to the complete TRAIT on a renamed lane, not to the literal id `done`", async () => {
    /*
    A board whose terminal lane is called `shipped` must refuse exactly like `done`: the guard reads
    the resolved trait flags, so a renamed board cannot be a way around it. Derived from the built-in
    IR rather than hand-written so only the lane NAME differs.
    */
    const renamedIr = structuredClone(BUILTIN_CODING_WORKFLOW_IR);
    for (const column of renamedIr.columns) {
      if (column.id === "done") {
        column.id = "shipped";
        column.name = "Shipped";
      }
    }
    for (const node of renamedIr.nodes) {
      if (node.column === "done") node.column = "shipped";
    }
    const definition = await h.store().createWorkflowDefinition({ name: "Renamed complete lane", ir: renamedIr });

    await seed("RUFU406-RENAMED", "in-progress", [APPROVED("plan-review", "Plan Review")]);
    await h.store().selectTaskWorkflow("RUFU406-RENAMED", definition.id);

    const error = await h.store()
      .moveTask("RUFU406-RENAMED", "shipped", { moveSource: "user" })
      .then(() => null, (caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(CompleteColumnGateEvidenceRejectionError);
    expect((error as CompleteColumnGateEvidenceRejectionError).rejection.code).toBe("gate-evidence-missing");
    expect((error as CompleteColumnGateEvidenceRejectionError).gateFindings.map((finding) => finding.gateId))
      .toContain("code-review");
  });

  it("stays inert for a move into a non-complete destination, which is the normal review handoff", async () => {
    /*
    The complement of the trait binding: a card moving INTO review with the code-review gate still
    unrun is the ordinary handoff (that is where the gate is supposed to run), so the guard must not
    pre-empt it. Without this case, a guard that fired on every operator move would pass the tests
    above just as well.
    */
    await seed("RUFU406-TO-REVIEW", "in-progress", [APPROVED("plan-review", "Plan Review")]);

    const moved = await h.store().moveTask("RUFU406-TO-REVIEW", "in-review", { moveSource: "user" });
    expect(moved.column).toBe("in-review");
  });

  it("records the refusal on the card and in run audit without swallowing the rejection", async () => {
    await seed("RUFU406-OBSERVE", "in-progress", [APPROVED("plan-review", "Plan Review")]);

    await expect(
      h.store().moveTask("RUFU406-OBSERVE", "done", {
        moveSource: "user",
        moveCallerSurface: "agent-cli",
        moveCallerPrincipal: { sessionId: "2026-10-11T00-00-00-000Z_probe-session" },
      }),
    ).rejects.toThrow(/code-review/);

    /* Both echoes are fire-and-forget by contract, so wait for them rather than adding real delays. */
    await vi.waitFor(async () => {
      const after = await h.store().getTask("RUFU406-OBSERVE");
      expect(after?.log?.some((entry) => (entry.action ?? "").includes("code-review") && entry.outcome === "refused")).toBe(true);
    });

    const refusal = await vi.waitFor(async () => {
      const rows = await queryRunAuditEvents(h.layer().db, { taskId: "RUFU406-OBSERVE" });
      const found = rows.find((event) => event.mutationType === "task:move-refused-complete-column-gate-evidence");
      if (!found) throw new Error("refusal audit row not written yet");
      return found;
    });
    expect(refusal).toBeDefined();
    expect(refusal?.metadata).toMatchObject({
      rejectionCode: "gate-evidence-missing",
      toColumn: "done",
      moveSource: "user",
      /* RUFU-406: the transport AND the principal class it can prove, so a refusal can be told apart
      from a human's identical move. Provenance only — the verdict is the same for either class. */
      moveCallerSurface: "agent-cli",
      callerSessionId: "2026-10-11T00-00-00-000Z_probe-session",
      gateCount: 1,
    });
    expect(refusal?.metadata?.gateFindings).toEqual(["pre-merge:code-review:missing"]);
    /* The refusal names gates and states only — no reason prose, no card text, no paths. */
    expect(JSON.stringify(refusal?.metadata)).not.toMatch(/gate evidence RUFU406-OBSERVE/);
  });

  it("counts the same refusal for a guarded moveTaskIf, which shares the store seam", async () => {
    await seed("RUFU406-IF", "in-progress", [APPROVED("plan-review", "Plan Review")]);

    await expect(
      h.store().moveTaskIf("RUFU406-IF", "done", () => true, { moveSource: "user", moveCallerSurface: "dashboard-http" }),
    ).rejects.toThrow(/code-review/);

    const after = await h.store().getTask("RUFU406-IF");
    expect(after?.column).toBe("in-progress");
    await vi.waitFor(async () => {
      const rows = await queryRunAuditEvents(h.layer().db, { taskId: "RUFU406-IF" });
      expect(rows.some((event) => event.mutationType === "task:move-refused-complete-column-gate-evidence")).toBe(true);
    });
  });

  it("leaves an explicitly privileged guard-bypassing move untouched, which is the graph's own authority", async () => {
    /*
    KTD-9: the guard is an operator-facing backstop, not a new authority. The move seam derives
    `bypassGuards` from `moveSource === "engine"` plus explicit engine options, and the graph's
    terminal-finalize path (`workflow-terminal-finalize.ts`) also passes `skipMergeBlocker: true` so a
    lane's completion edge can never be double-gated here. Proven against the real store: the same
    zero-evidence card reaches the complete lane when the move declares that authority.
    */
    await seed("RUFU406-BYPASS", "in-progress", [APPROVED("plan-review", "Plan Review")]);

    const moved = await h.store().moveTask("RUFU406-BYPASS", "done", {
      moveSource: "engine",
      skipMergeBlocker: true,
    });
    expect(moved.column).toBe("done");
  });
});
