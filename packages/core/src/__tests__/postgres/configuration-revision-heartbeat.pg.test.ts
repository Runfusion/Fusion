import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pgDescribe, createSharedPgTaskStoreTestHarness, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import {
  appendConfigurationRevision,
  getConfigurationRevision,
} from "../../async-stores/async-configuration-revision-store.js";
import { ConfigurationRevisionStore } from "../../config/configuration-revision-store.js";
import { readProjectConfig } from "../../task-store/async/async-settings.js";

const pgTest = pgDescribe;

pgTest("configuration revision heartbeat isolation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_revision_heartbeat", projectId: "revision-heartbeat" });
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);

  it("keeps a real revision queryable after 120 heartbeat writes", async () => {
    const store = h.store();
    const layer = store.getAsyncLayer()!;
    const target = { projectId: layer.projectId ?? "" };
    const revisionStore = new ConfigurationRevisionStore(layer, layer.projectId);
    await store.updateSettings({ autoMerge: false });
    const rowsBeforeHeartbeats = (await revisionStore.list("project-settings", target)).length;
    for (let index = 0; index < 120; index++) {
      await store.updateSettings({ engineLastActiveAt: new Date(1_700_000_000_000 + index).toISOString() });
    }
    const revisions = await revisionStore.list("project-settings", target);
    expect(revisions).toHaveLength(rowsBeforeHeartbeats);
    expect(revisions).toContainEqual(expect.objectContaining({ diffs: expect.arrayContaining([expect.objectContaining({ field: "autoMerge" })]) }));
    expect((await store.getSettings()).engineLastActiveAt).toBe(new Date(1_700_000_000_119).toISOString());
  });

  it("records only audit-worthy fields from a mixed heartbeat write", async () => {
    const store = h.store();
    const layer = store.getAsyncLayer()!;
    const target = { projectId: layer.projectId ?? "" };
    const revisionStore = new ConfigurationRevisionStore(layer, layer.projectId);
    await store.updateSettings({ autoMerge: false, engineLastActiveAt: "2026-08-09T04:33:00.000Z" });
    const [revision] = await revisionStore.list("project-settings", target);
    expect(revision.diffs).toEqual([expect.objectContaining({ field: "autoMerge", oldValue: true, newValue: false })]);
    expect(revision.before).not.toHaveProperty("engineLastActiveAt");
    expect(revision.after).not.toHaveProperty("engineLastActiveAt");
    expect((await store.getSettings()).engineLastActiveAt).toBe("2026-08-09T04:33:00.000Z");
  });

  it("preserves a fresh heartbeat while rolling back a genuinely legacy snapshot", async () => {
    const store = h.store();
    const layer = store.getAsyncLayer()!;
    const target = { projectId: layer.projectId ?? "" };
    await store.updateSettings({ autoMerge: false, engineLastActiveAt: "2026-01-01T00:00:00.000Z" });
    const live = (await readProjectConfig(layer)).settings ?? {};
    const stale = "2000-01-01T00:00:00.000Z";
    const id = randomUUID();
    await appendConfigurationRevision(layer.db, {
      id, projectId: layer.projectId ?? "", ownerScope: "project", configKind: "project-settings", configTarget: target,
      configTargetKey: JSON.stringify(target), before: { ...live, autoMerge: true, engineLastActiveAt: stale }, after: { ...live, autoMerge: false, engineLastActiveAt: stale },
      diffs: [{ field: "autoMerge", oldValue: true, newValue: false }, { field: "engineLastActiveAt", oldValue: stale, newValue: stale }],
      changedBy: { kind: "system", id: "legacy-fixture" }, source: "mutation", createdAt: "2000-01-01T00:00:00.000Z",
    });
    // The raw writer intentionally retains this legacy shape; otherwise this test cannot detect stale resurrection.
    expect((await getConfigurationRevision(layer.db, layer.projectId ?? "", id))?.before).toMatchObject({ engineLastActiveAt: stale });
    const fresh = "2026-08-09T04:34:00.000Z";
    await store.updateSettings({ engineLastActiveAt: fresh });
    const rollback = await store.rollbackConfiguration(id);
    const restored = await store.getSettings();
    expect(restored.autoMerge).toBe(true);
    expect(restored.engineLastActiveAt).toBe(fresh);
    const storedRollback = await getConfigurationRevision(layer.db, layer.projectId ?? "", rollback.id);
    expect(rollback.diffs).toContainEqual(expect.objectContaining({ field: "autoMerge", oldValue: false, newValue: true }));
    expect(storedRollback?.diffs).not.toContainEqual(expect.objectContaining({ field: "engineLastActiveAt" }));
    expect(storedRollback?.before).not.toHaveProperty("engineLastActiveAt");
    expect(storedRollback?.after).not.toHaveProperty("engineLastActiveAt");
  });

  it("rejects a heartbeat-only legacy rollback without writing or emitting", async () => {
    const store = h.store();
    const layer = store.getAsyncLayer()!;
    const target = { projectId: layer.projectId ?? "" };
    await store.updateSettings({ engineLastActiveAt: "2026-08-09T04:35:00.000Z" });
    const live = (await readProjectConfig(layer)).settings ?? {};
    const revisionStore = new ConfigurationRevisionStore(layer, layer.projectId);
    const id = randomUUID();
    await appendConfigurationRevision(layer.db, {
      id, projectId: layer.projectId ?? "", ownerScope: "project", configKind: "project-settings", configTarget: target,
      configTargetKey: JSON.stringify(target), before: { ...live, engineLastActiveAt: "2001-01-01T00:00:00.000Z" }, after: live,
      diffs: [{ field: "engineLastActiveAt", oldValue: "2001-01-01T00:00:00.000Z", newValue: live.engineLastActiveAt }],
      changedBy: { kind: "system", id: "legacy-fixture" }, source: "mutation", createdAt: "2001-01-01T00:00:00.000Z",
    });
    const beforeRows = await revisionStore.list("project-settings", target, 500);
    const beforeSettings = structuredClone(await store.getSettings());
    const updated = vi.fn();
    store.on("settings:updated", updated);
    await expect(store.rollbackConfiguration(id)).rejects.toThrow(/is already restored/);
    expect(await revisionStore.list("project-settings", target, 500)).toHaveLength(beforeRows.length);
    expect(await store.getSettings()).toEqual(beforeSettings);
    expect(updated).not.toHaveBeenCalled();
  });

  it("returns stable newest-first offset pages without a count query", async () => {
    const store = h.store();
    const layer = store.getAsyncLayer()!;
    const target = { projectId: layer.projectId ?? "" };
    const revisionStore = new ConfigurationRevisionStore(layer, layer.projectId);
    for (let value = 2; value <= 7; value++) await store.updateSettings({ maxConcurrentTasks: value });
    const first = await revisionStore.listPage("project-settings", target, { limit: 2, offset: 0 });
    const second = await revisionStore.listPage("project-settings", target, { limit: 2, offset: 2 });
    const all = await revisionStore.list("project-settings", target, 500);
    const final = await revisionStore.listPage("project-settings", target, { limit: 2, offset: Math.max(0, all.length - 2) });
    const beyond = await revisionStore.listPage("project-settings", target, { limit: 2, offset: all.length + 100 });
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(final.hasMore).toBe(false);
    expect(first.revisions.map((revision) => revision.id)).toEqual(all.slice(0, 2).map((revision) => revision.id));
    expect(second.revisions.map((revision) => revision.id)).toEqual(all.slice(2, 4).map((revision) => revision.id));
    expect(first.revisions.map((revision) => revision.id)).not.toEqual(expect.arrayContaining(second.revisions.map((revision) => revision.id)));
    expect(beyond).toEqual({ revisions: [], hasMore: false });
  });
});
