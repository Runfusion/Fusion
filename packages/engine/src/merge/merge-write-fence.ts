/*
FNXC:MergeReliability 2026-08-11-21:12:
An aborted per-claim signal means its merge body no longer owns the task row: a successor owns a
fresh signal. Abort is asynchronous, so ownership is read immediately before each individual
mutation or irreversible action; a closure, loop, or function-entry check cannot cover a later
write, and one checkpoint never covers adjacent writers. Call sites choose their bucket: diagnostic
writes suppress while finalization writes reject and unwind.

The recorder is injected so orphan observability has no ambient state. One best-effort audit row is
emitted at the first fence interaction: suppression emits count 1 and rejection emits count 0.
The running count is intentionally in-process only because unwinding cannot guarantee an end flush.
*/

export type MergeWriteCategory = "log" | "lifecycle" | "finalization" | "audit";
export type MergeFenceInteraction = "suppressed" | "rejected";

export interface OrphanFenceAuditRecorder {
  recordRunAuditEvent(event: {
    type: "merge:orphan-write-fenced";
    taskId: string;
    metadata: { taskId: string; category: MergeWriteCategory; interaction: MergeFenceInteraction; suppressedCount: number };
  }): Promise<unknown> | unknown;
}

export interface MergeWriteFence {
  readonly taskId: string;
  readonly signal: AbortSignal | undefined;
  readonly suppressedCount: number;
  isOrphaned(): boolean;
  write<T>(category: MergeWriteCategory, write: () => Promise<T> | T): Promise<T | undefined>;
  assertOwned(category?: MergeWriteCategory): void;
}

export function createMergeAbortedError(taskId: string): Error {
  const error = new Error(`AI merge aborted for ${taskId}`);
  error.name = "MergeAbortedError";
  return error;
}

export function isMergeAbortedError(error: unknown): boolean {
  return error instanceof Error && error.name === "MergeAbortedError";
}

export function assertMergeGenerationOwned(signal: AbortSignal | undefined, taskId: string): void {
  if (signal?.aborted === true) throw createMergeAbortedError(taskId);
}

export function createMergeWriteFence(options: {
  taskId: string;
  signal?: AbortSignal;
  recordAudit?: OrphanFenceAuditRecorder | ((category: MergeWriteCategory, interaction: MergeFenceInteraction, suppressedCount: number) => Promise<unknown> | unknown);
}): MergeWriteFence {
  let suppressedCount = 0;
  let auditEmitted = false;
  const emit = (category: MergeWriteCategory, interaction: MergeFenceInteraction): void => {
    if (auditEmitted) return;
    auditEmitted = true;
    try {
      const recorder = options.recordAudit;
      const result = typeof recorder === "function"
        ? recorder(category, interaction, suppressedCount)
        : recorder?.recordRunAuditEvent({
          type: "merge:orphan-write-fenced",
          taskId: options.taskId,
          metadata: { taskId: options.taskId, category, interaction, suppressedCount },
        });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Observability must never replace the merge's original outcome.
    }
  };
  return {
    taskId: options.taskId,
    signal: options.signal,
    get suppressedCount() { return suppressedCount; },
    isOrphaned: () => options.signal?.aborted === true,
    async write<T>(category: MergeWriteCategory, write: () => Promise<T> | T): Promise<T | undefined> {
      if (options.signal?.aborted === true) {
        suppressedCount += 1;
        emit(category, "suppressed");
        return undefined;
      }
      return await write();
    },
    assertOwned(category: MergeWriteCategory = "finalization"): void {
      if (options.signal?.aborted === true) {
        emit(category, "rejected");
        throw createMergeAbortedError(options.taskId);
      }
    },
  };
}
