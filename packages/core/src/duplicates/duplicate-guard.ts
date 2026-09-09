import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";
import { computeContentFingerprint } from "./duplicate-detection.js";
import { isNearDuplicateCanonicalInactive } from "./near-duplicate-canonical.js";
import { resolveNearDuplicateCanonicalFlags } from "./near-duplicate-canonical-flags.js";

/*
FNXC:TaskCreationDeduplication 2026-07-26-06:45:
The window must outlive one agent timeout-and-retry cycle, not one request.

Incident: an agent fired five parallel fn_task_create calls, reported them as timed out, and
retried them sequentially about two minutes later. The originals had committed, but the retries
landed outside the old 60s window, so the exact-content guard saw nothing and the board took ten
tasks instead of five. 60s only covered concurrent in-flight creates; a model that pauses to
explain itself and then retries always beat it.

Ten minutes is chosen to span a stalled tool call plus the model's retry turn. False positives stay
cheap and rare: this is an EXACT normalized title+description hash, and a legitimate repeat of
byte-identical content inside ten minutes is a double-submit, not distinct work. Near-duplicate
(paraphrase) matching is unaffected and keeps its own thresholds/windows. The clamp ceiling rises
with it so an explicit caller-supplied window is not silently cut back to five minutes.

FNXC:TaskCreationDeduplication 2026-07-26-07:40:
Exported because the STORE query clamps the window independently. Code review caught that
findRecentTasksByContentFingerprintImpl carried its own `?? 60_000` / `Math.min(300_000, …)`
pair, so widening only this module capped the effective window at five minutes and made the
new ceiling unreachable. Two clamps for one policy is how a window silently under-delivers;
both sites now read these constants.
*/
export const FINGERPRINT_WINDOW_DEFAULT_MS = 600_000;
export const FINGERPRINT_WINDOW_MAX_MS = 3_600_000;
const DEFAULT_WINDOW_MS = FINGERPRINT_WINDOW_DEFAULT_MS;
const MAX_WINDOW_MS = FINGERPRINT_WINDOW_MAX_MS;
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
  /** When set, only tasks created by this parent can satisfy the duplicate check. */
  sourceParentTaskId?: string | null;
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

function matchesParentScope(task: Task, sourceParentTaskId?: string | null): boolean {
  return !sourceParentTaskId || task.sourceParentTaskId === sourceParentTaskId;
}

async function findActiveDuplicate(
  store: TaskStore,
  candidates: readonly Task[],
  predicate: (task: Task) => boolean,
): Promise<Task | undefined> {
  for (const candidate of candidates) {
    if (!predicate(candidate)) continue;
    const flags = await resolveNearDuplicateCanonicalFlags(store, candidate);
    if (!isNearDuplicateCanonicalInactive(candidate, flags)) return candidate;
  }
  return undefined;
}

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
      const deterministicConflict = await findActiveDuplicate(store, deterministicMatches, (match) =>
        matchesParentScope(match, opts?.sourceParentTaskId) && !acknowledged.has(match.id),
      );
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

  const lockKey = `${opts.lockScope}:${opts.sourceParentTaskId ?? "*"}:${opts.serializationKey ?? fingerprint}`;
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
    const deterministicConflict = await findActiveDuplicate(store, deterministicMatches, (match) =>
      matchesParentScope(match, opts.sourceParentTaskId) && !acknowledged.has(match.id),
    );
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
    sourceParentTaskId?: string | null;
    logger?: { warn(msg: string, data?: Record<string, unknown>): void };
    /** Choose whether a claimed bootstrap duplicate stays visible or is soft-deleted. */
    onDuplicate?: (canonical: Task) => Promise<"keep-created" | "remove-created">;
  },
): Promise<{ outcome: "kept" | "removed" | "kept-duplicate"; canonical: Task }> {
  if (!args.fingerprint) {
    return { outcome: "kept", canonical: args.createdTask };
  }

  try {
    const siblings = await store.findRecentTasksByContentFingerprint(args.fingerprint, {
      windowMs: clampWindowMs(args.windowMs),
      includeArchived: false,
    });

    const olderSibling = await findActiveDuplicate(store, siblings, (sibling) =>
      sibling.id !== args.createdTask.id
      && sibling.createdAt < args.createdTask.createdAt
      && matchesParentScope(sibling, args.sourceParentTaskId),
    );
    if (!olderSibling) {
      return { outcome: "kept", canonical: args.createdTask };
    }

    /*
    FNXC:MissionAdmission 2026-07-23-20:00:
    A defined-feature bootstrap has already transactionally made its inserted
    task feature.taskId. Let that caller reconcile the older sibling without
    routing the generic duplicate path through an archive of the claimed row.
    */
    if (await args.onDuplicate?.(olderSibling) === "keep-created") {
      return { outcome: "kept-duplicate", canonical: args.createdTask };
    }

    await store.updateTask(args.createdTask.id, {
      sourceMetadataPatch: {
        contentFingerprint: args.fingerprint,
        deterministicDuplicateOf: olderSibling.id,
      },
    });
    /*
    FNXC:TaskArchiveRemoval 2026-09-04-10:36:
    A deterministic duplicate is not completed work. With task archiving removed, preserve its
    reserved identity and duplicate provenance through the ordinary non-resurrectable soft-delete
    path instead of inventing a terminal lane.
    */
    await store.deleteTask(args.createdTask.id, { allowResurrection: false });

    return { outcome: "removed", canonical: olderSibling };
  } catch (error) {
    args.logger?.warn("Deterministic duplicate reconciliation failed; keeping created task", {
      taskId: args.createdTask.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: "kept", canonical: args.createdTask };
  }
}
