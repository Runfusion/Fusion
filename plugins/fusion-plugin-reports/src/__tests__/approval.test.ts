import { describe, expect, it } from "vitest";
import { applyDecision, nextApprovalState, type ApprovalAction, type ApprovalActor, type ApprovalDecision, type ApprovalSettings, type ApprovalState } from "../approval.js";
import type { Report } from "../store/report-types.js";

interface MatrixCase {
  approvalRequired: boolean;
  autoPublishOnApproval: boolean;
  actorIsApprover: boolean;
  action: ApprovalAction;
  expected: ApprovalState | "invalid_transition" | "unauthorized";
}

const matrix: MatrixCase[] = [
  { approvalRequired: false, autoPublishOnApproval: false, actorIsApprover: false, action: "approve", expected: "approved" },
  { approvalRequired: false, autoPublishOnApproval: false, actorIsApprover: false, action: "reject", expected: "rejected" },
  { approvalRequired: false, autoPublishOnApproval: false, actorIsApprover: false, action: "publish", expected: "invalid_transition" },
  { approvalRequired: false, autoPublishOnApproval: false, actorIsApprover: true, action: "approve", expected: "approved" },
  { approvalRequired: false, autoPublishOnApproval: false, actorIsApprover: true, action: "reject", expected: "rejected" },
  { approvalRequired: false, autoPublishOnApproval: false, actorIsApprover: true, action: "publish", expected: "invalid_transition" },
  { approvalRequired: false, autoPublishOnApproval: true, actorIsApprover: false, action: "approve", expected: "published" },
  { approvalRequired: false, autoPublishOnApproval: true, actorIsApprover: false, action: "reject", expected: "rejected" },
  { approvalRequired: false, autoPublishOnApproval: true, actorIsApprover: false, action: "publish", expected: "invalid_transition" },
  { approvalRequired: false, autoPublishOnApproval: true, actorIsApprover: true, action: "approve", expected: "published" },
  { approvalRequired: false, autoPublishOnApproval: true, actorIsApprover: true, action: "reject", expected: "rejected" },
  { approvalRequired: false, autoPublishOnApproval: true, actorIsApprover: true, action: "publish", expected: "invalid_transition" },
  { approvalRequired: true, autoPublishOnApproval: false, actorIsApprover: false, action: "approve", expected: "unauthorized" },
  { approvalRequired: true, autoPublishOnApproval: false, actorIsApprover: false, action: "reject", expected: "unauthorized" },
  { approvalRequired: true, autoPublishOnApproval: false, actorIsApprover: false, action: "publish", expected: "unauthorized" },
  { approvalRequired: true, autoPublishOnApproval: false, actorIsApprover: true, action: "approve", expected: "approved" },
  { approvalRequired: true, autoPublishOnApproval: false, actorIsApprover: true, action: "reject", expected: "rejected" },
  { approvalRequired: true, autoPublishOnApproval: false, actorIsApprover: true, action: "publish", expected: "invalid_transition" },
  { approvalRequired: true, autoPublishOnApproval: true, actorIsApprover: false, action: "approve", expected: "unauthorized" },
  { approvalRequired: true, autoPublishOnApproval: true, actorIsApprover: false, action: "reject", expected: "unauthorized" },
  { approvalRequired: true, autoPublishOnApproval: true, actorIsApprover: false, action: "publish", expected: "unauthorized" },
  { approvalRequired: true, autoPublishOnApproval: true, actorIsApprover: true, action: "approve", expected: "published" },
  { approvalRequired: true, autoPublishOnApproval: true, actorIsApprover: true, action: "reject", expected: "rejected" },
  { approvalRequired: true, autoPublishOnApproval: true, actorIsApprover: true, action: "publish", expected: "invalid_transition" },
];

function makeSettings(input: Pick<MatrixCase, "approvalRequired" | "autoPublishOnApproval" | "actorIsApprover">): ApprovalSettings {
  return {
    approvalRequired: input.approvalRequired,
    autoPublishOnApproval: input.autoPublishOnApproval,
    approverAgentIds: input.actorIsApprover ? ["approver-1"] : ["approver-2"],
    publishTargets: ["dashboard"],
  };
}

function makeDecision(action: ApprovalAction): ApprovalDecision {
  return { action, decidedAt: "2026-05-10T00:00:00.000Z", decidedBy: "approver-1", note: "ship" };
}

function makeReport(state: ApprovalState): Report {
  return {
    id: "rep_1",
    cadence: "daily",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-01",
    title: "Title",
    status: "review_complete",
    generationStartedAt: "2026-05-01T00:00:00.000Z",
    generationCompletedAt: null,
    reviewStartedAt: null,
    reviewCompletedAt: "2026-05-01T01:00:00.000Z",
    approvedAt: null,
    approvedBy: null,
    publishedAt: null,
    archivedAt: null,
    failureReason: null,
    approvalState: state,
    approvalHistory: [],
    draftMarkdown: "# x",
    renderedHtmlPath: null,
    renderedHtml: null,
    renderedHtmlGeneratedAt: null,
    metadata: {},
    combinedReview: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

describe("approval state machine", () => {
  it.each(matrix)("transition matrix %#", (entry) => {
    const settings = makeSettings(entry);
    const actor: ApprovalActor = { id: "approver-1", type: "agent" };
    const result = nextApprovalState("awaiting_approval", entry.action, settings, actor);
    if ("error" in result) {
      expect(result.error).toBe(entry.expected);
      return;
    }
    expect(result.next).toBe(entry.expected);
  });

  it("returns invalid_transition for not_required actions", () => {
    const settings: ApprovalSettings = {
      approvalRequired: true,
      autoPublishOnApproval: false,
      approverAgentIds: ["approver-1"],
      publishTargets: [],
    };
    const actor: ApprovalActor = { id: "approver-1", type: "agent" };
    expect(nextApprovalState("not_required", "approve", settings, actor)).toEqual({ error: "invalid_transition" });
    expect(nextApprovalState("not_required", "reject", settings, actor)).toEqual({ error: "invalid_transition" });
    expect(nextApprovalState("not_required", "publish", settings, actor)).toEqual({ error: "invalid_transition" });
  });

  it("allows any human when approverAgentIds is empty", () => {
    const settings: ApprovalSettings = {
      approvalRequired: true,
      autoPublishOnApproval: false,
      approverAgentIds: [],
      publishTargets: [],
    };
    const human: ApprovalActor = { id: "u-1", type: "human" };
    expect(nextApprovalState("awaiting_approval", "approve", settings, human)).toEqual({ next: "approved" });
  });

  it("keeps agents unauthorized when approverAgentIds is empty", () => {
    const settings: ApprovalSettings = {
      approvalRequired: true,
      autoPublishOnApproval: false,
      approverAgentIds: [],
      publishTargets: [],
    };
    const agent: ApprovalActor = { id: "approver-1", type: "agent" };
    expect(nextApprovalState("awaiting_approval", "approve", settings, agent)).toEqual({ error: "unauthorized" });
  });

  it("applyDecision auto-publish chain updates report fields", () => {
    const report = makeReport("awaiting_approval");
    const settings: ApprovalSettings = {
      approvalRequired: true,
      autoPublishOnApproval: true,
      approverAgentIds: ["approver-1"],
      publishTargets: ["dashboard", "html-export"],
    };

    const result = applyDecision(report, makeDecision("approve"), settings, { id: "approver-1", type: "agent" });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.updatedReport.approvalState).toBe("published");
    expect(result.updatedReport.status).toBe("published");
    expect(result.updatedReport.approvedBy).toBe("approver-1");
    expect(result.sideEffects.publishTargets).toEqual(["dashboard", "html-export"]);
  });

  it("applyDecision publish action from approved sets published state", () => {
    const report = makeReport("approved");
    const settings: ApprovalSettings = {
      approvalRequired: true,
      autoPublishOnApproval: false,
      approverAgentIds: ["approver-1"],
      publishTargets: ["dashboard"],
    };

    const result = applyDecision(report, makeDecision("publish"), settings, { id: "approver-1", type: "agent" });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.updatedReport.approvalState).toBe("published");
    expect(result.updatedReport.status).toBe("published");
    expect(result.updatedReport.publishedAt).toBe("2026-05-10T00:00:00.000Z");
  });
});
