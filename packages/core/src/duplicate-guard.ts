import type { Task } from "./types.js";
import type { TaskStore } from "./store.js";
import { computeContentFingerprint } from "./duplicate-detection.js";

const DEFAULT_WINDOW_MS = 60_000;
const MAX_WINDOW_MS = 300_000;
export const deterministicGuardLocks = new Map<string, Promise<void>>();

// Test-only compatibility hook used by dashboard deterministic-dedup route tests.
export const __deterministicGuardLocksForTests = deterministicGuardLocks;

export interface DeterministicGuardOptions {
  windowMs?: number;
  lockScope?: string;
  acknowledgedDuplicates?: readonly string[];
  bypass?: boolean;
  logger?: { warn(msg: string, data?: Record<string, unknown>): void };
  /** Serialize related creates even when their exact-content fingerprints differ. */
  serializationKey?: string;
}

export interface DeterministicGuardOutcome {
  action: "proceed" | "duplicate";
  fingerprint: string | null;
  existing?: Task;
  releaseLock: () => void;
}

export function __getDeterministicGuardMutexSize(): number {
  return deterministicGuardLocks.size;
}

function clampWindowMs(windowMs?: number): number {
  const requested = windowMs ?? DEFAULT_WINDOW_MS;
  return Math.max(1, Math.min(MAX_WINDOW_MS, Math.trunc(requested)));
}

function noop(): void {}

export async function runDeterministicDuplicateGuard(
  store: TaskStore,
  input: { title?: string | null; description: string },
  opts?: DeterministicGuardOptions,
): Promise<DeterministicGuardOutcome> {
  const fingerprint = computeContentFingerprint(input);
  if (opts?.bypass === true || !fingerprint) {
    return { action: "proceed", fingerprint, releaseLock: noop };
  }

  const acknowledged = new Set(opts?.acknowledgedDuplicates ?? []);
  const windowMs = clampWindowMs(opts?.windowMs);

  if (!opts?.lockScope) {
    try {
      const deterministicMatches = await store.findRecentTasksByContentFingerprint(fingerprint, {
        windowMs,
        includeArchived: false,
      });
      const deterministicConflict = deterministicMatches.find((match) => !acknowledged.has(match.id));
      if (deterministicConflict) {
        return { action: "duplicate", fingerprint, existing: deterministicConflict, releaseLock: noop };
      }
    } catch (error) {
      opts?.logger?.warn("Deterministic duplicate pre-check failed; proceeding", {
        contentFingerprint: fingerprint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { action: "proceed", fingerprint, releaseLock: noop };
  }

  const lockKey = `${opts.lockScope}:${opts.serializationKey ?? fingerprint}`;
  const existingLock = deterministicGuardLocks.get(lockKey);
  let releaseCalled = false;
  let resolveGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  // Install our tail before waiting so three or more callers form a queue
  // instead of all waking and proceeding when the first holder releases.
  deterministicGuardLocks.set(lockKey, gate);
  if (existingLock) {
    try {
      await existingLock;
    } catch (error) {
      opts?.logger?.warn("Deterministic duplicate pre-check failed; proceeding", {
        lockKey,
        contentFingerprint: fingerprint,
        error: error instanceof Error ? error.message : String(error),
      });
      if (deterministicGuardLocks.get(lockKey) === gate) deterministicGuardLocks.delete(lockKey);
    }
  }

  const releaseLock = () => {
    if (releaseCalled) {
      return;
    }
    releaseCalled = true;
    resolveGate?.();
    if (deterministicGuardLocks.get(lockKey) === gate) deterministicGuardLocks.delete(lockKey);
  };

  try {
    const deterministicMatches = await store.findRecentTasksByContentFingerprint(fingerprint, {
      windowMs,
      includeArchived: false,
    });
    const deterministicConflict = deterministicMatches.find((match) => !acknowledged.has(match.id));
    if (deterministicConflict) {
      return { action: "duplicate", fingerprint, existing: deterministicConflict, releaseLock };
    }
  } catch (error) {
    opts?.logger?.warn("Deterministic duplicate pre-check failed; proceeding", {
      lockKey,
      contentFingerprint: fingerprint,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { action: "proceed", fingerprint, releaseLock };
}

export async function reconcileDeterministicDuplicate(
  store: TaskStore,
  args: {
    createdTask: Task;
    fingerprint: string | null;
    windowMs?: number;
    logger?: { warn(msg: string, data?: Record<string, unknown>): void };
  },
): Promise<{ outcome: "kept" | "archived"; canonical: Task }> {
  if (!args.fingerprint) {
    return { outcome: "kept", canonical: args.createdTask };
  }

  try {
    const siblings = await store.findRecentTasksByContentFingerprint(args.fingerprint, {
      windowMs: clampWindowMs(args.windowMs),
      includeArchived: false,
    });

    const olderSibling = siblings.find((sibling) => sibling.id !== args.createdTask.id && sibling.createdAt < args.createdTask.createdAt);
    if (!olderSibling) {
      return { outcome: "kept", canonical: args.createdTask };
    }

    await store.updateTask(args.createdTask.id, {
      sourceMetadataPatch: {
        contentFingerprint: args.fingerprint,
        deterministicDuplicateOf: olderSibling.id,
      },
    });
    await store.moveTask(args.createdTask.id, "archived");

    try {
      await store.recordActivity({
        type: "task:auto-archived-deterministic-duplicate",
        taskId: args.createdTask.id,
        taskTitle: args.createdTask.title,
        details: `Auto-archived as deterministic duplicate of ${olderSibling.id}`,
        metadata: { canonicalTaskId: olderSibling.id, contentFingerprint: args.fingerprint },
      });
    } catch (error) {
      args.logger?.warn("Failed to record deterministic-duplicate activity", {
        taskId: args.createdTask.id,
        canonicalTaskId: olderSibling.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { outcome: "archived", canonical: olderSibling };
  } catch (error) {
    args.logger?.warn("Deterministic duplicate reconciliation failed; keeping created task", {
      taskId: args.createdTask.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: "kept", canonical: args.createdTask };
  }
}
