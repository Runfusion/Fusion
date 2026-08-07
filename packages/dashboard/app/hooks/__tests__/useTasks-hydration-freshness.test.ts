/*
FNXC:MobileTabDiscard 2026-08-02-03:10:
The quarantine rescue fixes its off-by-one root cause with one fake system clock installed before every fixture. Exact epoch assertions remain required: tolerance, retries, or real-clock reads would conceal a hydration-freshness regression.

FNXC:MobileTabDiscard 2026-07-26-14:26:
Regression coverage for the freshness half of the mobile tab-discard restore.

Raising `SWR_TASKS_MAX_AGE_MS` from 60s to hours made a hydrated snapshot able to be OLDER than every
downstream freshness threshold for the first time. `lastFetchTimeMs` started as a bare
`useRef(undefined)` that only a successful fetch assigned, so every consumer fell back to `Date.now()`
and measured an hours-old `updatedAt` against NOW: on an iOS-PWA restore all in-progress cards
rendered 'stuck', their agent pulse was suppressed (`isTaskAgentActive({isStuck:true})`), and
Column/ExecutorStatusBar reported the same false counts until the mount revalidation resolved.

The invariant: `lastFetchTimeMs` describes the AGE OF THE ROWS CURRENTLY IN `tasks`, on the FIRST
render, not just after a fetch. Asserted against real localStorage and the real swrCache module —
a mocked cache is what let the missing `savedAt` plumbing hide.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { mergeTaskSnapshot, useTasks } from "../useTasks";
import * as api from "../../api";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";
import { isTaskStuck, countStuckTasks } from "../../utils/taskStuck";
import { isTaskAgentActive } from "../../utils/taskActivity";

/*
FNXC:MobileTabDiscard 2026-07-26-16:40:
The SSE bus is faked (rather than driven through EventSource) so a test can deliver ONE task event at a
chosen moment and inspect the freshness clock. `vi.hoisted` is required: the factory runs when
`../useTasks` is imported, before module-scope `const`s initialize.
*/
type SseEventHandlers = Record<string, ((event: MessageEvent) => void) | undefined>;
const sseHarness = vi.hoisted(() => ({ subscriptions: [] as Record<string, unknown>[] }));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (_url: string, sub: { events?: Record<string, unknown> } = {}) => {
    const events = sub.events ?? {};
    sseHarness.subscriptions.push(events);
    return () => {
      const index = sseHarness.subscriptions.indexOf(events);
      if (index >= 0) sseHarness.subscriptions.splice(index, 1);
    };
  },
}));

function emitSse(event: string, payload: unknown): void {
  act(() => {
    for (const events of [...sseHarness.subscriptions]) {
      (events as SseEventHandlers)[event]?.({ data: JSON.stringify(payload) } as MessageEvent);
    }
  });
}

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
const PROJECT_ID = "proj-freshness";
const CACHE_KEY = `${SWR_CACHE_KEYS.TASKS_PREFIX}${PROJECT_ID}`;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
/** Project default from `packages/core/src/settings-schema.ts`. */
const TASK_STUCK_TIMEOUT_MS = 600_000;

function createInProgressTask(id: string, updatedAtMs: number): Task {
  return {
    id,
    title: `Card ${id}`,
    description: "",
    column: "in-progress",
    status: "executing",
    dependencies: [],
    steps: [],
    log: [],
    createdAt: new Date(updatedAtMs - 60_000).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
  } as Task;
}

/** Seed the project snapshot with an explicit write time, mimicking a tab discarded `ageMs` ago. */
function seedSnapshot(tasks: Task[], ageMs: number): number {
  const savedAt = Date.now() - ageMs;
  localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt, data: tasks }));
  return savedAt;
}

/** Flush the resolved fetch promise without advancing the controlled system clock. */
async function flushAsyncUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
  sseHarness.subscriptions.length = 0;
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

/*
FNXC:TaskDetailStateStability 2026-08-05-02:55:
Scheduler-driven board resyncs can deliver an older Todo row after a newer queued dependency/file-overlap
snapshot has already reached an open detail host. The reconciliation helper must use lifecycle timestamps,
not payload arrival order: a stale or equal lifecycle payload cannot roll the visible task backwards, while
a real newer column move can advance it. Full-detail prompt/log data is retained when slim rows arrive.
*/
describe("task snapshot lifecycle freshness", () => {
  const todo = createInProgressTask("FN-ORDER", Date.parse("2026-08-05T10:00:00.000Z"));

  it("keeps a newer queued status through an old → new → stale-old scheduler ordering", () => {
    const queued = {
      ...todo,
      column: "todo",
      status: "queued-dependency",
      updatedAt: "2026-08-05T10:02:00.000Z",
      columnMovedAt: "2026-08-05T10:02:00.000Z",
      prompt: "# Full task detail",
      log: [{ timestamp: "2026-08-05T10:02:00.000Z", action: "Queued behind dependency" }],
    } as Task;
    const staleTodo = { ...todo, status: "todo", columnMovedAt: "2026-08-05T10:00:00.000Z" };

    const afterNew = mergeTaskSnapshot(todo, queued);
    const afterStale = mergeTaskSnapshot(afterNew, staleTodo);

    expect(afterStale).toMatchObject({ column: "todo", status: "queued-dependency", updatedAt: queued.updatedAt });
    expect(afterStale).toHaveProperty("prompt", "# Full task detail");
    expect(afterStale.log).toEqual(queued.log);
  });

  it("keeps populated detail metadata through an equal-clock sparse snapshot", () => {
    const queued = {
      ...todo,
      status: "queued-overlap",
      updatedAt: "2026-08-05T10:02:00.000Z",
      overlapBlockedBy: "FN-HOLDER",
      workflowStepResults: [{ stepId: "plan", status: "failed" }],
    };
    const equalSparseEvent = {
      ...todo,
      status: "todo",
      updatedAt: queued.updatedAt,
      overlapBlockedBy: null,
      workflowStepResults: [],
      title: "Scheduler summary",
    };

    const resolved = mergeTaskSnapshot(queued, equalSparseEvent);

    expect(resolved).toMatchObject({
      status: "queued-overlap",
      overlapBlockedBy: "FN-HOLDER",
      workflowStepResults: queued.workflowStepResults,
    });
    expect(resolved.title).toBe(todo.title);
  });

  it("keeps populated detail metadata when both a legacy row and sparse event lack update clocks", () => {
    const current = {
      ...todo,
      updatedAt: undefined,
      overlapBlockedBy: "FN-HOLDER",
      workflowStepResults: [{ stepId: "plan", status: "failed" }],
    } as unknown as Task;
    const sparseEvent = {
      ...todo,
      updatedAt: undefined,
      overlapBlockedBy: null,
      workflowStepResults: [],
    } as unknown as Task;

    expect(mergeTaskSnapshot(current, sparseEvent)).toMatchObject({
      overlapBlockedBy: "FN-HOLDER",
      workflowStepResults: current.workflowStepResults,
    });
  });

  it("accepts equal-clock non-lifecycle fields only from a marked complete fetch", () => {
    const current = { ...todo, updatedAt: "2026-08-05T10:02:00.000Z", title: "Cached title" };
    const completeFetch = { ...todo, updatedAt: current.updatedAt, title: "Fetched title" };

    expect(mergeTaskSnapshot(current, completeFetch, { fullSnapshot: true })).toMatchObject({
      status: current.status,
      title: "Fetched title",
    });
  });

  it("clears a stale planning status from an equal-clock complete refresh", () => {
    const current = {
      ...todo,
      column: "in-progress",
      status: "planning",
      updatedAt: "2026-08-05T10:02:00.000Z",
      recentAgentActivityAt: "2026-08-05T10:02:00.000Z",
    } as Task;
    const completeFetch = {
      ...todo,
      column: "in-progress",
      status: null,
      updatedAt: current.updatedAt,
    } as Task;

    expect(mergeTaskSnapshot(current, completeFetch, { fullSnapshot: true })).toMatchObject({
      column: "in-progress",
      status: null,
      recentAgentActivityAt: undefined,
    });
  });

  it("preserves newer planner activity when an equal-clock refresh has unchanged status", () => {
    const current = {
      ...todo,
      column: "triage",
      status: "needs-replan",
      updatedAt: "2026-08-05T10:02:00.000Z",
      recentAgentActivityAt: "2026-08-05T10:03:00.000Z",
    } as Task;
    const completeFetch = {
      ...todo,
      column: "triage",
      status: "needs-replan",
      updatedAt: current.updatedAt,
    } as Task;

    expect(mergeTaskSnapshot(current, completeFetch, { fullSnapshot: true })).toMatchObject({
      status: "needs-replan",
      recentAgentActivityAt: current.recentAgentActivityAt,
    });
  });

  it("keeps column and status from the same lifecycle row", () => {
    const current = {
      ...todo,
      column: "in-progress",
      status: "planning",
      updatedAt: "2026-08-05T10:02:00.000Z",
      columnMovedAt: "2026-08-05T10:02:00.000Z",
    } as Task;
    const staleCompleteFetch = {
      ...todo,
      column: "triage",
      status: null,
      updatedAt: current.updatedAt,
      columnMovedAt: current.columnMovedAt,
    } as Task;

    expect(mergeTaskSnapshot(current, staleCompleteFetch, { fullSnapshot: true })).toMatchObject({
      column: "in-progress",
      status: "planning",
    });
  });

  it("accepts a genuinely newer column transition", () => {
    const queued = { ...todo, column: "todo", status: "queued-overlap", updatedAt: "2026-08-05T10:02:00.000Z", columnMovedAt: "2026-08-05T10:02:00.000Z" };
    const executing = { ...todo, column: "in-progress", status: "executing", updatedAt: "2026-08-05T10:03:00.000Z", columnMovedAt: "2026-08-05T10:03:00.000Z" };

    expect(mergeTaskSnapshot(queued, executing)).toMatchObject({ column: "in-progress", status: "executing" });
  });
});

describe("useTasks hydration freshness (dataAsOfMs)", () => {
  it("reports the envelope savedAt, not now, on the first render after a 2-hour discard", () => {
    const savedAt = seedSnapshot([createInProgressTask("FN-1", Date.now() - TWO_HOURS_MS)], TWO_HOURS_MS);
    // Never resolves: everything asserted here is the pre-revalidation restore frame.
    mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));

    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-1"]);
    expect(result.current.lastFetchTimeMs).toBe(savedAt);
  });

  it("does not mark a whole board stuck when the snapshot itself is hours old", () => {
    const savedAt = Date.now() - TWO_HOURS_MS;
    // Each card was updated a minute before the snapshot was written: fresh RELATIVE TO the snapshot,
    // hours old relative to now. This is the operator's 6 in-progress cards after an iOS PWA discard.
    const tasks = Array.from({ length: 6 }, (_, index) =>
      createInProgressTask(`FN-${index}`, savedAt - 60_000),
    );
    seedSnapshot(tasks, TWO_HOURS_MS);
    mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    const dataAsOfMs = result.current.lastFetchTimeMs;

    expect(dataAsOfMs).toBe(savedAt);
    // The reported surface: TaskCard's `isStuck` / status badge.
    for (const task of result.current.tasks) {
      expect(isTaskStuck(task, TASK_STUCK_TIMEOUT_MS, dataAsOfMs)).toBe(false);
    }
    // Column.activeTaskCount and ExecutorStatusBar/useExecutorStats counters read the same clock.
    expect(countStuckTasks(result.current.tasks, TASK_STUCK_TIMEOUT_MS, dataAsOfMs)).toBe(0);
    // TaskCard's agent pulse is suppressed by `isStuck`; with an honest clock it stays lit.
    for (const task of result.current.tasks) {
      const isStuck = isTaskStuck(task, TASK_STUCK_TIMEOUT_MS, dataAsOfMs);
      expect(isTaskAgentActive(task, { isStuck })).toBe(true);
    }

    // Guard the exact regression: the old `undefined` clock (=> Date.now()) called all six stuck.
    expect(countStuckTasks(result.current.tasks, TASK_STUCK_TIMEOUT_MS, undefined)).toBe(6);
  });

  it("still reports a genuinely stuck card as stuck against the snapshot's own clock", () => {
    const savedAt = Date.now() - TWO_HOURS_MS;
    seedSnapshot(
      [
        createInProgressTask("FN-FRESH", savedAt - 60_000),
        // Already idle for 20 minutes when the snapshot was taken.
        createInProgressTask("FN-STUCK", savedAt - 20 * 60_000),
      ],
      TWO_HOURS_MS,
    );
    mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    const dataAsOfMs = result.current.lastFetchTimeMs;

    const stuckIds = result.current.tasks
      .filter((task) => isTaskStuck(task, TASK_STUCK_TIMEOUT_MS, dataAsOfMs))
      .map((task) => task.id);
    expect(stuckIds).toEqual(["FN-STUCK"]);
  });

  it("advances the clock to now once the mount revalidation lands real data", async () => {
    const savedAt = seedSnapshot([createInProgressTask("FN-OLD", Date.now() - TWO_HOURS_MS)], TWO_HOURS_MS);
    mockFetchTasks.mockResolvedValue([createInProgressTask("FN-NEW", Date.now())]);

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    expect(result.current.lastFetchTimeMs).toBe(savedAt);

    await flushAsyncUpdates();
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-NEW"]);
    expect(result.current.lastFetchTimeMs).toBeGreaterThan(savedAt);
  });

  it("leaves the clock undefined when there is no snapshot to describe", async () => {
    mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));

    expect(result.current.tasks).toEqual([]);
    expect(result.current.lastFetchTimeMs).toBeUndefined();
  });

  it("re-anchors the clock to the new project's snapshot on a project switch", async () => {
    const otherProjectId = "proj-freshness-other";
    const otherKey = `${SWR_CACHE_KEYS.TASKS_PREFIX}${otherProjectId}`;
    const firstSavedAt = seedSnapshot([createInProgressTask("FN-A", Date.now() - TWO_HOURS_MS)], TWO_HOURS_MS);
    const otherSavedAt = Date.now() - 30 * 60_000;
    localStorage.setItem(
      otherKey,
      JSON.stringify({ savedAt: otherSavedAt, data: [createInProgressTask("FN-B", otherSavedAt - 60_000)] }),
    );
    mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useTasks({ projectId }),
      { initialProps: { projectId: PROJECT_ID } },
    );
    expect(result.current.lastFetchTimeMs).toBe(firstSavedAt);

    rerender({ projectId: otherProjectId });

    await flushAsyncUpdates();
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-B"]);
    expect(result.current.lastFetchTimeMs).toBe(otherSavedAt);
  });
});

/*
FNXC:MobileTabDiscard 2026-07-26-16:40:
`lastFetchTimeMs` is read as the as-of time of ALL rows in `tasks`, but four writers advanced it to
`Date.now()` on learning about ONE row (task:created / task:moved / task:updated, and
`ingestCreatedTasks`). While a hydrated hours-old board waits for the mount revalidation on a waking
radio, a single unrelated event re-stamped the entire board as measured-from-now and every in-progress
card rendered 'stuck' again — the seeding regression above, reached through a sibling path.

The rule under test: a single-row live update may advance the clock only AFTER a full fetch has confirmed
every row. It must still advance after that, or stuck detection would silently stop firing for the rest
of a long SSE session (this hook has no periodic poll).
*/
describe("useTasks freshness clock vs single-row live updates", () => {
  const eventCases: [string, (task: Task) => unknown][] = [
    ["task:created", (task) => task],
    ["task:updated", (task) => task],
    ["task:moved", (task) => ({ task, from: "todo", to: "in-progress" })],
  ];

  it.each(eventCases)(
    "%s does not advance the clock while an unconfirmed hydrated snapshot is on screen",
    (eventName, buildPayload) => {
      const savedAt = Date.now() - TWO_HOURS_MS;
      const hydrated = Array.from({ length: 3 }, (_, index) =>
        createInProgressTask(`FN-${index}`, savedAt - 60_000),
      );
      seedSnapshot(hydrated, TWO_HOURS_MS);
      // Never resolves: the mount revalidation is still in flight, exactly as on a waking radio.
      mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

      const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));
      expect(result.current.lastFetchTimeMs).toBe(savedAt);

      emitSse(eventName, buildPayload(createInProgressTask("FN-LIVE", Date.now())));

      // The event was applied...
      expect(result.current.tasks.map((task) => task.id)).toContain("FN-LIVE");
      // ...but it says nothing about the other three rows, so the board's age is unchanged.
      expect(result.current.lastFetchTimeMs).toBe(savedAt);
      const stuckHydrated = hydrated.filter((task) =>
        isTaskStuck(task, TASK_STUCK_TIMEOUT_MS, result.current.lastFetchTimeMs),
      );
      expect(stuckHydrated).toEqual([]);
      expect(countStuckTasks(result.current.tasks, TASK_STUCK_TIMEOUT_MS, result.current.lastFetchTimeMs)).toBe(0);
    },
  );

  it("ingestCreatedTasks does not advance the clock while the snapshot is unconfirmed", () => {
    const savedAt = Date.now() - TWO_HOURS_MS;
    seedSnapshot([createInProgressTask("FN-0", savedAt - 60_000)], TWO_HOURS_MS);
    mockFetchTasks.mockReturnValue(new Promise<Task[]>(() => {}));

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));

    act(() => {
      result.current.ingestCreatedTasks([createInProgressTask("FN-INGESTED", Date.now())]);
    });

    expect(result.current.tasks.map((task) => task.id)).toContain("FN-INGESTED");
    expect(result.current.lastFetchTimeMs).toBe(savedAt);
  });

  it("still advances the clock on a live update once a fetch has confirmed the whole board", async () => {
    seedSnapshot([createInProgressTask("FN-0", Date.now() - TWO_HOURS_MS)], TWO_HOURS_MS);
    mockFetchTasks.mockResolvedValue([createInProgressTask("FN-CONFIRMED", Date.now())]);

    const { result } = renderHook(() => useTasks({ projectId: PROJECT_ID }));
    await flushAsyncUpdates();
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-CONFIRMED"]);
    const confirmedAt = result.current.lastFetchTimeMs;
    expect(confirmedAt).toBeDefined();

    vi.setSystemTime(Date.now() + 5 * 60_000);
    emitSse("task:updated", createInProgressTask("FN-CONFIRMED", Date.now()));

    expect(result.current.lastFetchTimeMs!).toBeGreaterThan(confirmedAt!);
  });
});
