import "./executor-test-helpers.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TriageProcessor } from "../triage.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:CodingIdeasWorkflow 2026-07-25-11:20:
Covers the two halves of "a started Ideas card does not begin planning":

1. WAKE — Start performs a bare column move (TaskCard.handleStartClick -> onMoveTask) with no
   dispatch call, so planning previously waited out the poll timer (pollIntervalMs, 15s default).
   The wake is bound to the STORE EVENT rather than the button, so every move surface (board drag,
   context menu, task detail, List view, CLI, agent tools, POST /tasks/:id/move) is covered by
   construction — they all funnel through store.moveTask, which emits task:updated.
2. MISSING PROMPT.md — previously a silent `catch {}` dropped the card from planning discovery
   while the scheduler still kept it as a dispatch candidate, so it was invisible to planning with
   no log line in either lane.

Surface enumeration for the wake guard: both planning-eligible columns (todo, triage), a
non-eligible column, paused/userPaused rows, an already-processing row, the created-vs-updated
event, the stopped processor, and the nudge-during-poll replay path.
*/

type Listener = (...args: any[]) => void;

function createEventedStore(overrides: Record<string, any> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const store = {
    // A long interval guarantees any poll observed in these tests came from the wake, not a tick.
    getSettings: vi.fn().mockResolvedValue({
      pollIntervalMs: 600_000,
      maxConcurrent: 4,
      maxWorktrees: 4,
      autoMerge: true,
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    ...overrides,
  } as any;

  return {
    store,
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-WAKE-1",
    title: "Idea card",
    description: "desc",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

/*
FNXC:EngineTests 2026-07-25-11:20:
Fake timers, not real waits — the wake is debounced (NUDGE_DEBOUNCE_MS) and the poll interval is
600s, so a real-time sleep would either be flaky or slow. advanceTimersByTimeAsync also flushes the
microtasks between timers, which is what lets the start()-triggered poll settle before the assert.
*/
async function settleWake(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
}

describe("TriageProcessor planning wake (immediate poll on move)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls immediately when a task lands in todo instead of waiting for the interval", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    processor.start();
    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);

    emit("task:updated", createTask({ column: "todo" }));
    expect(poll).not.toHaveBeenCalled(); // debounced, not synchronous
    await settleWake();

    expect(poll).toHaveBeenCalledTimes(1);
    processor.stop();
  });

  it("also wakes for the triage column and for task:created", async () => {
    for (const [event, column] of [
      ["task:updated", "triage"],
      ["task:created", "todo"],
      ["task:created", "triage"],
    ] as const) {
      const { store, emit } = createEventedStore();
      const processor = new TriageProcessor(store, "/tmp/root");
      processor.start();
      const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);

      emit(event, createTask({ column }));
      await settleWake();

      expect(poll, `${event} in ${column}`).toHaveBeenCalledTimes(1);
      processor.stop();
    }
  });

  /*
  FNXC:WorkflowEvents 2026-08-01-07:21:
  Renamed planner lanes are authoritative only when task:updated carries cache-warmed metadata.
  A cold cache or runtime bridge is unknown, so it must retain the builtin literal fallback instead
  of synchronously resolving PostgreSQL's default workflow.
  */
  it("uses payload lanes for renamed wake columns and keeps absent metadata on the legacy fallback", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    processor.start();
    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);

    emit("task:updated", createTask({ id: "FN-RENAMED-WAKE", column: "drafting" }), {
      lanes: { hold: "drafting", intake: "inbox" },
    });
    await settleWake();
    expect(poll).toHaveBeenCalledTimes(1);

    poll.mockClear();
    emit("task:updated", createTask({ id: "FN-UNKNOWN-RENAMED", column: "drafting" }));
    await settleWake();
    expect(poll).not.toHaveBeenCalled();
    processor.stop();
  });

  it("coalesces a burst of moves into a single poll", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    processor.start();
    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);

    for (let i = 0; i < 5; i++) emit("task:updated", createTask({ id: `FN-WAKE-${i}`, column: "todo" }));
    await settleWake();

    expect(poll).toHaveBeenCalledTimes(1);
    processor.stop();
  });

  it("ignores moves that cannot start planning", async () => {
    const cases: Array<[string, Partial<Task>]> = [
      ["non-planning column", { column: "in-progress" }],
      ["paused", { column: "todo", paused: true }],
      ["userPaused", { column: "todo", userPaused: true }],
    ];
    for (const [label, overrides] of cases) {
      const { store, emit } = createEventedStore();
      const processor = new TriageProcessor(store, "/tmp/root");
      processor.start();
      const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);

      emit("task:updated", createTask(overrides));
      await settleWake();

      expect(poll, label).not.toHaveBeenCalled();
      processor.stop();
    }
  });

  it("ignores a task already being planned", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    processor.start();
    (processor as any).processing.add("FN-WAKE-1");
    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);

    emit("task:updated", createTask({ column: "todo" }));
    await settleWake();

    expect(poll).not.toHaveBeenCalled();
    processor.stop();
  });

  it("is a no-op before start and after stop, and unsubscribes on stop", async () => {
    const { store, emit, listenerCount } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    expect(processor.requestImmediatePoll()).toBe(false); // not running yet

    processor.start();
    expect(listenerCount("task:updated")).toBeGreaterThan(0);
    expect(processor.requestImmediatePoll()).toBe(true);

    processor.stop();
    expect(processor.requestImmediatePoll()).toBe(false);

    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);
    emit("task:updated", createTask({ column: "todo" }));
    await settleWake();
    expect(poll).not.toHaveBeenCalled();
  });

  it("replays a wake that arrives while a poll is already in flight", async () => {
    const { store } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    processor.start();

    // Simulate the re-entry guard: a nudge lands mid-poll and must not be swallowed.
    (processor as any).polling = true;
    expect(processor.requestImmediatePoll()).toBe(true);
    expect((processor as any).nudgeDuringPoll).toBe(true);

    const poll = vi.spyOn(processor as any, "poll").mockResolvedValue(undefined);
    // Drain the finally-block replay the same way poll() does.
    (processor as any).polling = false;
    (processor as any).nudgeDuringPoll = false;
    processor.requestImmediatePoll();
    await settleWake();

    expect(poll).toHaveBeenCalledTimes(1);
    processor.stop();
  });
});

describe("TriageProcessor planning discovery: missing PROMPT.md", () => {
  let rootDir: string;

  beforeEach(async () => {
    resetExecutorMocks();
    vi.clearAllMocks();
    rootDir = await mkdtemp(join(tmpdir(), "fusion-wake-test-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function discover(store: any, tasks: Task[]): Promise<string[]> {
    const processor = new TriageProcessor(store, rootDir);
    const found = await (processor as any).discoverReadyPlanningTasks(tasks, Date.now());
    return (found as Task[]).map((t) => t.id);
  }

  it("admits a todo task whose PROMPT.md is missing rather than silently skipping it", async () => {
    const { store } = createEventedStore();
    const task = createTask({ id: "FN-NOPROMPT", column: "todo" });
    // Task dir exists but PROMPT.md was never written / was deleted.
    await mkdir(join(rootDir, ".fusion", "tasks", task.id), { recursive: true });

    expect(await discover(store, [task])).toEqual(["FN-NOPROMPT"]);
  });

  it("admits a todo task whose PROMPT.md is still the seed stub, drift and all", async () => {
    for (const [label, content] of [
      ["exact", "# FN-SEED: Idea card\n\ndesc\n"],
      // CRLF + stripped trailing newline: the drift that used to read as "already planned".
      ["crlf, no trailing newline", "# FN-SEED: Idea card\r\n\r\ndesc"],
      ["trailing spaces", "# FN-SEED: Idea card  \n\ndesc  \n"],
    ] as const) {
      const { store } = createEventedStore();
      const task = createTask({ id: "FN-SEED", column: "todo", title: "Idea card", description: "desc" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "PROMPT.md"), content, "utf-8");

      expect(await discover(store, [task]), label).toEqual(["FN-SEED"]);
    }
  });

  /*
  FNXC:CodingIdeasWorkflow 2026-07-25-11:20:
  The refinement seed shape (no task-id prefix) must be admitted for planning too. This is the
  shape the scheduler's dispatch filter used to disagree about — it open-coded a strict bootstrap
  compare, so it treated a refinement seed as a real spec and kept it as a dispatch candidate while
  triage was planning it. Both lanes now share isUnplannedSeedPrompt.
  */
  it("admits a todo task carrying the refinement seed shape", async () => {
    const { store } = createEventedStore();
    const task = createTask({ id: "FN-REFINE", column: "todo", title: "Idea card", description: "desc" });
    const dir = join(rootDir, ".fusion", "tasks", task.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), "# Idea card\n\ndesc\n", "utf-8");

    expect(await discover(store, [task])).toEqual(["FN-REFINE"]);
  });

  /*
  FNXC:WorkflowReplan 2026-07-26-06:10:
  FN-8594 symptom: a card that executed once, failed Plan Review, and was rebounded to triage with
  status `needs-replan` was never re-admitted for planning — it sat in triage/needs-replan forever
  ("stuck in planning" on the board) because execution timestamps are sticky and outranked the
  planner-lane checks in hasAdvancedPastPlanning. Discovery is the surface that stranded the card,
  so assert admission here and not only on the pure guard. `firstExecutionAt` and
  `executionStartedAt` are stamped independently, so both are covered.
  */
  it("re-admits a rebounded triage replan card that already executed once", async () => {
    for (const [label, stamps] of [
      ["firstExecutionAt", { firstExecutionAt: "2026-07-26T04:35:29.068Z" }],
      ["executionStartedAt", { executionStartedAt: "2026-07-26T04:35:29.068Z" }],
      [
        "both stamps",
        {
          firstExecutionAt: "2026-07-26T04:35:29.068Z",
          executionStartedAt: "2026-07-26T04:35:29.068Z",
        },
      ],
    ] as const) {
      const { store } = createEventedStore();
      const task = createTask({
        id: "FN-REPLAN-EXECUTED",
        column: "triage",
        status: "needs-replan",
        // A replan card carries the steps and spec of its previous (rejected) planning pass.
        steps: [{ name: "step-1", status: "pending" }],
        ...stamps,
      });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "PROMPT.md"),
        "# FN-REPLAN-EXECUTED: Idea card\n\n## Mission\n\nRejected spec.\n",
        "utf-8",
      );

      expect(await discover(store, [task]), label).toEqual(["FN-REPLAN-EXECUTED"]);
    }
  });

  /*
  FNXC:WorkflowReplan 2026-07-26-08:35:
  The FN-8361 counter-case at the SURFACE, not only in the pure guard table: a `planning` row that
  execution claimed mid-race (stamp landed before the column/status write) must NOT be admitted for
  planning — otherwise a second planner starts on a card the executor already owns.
  */
  it("does not admit a planning row that execution claimed mid-race", async () => {
    const { store } = createEventedStore();
    const task = createTask({
      id: "FN-CLAIMED",
      column: "triage",
      status: "planning",
      worktree: "/tmp/claimed",
      firstExecutionAt: "2026-07-26T04:35:29.068Z",
    });
    const dir = join(rootDir, ".fusion", "tasks", task.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), "# FN-CLAIMED: Idea card\n\n## Mission\n\nSpec.\n", "utf-8");

    expect(await discover(store, [task])).toEqual([]);
  });

  it("re-admits a plan-in-place todo replan card that already executed once", async () => {
    const { store } = createEventedStore();
    const task = createTask({
      id: "FN-IDEAS-REPLAN",
      column: "todo",
      status: "needs-replan",
      steps: [{ name: "step-1", status: "pending" }],
      firstExecutionAt: "2026-07-26T04:35:29.068Z",
    });
    const dir = join(rootDir, ".fusion", "tasks", task.id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "PROMPT.md"),
      "# FN-IDEAS-REPLAN: Idea card\n\n## Mission\n\nRejected spec.\n",
      "utf-8",
    );

    expect(await discover(store, [task])).toEqual(["FN-IDEAS-REPLAN"]);
  });

  it("does not admit a todo task that already has a real spec", async () => {
    const { store } = createEventedStore();
    const task = createTask({ id: "FN-PLANNED", column: "todo", title: "Idea card", description: "desc" });
    const dir = join(rootDir, ".fusion", "tasks", task.id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "PROMPT.md"),
      "# FN-PLANNED: Idea card\n\n## Mission\n\nReal spec.\n\n## Steps\n\n1. Do it\n",
      "utf-8",
    );

    expect(await discover(store, [task])).toEqual([]);
  });
});
