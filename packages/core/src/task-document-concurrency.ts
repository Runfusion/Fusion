import { createHash } from "node:crypto";

export const TASK_DOCUMENT_PRECONDITION_FAILED = "TASK_DOCUMENT_PRECONDITION_FAILED" as const;
export const TASK_DOCUMENT_CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const ARCHIVED_TASK_DOCUMENT_ADDITION_BOUNDARY = "\n\n";
export const ARCHIVED_TASK_DOCUMENT_PUBLICATION_REJECTED = "ARCHIVED_TASK_DOCUMENT_PUBLICATION_REJECTED" as const;

export type ArchivedTaskDocumentPublicationRejection =
  | "parent-not-found"
  | "document-not-found"
  | "parent-not-archived"
  | "archived-state-inconsistent"
  | "postgres-required";

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

/**
 * FNXC:ArchivedTaskDocumentPublication 2026-07-20-15:36:
 * Archived publication requires an existing current row, so revision zero and optional CAS are invalid. Existing and appended strings remain byte-significant; the mutation constructs `existing + "\\n\\n" + appendContent` without trimming or newline normalization.
 */
export function validateArchivedTaskDocumentAddition(input: {
  appendContent: unknown;
  expectedRevision: unknown;
  expectedContentHash: unknown;
  author: unknown;
  reason: unknown;
}): asserts input is {
  appendContent: string;
  expectedRevision: number;
  expectedContentHash: string;
  author: string;
  reason: string;
} {
  if (typeof input.appendContent !== "string" || input.appendContent.length === 0) {
    throw new TypeError("appendContent must be a non-empty string");
  }
  if (!Number.isInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) {
    throw new TypeError("expectedRevision must be a positive integer");
  }
  if (typeof input.expectedContentHash !== "string" || !TASK_DOCUMENT_CONTENT_HASH_PATTERN.test(input.expectedContentHash)) {
    throw new TypeError("expectedContentHash must use the format sha256:<64 lowercase hex characters>");
  }
  if (typeof input.author !== "string" || input.author.trim().length === 0) {
    throw new TypeError("author must be a non-empty string");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new TypeError("reason must be a non-empty string");
  }
}

export class ArchivedTaskDocumentPublicationRejectedError extends Error {
  readonly code = ARCHIVED_TASK_DOCUMENT_PUBLICATION_REJECTED;

  constructor(
    readonly reason: ArchivedTaskDocumentPublicationRejection,
    readonly projectId: string,
    readonly taskId: string,
    readonly key: string,
  ) {
    super(`Archived task document publication rejected for ${taskId}/${key}: ${reason}`);
    this.name = "ArchivedTaskDocumentPublicationRejectedError";
  }

  toDetails(): {
    code: typeof ARCHIVED_TASK_DOCUMENT_PUBLICATION_REJECTED;
    reason: ArchivedTaskDocumentPublicationRejection;
    projectId: string;
    taskId: string;
    key: string;
  } {
    return { code: this.code, reason: this.reason, projectId: this.projectId, taskId: this.taskId, key: this.key };
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
