import type { DeterministicSignals, EvaluationEvidenceRef } from "./eval-types.js";
import type { TaskDetail, TaskLogEntry, WorkflowStepResult } from "../types.js";

export interface EvalRunContext {
  runId: string;
  startedAt: string;
}

const TIMING_LOG_RE = /\[timing\].*?\bin\s+(\d+)ms\b/i;
const COMMIT_SHA_RE = /\b[0-9a-f]{7,40}\b/i;

function countWorkflow(results: WorkflowStepResult[] | undefined): DeterministicSignals["workflowSummary"] {
  const list = results ?? [];
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const result of list) {
    if (result.status === "passed") passed += 1;
    else if (result.status === "failed" || result.status === "advisory_failure") failed += 1;
    else if (result.status === "pending") pending += 1;
  }
  return { total: list.length, passed, failed, pending };
}

function summarizeLogs(log: TaskLogEntry[]): {
  errorCount: number;
  warningCount: number;
  timingEntries: number;
  evidence: EvaluationEvidenceRef[];
} {
  let errorCount = 0;
  let warningCount = 0;
  let timingEntries = 0;
  const evidence: EvaluationEvidenceRef[] = [];

  for (const entry of log) {
    const text = `${entry.action} ${entry.outcome ?? ""}`.toLowerCase();
    if (text.includes("error") || text.includes("failed")) errorCount += 1;
    if (text.includes("warn")) warningCount += 1;
    const timingMatch = TIMING_LOG_RE.exec(entry.action);
    if (timingMatch) {
      timingEntries += 1;
      evidence.push({
        kind: "timing",
        label: "Timing entry",
        value: `${timingMatch[1]}ms`,
        source: entry.timestamp,
      });
    }
  }

  return { errorCount, warningCount, timingEntries, evidence };
}

function collectCommitSummary(task: TaskDetail): DeterministicSignals["commitSummary"] {
  const mergedAt = task.mergeDetails?.mergedAt;
  const commitSet = new Set<string>();
  if (task.mergeDetails?.commitSha) commitSet.add(task.mergeDetails.commitSha);

  for (const entry of task.log) {
    const match = COMMIT_SHA_RE.exec(`${entry.action} ${entry.outcome ?? ""}`);
    if (match) commitSet.add(match[0]);
  }

  return {
    commitCount: commitSet.size,
    branch: task.branch,
    mergedAt,
  };
}

export function collectDeterministicSignals(task: TaskDetail, _run: EvalRunContext): DeterministicSignals {
  const workflowSummary = countWorkflow(task.workflowStepResults);
  const logSummaryWithEvidence = summarizeLogs(task.log ?? []);
  const commitSummary = collectCommitSummary(task);

  const evidence: EvaluationEvidenceRef[] = [
    {
      kind: "task",
      label: "Task column",
      value: task.column,
      source: task.id,
    },
    {
      kind: "review",
      label: "Task status",
      value: task.status ?? "unknown",
      source: task.id,
    },
    ...logSummaryWithEvidence.evidence,
  ];

  if (workflowSummary.total > 0) {
    evidence.push({
      kind: "workflow",
      label: "Workflow summary",
      value: `${workflowSummary.passed}/${workflowSummary.total} passed`,
      source: task.id,
    });
  }

  if (commitSummary.commitCount > 0 || commitSummary.mergedAt) {
    evidence.push({
      kind: "commit",
      label: "Commit summary",
      value: `count=${commitSummary.commitCount}`,
      source: commitSummary.branch,
    });
  }

  return {
    taskId: task.id,
    column: task.column === "archived" ? "archived" : "done",
    executionStartedAt: task.executionStartedAt,
    executionCompletedAt: task.executionCompletedAt,
    timedExecutionMs: task.timedExecutionMs,
    reviewStatus: task.status,
    workflowSummary,
    commitSummary,
    logSummary: {
      errorCount: logSummaryWithEvidence.errorCount,
      warningCount: logSummaryWithEvidence.warningCount,
      timingEntries: logSummaryWithEvidence.timingEntries,
    },
    evidence,
  };
}
