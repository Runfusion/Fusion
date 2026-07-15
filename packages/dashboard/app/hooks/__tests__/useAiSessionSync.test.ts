import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiSessionSyncStore,
  __destroyAiSessionSyncStoreForTests,
  __resetAiSessionSyncStoreForTests,
} from "../useAiSessionSync";

class MockBroadcastChannel {
  static channels = new Map<string, Set<MockBroadcastChannel>>();

  readonly name: string;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    const group = MockBroadcastChannel.channels.get(name) ?? new Set<MockBroadcastChannel>();
    group.add(this);
    MockBroadcastChannel.channels.set(name, group);
  }

  postMessage(data: unknown): void {
    const group = MockBroadcastChannel.channels.get(this.name);
    if (!group) return;

    for (const channel of group) {
      if (channel === this) continue;
      channel.onmessage?.({ data } as MessageEvent<unknown>);
    }
  }

  close(): void {
    const group = MockBroadcastChannel.channels.get(this.name);
    if (!group) return;

    group.delete(this);
    if (group.size === 0) {
      MockBroadcastChannel.channels.delete(this.name);
    }
  }
}

describe("AiSessionSyncStore", () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  const stores: AiSessionSyncStore[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    MockBroadcastChannel.channels.clear();
    __resetAiSessionSyncStoreForTests();
    __destroyAiSessionSyncStoreForTests();
    (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel =
      MockBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    while (stores.length > 0) {
      stores.pop()?.destroy();
    }
    __resetAiSessionSyncStoreForTests();
    __destroyAiSessionSyncStoreForTests();
    vi.useRealTimers();
    (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel =
      originalBroadcastChannel;
  });

  function createStore(): AiSessionSyncStore {
    const store = new AiSessionSyncStore();
    stores.push(store);
    return store;
  }

  it("handles session updates and completion", () => {
    const storeA = createStore();
    const storeB = createStore();

    storeA.broadcastUpdate({
      sessionId: "sess-1",
      status: "awaiting_input",
      needsInput: true,
      type: "planning",
      title: "Cross-tab planning",
      projectId: "proj-1",
      timestamp: 10,
    });

    const syncedUpdate = storeB.getSnapshot().sessions.get("sess-1");
    expect(syncedUpdate?.status).toBe("awaiting_input");
    expect(syncedUpdate?.needsInput).toBe(true);

    storeA.broadcastCompleted({ sessionId: "sess-1", status: "complete", timestamp: 20 });

    const completed = storeB.getSnapshot().sessions.get("sess-1");
    expect(completed?.status).toBe("complete");
    expect(completed?.needsInput).toBe(false);
  });

  it("ignores stale updates using timestamp deduplication", () => {
    const storeA = createStore();
    const storeB = createStore();

    storeA.broadcastUpdate({
      sessionId: "sess-2",
      status: "awaiting_input",
      needsInput: true,
      type: "planning",
      title: "Latest state",
      projectId: "proj-1",
      timestamp: 200,
    });

    storeA.broadcastUpdate({
      sessionId: "sess-2",
      status: "error",
      needsInput: false,
      type: "planning",
      title: "Stale state",
      projectId: "proj-1",
      timestamp: 100,
    });

    const state = storeB.getSnapshot().sessions.get("sess-2");
    expect(state?.status).toBe("awaiting_input");
    expect(state?.lastEventTimestamp).toBe(200);
  });

  it("responds to sync requests with known session state", () => {
    const storeA = createStore();
    const storeB = createStore();

    storeA.broadcastUpdate({
      sessionId: "sess-3",
      status: "generating",
      needsInput: false,
      type: "mission_interview",
      title: "Mission planning",
      projectId: "proj-1",
      timestamp: 50,
    });

    storeB.requestSync();

    const synced = storeB.getSnapshot().sessions.get("sess-3");
    expect(synced).toBeDefined();
    expect(synced?.status).toBe("generating");
    expect(synced?.type).toBe("mission_interview");
  });

  it("falls back to localStorage storage events when BroadcastChannel is unavailable", () => {
    (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel =
      undefined;

    const storeA = createStore();
    const storeB = createStore();

    // Local updates still work without BroadcastChannel.
    storeA.broadcastUpdate({
      sessionId: "sess-4",
      status: "generating",
      needsInput: false,
      type: "subtask",
      title: "Fallback session",
      projectId: "proj-1",
      timestamp: 50,
    });

    const envelope = {
      id: "evt-1",
      message: {
        type: "session:updated",
        sessionId: "sess-4",
        status: "awaiting_input",
        needsInput: true,
        sessionType: "subtask",
        title: "Fallback session",
        projectId: "proj-1",
        timestamp: 75,
      },
    };

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "fusion:ai-session-sync",
        newValue: JSON.stringify(envelope),
      }),
    );

    const state = storeB.getSnapshot().sessions.get("sess-4");
    expect(state?.status).toBe("awaiting_input");
    expect(state?.needsInput).toBe(true);
  });

  /*
  FNXC:PlanningMultiTab 2026-07-14-00:00:
  This store carries no tab-ownership concept: sessions are multi-tab, so there is no lock to
  broadcast, no heartbeat to keep alive, and nothing to release on unload. A snapshot exposes
  session status only.
  */
  it("exposes no tab-ownership surface", () => {
    const store = createStore();

    expect("broadcastLock" in store).toBe(false);
    expect("broadcastUnlock" in store).toBe(false);
    expect("broadcastHeartbeat" in store).toBe(false);
    expect("activeTabMap" in store.getSnapshot()).toBe(false);
  });
});
