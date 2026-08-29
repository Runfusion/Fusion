import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { LiveSnapshot } from "@fusion/core";

// Mock the api() helper so the panel fetches deterministic snapshots.
const apiMock = vi.fn();
vi.mock("../../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 0, sourceFileCount: 0, sourceByteCount: 0, diskBytes: 0, diskFileCount: 0, method: "local", truncated: false }),
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
}));

// Mock the SSE bus, capturing the subscription so tests can fire events and
// assert subscribe/unsubscribe behavior.
type SseEvents = Record<string, (e: unknown) => void>;
let sseHandlers: SseEvents = {};
let sseOnReconnect: (() => void) | undefined;
const unsubscribeMock = vi.fn();
const subscribeMock = vi.fn((_url: string, sub: { events?: SseEvents; onReconnect?: () => void }) => {
  sseHandlers = sub.events ?? {};
  sseOnReconnect = sub.onReconnect;
  return unsubscribeMock;
});
vi.mock("../../../sse-bus", () => ({
  subscribeSse: (url: string, sub: { events?: SseEvents; onReconnect?: () => void }) => subscribeMock(url, sub),
}));

import { MissionControlPanel, LIVE_POLL_INTERVAL_MS, NODE_STALE_THRESHOLD_MS } from "../MissionControlPanel";

function snapshot(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    capturedAt: "2026-06-15T12:00:00.000Z",
    activeSessions: 0,
    activeRuns: 0,
    activeNodes: 0,
    sessions: [],
    runs: [],
    columns: [],
    ...overrides,
  };
}

function activeSession(id: string, overrides: Partial<LiveSnapshot["sessions"][number]> = {}) {
  return {
    id,
    taskId: `task-${id}`,
    purpose: `purpose-${id}`,
    adapterId: "claude-local",
    agentState: "active",
    worktreePath: `/repo/wt-${id}`,
    updatedAt: "2026-06-15T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * Drive the real `document.visibilityState` + `visibilitychange` pair the panel listens on.
 * jsdom's visibilityState is read-only, so it is redefined per call.
 */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  apiMock.mockReset();
  subscribeMock.mockClear();
  unsubscribeMock.mockClear();
  sseHandlers = {};
  sseOnReconnect = undefined;
  vi.useFakeTimers();
});

afterEach(() => {
  setVisibility("visible");
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

/** Flush microtasks (awaited promises) under fake timers. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MissionControlPanel — KTD5 push + poll convergence", () => {
  it("renders an active session and removes it when it ends", async () => {
    // Initial: one active session.
    apiMock.mockResolvedValueOnce(
      snapshot({ activeSessions: 1, activeNodes: 1, sessions: [activeSession("s1")] }),
    );
    render(<MissionControlPanel />);
    await flush();

    expect(screen.getByTestId("mission-control-session-s1")).toBeTruthy();
    expect(screen.getByTestId("mission-control-active-sessions").textContent).toContain("1");

    // Next fetch (via SSE push): the session ended → empty snapshot.
    apiMock.mockResolvedValueOnce(snapshot());
    await act(async () => {
      sseHandlers["session:completed"]?.({});
    });
    await flush();

    expect(screen.queryByTestId("mission-control-session-s1")).toBeNull();
    expect(screen.getByTestId("mission-control-idle")).toBeTruthy();
  });

  it("appends projectId to the live snapshot request when supplied, and omits it when not", async () => {
    apiMock.mockResolvedValue(snapshot());
    const { unmount } = render(<MissionControlPanel />);
    await flush();
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe("/command-center/live");
    unmount();

    apiMock.mockClear();
    apiMock.mockResolvedValue(snapshot());
    render(<MissionControlPanel projectId="proj-abc" />);
    await flush();
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe("/command-center/live?projectId=proj-abc");
  });

  it("does NOT schedule a poll interval when idle (zero active sessions)", async () => {
    apiMock.mockResolvedValue(snapshot()); // idle from the start
    const setInterval = vi.spyOn(globalThis, "setInterval");
    render(<MissionControlPanel />);
    await flush();

    // No interval was ever scheduled because there is no work in-flight.
    expect(setInterval).not.toHaveBeenCalled();

    // Advancing well past the poll cadence triggers no further fetches.
    apiMock.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_POLL_INTERVAL_MS * 3);
    });
    await flush();
    expect(apiMock).not.toHaveBeenCalled();

    setInterval.mockRestore();
  });

  it("schedules a poll interval only while work is in-flight and stops it when idle", async () => {
    // In-flight snapshot → interval should arm.
    apiMock.mockResolvedValueOnce(
      snapshot({ activeSessions: 1, activeNodes: 1, sessions: [activeSession("s1")] }),
    );
    render(<MissionControlPanel />);
    await flush();

    // Poll tick fires while in-flight → another fetch (now idle).
    apiMock.mockResolvedValueOnce(snapshot());
    await act(async () => {
      vi.advanceTimersByTime(LIVE_POLL_INTERVAL_MS);
    });
    await flush();
    expect(screen.getByTestId("mission-control-idle")).toBeTruthy();

    // Now idle: further ticks must NOT fetch (interval was cleared).
    apiMock.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_POLL_INTERVAL_MS * 3);
    });
    await flush();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("refetches immediately on an SSE push, even between poll ticks", async () => {
    apiMock.mockResolvedValueOnce(snapshot()); // idle → no poll interval
    render(<MissionControlPanel />);
    await flush();
    apiMock.mockClear();

    // A push event arrives with NO timer advance: it must trigger a refetch.
    apiMock.mockResolvedValueOnce(
      snapshot({ activeSessions: 1, activeNodes: 1, sessions: [activeSession("s2")] }),
    );
    await act(async () => {
      sseHandlers["run:created"]?.({});
    });
    await flush();

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mission-control-session-s2")).toBeTruthy();
  });

  it("marks a node with no recent heartbeat as inactive rather than dropping it", async () => {
    const capturedAt = "2026-06-15T12:00:00.000Z";
    const capturedMs = Date.parse(capturedAt);
    const staleAt = new Date(capturedMs - NODE_STALE_THRESHOLD_MS - 5_000).toISOString();
    const freshAt = new Date(capturedMs - 1_000).toISOString();

    apiMock.mockResolvedValueOnce(
      snapshot({
        capturedAt,
        activeSessions: 2,
        activeNodes: 2,
        sessions: [
          activeSession("fresh", { worktreePath: "/repo/fresh-node", updatedAt: freshAt }),
          activeSession("stale", { worktreePath: "/repo/stale-node", updatedAt: staleAt }),
        ],
      }),
    );
    render(<MissionControlPanel />);
    await flush();

    // Both nodes are still present (stale one not dropped).
    const freshNode = screen.getByTestId("mission-control-node-fresh-node");
    const staleNode = screen.getByTestId("mission-control-node-stale-node");
    expect(freshNode.getAttribute("data-inactive")).toBe("false");
    expect(staleNode.getAttribute("data-inactive")).toBe("true");
  });

  it("subscribes to the SSE bus on mount and unsubscribes on unmount", async () => {
    apiMock.mockResolvedValue(snapshot());
    const { unmount } = render(<MissionControlPanel />);
    await flush();

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock.mock.calls[0][0]).toBe("/api/events");
    expect(typeof sseOnReconnect).toBe("function");

    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("renders the live SDLC funnel from current column counts", async () => {
    apiMock.mockResolvedValueOnce(
      snapshot({
        activeSessions: 1,
        sessions: [activeSession("s1")],
        columns: [
          { column: "triage", count: 4 },
          { column: "in-progress", count: 2 },
          { column: "done", count: 7 },
          { column: "custom-column", count: 3 },
        ],
      }),
    );
    render(<MissionControlPanel />);
    await flush();

    const funnel = screen.getByTestId("mission-control-funnel");
    expect(funnel).toBeTruthy();
    // The unmapped "custom-column" folds into an "Other" stage, not dropped.
    expect(funnel.textContent).toContain("3");
    expect(funnel.textContent).toContain("7");
  });

  it("surfaces a hard error when the first fetch fails with no prior data", async () => {
    apiMock.mockRejectedValueOnce(new Error("boom"));
    render(<MissionControlPanel />);
    await flush();
    expect(screen.getByTestId("mission-control-error")).toBeTruthy();
  });
});

/*
FNXC:MobileTabRetention 2026-07-26-17:05:
`useLiveSnapshot` does NOT use the shared `useVisibilityAwarePoll` primitive — it hand-rolls its own
`visibilitychange` listener because the poll is self-managing (each response decides whether to re-arm).
Consequence: it is invisible to `visibility-poll-gating.test.ts`'s sampled surfaces AND to the shared
hook's unit tests, so until this block existed a regression that reintroduced background polling on a
backgrounded tab would have passed the entire suite. A 5s fetch loop on a hidden tab is a primary iOS
Safari / Chrome Android page-discard signal, and the discard is the white-splash reload on return.

Two independent behaviors are asserted, because there are two independent ways to reintroduce the leak:
1. The hidden edge must CLEAR the running interval (the listener's `stopPolling`).
2. A refetch that completes while hidden must not RE-ARM it (the `documentVisible` gate in `load`'s
   `finally`). Deleting either one alone leaves the other passing, so both are tested separately.
The visible edge must then refetch exactly once and resume polling — suspension that never resumes is
the same silent-staleness defect wearing different clothes.
*/
describe("MissionControlPanel — hidden-tab poll gating", () => {
  it("stops polling while the document is hidden and fires no background fetches", async () => {
    apiMock.mockResolvedValue(
      snapshot({ activeSessions: 1, activeNodes: 1, sessions: [activeSession("s1")] }),
    );
    render(<MissionControlPanel />);
    await flush();

    // In-flight work: the interval is armed and a tick fetches.
    await act(async () => {
      vi.advanceTimersByTime(LIVE_POLL_INTERVAL_MS);
    });
    await flush();
    expect(apiMock.mock.calls.length).toBeGreaterThan(1);

    setVisibility("hidden");
    await flush();

    apiMock.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_POLL_INTERVAL_MS * 3);
    });
    await flush();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("does not re-arm the poll interval from a refetch that completes while hidden", async () => {
    apiMock.mockResolvedValue(
      snapshot({ activeSessions: 1, activeNodes: 1, sessions: [activeSession("s1")] }),
    );
    render(<MissionControlPanel />);
    await flush();

    setVisibility("hidden");
    await flush();

    // An SSE push (or the reconnect resync) can still land in the window before the bus itself
    // suspends. Its response reports work in-flight — but a hidden tab must not schedule a timer.
    await act(async () => {
      sseHandlers["run:created"]?.({});
    });
    await flush();

    apiMock.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_POLL_INTERVAL_MS * 3);
    });
    await flush();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("refetches exactly once on the hidden -> visible edge and re-arms polling", async () => {
    apiMock.mockResolvedValue(
      snapshot({ activeSessions: 1, activeNodes: 1, sessions: [activeSession("s1")] }),
    );
    render(<MissionControlPanel />);
    await flush();

    setVisibility("hidden");
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_POLL_INTERVAL_MS * 3);
    });
    await flush();

    apiMock.mockClear();
    setVisibility("visible");
    await flush();

    // Exactly one refresh on the edge — not zero (stale panel) and not a burst.
    expect(apiMock).toHaveBeenCalledTimes(1);

    // ...and polling is live again, so the panel keeps converging while in view.
    apiMock.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_POLL_INTERVAL_MS);
    });
    await flush();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
