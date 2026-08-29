import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ProjectEngine } from "../project-engine.js";
import { runtimeLog } from "../logger.js";
import type { Settings, Task } from "@fusion/core";

function makeSettings(autoMerge: boolean): Settings {
  return {
    autoMerge,
    globalPause: false,
    enginePaused: false,
    maintenanceIntervalMs: 900_000,
  } as Settings;
}

function makeEngineHarness(tasks: Task[]) {
  const events = new EventEmitter();
  const auditEvents: unknown[] = [];
  const store = Object.assign(events, {
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => tasks.filter((task) => !column || task.column === column)),
    recordRunAuditEvent: vi.fn((event: unknown) => {
      auditEvents.push(event);
      return event;
    }),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    pauseTask: vi.fn(),
  });
  const engine = Object.create(ProjectEngine.prototype) as ProjectEngine & {
    settingsHandlers: Array<(payload: { settings: Settings; previous: Settings }) => Promise<void> | void>;
    legacyAutoMergeStampAdvisoryEmitted: boolean;
    mergeAbortController: AbortController | null;
    activeMergeSession: null;
    scheduleMergeActiveReconciliation: (intervalMs: number) => void;
  };
  engine.settingsHandlers = [];
  engine.legacyAutoMergeStampAdvisoryEmitted = false;
  engine.mergeAbortController = null;
  engine.activeMergeSession = null;
  engine.scheduleMergeActiveReconciliation = vi.fn();
  (engine as any).runtime = {};
  (engine as any).automationStore = null;
  (engine as any).wireSettingsListeners(store);
  return { engine, store, auditEvents };
}

describe("auto-merge toggle legacy advisory", () => {
  it("emits an operator advisory on global autoMerge OFF for legacy in-review stamps without mutating tasks", async () => {
    const legacy = {
      id: "FN-LEGACY",
      column: "in-review",
      autoMerge: true,
      autoMergeProvenance: "legacy-stamp",
    } as Task;
    const absent = {
      id: "FN-ABSENT",
      column: "in-review",
      autoMerge: true,
    } as Task;
    const user = {
      id: "FN-USER",
      column: "in-review",
      autoMerge: true,
      autoMergeProvenance: "user",
    } as Task;
    const todoLegacy = {
      id: "FN-TODO",
      column: "todo",
      autoMerge: true,
      autoMergeProvenance: "legacy-stamp",
    } as Task;
    const { engine, store, auditEvents } = makeEngineHarness([legacy, absent, user, todoLegacy]);
    const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined as any);

    try {
      const autoMergeOffHandler = engine.settingsHandlers[2];
      await autoMergeOffHandler?.({ settings: makeSettings(false), previous: makeSettings(true) });

      expect(store.listTasks).toHaveBeenCalledWith({ column: "in-review" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("FN-LEGACY");
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("FN-ABSENT");
      expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain("FN-USER");
      expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain("FN-TODO");

      expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(1);
      expect(auditEvents[0]).toMatchObject({
        domain: "database",
        mutationType: "task:auto-merge-legacy-stamp-advisory",
        target: "settings.autoMerge",
        metadata: {
          taskIds: ["FN-LEGACY", "FN-ABSENT"],
          changedTaskState: false,
        },
      });
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.pauseTask).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not advise for genuine user overrides or non-off transitions", async () => {
    const user = {
      id: "FN-USER",
      column: "in-review",
      autoMerge: true,
      autoMergeProvenance: "user",
    } as Task;
    const { engine, store } = makeEngineHarness([user]);
    const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined as any);

    try {
      const autoMergeOffHandler = engine.settingsHandlers[2];
      await autoMergeOffHandler?.({ settings: makeSettings(true), previous: makeSettings(false) });
      await autoMergeOffHandler?.({ settings: makeSettings(false), previous: makeSettings(false) });
      await autoMergeOffHandler?.({ settings: makeSettings(false), previous: makeSettings(true) });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
