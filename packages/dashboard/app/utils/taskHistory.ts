import type { Task, WorkflowStepResult } from "@fusion/core";
import { buildStepDurations, parseTimestampToMs } from "./taskTiming";
import { workflowResultBodyParts } from "./workflowResultText";

export type TaskHistoryStageId = "plan" | "code" | "review";
export type TaskHistoryLabel =
  | { kind: "text"; text: string }
  | { kind: "i18n"; key: string; defaultValue: string; params?: Record<string, string | number> };
export interface TaskHistoryMetaItem { label: TaskHistoryLabel; value: string }
export interface TaskHistoryEntry {
  id: string;
  stage: TaskHistoryStageId;
  title: TaskHistoryLabel;
  timestamp?: string;
  verdict?: string;
  status?: string;
  body?: string;
  meta?: TaskHistoryMetaItem[];
  durationMs?: number;
  isCompletionSummary?: true;
}
export interface TaskHistoryStage { id: TaskHistoryStageId; entries: TaskHistoryEntry[] }

/*
FNXC:TaskHistory 2026-08-29-12:20:
The browser alias exposes core types but not workflow constant modules, so these literals mirror the
built-in node identities and the util test guards drift. The three-stage projection is total: every
non-archived workflow result lands in Plan, Code, or Review, while application-authored labels are
i18n descriptors. kind:text is reserved for persisted task data and report bodies remain untranslated.
*/
export const TASK_HISTORY_WORKFLOW_IDS = {
  planReviewGroup: "plan-review",
  planReviewStep: "plan-review-step",
  codeReviewGroup: "code-review",
  codeReviewStep: "code-review-step",
  browserVerificationGroup: "browser-verification",
  browserVerificationStep: "browser-verification-step",
  completionSummary: "completion-summary",
  documentationDeliveryGroup: "documentation-delivery",
  documentationDeliveryStep: "documentation-delivery-step",
} as const;

const STAGE_ORDER: TaskHistoryStageId[] = ["plan", "code", "review"];

function i18n(key: string, defaultValue: string, params?: Record<string, string | number>): TaskHistoryLabel {
  return { kind: "i18n", key, defaultValue, ...(params ? { params } : {}) };
}

/*
FNXC:TaskHistory 2026-08-28-21:23:
History projection preserves reviewer-authored output, notes, and findings only. It returns undefined
when none exist so the rendering component can choose verdict-aware localized fallback copy.
*/
function resultBody(result: WorkflowStepResult): string | undefined {
  const parts = workflowResultBodyParts(result.output, result.notes);
  if (parts.length > 0) return parts.join("\n\n");
  if (!result.findings?.length) return undefined;
  return result.findings.map((finding) => `**${finding.title}**\n\n${finding.body}`).join("\n\n");
}

function isStrippedArchivedCarrier(result: WorkflowStepResult): boolean {
  return Boolean(
    result.remediationArchivedAt
    && !result.output?.trim()
    && !result.notes?.trim()
    && !result.verdict
    && !result.findings?.length,
  );
}

function isSummaryProjectionResult(result: WorkflowStepResult): boolean {
  const id = result.workflowStepId.toLowerCase();
  return id === TASK_HISTORY_WORKFLOW_IDS.completionSummary
    || id === TASK_HISTORY_WORKFLOW_IDS.documentationDeliveryGroup
    || id === TASK_HISTORY_WORKFLOW_IDS.documentationDeliveryStep;
}

function classifyResult(result: WorkflowStepResult): TaskHistoryStageId {
  const id = result.workflowStepId.toLowerCase();
  const name = result.workflowStepName.toLowerCase();
  if (result.phase === "post-merge") return "review";
  if (isSummaryProjectionResult(result)) return "review";
  if (
    result.reviewKind === "plan"
    || id === TASK_HISTORY_WORKFLOW_IDS.planReviewGroup
    || id === TASK_HISTORY_WORKFLOW_IDS.planReviewStep
    || name.includes("plan review")
  ) return "plan";
  if (
    result.reviewKind === "code"
    || id === TASK_HISTORY_WORKFLOW_IDS.codeReviewGroup
    || id === TASK_HISTORY_WORKFLOW_IDS.codeReviewStep
    || id === TASK_HISTORY_WORKFLOW_IDS.browserVerificationGroup
    || id === TASK_HISTORY_WORKFLOW_IDS.browserVerificationStep
    || Boolean(result.verdict)
    || Boolean(result.findings?.length)
  ) return "review";
  return "code";
}

function timestampOf(result: WorkflowStepResult): string | undefined {
  return result.completedAt ?? result.startedAt;
}

function workflowDurationMs(result: WorkflowStepResult): number | undefined {
  const startedAtMs = parseTimestampToMs(result.startedAt);
  const completedAtMs = parseTimestampToMs(result.completedAt);
  if (startedAtMs == null || completedAtMs == null || completedAtMs < startedAtMs) return undefined;
  return completedAtMs - startedAtMs;
}

function workflowEntry(result: WorkflowStepResult, sourceIndex: number, attemptIndex: number): TaskHistoryEntry {
  const stage = classifyResult(result);
  const timestamp = timestampOf(result);
  const durationMs = workflowDurationMs(result);
  const isCompletionSummary = isSummaryProjectionResult(result);
  return {
    id: `workflow:${result.workflowStepId}:${timestamp ?? sourceIndex}:${attemptIndex}`,
    stage,
    title: isCompletionSummary
      ? i18n("taskHistory.entry.completionSummary", "Completion summary")
      : { kind: "text", text: result.workflowStepName },
    timestamp,
    /*
    FNXC:TaskHistory 2026-08-29-12:20:
    Summary-projection nodes are reportingOnly and have no approval to withhold, so an approval-shaped
    verdict or status pill misrepresents their report. Omit both fields here; raw step health remains
    available on the Workflow tab and all non-summary entries retain their ordinary badges.
    */
    ...(!isCompletionSummary ? { verdict: result.verdict, status: result.status } : {}),
    body: resultBody(result),
    ...(durationMs != null ? { durationMs } : {}),
    ...(isCompletionSummary ? { isCompletionSummary: true } : {}),
  };
}

function compareEntries(left: TaskHistoryEntry, right: TaskHistoryEntry): number {
  if (left.timestamp && right.timestamp) {
    const byTimestamp = left.timestamp.localeCompare(right.timestamp);
    if (byTimestamp !== 0) return byTimestamp;
  } else if (left.timestamp) return -1;
  else if (right.timestamp) return 1;
  return left.id.localeCompare(right.id);
}

/*
FNXC:TaskDetailSummary 2026-08-29-12:20:
Summary renders Plan, Code, and Review only. Completion reports always end Review once, while landed
commit facts remain owned by the trailing MergeDetails panel rather than an empty history stage.
*/
export function buildTaskHistory(task: Pick<Task, "stepReports" | "summary" | "log">, results: WorkflowStepResult[]): TaskHistoryStage[] {
  const entries: TaskHistoryEntry[] = [];
  const retainedSummaryProjectionEntries: TaskHistoryEntry[] = [];
  const stepDurations = buildStepDurations(task.log);

  results.forEach((current, sourceIndex) => {
    const snapshots = [...(current.priorAttempts ?? [])].reverse();
    snapshots.forEach((attempt, attemptIndex) => {
      const entry = workflowEntry(attempt, sourceIndex, attemptIndex);
      entries.push(entry);
      if (entry.isCompletionSummary) retainedSummaryProjectionEntries.push(entry);
    });
    if (!isStrippedArchivedCarrier(current)) {
      const entry = workflowEntry(current, sourceIndex, snapshots.length);
      entries.push(entry);
      if (entry.isCompletionSummary) retainedSummaryProjectionEntries.push(entry);
    }
  });

  for (const report of task.stepReports ?? []) {
    const durationMs = stepDurations.get(report.stepIndex, report.stepName);
    entries.push({
      id: `step-report:${report.id}`,
      stage: "code",
      title: i18n("taskHistory.entry.stepReport", "Step {{index}}: {{name}}", {
        index: report.stepIndex,
        name: report.stepName,
      }),
      timestamp: report.recordedAt,
      status: "passed",
      body: report.summary,
      ...(durationMs != null ? { durationMs } : {}),
    });
  }

  if (task.summary?.trim()) {
    if (retainedSummaryProjectionEntries.length > 0) {
      const lastSummaryProjectionEntry = retainedSummaryProjectionEntries
        .sort(compareEntries)
        .at(-1)!;
      /*
      FNXC:TaskHistory 2026-08-29-12:20:
      task.summary is this node's persisted projection after the engine removes the machine
      recommendations JSON block. Prefer it for the retained final report so Summary cannot expose
      that payload to operators, while earlier attempts remain available as their captured history.
      */
      lastSummaryProjectionEntry.body = task.summary.trim();
    } else {
      entries.push({
        id: "task:completion-summary",
        stage: "review",
        title: i18n("taskHistory.entry.completionSummary", "Completion summary"),
        body: task.summary,
        isCompletionSummary: true,
      });
    }
  }

  return STAGE_ORDER.map((id) => {
    const stageEntries = entries.filter((entry) => entry.stage === id);
    const completionSummaries = stageEntries.filter((entry) => entry.isCompletionSummary);
    const otherEntries = stageEntries.filter((entry) => !entry.isCompletionSummary);
    return {
      id,
      entries: [...otherEntries.sort(compareEntries), ...completionSummaries.sort(compareEntries)],
    };
  });
}
