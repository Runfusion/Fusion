import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { Scheduler } from "../scheduler.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createStore(settings: Partial<Settings> = {}): TaskStore {
  const resolved = {
    maxConcurrent: 2,
    maxWorktrees: 2,
    pollIntervalMs: 60_000,
    groupOverlappingFiles: true,
    ...settings,
  } as Settings;
  return {
    listTasks: vi.fn(async () => []),
    getSettings: vi.fn(async () => resolved),
    updateSettings: vi.fn(async () => resolved),
    getRootDir: vi.fn(() => "/repo"),
    getTasksDir: vi.fn(() => "/repo/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

function createControlledScheduler(): {
  scheduler: Scheduler;
  releaseFirstPass: () => void;
  passCount: () => number;
  maxConcurrentPasses: () => number;
} {
  const scheduler = new Scheduler(createStore());
  const firstPass = deferred();
  let passes = 0;
  let active = 0;
  let maxActive = 0;
  (scheduler as unknown as {
    running: boolean;
    runHoldReleaseSweepPass: () => Promise<void>;
  }).running = true;
  (scheduler as unknown as { runHoldReleaseSweepPass: () => Promise<void> }).runHoldReleaseSweepPass = vi.fn(async () => {
    passes++;
    active++;
    maxActive = Math.max(maxActive, active);
    if (passes === 1) await firstPass.promise;
    active--;
  });
  return {
    scheduler,
    releaseFirstPass: firstPass.resolve,
    passCount: () => passes,
    maxConcurrentPasses: () => maxActive,
  };
}

describe("Scheduler coalesced completion wake", () => {
  it("runs exactly one follow-up pass for terminal and post-CAS wakes received during a pass", async () => {
    const controlled = createControlledScheduler();
    const firstSchedule = controlled.scheduler.schedule();
    await vi.waitFor(() => expect(controlled.passCount()).toBe(1));

    controlled.scheduler.requestImmediateSchedule();
    controlled.scheduler.requestImmediateSchedule();
    expect(controlled.passCount()).toBe(1);

    controlled.releaseFirstPass();
    await firstSchedule;
    await vi.waitFor(() => expect(controlled.passCount()).toBe(2));

    expect(controlled.maxConcurrentPasses()).toBe(1);
    controlled.scheduler.stop();
  });

  it("coalesces duplicate requests independently on each active pass", async () => {
    const controlled = createControlledScheduler();
    const firstSchedule = controlled.scheduler.schedule();
    await vi.waitFor(() => expect(controlled.passCount()).toBe(1));

    for (let index = 0; index < 5; index++) controlled.scheduler.requestImmediateSchedule();
    controlled.releaseFirstPass();
    await firstSchedule;
    await vi.waitFor(() => expect(controlled.passCount()).toBe(2));

    expect(controlled.maxConcurrentPasses()).toBe(1);
    controlled.scheduler.stop();
  });

  it("ignores requests while stopped and cancels a pending follow-up on stop", async () => {
    const stopped = createControlledScheduler();
    stopped.scheduler.stop();
    stopped.scheduler.requestImmediateSchedule();
    expect(stopped.passCount()).toBe(0);

    const controlled = createControlledScheduler();
    const firstSchedule = controlled.scheduler.schedule();
    await vi.waitFor(() => expect(controlled.passCount()).toBe(1));
    controlled.scheduler.requestImmediateSchedule();
    controlled.scheduler.stop();
    controlled.releaseFirstPass();
    await firstSchedule;

    expect(controlled.passCount()).toBe(1);
    expect(controlled.maxConcurrentPasses()).toBe(1);
  });
});
