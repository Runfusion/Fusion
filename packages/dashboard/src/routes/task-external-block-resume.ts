import {
  buildTaskExternalBlockClearPatch,
  computeWorkflowIrPin,
  emitBoundedRunAudit,
  isTaskExternallyBlocked,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
  type WorkflowWorkItem,
} from "@fusion/core";
import { generateSyntheticRunId, resolveColumnResumeNode } from "@fusion/engine";
import { conflict, notFound } from "../api-error.js";

const EXTERNAL_BLOCK_RESUME_RUN_SEGMENT = ":external-block-resume:";

type ExternalBlockResumeStore = TaskStore & {
  listWorkflowWorkItemsForTask(taskId: string): Promise<WorkflowWorkItem[]>;
};

export type ResumeExternallyBlockedTaskResult =
  | { kind: "not-blocked" }
  | { kind: "resumed"; task: Task; nodeId: string };

function isPendingExternalBlockResume(item: WorkflowWorkItem): boolean {
  return item.kind === "task"
    && (item.state === "runnable" || item.state === "running" || item.state === "held")
    && typeof item.runId === "string"
    && item.runId.includes(EXTERNAL_BLOCK_RESUME_RUN_SEGMENT);
}

/*
FNXC:ExternalBlockResume 2026-08-28-04:56:
Retry for an external block is a continuation publication, never a stage restart. It retains every
implementation artifact, keeps the durable pause raised until the successor continuation exists,
and refuses a duplicate request while that continuation is still pending so rapid operator clicks
cannot replay or discard the interrupted step.
*/
export async function resumeExternallyBlockedTask(params: {
  store: ExternalBlockResumeStore;
  taskId: string;
}): Promise<ResumeExternallyBlockedTaskResult> {
  const { store, taskId } = params;
  return store.withPlanningLifecycleLock(taskId, async () => {
    const task = await store.getTask(taskId);
    if (!task) throw notFound(`Task ${taskId} not found`);

    const existingItems = await store.listWorkflowWorkItemsForTask(taskId);
    if (!isTaskExternallyBlocked(task)) {
      if (existingItems.some(isPendingExternalBlockResume)) {
        throw conflict("External-block Retry has already resumed this task");
      }
      return { kind: "not-blocked" };
    }

    const externalBlock = task.externalBlock;
    if (!externalBlock) throw conflict("External-block Retry requires durable obstacle metadata");
    const ir = await resolveWorkflowIrForTask(store, task.id);
    const resumeNode = externalBlock.resume.nodeId
      ? ir.nodes.find((node) => node.id === externalBlock.resume.nodeId)
      : resolveColumnResumeNode(ir, externalBlock.resume.column);
    if (!resumeNode) {
      throw conflict(`External-block Retry cannot resolve a workflow node for column ${externalBlock.resume.column}`);
    }

    const continuationSequence = existingItems.length;
    const runId = `${taskId}${EXTERNAL_BLOCK_RESUME_RUN_SEGMENT}${resumeNode.id}:${continuationSequence}`;

    // Publish the successor behind the still-intact external-block fence.
    await store.replaceActiveTaskWorkflowContinuation({
      taskId,
      nodeId: resumeNode.id,
      kind: "task",
      state: "runnable",
      waitReason: null,
      blockedReason: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      retryAfter: null,
      sourceColumn: task.column,
      targetColumn: task.column,
      continuationSequence,
      stableWorkflowRunId: `${taskId}:${ir.name}`,
      runId,
      irHash: computeWorkflowIrPin(ir, resumeNode.id).irHash,
    });

    // The continuation now owns resumption, so the obstacle and durable pause can clear together.
    await store.updateTask(taskId, buildTaskExternalBlockClearPatch());
    await store.logEntry(taskId, `External block cleared by dashboard Retry; resuming workflow at ${resumeNode.id}`);
    void emitBoundedRunAudit(store, {
      taskId,
      agentId: "dashboard-api",
      runId: generateSyntheticRunId("external-block-resume", taskId),
      domain: "database",
      mutationType: "task:external-block-cleared",
      target: taskId,
      metadata: {
        taskId,
        origin: externalBlock.origin,
        code: externalBlock.code,
        source: externalBlock.source,
        column: task.column,
        resumeNodeId: resumeNode.id,
      },
    });

    const updated = await store.getTask(taskId);
    if (!updated) throw notFound(`Task ${taskId} not found after external-block Retry`);
    return { kind: "resumed", task: updated, nodeId: resumeNode.id };
  });
}
