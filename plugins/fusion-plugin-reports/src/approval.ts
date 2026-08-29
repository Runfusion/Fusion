import type { Report, ReportStatus } from "./store/report-types.js";

export type ApprovalState = "not_required" | "awaiting_approval" | "approved" | "rejected" | "published";
export type ApprovalAction = "approve" | "reject" | "publish";

export interface ApprovalDecision {
  decidedBy: string;
  decidedAt: string;
  note?: string;
  action: ApprovalAction;
}

export interface ApprovalSettings {
  approvalRequired: boolean;
  autoPublishOnApproval: boolean;
  approverAgentIds: string[];
  publishTargets: string[];
}

export interface ApprovalActor {
  id: string;
  type: "human" | "agent";
}

export type ApprovalError = "invalid_transition" | "unauthorized";

export function initializeApprovalState(reportStatus: ReportStatus, settings: ApprovalSettings): ApprovalState {
  if (reportStatus !== "review_complete") return "not_required";
  if (settings.approvalRequired) return "awaiting_approval";
  return settings.autoPublishOnApproval ? "published" : "approved";
}

export function nextApprovalState(
  current: ApprovalState,
  action: ApprovalAction,
  settings: ApprovalSettings,
  actor: ApprovalActor,
): { next: ApprovalState } | { error: ApprovalError } {
  if (!isAuthorized(settings, actor)) return { error: "unauthorized" };
  if (current === "awaiting_approval" && action === "approve") {
    return { next: settings.autoPublishOnApproval ? "published" : "approved" };
  }
  if (current === "awaiting_approval" && action === "reject") return { next: "rejected" };
  if (current === "approved" && action === "publish") return { next: "published" };
  return { error: "invalid_transition" };
}

export function applyDecision(
  report: Report,
  decision: ApprovalDecision,
  settings: ApprovalSettings,
  actor: ApprovalActor,
):
  | { error: ApprovalError }
  | {
    updatedReport: Partial<Report>;
    sideEffects: { publishTargets: string[] };
  } {
  const transition = nextApprovalState(report.approvalState, decision.action, settings, actor);
  if ("error" in transition) return transition;

  const approvalHistory = [...report.approvalHistory, decision];
  const update: Partial<Report> = {
    approvalState: transition.next,
    approvalHistory,
  };

  if (transition.next === "approved") {
    update.status = "approved";
    update.approvedAt = decision.decidedAt;
    update.approvedBy = decision.decidedBy;
  }

  if (transition.next === "published") {
    update.status = "published";
    update.publishedAt = decision.decidedAt;
    if (decision.action === "approve") {
      update.approvedAt = decision.decidedAt;
      update.approvedBy = decision.decidedBy;
    }
  }

  return {
    updatedReport: update,
    sideEffects: {
      publishTargets: transition.next === "published" ? [...settings.publishTargets] : [],
    },
  };
}

function isAuthorized(settings: ApprovalSettings, actor: ApprovalActor): boolean {
  if (!settings.approvalRequired) return true;
  const approvers = settings.approverAgentIds;
  if (approvers.length === 0) return actor.type === "human";
  if (actor.type !== "agent") return false;
  return approvers.includes(actor.id);
}
