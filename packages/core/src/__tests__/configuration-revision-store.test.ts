import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const settingsOps = vi.hoisted(() => ({
  readProjectConfig: vi.fn(),
  writeProjectConfig: vi.fn(),
}));
vi.mock("../task-store/async/async-settings.js", () => settingsOps);

import {
  configurationTargetKey,
  createConfigurationRevision,
  diffConfigurationSnapshots,
  listConfigurationRevisionsPage,
} from "../async-stores/async-configuration-revision-store.js";
import { createProjectSettingsRollbackSnapshotOps, rollbackConfigurationImpl } from "../task-store/task-mutation-ops.js";
import { ConfigurationRevisionStore } from "../config/configuration-revision-store.js";
import { GlobalSettingsStore } from "../config/global-settings.js";

describe("configuration revision snapshots", () => {
  it("uses canonical structured target identity independent of key order", () => {
    expect(configurationTargetKey({ workflowId: "wf-1", projectId: "p-1" }))
      .toBe(configurationTargetKey({ projectId: "p-1", workflowId: "wf-1" }));
  });

  it("does not create revisions for exact no-op snapshots", () => {
    expect(createConfigurationRevision({
      projectId: "project", ownerScope: "project", configKind: "project-settings",
      configTarget: { projectId: "project" }, before: { enabled: true }, after: { enabled: true },
      changedBy: { kind: "system", id: "system" },
    })).toBeNull();
  });

  it("captures deleted keys in a field diff", () => {
    expect(diffConfigurationSnapshots({ retained: 1, deleted: 2 }, { retained: 1 }))
      .toEqual([{ field: "deleted", oldValue: 2, newValue: undefined }]);
  });
});

describe("non-versioned project settings", () => {
  it("omits heartbeat-only and strips heartbeat from mixed project revisions", async () => {
    const { mergeRestoredProjectSettings, NON_VERSIONED_SETTINGS_KEYS, isProjectSettingsKey } = await import("../config/settings-schema.js");
    expect(NON_VERSIONED_SETTINGS_KEYS.every(isProjectSettingsKey)).toBe(true);
    expect(createConfigurationRevision({ projectId: "p", ownerScope: "project", configKind: "project-settings", configTarget: { projectId: "p" }, before: { engineLastActiveAt: "old" }, after: { engineLastActiveAt: "new" }, changedBy: { kind: "system", id: "engine" } })).toBeNull();
    const revision = createConfigurationRevision({ projectId: "p", ownerScope: "project", configKind: "project-settings", configTarget: { projectId: "p" }, before: { engineLastActiveAt: "old", autoMerge: false }, after: { engineLastActiveAt: "new", autoMerge: true }, changedBy: { kind: "system", id: "engine" } });
    expect(revision?.diffs).toEqual([{ field: "autoMerge", oldValue: false, newValue: true }]);
    expect(revision?.before).toEqual({ autoMerge: false });
    const snapshot = { engineLastActiveAt: "stale", autoMerge: false };
    const live = { engineLastActiveAt: "live", extra: true };
    expect(mergeRestoredProjectSettings(snapshot, live)).toEqual({ engineLastActiveAt: "live", autoMerge: false });
    expect(mergeRestoredProjectSettings({ autoMerge: false }, live)).toEqual({ autoMerge: false, engineLastActiveAt: "live" });
    expect(mergeRestoredProjectSettings({ engineLastActiveAt: "stale", autoMerge: false }, {})).toEqual({ autoMerge: false });
    expect(snapshot).toEqual({ engineLastActiveAt: "stale", autoMerge: false });
    expect(live).toEqual({ engineLastActiveAt: "live", extra: true });
  });

  it("treats an absent or undefined heartbeat as a non-versioned no-op", () => {
    const input = { projectId: "p", ownerScope: "project" as const, configKind: "project-settings" as const, configTarget: { projectId: "p" }, changedBy: { kind: "system" as const, id: "engine" } };
    expect(createConfigurationRevision({ ...input, before: {}, after: { engineLastActiveAt: "fresh" } })).toBeNull();
    expect(createConfigurationRevision({ ...input, before: { engineLastActiveAt: undefined }, after: { engineLastActiveAt: undefined } })).toBeNull();
  });

  it("does not filter a same-named field outside project settings", () => {
    for (const configKind of ["global-settings", "workflow-settings", "routine", "automation"] as const) {
      expect(createConfigurationRevision({ projectId: "p", ownerScope: "project", configKind, configTarget: { id: configKind }, before: { engineLastActiveAt: "old" }, after: { engineLastActiveAt: "new" }, changedBy: { kind: "system", id: "test" } })?.diffs)
        .toEqual([{ field: "engineLastActiveAt", oldValue: "old", newValue: "new" }]);
    }
  });

  it("makes the project-bound facade inherit the skip while leaving the raw writer verbatim", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values });
    const handle = { insert };
    const store = new ConfigurationRevisionStore({ db: handle, projectId: "p" } as never, "p");
    await expect(store.append({ ownerScope: "project", configKind: "project-settings", configTarget: { projectId: "p" }, before: { engineLastActiveAt: "old" }, after: { engineLastActiveAt: "new" }, changedBy: { kind: "system", id: "engine" } })).resolves.toBeNull();
    expect(insert).not.toHaveBeenCalled();
    const raw = {
      id: "legacy", projectId: "p", ownerScope: "project" as const, configKind: "project-settings" as const,
      configTarget: { projectId: "p" }, configTargetKey: '{"projectId":"p"}', before: { engineLastActiveAt: "old" }, after: { engineLastActiveAt: "new" },
      diffs: [{ field: "engineLastActiveAt", oldValue: "old", newValue: "new" }], changedBy: { kind: "system" as const, id: "legacy" }, source: "mutation" as const, createdAt: "2026-08-09T00:00:00.000Z",
    };
    const { appendConfigurationRevision } = await import("../async-stores/async-configuration-revision-store.js");
    await appendConfigurationRevision(handle as never, raw);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ before: raw.before, after: raw.after, diffs: raw.diffs }));
  });
});

describe("configuration revision paging", () => {
  it("clamps invalid core paging inputs before building the query", async () => {
    const calls: { limit?: number; offset?: number } = {};
    const rows = [{ id: "one" }];
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: (value: number) => { calls.limit = value; return query; },
      offset: async (value: number) => { calls.offset = value; return rows; },
    };
    const page = await listConfigurationRevisionsPage({ select: () => query } as never, {
      projectId: "p", configKind: "project-settings", configTarget: { projectId: "p" }, limit: Number.NaN, offset: Number.NaN,
    });
    expect(calls).toEqual({ limit: 101, offset: 0 });
    expect(page).toMatchObject({ hasMore: false, revisions: [{ id: "one" }] });
  });

  it("preserves positional-number compatibility through project and global revision facades", async () => {
    const calls: Array<{ limit: number; offset: number }> = [];
    const query = {
      from: () => query, where: () => query, orderBy: () => query,
      limit: (limit: number) => { calls.push({ limit, offset: -1 }); return query; },
      offset: async (offset: number) => { calls.at(-1)!.offset = offset; return []; },
    };
    const target = { projectId: "p" };
    const project = new ConfigurationRevisionStore({ db: { select: () => query }, projectId: "p" } as never, "p");
    await project.list("project-settings", target, 7);
    const tx = { execute: vi.fn(), select: () => query };
    const global = new GlobalSettingsStore("/tmp/fusion-fn-8852-global-settings", {
      transactionImmediate: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    } as never);
    await global.listConfigurationRevisions("global-settings", { scope: "user-global" }, 9);
    expect(calls).toEqual([{ limit: 8, offset: 0 }, { limit: 10, offset: 0 }]);
  });

  it("uses the documented limit boundaries and limit-plus-one hasMore probe", async () => {
    const limits: number[] = [];
    const query = {
      from: () => query, where: () => query, orderBy: () => query,
      limit: (value: number) => { limits.push(value); return query; },
      offset: async () => Array.from({ length: limits.at(-1)! }, (_, index) => ({ id: String(index) })),
    };
    const base = { projectId: "p", configKind: "project-settings" as const, configTarget: { projectId: "p" } };
    expect((await listConfigurationRevisionsPage({ select: () => query } as never, { ...base, limit: 0 })).revisions).toHaveLength(1);
    expect((await listConfigurationRevisionsPage({ select: () => query } as never, { ...base, limit: 1000 })).revisions).toHaveLength(500);
    expect(limits).toEqual([2, 501]);
  });
});

describe("project settings rollback snapshot operations", () => {
  it("uses the identical transaction for reads and writes and overlays the live heartbeat", async () => {
    const tx = {};
    settingsOps.readProjectConfig.mockResolvedValueOnce({ settings: { autoMerge: false } })
      .mockResolvedValueOnce({ settings: { autoMerge: false, engineLastActiveAt: "live" } });
    settingsOps.writeProjectConfig.mockResolvedValue(undefined);
    const ops = createProjectSettingsRollbackSnapshotOps({} as never, tx as never);
    expect(await ops.readCurrent()).toEqual({ autoMerge: false });
    await ops.replace({ autoMerge: true, engineLastActiveAt: "stale" });
    expect(settingsOps.readProjectConfig).toHaveBeenNthCalledWith(1, expect.anything(), tx);
    expect(settingsOps.readProjectConfig).toHaveBeenNthCalledWith(2, expect.anything(), tx);
    expect(settingsOps.writeProjectConfig).toHaveBeenCalledWith(expect.anything(), { autoMerge: true, engineLastActiveAt: "live" }, undefined, tx);
  });

  it("re-overlays a live heartbeat for a stripped snapshot with the same transaction", async () => {
    const tx = {};
    settingsOps.readProjectConfig.mockReset();
    settingsOps.writeProjectConfig.mockReset();
    settingsOps.readProjectConfig.mockResolvedValue({ settings: { autoMerge: false, engineLastActiveAt: "live" } });
    const ops = createProjectSettingsRollbackSnapshotOps({} as never, tx as never);
    await ops.replace({ autoMerge: true });
    expect(settingsOps.readProjectConfig).toHaveBeenCalledWith(expect.anything(), tx);
    expect(settingsOps.writeProjectConfig).toHaveBeenCalledWith(expect.anything(), { autoMerge: true, engineLastActiveAt: "live" }, undefined, tx);
  });

  it("keeps an absent live heartbeat absent", async () => {
    const tx = {};
    settingsOps.readProjectConfig.mockReset();
    settingsOps.writeProjectConfig.mockReset();
    settingsOps.readProjectConfig.mockResolvedValue({ settings: { autoMerge: false } });
    const ops = createProjectSettingsRollbackSnapshotOps({} as never, tx as never);
    await ops.replace({ autoMerge: true, engineLastActiveAt: "stale" });
    expect(settingsOps.writeProjectConfig).toHaveBeenCalledWith(expect.anything(), { autoMerge: true }, undefined, tx);
  });

  it("keeps workflow-settings rollback behavior independent of project snapshot operations", async () => {
    const revision = {
      id: "workflow-revision", projectId: "p", ownerScope: "project" as const, configKind: "workflow-settings" as const,
      configTarget: { workflowId: "wf", projectId: "p" }, configTargetKey: '{"projectId":"p","workflowId":"wf"}',
      before: { enabled: false }, after: { enabled: true }, diffs: [{ field: "enabled", oldValue: false, newValue: true }],
      changedBy: { kind: "human" as const, id: "operator" }, source: "mutation" as const, createdAt: "2026-08-09T00:00:00.000Z",
    };
    const revisionQuery = { from: () => revisionQuery, where: () => revisionQuery, limit: vi.fn().mockResolvedValue([revision]) };
    const settingsQuery = { from: () => settingsQuery, where: () => settingsQuery, limit: vi.fn().mockResolvedValue([{ values: { enabled: true } }]) };
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select: (...args: unknown[]) => args.length > 0 ? settingsQuery : revisionQuery,
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate })) })),
    };
    const layer = {
      db: { select: () => revisionQuery },
      transactionImmediate: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const store = { backendMode: true, asyncLayer: layer, getSettings: vi.fn().mockResolvedValue({}), emit: vi.fn() };
    await expect(rollbackConfigurationImpl(store as never, "workflow-revision")).resolves.toMatchObject({ rollbackToRevisionId: "workflow-revision" });
    expect(settingsQuery.limit).toHaveBeenCalled();
    expect(onConflictDoUpdate).toHaveBeenCalled();
  });

  it("keeps rollback wired through the extracted production factory", async () => {
    const source = await readFile(new URL("../task-store/task-mutation-ops.ts", import.meta.url), "utf8");
    expect(source).toContain("createProjectSettingsRollbackSnapshotOps(layer, tx)");
    expect(source).not.toContain("writeProjectConfig(layer, snapshot");
  });
});
