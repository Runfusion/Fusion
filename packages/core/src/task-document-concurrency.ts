import { createHash } from "node:crypto";

export const TASK_DOCUMENT_PRECONDITION_FAILED = "TASK_DOCUMENT_PRECONDITION_FAILED" as const;
export const TASK_DOCUMENT_CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface TaskDocumentPreconditionState {
  projectId: string;
  taskId: string;
  key: string;
  expectedRevision?: number;
  expectedContentHash?: string;
  currentRevision: number | null;
  currentContentHash: string | null;
}

/**
 * FNXC:TaskDocumentCAS 2026-07-20-11:06:
 * Conditional document publication compares deterministic projections of the exact UTF-8 content. Whitespace and line endings are significant. Revision zero means the document must be absent; positive revisions and every hash expectation require an existing exact match. When both expectations are supplied, both must match. Omitted expectations retain the legacy unconditional write contract.
 */
export function taskDocumentContentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function validateTaskDocumentPreconditions(input: {
  expectedRevision?: number;
  expectedContentHash?: string;
}): void {
  if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new TypeError("expectedRevision must be a non-negative integer");
  }
  if (input.expectedContentHash !== undefined && !TASK_DOCUMENT_CONTENT_HASH_PATTERN.test(input.expectedContentHash)) {
    throw new TypeError("expectedContentHash must use the format sha256:<64 lowercase hex characters>");
  }
}

export class TaskDocumentPreconditionFailedError extends Error {
  readonly code = TASK_DOCUMENT_PRECONDITION_FAILED;
  readonly projectId: string;
  readonly taskId: string;
  readonly key: string;
  readonly expectedRevision?: number;
  readonly expectedContentHash?: string;
  readonly currentRevision: number | null;
  readonly currentContentHash: string | null;

  constructor(state: TaskDocumentPreconditionState) {
    super(`Task document precondition failed for ${state.taskId}/${state.key}`);
    this.name = "TaskDocumentPreconditionFailedError";
    this.projectId = state.projectId;
    this.taskId = state.taskId;
    this.key = state.key;
    this.expectedRevision = state.expectedRevision;
    this.expectedContentHash = state.expectedContentHash;
    this.currentRevision = state.currentRevision;
    this.currentContentHash = state.currentContentHash;
  }

  toDetails(): TaskDocumentPreconditionState & { code: typeof TASK_DOCUMENT_PRECONDITION_FAILED } {
    return {
      code: this.code,
      projectId: this.projectId,
      taskId: this.taskId,
      key: this.key,
      expectedRevision: this.expectedRevision,
      expectedContentHash: this.expectedContentHash,
      currentRevision: this.currentRevision,
      currentContentHash: this.currentContentHash,
    };
  }
}

export function assertTaskDocumentPreconditions(
  identity: Pick<TaskDocumentPreconditionState, "projectId" | "taskId" | "key">,
  expected: Pick<TaskDocumentPreconditionState, "expectedRevision" | "expectedContentHash">,
  current: { revision: number; content: string } | null,
): void {
  validateTaskDocumentPreconditions(expected);
  const currentRevision = current?.revision ?? null;
  const currentContentHash = current ? taskDocumentContentHash(current.content) : null;
  const revisionMatches = expected.expectedRevision === undefined
    || (expected.expectedRevision === 0 ? current === null : currentRevision === expected.expectedRevision);
  const hashMatches = expected.expectedContentHash === undefined
    || (current !== null && currentContentHash === expected.expectedContentHash);
  if (!revisionMatches || !hashMatches) {
    throw new TaskDocumentPreconditionFailedError({
      ...identity,
      ...expected,
      currentRevision,
      currentContentHash,
    });
  }
}
