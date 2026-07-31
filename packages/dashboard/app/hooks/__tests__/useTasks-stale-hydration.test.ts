/*
FNXC:MobileTabDiscard 2026-07-26-11:05:
Regression coverage for the mobile tab-discard restore. iOS Safari, iOS PWAs, and Chrome Android
discard a backgrounded dashboard tab after a few minutes; on return the bundle re-executes and the
board must repaint from its localStorage snapshot instead of starting from []. The invariant under
test is the whole stale-while-revalidate contract, not just the TTL number:
  1. a snapshot older than the old 60s bound (minutes / hours) still hydrates on mount,
  2. hydration always issues exactly one immediate revalidation and reports `isStale` while it runs
     (App renders <TopProgressBar visible={isRevalidating}> off that flag), and
  3. a failed revalidation clears the entry so the next mount cannot re-hydrate unverifiable data.
These are asserted against real localStorage + the real swrCache module, because a mocked cache is
exactly what let the expired-snapshot bug hide.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { useTasks } from "../useTasks";
import * as api from "../../api";
import { SWR_CACHE_KEYS, SWR_TASKS_MAX_AGE_MS } from "../../utils/swrCache";

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTasks: vi.fn().mockResolvedValue([]),
  });
});

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 1;
  close = vi.fn(() => {
    this.readyState = 2;
  });
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const originalEventSource = globalThis.EventSource;
const mockFetchTasks = vi.mocked(api.fetchTasks);
const PROJECT_ID = "proj-discard";
const CACHE_KEY = `${SWR_CACHE_KEYS.TASKS_PREFIX}${PROJECT_ID}`;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-CACHED",
    title: "Cached card",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    log: [],
    createdAt: "2026-07-26T09:00:00.000Z",
    updatedAt: "2026-07-26T09:00:00.000Z",
    ...overrides,
  } as Task;
}

/** Seed the project snapshot with an explicit age, mimicking a tab discarded `ageMs` ago. */
function seedSnapshot(tasks: Task[], ageMs: number): void {
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ savedAt: Date.now() - ageMs, data: tasks }),
  );
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  localStorage.clear();
  mockFetchTasks.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
  localStorage.clear();
  vi.useRealTimers();
});

describe("useTasks stale snapshot hydration (mobile tab discard)", () => {
  it("hydrates a snapshot several minutes old on mount", async () => {
    seedSnapshot([createTask({ id: "FN-STALE" })], FIVE_MINUTES_MS);
    // Never resolve: proves the board painted from cache, not from the fetch.
    mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));

    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-STALE"]);
    expect(result.current.isStale).toBe(true);
  });

  it("hydrates a snapshot just under the hydration TTL and drops one past it", () => {
    seedSnapshot([createTask({ id: "FN-OLD" })], SWR_TASKS_MAX_AGE_MS - 60_000);
    mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

    const { result, unmount } = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-OLD"]);
    unmount();

    seedSnapshot([createTask({ id: "FN-ANCIENT" })], SWR_TASKS_MAX_AGE_MS + 60_000);
    const expired = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    expect(expired.result.current.tasks).toEqual([]);
  });

  it("issues exactly one immediate revalidation after hydrating, then clears the stale flag", async () => {
    seedSnapshot([createTask({ id: "FN-STALE" })], FIVE_MINUTES_MS);
    mockFetchTasks.mockResolvedValue([createTask({ id: "FN-FRESH" })]);

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));

    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-STALE"]);
    expect(mockFetchTasks).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-FRESH"]);
    });
    expect(result.current.isStale).toBe(false);
    expect(mockFetchTasks).toHaveBeenCalledTimes(1);
  });

  it("clears the entry when a revalidation that REACHED THE SERVER fails, so the next mount does not re-hydrate it", async () => {
    seedSnapshot([createTask({ id: "FN-STALE" })], FIVE_MINUTES_MS);
    // A non-2xx response: the server answered and the snapshot is unverifiable.
    mockFetchTasks.mockRejectedValue(new Error("Request failed: 500"));

    const first = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    expect(first.result.current.tasks.map((task) => task.id)).toEqual(["FN-STALE"]);

    await waitFor(() => {
      expect(first.result.current.lastRefreshErrorAt).not.toBeNull();
    });
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
    expect(first.result.current.tasks).toEqual([]);
    first.unmount();

    const second = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    expect(second.result.current.tasks).toEqual([]);
  });

  /*
  FNXC:MobileTabDiscard 2026-07-26-16:40:
  The failure mode this whole cache exists to survive. The mount revalidation fires on a just-woken
  mobile radio, where the first fetch routinely rejects at the transport layer ("Load failed" on iOS
  Safari, "Failed to fetch" on Chrome Android). That rejection says nothing about the snapshot, but the
  `clearOnError` catch used to delete the entry AND blank the hydrated board — so the restore went white
  and the NEXT restore had nothing left to hydrate either.
  */
  describe.each([
    ["an iOS suspension rejection", () => new TypeError("Load failed"), false],
    ["a Chrome Android suspension rejection", () => new TypeError("Failed to fetch"), false],
    ["an offline device", () => new Error("boom"), true],
  ])("when mount revalidation fails with %s", (_label, makeError, forceOffline) => {
    beforeEach(() => {
      if (!forceOffline) return;
      // Own property shadows jsdom's Navigator.prototype getter; deleting it restores the getter.
      Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    });

    afterEach(() => {
      if (!forceOffline) return;
      delete (navigator as unknown as Record<string, unknown>).onLine;
    });

    it("keeps both the painted board and the snapshot so the next restore still hydrates", async () => {
      seedSnapshot([createTask({ id: "FN-STALE" })], FIVE_MINUTES_MS);
      mockFetchTasks.mockRejectedValue(makeError());

      const first = renderHook(() => useTasks({ projectId: PROJECT_ID }));
      expect(first.result.current.tasks.map((task) => task.id)).toEqual(["FN-STALE"]);

      await waitFor(() => {
        expect(first.result.current.lastRefreshErrorAt).not.toBeNull();
      });
      // The board must not blank behind the failed revalidation.
      expect(first.result.current.tasks.map((task) => task.id)).toEqual(["FN-STALE"]);
      expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();
      first.unmount();

      // The restore after this one is the real regression: it must not start from [].
      const second = renderHook(() => useTasks({ projectId: PROJECT_ID }));
      expect(second.result.current.tasks.map((task) => task.id)).toEqual(["FN-STALE"]);
    });
  });

  it("still persists a snapshot when the full board exceeds the write budget", async () => {
    // ~2.5KB of log/description bulk per row across 400 rows blows past the 500KB envelope cap.
    const heavyTasks = Array.from({ length: 400 }, (_, index) =>
      createTask({
        id: `FN-${index.toString().padStart(3, "0")}`,
        description: "x".repeat(1_200),
        log: Array.from({ length: 12 }, () => ({ timestamp: "2026-07-26T09:00:00.000Z", action: "y".repeat(100) })),
      } satisfies Partial<Task>),
    );
    mockFetchTasks.mockResolvedValue(heavyTasks);

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(400);
    });

    await waitFor(() => {
      expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();
    });
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as { data: Task[] };
    expect(stored.data.length).toBeGreaterThan(0);
    expect(stored.data[0]).not.toHaveProperty("log");
  });

  it("re-hydrates the persisted snapshot on a simulated discard-and-restore", async () => {
    mockFetchTasks.mockResolvedValue([createTask({ id: "FN-PERSISTED" })]);
    const live = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    await waitFor(() => {
      expect(live.result.current.tasks.map((task) => task.id)).toEqual(["FN-PERSISTED"]);
    });
    live.unmount();

    // Discard: the page is evicted and re-executed minutes later with only localStorage surviving.
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as { savedAt: number; data: Task[] };
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...raw, savedAt: raw.savedAt - FIVE_MINUTES_MS }));
    mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

    const restored = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    expect(restored.result.current.tasks.map((task) => task.id)).toEqual(["FN-PERSISTED"]);
  });
});

describe("useTasks in-app view re-entry freshness", () => {
  it("still catches up after a minute away even though the hydration TTL is hours", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchTasks.mockResolvedValue([createTask({ id: "FN-A" })]);

    const { result, rerender } = renderHook(
      ({ sseEnabled }: { sseEnabled: boolean }) => useTasks({ projectId: PROJECT_ID, sseEnabled }),
      { initialProps: { sseEnabled: false } },
    );
    await waitFor(() => {
      expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-A"]);
    });
    expect(mockFetchTasks).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61_000);
    mockFetchTasks.mockResolvedValue([createTask({ id: "FN-B" })]);
    await act(async () => {
      rerender({ sseEnabled: true });
    });

    await waitFor(() => {
      expect(mockFetchTasks).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-B"]);
    });
  });
});
