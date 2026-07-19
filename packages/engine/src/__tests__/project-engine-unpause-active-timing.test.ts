import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { ProjectEngine } from "../project-engine.js";
import { SelfHealingManager } from "../self-healing.js";

const activeSettings = {
  globalPause: false,
  enginePaused: false,
  autoMerge: true,
} as Settings;

type SettingsUpdatedHandler = (event: { settings: Settings; previous: Settings }) => void;

function wireUnpauseTimingHandler(manager: SelfHealingManager) {
  const handlers: SettingsUpdatedHandler[] = [];
  const store = {
    on: vi.fn((event: string, handler: SettingsUpdatedHandler) => {
      if (event === "settings:updated") handlers.push(handler);
    }),
  };
  const engine = {
    runtime: { stuckTaskDetector: { pause: vi.fn(), resume: vi.fn() } },
    settingsHandlers: [],
    getSelfHealingManager: () => manager,
    resumeAfterUnpauseAndSweepInReview: (
      ProjectEngine.prototype as unknown as { resumeAfterUnpauseAndSweepInReview: unknown }
    ).resumeAfterUnpauseAndSweepInReview,
  } as unknown as ProjectEngine;

  (
    ProjectEngine.prototype as unknown as {
      wireSettingsListeners(store: TaskStore): void;
    }
  ).wireSettingsListeners.call(engine, store as unknown as TaskStore);

  return handlers[0]!;
}

function createManager(
  reconcileActiveTimingForEngineDowntime: ReturnType<typeof vi.fn>,
  recordRunAuditEvent: ReturnType<typeof vi.fn>,
) {
  return new SelfHealingManager({
    reconcileActiveTimingForEngineDowntime,
    recordRunAuditEvent,
  } as unknown as TaskStore, { rootDir: "/tmp/fn-7975" });
}

describe("ProjectEngine unpause active timing reconciliation", () => {
  it.each([
    ["globalPause", "Global unpause"],
    ["enginePaused", "Engine unpause"],
  ] as const)("routes %s resume through the downtime audit with shifted tasks", async (pauseKey) => {
    const reconcileActiveTimingForEngineDowntime = vi.fn().mockResolvedValue({
      shiftedTaskIds: ["FN-active"],
      downtimeMs: 3_600_000,
    });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const handler = wireUnpauseTimingHandler(createManager(reconcileActiveTimingForEngineDowntime, recordRunAuditEvent));
    const capturedHeartbeat = "2026-07-15T11:00:00.000Z";

    handler({
      settings: { ...activeSettings },
      previous: { ...activeSettings, [pauseKey]: true, engineLastActiveAt: capturedHeartbeat },
    });
    await vi.waitFor(() => expect(recordRunAuditEvent).toHaveBeenCalledTimes(1));

    expect(reconcileActiveTimingForEngineDowntime).toHaveBeenCalledWith(
      expect.any(Date),
      { engineLastActiveAtOverride: capturedHeartbeat },
    );
    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reconcile-engine-downtime-active-timing",
      metadata: expect.objectContaining({ shiftedTaskIds: ["FN-active"], downtimeMs: 3_600_000 }),
    }));
  });

  it("emits the no-action audit for a below-threshold unpause", async () => {
    const reconcileActiveTimingForEngineDowntime = vi.fn().mockResolvedValue({ shiftedTaskIds: [], downtimeMs: 60_000 });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const handler = wireUnpauseTimingHandler(createManager(reconcileActiveTimingForEngineDowntime, recordRunAuditEvent));

    handler({
      settings: { ...activeSettings },
      previous: { ...activeSettings, globalPause: true, engineLastActiveAt: "2026-07-15T11:59:00.000Z" },
    });
    await vi.waitFor(() => expect(recordRunAuditEvent).toHaveBeenCalledTimes(1));

    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reconcile-engine-downtime-active-timing-no-action",
      metadata: expect.objectContaining({ shiftedTaskIds: [], downtimeMs: 60_000 }),
    }));
  });
});
