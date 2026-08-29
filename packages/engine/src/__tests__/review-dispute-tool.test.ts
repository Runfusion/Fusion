import { describe, expect, it, vi } from "vitest";
import { isOpenWorkflowReviewFinding } from "@fusion/core";
import { createReviewDisputeTool } from "../executor/create-review-dispute-tool.js";

const task = () => ({
  id: "FN-149", title: "Review collision", description: "", column: "in-progress", dependencies: [], steps: [], currentStep: 0,
  log: [], createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
  workflowStepResults: [
    {
      workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", source: "optional-group", status: "failed", reviewKind: "plan",
      findings: [{ id: "shared-id", title: "Plan finding", body: "Plan concern" }],
    },
    {
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", source: "optional-group", status: "failed", reviewKind: "code",
      findings: [{ id: "shared-id", title: "Code finding", body: "Code concern" }],
    },
  ],
});

/*
FNXC:ReviewConvergence 2026-08-22-06:25:
FN-149 permits identical reviewer-generated finding IDs in separate gates. The dispute tool must
fail closed on that collision so an implementer cannot silently annotate Plan Review while trying
to contest Code Review.
*/
describe("review dispute tool gate selection", () => {
  it("rejects a finding ID shared by concurrent review gates without mutating either gate", async () => {
    const row = task();
    const updateTaskAtomic = vi.fn(async (_id, callback) => {
      const patch = await callback(row);
      if (patch) Object.assign(row, patch);
      return row;
    });
    const logEntry = vi.fn();
    const tool = createReviewDisputeTool({
      store: { updateTaskAtomic, logEntry },
      getRunContextFor: () => undefined,
    } as any, row.id);

    const result = await tool.execute("call-1", { findingId: "shared-id", rationale: "The transaction is atomic." } as never);

    expect(result.details).toEqual({ outcome: "ambiguous" });
    expect(result.content[0].text).toContain("ambiguous across review gates");
    expect(row.workflowStepResults.flatMap((entry) => entry.findings)).toEqual([
      expect.not.objectContaining({ disputedAt: expect.anything() }),
      expect.not.objectContaining({ disputedAt: expect.anything() }),
    ]);
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("records a dispute as an open annotation and emits no rationale in telemetry", async () => {
    const row = task();
    row.workflowStepResults = [row.workflowStepResults[1]];
    const recordRunAuditEvent = vi.fn(async () => {});
    const updateTaskAtomic = vi.fn(async (_id, callback) => {
      const patch = await callback(row);
      if (patch) Object.assign(row, patch);
      return row;
    });
    const tool = createReviewDisputeTool({ store: { updateTaskAtomic, logEntry: vi.fn(), recordRunAuditEvent }, getRunContextFor: () => undefined } as any, row.id);
    const rationale = "The transaction makes rollback atomic.";
    await expect(tool.execute("call-open", { findingId: "shared-id", rationale } as never)).resolves.toMatchObject({ details: { outcome: "disputed", workflowStepId: "code-review" } });
    const finding = row.workflowStepResults[0].findings[0];
    expect(isOpenWorkflowReviewFinding(finding)).toBe(true);
    expect(finding).toMatchObject({ disputeRationale: rationale, disputedAt: expect.any(String) });
    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:review-finding-disputed",
      metadata: expect.not.objectContaining({ rationale }),
    }));
  });

  it.each([
    ["not-found", "missing", "valid rationale"],
    ["invalid-rationale", "shared-id", "   "],
  ] as const)("refuses %s without a store write", async (expected, findingId, rationale) => {
    const row = task();
    row.workflowStepResults = [row.workflowStepResults[1]];
    const updateTaskAtomic = vi.fn(async (_id, callback) => {
      const patch = await callback(row);
      if (patch) Object.assign(row, patch);
      return row;
    });
    const before = JSON.stringify(row.workflowStepResults);
    const tool = createReviewDisputeTool({ store: { updateTaskAtomic, logEntry: vi.fn() }, getRunContextFor: () => undefined } as any, row.id);
    await expect(tool.execute("call-refuse", { findingId, rationale } as never)).resolves.toMatchObject({ details: { outcome: expected } });
    expect(JSON.stringify(row.workflowStepResults)).toBe(before);
    if (expected === "invalid-rationale") expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("selects the newest matching archived finding in an unambiguous gate", async () => {
    const row = task();
    row.workflowStepResults = [{
      ...row.workflowStepResults[1],
      findings: undefined,
      priorAttempts: [
        { findings: [{ id: "same-id", title: "Newest", body: "New evidence" }] },
        { findings: [{ id: "same-id", title: "Older", body: "Old evidence" }] },
      ],
    }];
    const updateTaskAtomic = vi.fn(async (_id, callback) => {
      const patch = await callback(row);
      if (patch) Object.assign(row, patch);
      return row;
    });
    const tool = createReviewDisputeTool({ store: { updateTaskAtomic, logEntry: vi.fn() }, getRunContextFor: () => undefined } as any, row.id);

    const result = await tool.execute("call-2", { findingId: "same-id", rationale: "Newest finding is incorrect." } as never);

    expect(result.details).toEqual({ outcome: "disputed", workflowStepId: "code-review" });
    expect(row.workflowStepResults[0].priorAttempts[0].findings[0]).toEqual(expect.objectContaining({ disputedAt: expect.any(String) }));
    expect(row.workflowStepResults[0].priorAttempts[1].findings[0]).not.toHaveProperty("disputedAt");
  });
});
