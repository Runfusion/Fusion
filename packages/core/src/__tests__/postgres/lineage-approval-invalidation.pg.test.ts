/*
FNXC:SpecLockLineageInvalidation 2026-08-10-14:47:
Parent removal changes a child's canonical lineage binding. The regression covers both lifecycle
surfaces so neither may retain an active approval or report approved alignment after clearing it.
`evaluateSpecDrift` fences reports to the latest current-plan evidence; source hashes include the
canonical plan bindings, and listCurrentPlanEvidence is the row-enumeration API for this harness.

FNXC:SpecLockLineageInvalidation 2026-08-10-15:37:
Evidence-conflict coverage must exercise both legal idempotence shapes: a matching hash may be
latest or historical, so classification must query that hash rather than inspect the latest row.
A deliberately malformed matching snapshot also proves that hash identity never substitutes for
verifying the stored lineage before committing a parent removal.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { storeLog, type TaskStore } from "../../store.js";
import { PlanningLifecycleLockTransportError } from "../../postgres/advisory-locks.js";
import { LineageEvidenceAppendError, type LineageInvalidationTestEvent } from "../../task-store/lineage-approval-invalidation.js";
import { createCurrentPlanEvidence } from "../../planner/spec-lock.js";

const SPEC_LOCK_PROMPT = `# Task

## Mission

Keep lineage scope observable.

## File Scope

- packages/core/src/task-store/async/async-lifecycle.ts

## Steps

1. Preserve evidence

## Completion Criteria

- [ ] Evidence is retained

## Do NOT

- Hide lineage changes

## Dependencies

- None
`;

pgDescribe("lineage approval invalidation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_lineage_approval" });
  let store: TaskStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
    store = h.store();
  });
  afterEach(h.afterEach);

  async function createApprovedLineagePair() {
    const parent = await store.createTask({ description: "parent scope" });
    const child = await store.createTask({
      description: "approved child scope",
      source: { sourceType: "api", sourceParentTaskId: parent.id },
    });
    await writeFile(join(store.taskDir(child.id), "PROMPT.md"), SPEC_LOCK_PROMPT);
    const lock = await store.lockCurrentPlan(child.id, "approved-lineage-scope", SPEC_LOCK_PROMPT);
    await store.updateTask(child.id, { approvedPlanFingerprint: "approved-lineage-scope" });
    return { parent, child, lock };
  }

  it("invalidates approval and publishes a divergent report when parent lineage is removed by delete", async () => {
    const { parent, child, lock } = await createApprovedLineagePair();
    expect(lock.plan.sections.lineage.canonical).toContain(`parent-task:${parent.id}`);
    expect(await store.getActiveSpecLock(child.id)).toBeDefined();

    await store.deleteTask(parent.id, { removeLineageReferences: true });

    const [updated, activeLock, latestLock, evidence, report] = await Promise.all([
      store.getTask(child.id),
      store.getActiveSpecLock(child.id),
      store.getLatestSpecLock(child.id),
      store.getLatestCurrentPlanEvidence(child.id),
      store.getLatestSpecDriftReport(child.id),
    ]);
    expect(updated?.sourceParentTaskId).toBeUndefined();
    expect(updated?.approvedPlanFingerprint).toBeUndefined();
    expect(activeLock).toBeUndefined();
    expect(latestLock?.version).toBe(lock.version);
    expect(evidence?.version).toBeGreaterThan(lock.currentPlanVersion);
    expect(evidence?.plan.sections.lineage.canonical).not.toContain(`parent-task:${parent.id}`);
    expect(report).toEqual(expect.objectContaining({
      alignment: "diverged-needs-review",
      currentPlanVersion: evidence?.version,
    }));
    expect(report?.approvedPlanFingerprint).toBeUndefined();
    expect(report?.alignment).not.toBe("on-plan");
  });

  it("warns when a missing prompt is the sanctioned evidence-unavailable input", async () => {
    const { parent, child } = await createApprovedLineagePair();
    const events: LineageInvalidationTestEvent[] = [];
    const warn = vi.spyOn(storeLog, "warn").mockImplementation(() => undefined);
    (store as unknown as { __lineageInvalidationForTest?: { onEvent: (event: LineageInvalidationTestEvent) => void } }).__lineageInvalidationForTest = {
      onEvent: (event) => events.push(event),
    };
    await rm(join(store.taskDir(child.id), "PROMPT.md"));

    await store.deleteTask(parent.id, { removeLineageReferences: true });

    expect((await store.getTask(child.id))?.approvedPlanFingerprint).toBeUndefined();
    expect(events.find((event) => event.kind === "outcome")).toMatchObject({
      kind: "outcome", outcome: { evidenceUnavailableChildIds: [child.id], evidenceInsertAttempts: 0 },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(child.id));
    warn.mockRestore();
  });

  async function appendPostClearEvidence(childId: string, version: number, prompt = SPEC_LOCK_PROMPT) {
    const evidence = createCurrentPlanEvidence({
      version,
      sourceRevision: Date.now(),
      capturedAt: new Date().toISOString(),
      prompt,
    });
    return await store.appendCurrentPlanEvidence(childId, evidence);
  }

  it("reuses a verified latest matching source-hash evidence row without duplicating it", async () => {
    const { parent, child } = await createApprovedLineagePair();
    const events: LineageInvalidationTestEvent[] = [];
    const existing = await store.listCurrentPlanEvidence(child.id);
    const matching = await appendPostClearEvidence(child.id, existing.at(-1)!.version + 1);
    const before = await store.listCurrentPlanEvidence(child.id);
    expect(matching.plan.sections.lineage.canonical).not.toContain(`parent-task:${parent.id}`);
    (store as unknown as { __lineageInvalidationForTest?: unknown }).__lineageInvalidationForTest = {
      onEvent: (event: LineageInvalidationTestEvent) => events.push(event),
    };

    await store.deleteTask(parent.id, { removeLineageReferences: true });

    expect(await store.listCurrentPlanEvidence(child.id)).toEqual(before);
    expect(events.find((event) => event.kind === "outcome")).toMatchObject({
      kind: "outcome", outcome: { evidenceVersionByChild: new Map([[child.id, matching.version]]), evidenceInsertAttempts: 1 },
    });
  });

  it("resolves a verified stale matching hash instead of comparing only the latest evidence", async () => {
    const { parent, child } = await createApprovedLineagePair();
    const events: LineageInvalidationTestEvent[] = [];
    const original = await store.listCurrentPlanEvidence(child.id);
    const matching = await appendPostClearEvidence(child.id, original.at(-1)!.version + 1);
    const newer = await appendPostClearEvidence(child.id, matching.version + 1, `${SPEC_LOCK_PROMPT}\n\n## Later revision\nDifferent evidence.`);
    const before = await store.listCurrentPlanEvidence(child.id);
    (store as unknown as { __lineageInvalidationForTest?: unknown }).__lineageInvalidationForTest = {
      onEvent: (event: LineageInvalidationTestEvent) => events.push(event),
    };

    await store.deleteTask(parent.id, { removeLineageReferences: true });

    expect(await store.listCurrentPlanEvidence(child.id)).toEqual(before);
    const outcome = events.find((event) => event.kind === "outcome");
    expect(outcome).toMatchObject({
      kind: "outcome", outcome: { evidenceVersionByChild: new Map([[child.id, matching.version]]), evidenceInsertAttempts: 1 },
    });
    const report = await store.getLatestSpecDriftReport(child.id);
    // The report fences to the latest row; the durable idempotence row may be older.
    expect(report?.currentPlanVersion).toBe(newer.version);
    expect(report?.alignment).toBe("diverged-needs-review");
  });

  it("rolls back an untruthful matching-hash row instead of accepting it by hash alone", async () => {
    const { parent, child } = await createApprovedLineagePair();
    const existing = await store.listCurrentPlanEvidence(child.id);
    const postClearPrompt = `${SPEC_LOCK_PROMPT}\n\n## Truthfulness fixture\nUnique source identity.`;
    await writeFile(join(store.taskDir(child.id), "PROMPT.md"), postClearPrompt);
    const truthful = createCurrentPlanEvidence({
      version: existing.at(-1)!.version + 1,
      sourceRevision: Date.now(),
      capturedAt: new Date().toISOString(),
      prompt: postClearPrompt,
    });
    const untruthful = {
      ...truthful,
      plan: {
        ...truthful.plan,
        sections: {
          ...truthful.plan.sections,
          lineage: { canonical: `parent-task:${parent.id}` },
        },
      },
    };
    await store.appendCurrentPlanEvidence(child.id, untruthful);
    const before = await store.listCurrentPlanEvidence(child.id);

    await expect(store.deleteTask(parent.id, { removeLineageReferences: true }))
      .rejects.toMatchObject({ name: "LineageEvidenceAppendError", reason: "matched-row-not-truthful" } satisfies Partial<LineageEvidenceAppendError>);
    expect((await store.getTask(parent.id))?.deletedAt).toBeUndefined();
    expect((await store.getTask(child.id))?.sourceParentTaskId).toBe(parent.id);
    expect((await store.getTask(child.id))?.approvedPlanFingerprint).toBe("approved-lineage-scope");
    expect(await store.listCurrentPlanEvidence(child.id)).toEqual(before);
  });

  it("retries a forced evidence version collision and rolls back an unresolvable evidence append", async () => {
    const collisionVersion = 99;
    const events: LineageInvalidationTestEvent[] = [];
    const { parent, child } = await createApprovedLineagePair();
    // A disk-only prompt revision supplies a post-clear hash absent from approval-time evidence.
    await writeFile(join(store.taskDir(child.id), "PROMPT.md"), `${SPEC_LOCK_PROMPT}\n\n## Collision target\nFresh lineage evidence.`);
    await store.appendCurrentPlanEvidence(child.id, createCurrentPlanEvidence({
      version: collisionVersion,
      sourceRevision: Date.now(),
      capturedAt: new Date().toISOString(),
      prompt: `${SPEC_LOCK_PROMPT}\n\n## Collision fixture\nDifferent source hash.`,
    }));
    const beforeRetry = await store.listCurrentPlanEvidence(child.id);
    (store as unknown as { __lineageInvalidationForTest?: unknown }).__lineageInvalidationForTest = {
      evidenceTargetVersionForTest: (_childId: string, computed: number, attempt: number) => attempt === 0 ? collisionVersion : computed,
      onEvent: (event: LineageInvalidationTestEvent) => events.push(event),
    };

    await store.deleteTask(parent.id, { removeLineageReferences: true });

    const afterRetry = await store.listCurrentPlanEvidence(child.id);
    expect(afterRetry).toHaveLength(beforeRetry.length + 1);
    expect(afterRetry.at(-1)?.version).toBeGreaterThan(collisionVersion);
    expect(events.find((event) => event.kind === "outcome")).toMatchObject({
      kind: "outcome", outcome: { evidenceInsertAttempts: 2 },
    });

    const abortPair = await createApprovedLineagePair();
    await writeFile(join(store.taskDir(abortPair.child.id), "PROMPT.md"), `${SPEC_LOCK_PROMPT}\n\n## Abort target\nFresh lineage evidence.`);
    await store.appendCurrentPlanEvidence(abortPair.child.id, createCurrentPlanEvidence({
      version: collisionVersion,
      sourceRevision: Date.now(),
      capturedAt: new Date().toISOString(),
      prompt: `${SPEC_LOCK_PROMPT}\n\n## Permanent collision fixture\nDifferent source hash.`,
    }));
    const beforeAbort = await store.listCurrentPlanEvidence(abortPair.child.id);
    (store as unknown as { __lineageInvalidationForTest?: unknown }).__lineageInvalidationForTest = {
      evidenceTargetVersionForTest: () => collisionVersion,
    };

    await expect(store.deleteTask(abortPair.parent.id, { removeLineageReferences: true }))
      .rejects.toMatchObject({ name: "LineageEvidenceAppendError", reason: "no-durable-version" } satisfies Partial<LineageEvidenceAppendError>);
    expect((await store.getTask(abortPair.parent.id))?.deletedAt).toBeUndefined();
    expect((await store.getTask(abortPair.child.id))?.sourceParentTaskId).toBe(abortPair.parent.id);
    expect((await store.getTask(abortPair.child.id))?.approvedPlanFingerprint).toBe("approved-lineage-scope");
    expect(await store.listCurrentPlanEvidence(abortPair.child.id)).toEqual(beforeAbort);
  });

  it("retries a raced-in delete child and publishes before releasing all child locks", async () => {
    const { parent, child } = await createApprovedLineagePair();
    const events: LineageInvalidationTestEvent[] = [];
    let secondChildId: string | undefined;
    (store as unknown as {
      __lineageInvalidationForTest?: {
        availability: () => { available: true };
        withLocks: <T>(ids: readonly string[], callback: () => Promise<T>) => Promise<T>;
        onEvent: (event: LineageInvalidationTestEvent) => void;
      };
      __beforeDeleteClaimForTest?: () => Promise<void>;
    }).__lineageInvalidationForTest = {
      availability: () => ({ available: true }),
      async withLocks(_ids, callback) {
        return await callback();
      },
      onEvent: (event) => events.push(event),
    };
    (store as unknown as { __beforeDeleteClaimForTest?: () => Promise<void> }).__beforeDeleteClaimForTest = async () => {
      const second = await store.createTask({
        description: "raced-in approved child",
        source: { sourceType: "api", sourceParentTaskId: parent.id },
      });
      secondChildId = second.id;
      await writeFile(join(store.taskDir(second.id), "PROMPT.md"), SPEC_LOCK_PROMPT);
      await store.lockCurrentPlan(second.id, "raced-in-lineage-scope", SPEC_LOCK_PROMPT);
      await store.updateTask(second.id, { approvedPlanFingerprint: "raced-in-lineage-scope" });
    };

    await store.deleteTask(parent.id, { removeLineageReferences: true });

    expect(secondChildId).toBeDefined();
    for (const id of [child.id, secondChildId!]) {
      expect((await store.getTask(id))?.sourceParentTaskId).toBeUndefined();
      expect((await store.getTask(id))?.approvedPlanFingerprint).toBeUndefined();
      expect(await store.getActiveSpecLock(id)).toBeUndefined();
    }
    const acquisitions = events.filter((event) => event.kind === "acquire");
    expect(acquisitions).toHaveLength(2);
    expect(acquisitions[1]?.childIds).toEqual([child.id, secondChildId].sort());
    const reconciles = events.filter((event) => event.kind === "reconcile");
    expect(reconciles.map((event) => event.kind === "reconcile" ? event.childId : undefined).sort())
      .toEqual([child.id, secondChildId].sort());
  });

  it("records lifecycle outcomes and uses structural degradation but never turns a lock acquisition failure into an unlocked delete", async () => {
    const { parent, child } = await createApprovedLineagePair();
    const degradedEvents: LineageInvalidationTestEvent[] = [];
    (store as unknown as { __lineageInvalidationForTest?: unknown }).__lineageInvalidationForTest = {
      availability: () => ({ available: false, reason: "direct-session-unavailable" }),
      onEvent: (event: LineageInvalidationTestEvent) => degradedEvents.push(event),
    };
    await store.deleteTask(parent.id, { removeLineageReferences: true });
    expect((await store.getTask(child.id))?.approvedPlanFingerprint).toBeUndefined();
    expect(degradedEvents.some((event) => event.kind === "run" && event.degraded)).toBe(true);
    expect(degradedEvents.some((event) => event.kind === "acquire")).toBe(false);
    expect(degradedEvents.some((event) => event.kind === "reconcile" && event.childId === child.id)).toBe(true);

    await h.beforeEach();
    store = h.store();
    const pair = await createApprovedLineagePair();
    let ranBody = false;
    (store as unknown as { __lineageInvalidationForTest?: unknown }).__lineageInvalidationForTest = {
      availability: () => ({ available: true }),
      withLocks: async () => { throw new PlanningLifecycleLockTransportError("contended"); },
      onEvent: (event: LineageInvalidationTestEvent) => { if (event.kind === "run") ranBody = true; },
    };
    await expect(store.deleteTask(pair.parent.id, { removeLineageReferences: true }))
      .rejects.toBeInstanceOf(PlanningLifecycleLockTransportError);
    expect(ranBody).toBe(false);
    expect((await store.getTask(pair.parent.id))?.deletedAt).toBeUndefined();
    expect((await store.getTask(pair.child.id))?.sourceParentTaskId).toBe(pair.parent.id);
    expect((await store.getTask(pair.child.id))?.approvedPlanFingerprint).toBe("approved-lineage-scope");
  });
});
