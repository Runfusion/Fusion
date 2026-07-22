import type { AgentLogEntry, RunAuditEvent, TaskDetail, TaskDocument, TaskEvaluationEvidenceBundle, TaskLogEntry, TaskStore } from "@fusion/core";
import {
  EVIDENCE_LIMITS,
  EVIDENCE_EXCERPT_TRUNCATION_MARKER,
  MAX_EVIDENCE_EXCERPT_LENGTH,
  TASK_EVALUATION_EVIDENCE_SOURCE_ORDER,
  runCommandAsync,
} from "@fusion/core";

const COMMIT_SUBJECT_LIMIT = 160;

function truncateExcerpt(text: string | undefined): { excerpt?: string; truncated?: boolean } {
  if (!text) return {};
  if (text.length <= MAX_EVIDENCE_EXCERPT_LENGTH) return { excerpt: text };
  const prefixLength = Math.max(0, MAX_EVIDENCE_EXCERPT_LENGTH - EVIDENCE_EXCERPT_TRUNCATION_MARKER.length);
  return { excerpt: `${text.slice(0, prefixLength)}${EVIDENCE_EXCERPT_TRUNCATION_MARKER}`, truncated: true };
}

function truncateSubject(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length <= COMMIT_SUBJECT_LIMIT ? text : text.slice(0, COMMIT_SUBJECT_LIMIT);
}

function byChronologicalThenId<T extends { timestamp?: string; id: string }>(a: T, b: T): number {
  const timeOrder = (a.timestamp ?? "").localeCompare(b.timestamp ?? "");
  if (timeOrder !== 0) return timeOrder;
  return a.id.localeCompare(b.id);
}

async function collectCommitEvidence(task: TaskDetail, runId: string, cwd: string): Promise<TaskEvaluationEvidenceBundle["commits"]> {
  const mergeSha = task.mergeDetails?.commitSha;
  if (!mergeSha) return [];

  const command = [
    "git log",
    "--pretty=format:%H%x09%an%x09%aI%x09%s",
    `-n ${EVIDENCE_LIMITS.commits}`,
    mergeSha,
  ].join(" ");
  const res = await runCommandAsync(command, { cwd, timeoutMs: 7_500, maxBuffer: 1024 * 1024 });
  if (res.exitCode !== 0 || !res.stdout.trim()) return [];

  return res.stdout
    .trim()
    .split("\n")
    .map((line, index) => {
      const [sha, authorName, authoredAt, subject] = line.split("\t");
      const { excerpt, truncated } = truncateExcerpt(subject);
      return {
        id: `commit-${sha || index + 1}`,
        source: "commits" as const,
        label: truncateSubject(subject) ?? `commit ${index + 1}`,
        taskId: task.id,
        runId,
        timestamp: authoredAt,
        authoredAt,
        authorName,
        sha,
        subject: truncateSubject(subject),
        excerpt,
        truncated,
      };
    })
    .sort(byChronologicalThenId)
    .slice(-EVIDENCE_LIMITS.commits);
}

function collectDocumentEvidence(taskId: string, runId: string, docs: TaskDocument[]): TaskEvaluationEvidenceBundle["documents"] {
  return docs
    .map((doc, index) => {
      const { excerpt, truncated } = truncateExcerpt(doc.content);
      return {
        id: `doc-${index + 1}`,
        source: "documents" as const,
        label: doc.key,
        taskId,
        runId,
        timestamp: doc.updatedAt,
        documentKey: doc.key,
        revision: doc.revision,
        author: doc.author,
        excerpt,
        truncated,
      };
    })
    .sort(byChronologicalThenId)
    .slice(-EVIDENCE_LIMITS.documents);
}

function collectTaskActivityEvidence(taskId: string, runId: string, entries: TaskLogEntry[]): TaskEvaluationEvidenceBundle["taskActivity"] {
  return entries
    .map((entry, index) => {
      const text = [entry.action, entry.outcome].filter(Boolean).join(" — ");
      const { excerpt, truncated } = truncateExcerpt(text);
      return {
        id: `task-activity-${index + 1}`,
        source: "taskActivity" as const,
        label: entry.action,
        taskId,
        runId,
        timestamp: entry.timestamp,
        activityType: entry.action,
        excerpt,
        truncated,
      };
    })
    .sort(byChronologicalThenId)
    .slice(-EVIDENCE_LIMITS.taskActivity);
}

function collectAgentLogEvidence(taskId: string, runId: string, entries: AgentLogEntry[]): TaskEvaluationEvidenceBundle["agentLogs"] {
  return entries
    .map((entry, index) => {
      const text = `${entry.text}${entry.detail ? ` — ${entry.detail}` : ""}`;
      const { excerpt, truncated } = truncateExcerpt(text);
      return {
        id: `agent-log-${index + 1}`,
        source: "agentLogs" as const,
        label: entry.type,
        taskId,
        runId,
        timestamp: entry.timestamp,
        logType: entry.type,
        agentId: entry.agent,
        excerpt,
        truncated,
      };
    })
    .sort(byChronologicalThenId)
    .slice(-EVIDENCE_LIMITS.agentLogs);
}

function collectRunAuditEvidence(taskId: string, runId: string, events: RunAuditEvent[]): TaskEvaluationEvidenceBundle["runAudit"] {
  return events
    .map((event, index) => {
      const { excerpt, truncated } = truncateExcerpt(`${event.mutationType} ${event.target}`);
      return {
        id: `run-audit-${index + 1}`,
        source: "runAudit" as const,
        label: event.mutationType,
        taskId,
        runId,
        timestamp: event.timestamp,
        eventId: event.id,
        domain: event.domain,
        mutationType: event.mutationType,
        target: event.target,
        excerpt,
        truncated,
      };
    })
    .sort(byChronologicalThenId)
    .slice(-EVIDENCE_LIMITS.runAudit);
}

export async function collectTaskEvaluationEvidence(params: {
  store: TaskStore;
  task: TaskDetail;
  runId: string;
  cwd: string;
}): Promise<TaskEvaluationEvidenceBundle> {
  const { store, task, runId, cwd } = params;
  const [documents, agentLogs] = await Promise.all([
    store.getTaskDocuments(task.id),
    store.getAgentLogs(task.id, { limit: EVIDENCE_LIMITS.agentLogs }),
  ]);
  const commitEvidence = await collectCommitEvidence(task, runId, cwd);
  const workflow = (task.workflowStepResults ?? [])
    .map((step, index) => {
      const { excerpt, truncated } = truncateExcerpt(step.output);
      return {
        id: `workflow-${index + 1}`,
        source: "workflow" as const,
        label: step.workflowStepName,
        taskId: task.id,
        runId,
        timestamp: step.completedAt ?? step.startedAt,
        workflowStepId: step.workflowStepId,
        stepName: step.workflowStepName,
        status: step.status,
        excerpt,
        truncated,
      };
    })
    .sort(byChronologicalThenId)
    .slice(-EVIDENCE_LIMITS.workflow);

  const reviews = (task.log ?? [])
    .filter((entry) => /review/i.test(entry.action))
    .map((entry, index) => {
      const { excerpt, truncated } = truncateExcerpt(entry.outcome);
      return {
        id: `review-${index + 1}`,
        source: "reviews" as const,
        label: entry.action,
        taskId: task.id,
        runId,
        timestamp: entry.timestamp,
        verdict: entry.outcome,
        excerpt,
        truncated,
      };
    })
    .sort(byChronologicalThenId)
    .slice(-EVIDENCE_LIMITS.reviews);

  const taskMetadataExcerpt = truncateExcerpt(task.summary ?? task.description);

  return {
    taskId: task.id,
    runId,
    sourceOrder: TASK_EVALUATION_EVIDENCE_SOURCE_ORDER,
    taskMetadata: [{
      id: "task-metadata-1",
      source: "taskMetadata",
      label: task.title ?? task.id,
      taskId: task.id,
      runId,
      timestamp: task.updatedAt,
      summary: taskMetadataExcerpt.excerpt,
      excerpt: taskMetadataExcerpt.excerpt,
      truncated: taskMetadataExcerpt.truncated,
      references: {
        prNumber: task.prInfo?.number,
        prUrl: task.prInfo?.url,
        mergeCommitSha: task.mergeDetails?.commitSha,
        mergeCompletedAt: task.mergeDetails?.mergedAt,
        executionStartedAt: task.executionStartedAt,
        executionCompletedAt: task.executionCompletedAt,
      },
      retryMetrics: {
        mergeRetries: task.mergeRetries ?? 0,
        workflowStepRetries: task.workflowStepRetries ?? 0,
        stuckKillCount: task.stuckKillCount ?? 0,
        postReviewFixCount: task.postReviewFixCount ?? 0,
        recoveryRetryCount: task.recoveryRetryCount ?? 0,
        taskDoneRetryCount: task.taskDoneRetryCount ?? 0,
        verificationFailureCount: task.verificationFailureCount ?? 0,
        mergeConflictBounceCount: task.mergeConflictBounceCount ?? 0,
        mergeAuditBounceCount: task.mergeAuditBounceCount ?? 0,
        mergeTransientRetryCount: task.mergeTransientRetryCount ?? 0,
      },
    }],
    commits: commitEvidence,
    workflow,
    reviews,
    documents: collectDocumentEvidence(task.id, runId, documents),
    taskActivity: collectTaskActivityEvidence(task.id, runId, task.log ?? []),
    agentLogs: collectAgentLogEvidence(task.id, runId, agentLogs),
    runAudit: collectRunAuditEvidence(task.id, runId, await store.getRunAuditEventsAsync({ taskId: task.id, limit: EVIDENCE_LIMITS.runAudit })),
  };
}
