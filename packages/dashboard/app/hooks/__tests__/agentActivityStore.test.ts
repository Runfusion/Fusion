import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const getAgentActivity = vi.fn();
  let activityHandler: ((event: MessageEvent) => void) | undefined;
  let onReconnect: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const subscribeSse = vi.fn((_url: string, subscription: {
    events?: Record<string, (event: MessageEvent) => void>;
    onReconnect?: () => void;
  }) => {
    activityHandler = subscription.events?.["agent:activity"];
    onReconnect = subscription.onReconnect;
    return unsubscribe;
  });
  return {
    getAgentActivity,
    getActivityHandler: () => activityHandler,
    getOnReconnect: () => onReconnect,
    clearHandlers: () => { activityHandler = undefined; onReconnect = undefined; },
    unsubscribe,
    subscribeSse,
  };
});

vi.mock("../../api", () => ({ getAgentActivity: mocks.getAgentActivity }));
vi.mock("../../sse-bus", () => ({ subscribeSse: mocks.subscribeSse }));

import { ACTIVITY_EVENT_CAP, ACTIVITY_EXPIRY_TICK_MS, __resetAgentActivityStoreForTests, agentActivityStore } from "../agentActivityStore";
import { ACTIVE_STATE_WINDOW_MS } from "../../components/agentsOrgChartActivity";

const NOW = new Date("2026-08-09T10:00:00.000Z");
const page = (events: ReturnType<typeof event>[] = []) => ({ events, nextCursor: null });
const event = (eventId: string, occurredAt: string, agentId = "agent-a", projectId = "project") => ({
  eventId, seq: eventId, projectId, agentId, agentAttribution: "agent" as const,
  taskId: null, type: "task:started" as const, fromAgentId: null, toAgentId: null,
  summary: eventId, occurredAt, metadata: null,
});
const deliver = (value: ReturnType<typeof event>) => {
  mocks.getActivityHandler()!(new MessageEvent("agent:activity", { data: JSON.stringify(value) }));
};

afterEach(() => {
  __resetAgentActivityStoreForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.clearHandlers();
});

describe("agentActivityStore", () => {
  it("shares one stream and keeps snapshots stable between mutations", async () => {
    mocks.getAgentActivity.mockResolvedValue(page());
    const before = agentActivityStore.getSnapshot();
    expect(agentActivityStore.getSnapshot()).toBe(before);
    agentActivityStore.retain("first", "project");
    agentActivityStore.retain("second", "project");
    await vi.waitFor(() => expect(mocks.getAgentActivity).toHaveBeenCalledTimes(1));
    expect(mocks.subscribeSse).toHaveBeenCalledTimes(1);
    agentActivityStore.release("first");
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    agentActivityStore.release("second");
    await Promise.resolve();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight seed when the last consumer releases", async () => {
    let signal: AbortSignal | undefined;
    mocks.getAgentActivity.mockImplementation((_params: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
    agentActivityStore.retain("one", "project");
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    agentActivityStore.release("one");
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
  });

  it("merges delayed seed, live, and reconnect data by event order", async () => {
    let resolveSeed!: (value: ReturnType<typeof page>) => void;
    mocks.getAgentActivity.mockReturnValueOnce(new Promise((resolve) => { resolveSeed = resolve; }));
    agentActivityStore.retain("one", "project");
    await vi.waitFor(() => expect(mocks.getActivityHandler()).toBeTypeOf("function"));
    deliver(event("new", "2026-08-09T10:00:02.000Z"));
    resolveSeed(page([event("old", "2026-08-09T10:00:01.000Z")]));
    await vi.waitFor(() => expect(agentActivityStore.getSnapshot().events).toHaveLength(2));
    expect(agentActivityStore.getSnapshot().activityByAgentId.get("agent-a")?.eventId).toBe("new");

    mocks.getAgentActivity.mockResolvedValue(page([event("old", "2026-08-09T10:00:01.000Z")]));
    mocks.getOnReconnect()!();
    await vi.waitFor(() => expect(mocks.getAgentActivity).toHaveBeenCalledTimes(2));
    expect(agentActivityStore.getSnapshot().events.map((item) => item.eventId)).toEqual(["new", "old"]);
  });

  it("drops malformed timestamps and retains the newest events when the ring reaches its cap", async () => {
    mocks.getAgentActivity.mockResolvedValue(page());
    agentActivityStore.retain("one", "project");
    await vi.waitFor(() => expect(mocks.getActivityHandler()).toBeTypeOf("function"));
    deliver(event("bad", "not-a-date"));
    for (let index = 0; index <= ACTIVITY_EVENT_CAP; index++) {
      deliver(event(`event-${index}`, new Date(NOW.getTime() + index).toISOString(), `agent-${index}`));
    }
    const snapshot = agentActivityStore.getSnapshot();
    expect(snapshot.events).toHaveLength(ACTIVITY_EVENT_CAP);
    expect(snapshot.events.some((item) => item.eventId === "bad")).toBe(false);
    expect(snapshot.events.some((item) => item.eventId === "event-0")).toBe(false);
    expect(snapshot.events.some((item) => item.eventId === `event-${ACTIVITY_EVENT_CAP}`)).toBe(true);
    expect(snapshot.activityByAgentId.has("agent-0")).toBe(false);

    // Event ids stay idempotent even after their retained event was evicted.
    deliver(event("event-0", NOW.toISOString(), "agent-0"));
    expect(agentActivityStore.getSnapshot().events.some((item) => item.eventId === "event-0")).toBe(false);
  });

  it("publishes local expiry without fetching and stops the clock after evidence settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getAgentActivity.mockResolvedValue(page());
    agentActivityStore.retain("one", "project");
    await Promise.resolve();
    deliver(event("active", NOW.toISOString()));
    const startedAt = agentActivityStore.getSnapshot().nowTick;
    await vi.advanceTimersByTimeAsync(ACTIVITY_EXPIRY_TICK_MS);
    expect(agentActivityStore.getSnapshot().nowTick).toBeGreaterThan(startedAt);
    expect(mocks.getAgentActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ACTIVE_STATE_WINDOW_MS + ACTIVITY_EXPIRY_TICK_MS);
    const settledAt = agentActivityStore.getSnapshot().nowTick;
    await vi.advanceTimersByTimeAsync(ACTIVITY_EXPIRY_TICK_MS * 2);
    expect(agentActivityStore.getSnapshot().nowTick).toBe(settledAt);
  });

  it("clears stale project state and rejects obsolete or misrouted project rows", async () => {
    let resolveFirst!: (value: ReturnType<typeof page>) => void;
    mocks.getAgentActivity.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    mocks.getAgentActivity.mockResolvedValueOnce(page([
      event("wrong-project", NOW.toISOString(), "agent-a", "project-a"),
      event("project-b", NOW.toISOString(), "agent-b", "project-b"),
    ]));
    agentActivityStore.retain("one", "project-a");
    await vi.waitFor(() => expect(mocks.getActivityHandler()).toBeTypeOf("function"));
    agentActivityStore.retain("two", "project-b");
    expect(agentActivityStore.getSnapshot().events).toHaveLength(0);
    resolveFirst(page([event("project-a", NOW.toISOString(), "agent-a", "project-a")]));
    await vi.waitFor(() => expect(agentActivityStore.getSnapshot().activityByAgentId.get("agent-b")?.eventId).toBe("project-b"));
    expect(agentActivityStore.getSnapshot().activityByAgentId.has("agent-a")).toBe(false);

    deliver(event("misrouted", NOW.toISOString(), "agent-c", "project-a"));
    expect(agentActivityStore.getSnapshot().activityByAgentId.has("agent-c")).toBe(false);
  });

  it("clears state before reseeding when a sole consumer changes project", async () => {
    mocks.getAgentActivity
      .mockResolvedValueOnce(page([event("project-a", NOW.toISOString(), "agent-a", "project-a")]))
      .mockResolvedValueOnce(page([event("project-b", NOW.toISOString(), "agent-b", "project-b")]));
    agentActivityStore.retain("one", "project-a");
    await vi.waitFor(() => expect(agentActivityStore.getSnapshot().events).toHaveLength(1));

    agentActivityStore.retain("one", "project-b");
    expect(agentActivityStore.getSnapshot().events).toHaveLength(0);
    await vi.waitFor(() => expect(agentActivityStore.getSnapshot().activityByAgentId.get("agent-b")?.eventId).toBe("project-b"));
    expect(agentActivityStore.getSnapshot().activityByAgentId.has("agent-a")).toBe(false);
  });

  it("expires a future server timestamp from its receipt-time clamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getAgentActivity.mockResolvedValue(page());
    agentActivityStore.retain("one", "project");
    await Promise.resolve();
    deliver(event("future", new Date(NOW.getTime() + ACTIVE_STATE_WINDOW_MS * 4).toISOString()));
    await vi.advanceTimersByTimeAsync(ACTIVITY_EXPIRY_TICK_MS);
    await vi.advanceTimersByTimeAsync(ACTIVE_STATE_WINDOW_MS + ACTIVITY_EXPIRY_TICK_MS);
    const settledAt = agentActivityStore.getSnapshot().nowTick;
    await vi.advanceTimersByTimeAsync(ACTIVITY_EXPIRY_TICK_MS * 2);
    expect(agentActivityStore.getSnapshot().nowTick).toBe(settledAt);
  });
});
