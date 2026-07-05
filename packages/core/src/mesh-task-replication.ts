import type { MeshReplicatedTaskCreatePayload, Task, TaskCreateInput, TaskDetail, TaskSource } from "./types.js";

export function buildBootstrapPrompt(taskId: string, title: string | undefined, description: string): string {
  const heading = title ? `${taskId}: ${title}` : taskId;
  return `# ${heading}\n\n${description}\n`;
}

export function buildMeshReplicatedTaskCreatePayload(input: {
  taskId: string;
  reservationId: string;
  sourceNodeId: string;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  createInput: TaskCreateInput;
}): MeshReplicatedTaskCreatePayload {
  return {
    replicationVersion: 1,
    reservationId: input.reservationId,
    taskId: input.taskId,
    sourceNodeId: input.sourceNodeId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    prompt: input.prompt,
    input: input.createInput,
  };
}

function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneUndefined(entry)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function normalizeCreateInput(input: TaskCreateInput): TaskCreateInput {
  const source = input.source;
  return pruneUndefined({
    ...input,
    column: input.column ?? "triage",
    source: source
      ? {
        ...source,
        sourceType: source.sourceType ?? "unknown",
      }
      : { sourceType: "unknown" as const },
    dependencies: input.dependencies ?? [],
    enabledWorkflowSteps: input.enabledWorkflowSteps ?? [],
  });
}

function toTaskSource(source: Omit<TaskSource, "sourceType"> & { sourceType?: TaskSource["sourceType"] }): TaskSource {
  return {
    ...source,
    sourceType: source.sourceType ?? "unknown",
  };
}

function isSubsetEqual(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((entry, index) => isSubsetEqual(entry, actual[index]));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    return Object.entries(expectedRecord).every(([key, value]) => isSubsetEqual(value, actualRecord[key]));
  }
  return Object.is(expected, actual);
}

export function taskMatchesReplicatedCreate(existing: TaskDetail, payload: MeshReplicatedTaskCreatePayload): boolean {
  const existingPrompt = existing.prompt;
  const existingCreateInput: TaskCreateInput = {
    title: existing.title,
    description: existing.description,
    column: existing.column,
    dependencies: existing.dependencies,
    breakIntoSubtasks: existing.breakIntoSubtasks,
    enabledWorkflowSteps: existing.enabledWorkflowSteps,
    modelPresetId: existing.modelPresetId,
    modelProvider: existing.modelProvider,
    modelId: existing.modelId,
    validatorModelProvider: existing.validatorModelProvider,
    validatorModelId: existing.validatorModelId,
    planningModelProvider: existing.planningModelProvider,
    planningModelId: existing.planningModelId,
    thinkingLevel: existing.thinkingLevel,
    missionId: existing.missionId,
    sliceId: existing.sliceId,
    assignedAgentId: existing.assignedAgentId,
    nodeId: existing.nodeId,
    assigneeUserId: existing.assigneeUserId,
    reviewLevel: existing.reviewLevel,
    executionMode: existing.executionMode,
    plannerOversightLevel: existing.plannerOversightLevel,
    priority: existing.priority,
    sourceIssue: existing.sourceIssue,
    source: toTaskSource({
      sourceType: existing.sourceType,
      sourceAgentId: existing.sourceAgentId,
      sourceRunId: existing.sourceRunId,
      sourceSessionId: existing.sourceSessionId,
      sourceMessageId: existing.sourceMessageId,
      sourceParentTaskId: existing.sourceParentTaskId,
      sourceMetadata: existing.sourceMetadata,
    }),
    baseBranch: existing.baseBranch,
    branch: existing.branch,
  };

  return (
    existing.id === payload.taskId &&
    existing.createdAt === payload.createdAt &&
    existing.updatedAt === payload.updatedAt &&
    existingPrompt === payload.prompt &&
    isSubsetEqual(normalizeCreateInput(payload.input), normalizeCreateInput(existingCreateInput))
  );
}

export function replicationCollisionError(taskId: string): Error {
  return new Error(`Replicated task payload collision for existing task ${taskId}`);
}

export function toReplicatedCreateInput(task: Task): TaskCreateInput {
  return {
    title: task.title,
    description: task.description,
    column: task.column,
    dependencies: task.dependencies,
    breakIntoSubtasks: task.breakIntoSubtasks,
    enabledWorkflowSteps: task.enabledWorkflowSteps,
    modelPresetId: task.modelPresetId,
    modelProvider: task.modelProvider,
    modelId: task.modelId,
    validatorModelProvider: task.validatorModelProvider,
    validatorModelId: task.validatorModelId,
    planningModelProvider: task.planningModelProvider,
    planningModelId: task.planningModelId,
    thinkingLevel: task.thinkingLevel,
    missionId: task.missionId,
    sliceId: task.sliceId,
    assignedAgentId: task.assignedAgentId,
    nodeId: task.nodeId,
    assigneeUserId: task.assigneeUserId,
    reviewLevel: task.reviewLevel,
    executionMode: task.executionMode,
    plannerOversightLevel: task.plannerOversightLevel,
    priority: task.priority,
    sourceIssue: task.sourceIssue,
    source: toTaskSource({
      sourceType: task.sourceType,
      sourceAgentId: task.sourceAgentId,
      sourceRunId: task.sourceRunId,
      sourceSessionId: task.sourceSessionId,
      sourceMessageId: task.sourceMessageId,
      sourceParentTaskId: task.sourceParentTaskId,
      sourceMetadata: task.sourceMetadata,
    }),
    baseBranch: task.baseBranch,
    branch: task.branch,
  };
}
