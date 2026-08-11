import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { storeLog, type TaskStore } from "../store.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { findLiveLineageChildren, LineageEvidenceAppendError } from "./async/async-lifecycle.js";

/** A raced-in child must be locked on a fresh attempt rather than cleared unlocked. */
class CandidateChanged extends Error {}
export class LineageInvalidationCandidateRaceError extends Error {
  constructor(readonly parentId: string) { super(`Lineage children changed while invalidating ${parentId}`); this.name = "LineageInvalidationCandidateRaceError"; }
}
export { LineageEvidenceAppendError };

export type LineageInvalidationOutcome = {
  attempt: number;
  locksHeld: boolean;
  degraded: boolean;
  candidateIds: readonly string[];
  clearedChildIds: readonly string[];
  evidenceVersionByChild: ReadonlyMap<string, number>;
  evidenceUnavailableChildIds: readonly string[];
  evidenceInsertAttempts: number;
  error?: "candidate-race-sentinel" | "evidence-append" | "gate-rejected" | "other";
};

export type LineageInvalidationTestEvent =
  | { kind: "probe"; attempt: number }
  | { kind: "acquire"; attempt: number; childIds: readonly string[] }
  | { kind: "release"; attempt: number; childIds: readonly string[] }
  | { kind: "run"; attempt: number; candidateIds: readonly string[]; locksHeld: boolean; degraded: boolean }
  | { kind: "outcome"; outcome: LineageInvalidationOutcome }
  | { kind: "run-error"; attempt: number; error: unknown }
  | { kind: "reconcile"; childId: string };

type LineageInvalidationTestSeam = {
  availability?: () => { available: true } | { available: false; reason: string };
  withLocks?: <T>(ids: readonly string[], callback: () => Promise<T>) => Promise<T>;
  reconcile?: (childId: string) => Promise<void>;
  /** Test-only deterministic target collision injection for transactional evidence coverage. */
  evidenceTargetVersionForTest?: (childId: string, computed: number, attempt: number) => number;
  onEvent?: (event: LineageInvalidationTestEvent) => void;
};

function testSeam(store: TaskStore): LineageInvalidationTestSeam | undefined {
  return (store as unknown as { __lineageInvalidationForTest?: LineageInvalidationTestSeam }).__lineageInvalidationForTest;
}

/*
FNXC:SpecLockLineageInvalidation 2026-08-10-15:35:
Evidence version collisions cannot be produced by pre-seeding the next version because the
transaction derives its target from MAX(version). Expose only this inert deterministic seam so the
retry and rollback terminals are regression-tested without weakening production conflict handling.
*/
export function lineageEvidenceTargetVersionForTest(store: TaskStore):
  | ((childId: string, computed: number, attempt: number) => number)
  | undefined {
  return testSeam(store)?.evidenceTargetVersionForTest;
}

/*
FNXC:SpecLockLineageInvalidation 2026-08-10-15:15:
Delete/archive return only their parent result, so the per-attempt child clear, durable-evidence,
and error facts would otherwise be untestable. Publish this inert test seam after the transaction
and before reconciliation, preserving the required acquire → outcome → reconcile → release order.
*/
export function recordLineageInvalidationOutcome(store: TaskStore, outcome: LineageInvalidationOutcome): void {
  testSeam(store)?.onEvent?.({ kind: "outcome", outcome });
}

export function classifyLineageInvalidationOutcomeError(error: unknown): LineageInvalidationOutcome["error"] {
  if (error instanceof CandidateChanged) return "candidate-race-sentinel";
  if (error instanceof LineageEvidenceAppendError) return "evidence-append";
  return "other";
}

export async function resolveLineageInvalidationCandidates(layer: AsyncDataLayer, parentId: string, archivedColumns: ReadonlySet<string> | undefined): Promise<string[]> {
  return (await findLiveLineageChildren(layer.db, parentId, layer.projectId, archivedColumns)).sort();
}
export async function readLineagePromptMap(store: TaskStore, childIds: readonly string[]): Promise<Map<string, string>> {
  const prompts = new Map<string, string>();
  await Promise.all(childIds.map(async (childId) => {
    try { prompts.set(childId, await readFile(join(store.taskDir(childId), "PROMPT.md"), "utf8")); } catch { /* Missing plans are the explicitly supported evidence-unavailable case. */ }
  }));
  return prompts;
}
export function assertLineageCandidatesUnchanged(inTransactionChildIds: readonly string[], candidateIds: readonly string[]): void {
  const candidates = new Set(candidateIds);
  if (inTransactionChildIds.some((id) => !candidates.has(id))) throw new CandidateChanged();
}
export async function resolveAndAssertLineageCandidatesUnchanged(tx: DbTransaction, parentId: string, projectId: string | undefined, archivedColumns: ReadonlySet<string> | undefined, candidateIds: readonly string[]): Promise<string[]> {
  const live = await findLiveLineageChildren(tx, parentId, projectId, archivedColumns);
  assertLineageCandidatesUnchanged(live, candidateIds);
  return live;
}

/**
 * FNXC:SpecLockLineageInvalidation 2026-08-10-14:33:
 * Enter on the remove-lineage flag even with no candidates: archive discovers children in its
 * transaction, so an empty pre-read still needs revalidation. A structural pooler-only transport
 * may omit serialization, but a runtime lock failure propagates before the mutation body.
 */
export async function runLineageInvalidation<T>(
  store: TaskStore,
  parentId: string,
  input: { archivedColumns: ReadonlySet<string> | undefined; initialCandidateIds?: readonly string[] },
  run: (context: { candidateIds: string[]; promptByChildId: ReadonlyMap<string, string>; locksHeld: boolean; attempt: number }) => Promise<T>,
): Promise<T> {
  const layer = store.asyncLayer!;
  const seam = testSeam(store);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidateIds = (attempt === 0 && input.initialCandidateIds !== undefined ? [...input.initialCandidateIds] : await resolveLineageInvalidationCandidates(layer, parentId, input.archivedColumns)).sort();
    const invoke = async (locksHeld: boolean, degraded: boolean, promptByChildId: ReadonlyMap<string, string>): Promise<T> => {
      seam?.onEvent?.({ kind: "run", attempt, candidateIds, locksHeld, degraded });
      try {
        return await run({ candidateIds, promptByChildId, locksHeld, attempt });
      } catch (error) {
        seam?.onEvent?.({ kind: "run-error", attempt, error });
        throw error;
      }
    };
    try {
      if (candidateIds.length === 0) return await invoke(false, false, new Map());
      const promptByChildId = await readLineagePromptMap(store, candidateIds);
      seam?.onEvent?.({ kind: "probe", attempt });
      const availability = seam?.availability?.() ?? store.planningLifecycleLockTransportAvailability();
      if (!availability.available) {
        /*
        FNXC:SpecLockLineageInvalidation 2026-08-10-15:22:
        A pooler-only deployment deliberately degrades serialization, not durable invalidation.
        Warn once per operation so operators can distinguish that sanctioned path from a contention
        failure, which must still reject before the mutation body.
        */
        storeLog.warn(`[spec-lock] lineage invalidation for ${parentId} runs without planning lifecycle locks for ${candidateIds.length} child(ren): ${availability.reason}`);
        return await invoke(false, true, promptByChildId);
      }
      seam?.onEvent?.({ kind: "acquire", attempt, childIds: candidateIds });
      const withLocks = seam?.withLocks ?? ((ids, callback) => store.withPlanningLifecycleLocks(ids, callback));
      let callbackEntered = false;
      try {
        return await withLocks(candidateIds, () => {
          callbackEntered = true;
          return invoke(true, false, promptByChildId);
        });
      } finally {
        // Acquisition failures run no body and therefore own no observable callback lock window.
        if (callbackEntered) seam?.onEvent?.({ kind: "release", attempt, childIds: candidateIds });
      }
    } catch (error) {
      if (!(error instanceof CandidateChanged)) throw error;
      if (attempt === 1) throw new LineageInvalidationCandidateRaceError(parentId);
    }
  }
  throw new LineageInvalidationCandidateRaceError(parentId);
}

/** Publish after commit but before the multi-key callback releases child planning locks. */
export async function reconcileClearedLineageChildren(store: TaskStore, childIds: readonly string[], _context: { locksHeld: boolean }): Promise<void> {
  const seam = testSeam(store);
  for (const childId of [...new Set(childIds)].sort()) {
    seam?.onEvent?.({ kind: "reconcile", childId });
    await (seam?.reconcile?.(childId)
      ?? store.reconcileSpecDriftWhilePlanningLocked({ id: childId, approvedPlanFingerprint: undefined, modifiedFiles: [] }))
      .catch((error: unknown) => {
        // Report publication is retryable telemetry, but an operator still needs the failed child id.
        storeLog.warn(`[spec-lock] deferred lineage drift reconciliation for ${childId}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
}
