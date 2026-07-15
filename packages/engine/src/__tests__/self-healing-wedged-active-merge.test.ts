import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { DEFAULT_MERGING_PHASE_SILENCE_FLOOR_MS } from "../merge-reclaim-policy.js";

/*
FNXC:MergeQueue 2026-07-15-10:05:
Self-healing must reclaim a wedged in-process active merge when the AI merge review pass hangs
(status=reviewing / merger agent silence) without false-reclaiming a live merging-phase long bash.
*/

function createTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    description: id,
    column: "in-review",
    status: "reviewing",
    paused: false,
    blockedBy: null,
    dependencies: [],
    steps: [{ name: "Ship", status: "done" }],
    log: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SelfHealingManager wedged active merge recovery", () => {
  let tasks: Map<string, Record<string, unknown>>;
  let store: TaskStore;
  let agentLogs: Array<{ agent?: string; timestamp?: string; type?: string; text?: string }>;
  let auditEvents: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
    tasks = new Map();
    agentLogs = [];
    auditEvents = [];

    const wedged = createTask("FN-WEDGE");
    tasks.set("FN-WEDGE", wedged);

    store = {
      getSettings: vi.fn().mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        autoMerge: true,
        taskStuckTimeoutMs: 15 * 60_000,
      } as unknown as Settings),
      listTasks: vi.fn().mockImplementation(async (options?: { column?: string }) => {
        const all = Array.from(tasks.values());
        if (!options?.column) return all;
        return all.filter((task) => task.column === options.column);
      }),
      getTask: vi.fn().mockImplementation(async (id: string) => tasks.get(id) ?? null),
      updateTask: vi.fn().mockImplementation(async (id: string, patch: Record<string, unknown>) => {
        const current = tasks.get(id);
        if (!current) throw new Error(`Task ${id} missing`);
        tasks.set(id, { ...current, ...patch });
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      getAgentLogs: vi.fn().mockImplementation(async () => agentLogs),
      recordRunAuditEvent: vi.fn().mockImplementation(async (event: Record<string, unknown>) => {
        auditEvents.push(event);
      }),
      getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not reclaim a live active merge with recent merger agent activity", async () => {
    agentLogs = [
      { agent: "merger", timestamp: "2026-01-01T00:55:00.000Z", type: "tool", text: "bash" },
    ];
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      abortActiveMerge,
    });

    const recovered = await manager.recoverWedgedActiveMerge();
    expect(recovered).toBe(0);
    expect(abortActiveMerge).not.toHaveBeenCalled();
    manager.stop();
  });

  it("reclaims reviewing after merger agent silence past stuck timeout and emits audit", async () => {
    // Last merger activity 30 minutes ago; stuck timeout is 15 minutes; status=reviewing.
    agentLogs = [
      { agent: "merger", timestamp: "2026-01-01T00:30:00.000Z", type: "tool", text: "fn_task_show" },
      { agent: "executor", timestamp: "2026-01-01T00:59:00.000Z", type: "text", text: "noise" },
    ];
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const enqueueMerge = vi.fn().mockReturnValue(true);
    const clearMergeActive = vi.fn();
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      abortActiveMerge,
      enqueueMerge,
      clearMergeActive,
    });

    const recovered = await manager.recoverWedgedActiveMerge();
    expect(recovered).toBe(1);
    expect(abortActiveMerge).toHaveBeenCalledWith("FN-WEDGE", "wedged-active-merge-no-merger-progress");
    expect(clearMergeActive).toHaveBeenCalledWith("FN-WEDGE");
    expect(enqueueMerge).toHaveBeenCalledWith("FN-WEDGE");
    expect(tasks.get("FN-WEDGE")?.status).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-WEDGE",
      expect.stringContaining("wedged active merge reclaimed"),
    );
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "FN-WEDGE",
          mutationType: "task:reconcile-wedged-active-merge",
          metadata: expect.objectContaining({
            taskId: "FN-WEDGE",
            reason: "wedged-active-merge-no-merger-progress",
            limitMs: 15 * 60_000,
            status: "reviewing",
          }),
        }),
      ]),
    );
    manager.stop();
  });

  it("does not false-reclaim merging-phase silence at stuckTimeout alone", async () => {
    tasks.set("FN-WEDGE", createTask("FN-WEDGE", { status: "merging" }));
    // Silence = 30m > stuck 15m but < 45m floor
    agentLogs = [
      { agent: "merger", timestamp: "2026-01-01T00:30:00.000Z", type: "tool", text: "bash" },
    ];
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      abortActiveMerge,
    });

    const recovered = await manager.recoverWedgedActiveMerge();
    expect(recovered).toBe(0);
    expect(abortActiveMerge).not.toHaveBeenCalled();
    manager.stop();
  });

  it("reclaims merging-phase only after the higher silence floor", async () => {
    tasks.set("FN-WEDGE", createTask("FN-WEDGE", { status: "merging" }));
    // System time 01:00; silence from 00:00 => 60m > 45m floor
    agentLogs = [
      { agent: "merger", timestamp: "2026-01-01T00:00:00.000Z", type: "tool", text: "bash" },
    ];
    expect(DEFAULT_MERGING_PHASE_SILENCE_FLOOR_MS).toBe(45 * 60_000);
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      abortActiveMerge,
      enqueueMerge: vi.fn().mockReturnValue(true),
      clearMergeActive: vi.fn(),
    });

    const recovered = await manager.recoverWedgedActiveMerge();
    expect(recovered).toBe(1);
    expect(abortActiveMerge).toHaveBeenCalled();
    manager.stop();
  });

  it("recoverInterruptedMergingTasks includes AI-merge reviewing status and aborts the live owner", async () => {
    agentLogs = [
      { agent: "merger", timestamp: "2026-01-01T00:20:00.000Z", type: "tool", text: "bash" },
    ];
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const enqueueMerge = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      abortActiveMerge,
      enqueueMerge,
      clearMergeActive: vi.fn(),
    });

    const recovered = await manager.recoverInterruptedMergingTasks();
    expect(recovered).toBe(1);
    expect(abortActiveMerge).toHaveBeenCalledWith("FN-WEDGE", "recover-interrupted-merging-wedged-owner");
    expect(enqueueMerge).toHaveBeenCalledWith("FN-WEDGE");
    expect(tasks.get("FN-WEDGE")?.status).toBeNull();
    manager.stop();
  });

  it("reclaims when agent logs are empty but claim wall-clock exceeds stuck timeout (dead pump)", async () => {
    tasks.set("FN-WEDGE", createTask("FN-WEDGE", { status: null }));
    agentLogs = [];
    const abortActiveMerge = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-WEDGE",
      // Claimed 40 minutes ago at system time 01:00
      getActiveMergeStartedAtMs: () => Date.parse("2026-01-01T00:20:00.000Z"),
      abortActiveMerge,
      enqueueMerge: vi.fn().mockReturnValue(true),
      clearMergeActive: vi.fn(),
    });

    const recovered = await manager.recoverWedgedActiveMerge();
    expect(recovered).toBe(1);
    expect(abortActiveMerge).toHaveBeenCalled();
    manager.stop();
  });
});
