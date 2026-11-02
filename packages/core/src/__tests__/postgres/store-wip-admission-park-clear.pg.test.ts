/**
 * FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
 * PG regression for the clear half of the withheld-hold→WIP marker. The marker's claim is column-scoped —
 * "this card could not cross FROM here INTO there" — so a real column change falsifies it whoever did the
 * moving: the capacity sweep's release, an operator drag, a graph transition, or a completion. Enumerating
 * releasing lanes is exactly how a clear goes missing (RUFU-258 chased a pause that four remediators each
 * failed to clear, and that bug's shape was an incomplete clearing list, not a missing one), so the move
 * seam owns the single clear. This pins all four halves:
 * - a column change drops the key, including an operator move that was never a capacity release;
 * - a same-column write keeps it, because a no-op move is not a crossing;
 * - the clear is key-preserving, so a marker cannot travel back in as collateral of a wholesale
 *   `sourceMetadata` write, nor take unrelated keys with it;
 * - a card that never carried a marker gains none.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { WIP_ADMISSION_STALL_METADATA_KEY } from "../../types.js";
import { readWipAdmissionStallEpisode } from "../../tasks/wip-admission-park.js";

const pgTest = pgDescribe;

function episode(overrides: Record<string, unknown> = {}) {
  return {
    code: "scheduler-seam",
    signature: "capacity|todo->in-progress",
    nodeId: "hold-release-sweep",
    fromColumn: "todo",
    toColumn: "in-progress",
    lastAt: new Date().toISOString(),
    firstAt: new Date().toISOString(),
    stallCount: 3,
    ...overrides,
  };
}

pgTest("withheld-hold→WIP marker clear at the move seam (PostgreSQL, RUFU-393)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_wip_park_clear",
    projectId: "rufu393-wip-park-clear",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  FNXC:WipAdmissionPark 2026-11-02-08:05 (RUFU-393):
  Seeded through `sourceMetadataPatch`, because that is the ONLY shape the store accepts for this field — a
  whole-field `sourceMetadata` write is not an update-patch key and persists nothing, which made an earlier
  draft of this test pass its "the marker is gone" assertion while the marker had never been written at all.
  Every case therefore re-reads the row and asserts the seed landed BEFORE it asks the move seam to remove
  it: a clear is only proven by a clear that had something to clear.
  */
  async function seedParkedCard(id: string, sourceMetadataPatch: Record<string, unknown>) {
    const store = h.store();
    await store.createTaskWithReservedId({ description: id, column: "todo" }, { taskId: id, applyDefaultWorkflowSteps: false });
    await store.updateTask(id, { sourceMetadataPatch });
    const seeded = await store.getTask(id);
    expect(seeded?.sourceMetadata).toMatchObject(sourceMetadataPatch);
    return seeded;
  }

  it("drops the marker on an operator column change that was never a capacity release", async () => {
    await seedParkedCard("RUFU-393A", { [WIP_ADMISSION_STALL_METADATA_KEY]: episode(), keepMe: "kept" });

    await h.store().moveTask("RUFU-393A", "in-progress", { moveSource: "user" });

    const row = await h.store().getTask("RUFU-393A");
    expect(row!.column).toBe("in-progress");
    // Asserted through the READER, not key absence: the key-preserving clear patches the key to JSON `null`,
    // which is how this field's clear has always been spelled (RUFU-273's `clearPlanAdmissionStallPatch`
    // writes the same shape), and the reader is what every consumer actually asks.
    expect(readWipAdmissionStallEpisode(row!.sourceMetadata)).toBeUndefined();
    // The clear is key-preserving: the neighbouring provenance key survives the move.
    expect(row!.sourceMetadata?.keepMe).toBe("kept");
  });

  it("keeps a marker on a same-column write, because a no-op move is not a crossing", async () => {
    await seedParkedCard("RUFU-393B", { [WIP_ADMISSION_STALL_METADATA_KEY]: episode() });

    await h.store().moveTask("RUFU-393B", "todo", { moveSource: "user" });

    const row = await h.store().getTask("RUFU-393B");
    expect(row!.column).toBe("todo");
    expect(readWipAdmissionStallEpisode(row!.sourceMetadata)).toBeTruthy();
  });

  it("clears the marker without disturbing the rest of sourceMetadata", async () => {
    await seedParkedCard("RUFU-393C", {
      [WIP_ADMISSION_STALL_METADATA_KEY]: episode(),
      keepMe: { nested: true },
    });

    await h.store().moveTask("RUFU-393C", "in-progress", { moveSource: "user" });

    const row = await h.store().getTask("RUFU-393C");
    expect(row!.sourceMetadata).toMatchObject({ keepMe: { nested: true } });
    expect(readWipAdmissionStallEpisode(row!.sourceMetadata)).toBeUndefined();
  });

  it("moves a card that never carried a marker without inventing the key", async () => {
    await seedParkedCard("RUFU-393D", { keepMe: true });

    await h.store().moveTask("RUFU-393D", "in-progress", { moveSource: "user" });

    const row = await h.store().getTask("RUFU-393D");
    expect(row!.sourceMetadata).not.toHaveProperty(WIP_ADMISSION_STALL_METADATA_KEY);
  });
});
