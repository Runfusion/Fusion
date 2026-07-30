import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { TriageProcessor } from "../triage.js";

/*
FNXC:ConcurrencyAdmission 2026-07-26-09:30:
Regression suite for the diagnosability half of the FN-8600 incident.

Original symptom: an operator asked why a started card sat "Queued to plan" for seven minutes. The
answer was unrecoverable after the fact — the binding gate was written ONLY to `planLog.log`, which
lands in the TUI's in-memory pane (truncated) and is persisted nowhere. Reconstructing the timeline
required a manual DB forensics pass that still could not separate "host semaphore exhausted" from
"project cap consumed".

Invariant under test: whenever planning admission is withheld while eligible work exists, the
binding gate is recorded durably in run-audit with ids/counts only — and a sustained stall records
ONE row rather than one per poll, so the signal stays readable.
*/

vi.mock("../reviewer.js", () => ({ reviewStep: vi.fn() }));

vi.mock("../pi.js", () => {
  class ModelFallbackExhaustedError extends Error {}
  return {
    ModelFallbackExhaustedError,
    createFnAgent: vi.fn(),
    describeModel: vi.fn().mockReturnValue("mock-model"),
    formatModelMarkerDetails: vi.fn((model: string) => model),
    promptWithFallback: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original));
});

/** A todo card with no steps and no spec on disk — i.e. eligible for planning. */
function eligibleTodoTask(id: string): Task {
  return {
    id,
    description: "Add ability to favorite projects on mobile",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-26T15:37:52.786Z",
    updatedAt: "2026-07-26T15:37:52.786Z",
  } as Task;
}

interface RecordedEvent { type: string; target: string; metadata?: Record<string, unknown> }

/*
FNXC:CapacityModel 2026-07-29-18:40 (PR #2562 review):
The card that CONSUMES the project's single agent slot. Previously an exhausted host
semaphore forced the withhold; that gate is deleted, so the binding gate is now the
per-project agent count and something has to be holding it.
*/
function runningTask(id: string): Task {
  return {
    id,
    description: "already running",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-26T15:00:00.000Z",
    updatedAt: "2026-07-26T15:00:00.000Z",
  } as Task;
}

function createStore(tasks: Task[], recorded: RecordedEvent[], settings: Partial<Settings> = {}): TaskStore {
  // The running claimant is added here so every case exhausts the one project slot.
  tasks = [runningTask("FN-RUNNING"), ...tasks];
  return {
    getTask: vi.fn().mockImplementation(async (id: string) => {
      const task = tasks.find((candidate) => candidate.id === id);
      return task ? { ...task, prompt: "", attachments: [], comments: [] } : null;
    }),
    listTasks: vi.fn().mockResolvedValue(tasks),
    getSettings: vi.fn().mockResolvedValue({
      // FNXC:CapacityModel 2026-07-29-18:40: one slot, consumed by the in-progress
      // row below, so planning admission is withheld by the PROJECT agent count.
      maxConcurrent: 1,
      maxWorktrees: 4,
      pollIntervalMs: 600_000,
      groupOverlappingFiles: false,
      autoMerge: true,
      ...settings,
    } as Settings),
    recordRunAuditEvent: vi.fn().mockImplementation(async (event: { mutationType: string; target: string; metadata?: Record<string, unknown> }) => {
      recorded.push({ type: event.mutationType, target: event.target, metadata: event.metadata });
    }),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn(),
    createTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    updateSettings: vi.fn(),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as TaskStore;
}

/*
FNXC:CapacityModel 2026-07-29-18:40 (PR #2562 review — greptile P1):
Drive the throttle through the PROJECT AGENT COUNT, not an exhausted host semaphore.

These cases previously spent a 1-slot `AgentSemaphore` to force the withhold. That
gate is deleted with the cross-project cap, so the poll no longer consults it and no
throttle event was emitted — the suite exercised a limiter that no longer exists and
would have gone quietly non-firing.

The REQUIREMENT is unchanged and is what these cases still pin: when planning
admission is withheld while eligible cards wait, the binding gate must be recorded
durably (FN-8600 — an operator asked why a card sat "Queued to plan" for seven
minutes and it was unanswerable after the fact). Only the gate that can bind has
changed, so the setup exhausts `maxConcurrent` instead.
*/
async function pollWithExhaustedProjectCapacity(store: TaskStore): Promise<TriageProcessor> {
  const processor = new TriageProcessor(store, "/tmp/fn-8600-throttle-root", {});
  // poll() is a no-op unless the processor is running; these tests drive one pass directly rather
  // than starting the interval timer, which would make them time-dependent.
  (processor as unknown as { running: boolean }).running = true;
  await (processor as unknown as { poll: () => Promise<void> }).poll();
  // The audit write is fire-and-forget, so let its microtask settle before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  return processor;
}

describe("plan admission throttle run-audit (FN-8600)", () => {
  let recorded: RecordedEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    recorded = [];
  });

  it("records the binding gate when planning is withheld with eligible work", async () => {
    
    const store = createStore([eligibleTodoTask("FN-8600")], recorded);
    await pollWithExhaustedProjectCapacity(store);

    const throttle = recorded.filter((event) => event.type === "task:plan-admission-throttled");
    expect(throttle).toHaveLength(1);
    // The gate the operator could not previously determine.
    expect(throttle[0].metadata).toMatchObject({
      blockedBy: "running-agent cap",
      maxConcurrent: 1,
      eligibleCount: 1,
      eligibleTaskIds: ["FN-8600"],
    });
  });

  it("emits one row for a sustained stall instead of one per poll", async () => {
    
    const store = createStore([eligibleTodoTask("FN-8600")], recorded);
    const processor = new TriageProcessor(store, "/tmp/fn-8600-throttle-root", {});
    (processor as unknown as { running: boolean }).running = true;
    const poll = (processor as unknown as { poll: () => Promise<void> }).poll.bind(processor);
    await poll();
    await poll();
    await poll();
    await new Promise((resolve) => setImmediate(resolve));

    expect(recorded.filter((event) => event.type === "task:plan-admission-throttled")).toHaveLength(1);
  });

  /*
  FNXC:ConcurrencyAdmission 2026-07-26-10:45:
  A counts-only signature would swallow a NEW card's stall whenever the numbers happened to land on
  the same tuple, leaving the only persisted row naming a different task — fatal for an event whose
  whole job is answering "why is THIS card queued".
  */
  it("emits again when a different card is the one stalling, even with identical counts", async () => {
    
    const first = eligibleTodoTask("FN-8600");
    const store = createStore([first], recorded);
    const processor = new TriageProcessor(store, "/tmp/fn-8600-throttle-root", {});
    (processor as unknown as { running: boolean }).running = true;
    const poll = (processor as unknown as { poll: () => Promise<void> }).poll.bind(processor);
    await poll();

    /*
    Same counts, different card: A leaves the queue as C enters. The running
    claimant must be re-supplied — this mock REPLACES the list, and without it the
    project slot frees up, the gate stops binding and no second row is emitted
    (which is a correct outcome for a different scenario, not this one).
    */
    (store.listTasks as unknown as { mockResolvedValue: (v: Task[]) => void })
      .mockResolvedValue([runningTask("FN-RUNNING"), eligibleTodoTask("FN-8601")]);
    await poll();

    const throttle = recorded.filter((event) => event.type === "task:plan-admission-throttled");
    expect(throttle).toHaveLength(2);
    expect(throttle[1].metadata).toMatchObject({ eligibleTaskIds: ["FN-8601"] });
  });

  /*
  FNXC:ConcurrencyAdmission 2026-07-26-10:45:
  The dedupe marker must not be poisoned by a write that never landed. Store contention is the exact
  condition this event explains, so swallowing the record on write failure would reproduce the
  original unanswerable-stall problem.
  */
  it("retries the audit write on the next poll when the first write fails", async () => {
    
    const store = createStore([eligibleTodoTask("FN-8600")], recorded);
    let attempts = 0;
    (store as unknown as { recordRunAuditEvent: unknown }).recordRunAuditEvent = vi.fn()
      .mockImplementation(async (event: { mutationType: string; target: string; metadata?: Record<string, unknown> }) => {
        attempts += 1;
        if (attempts === 1) throw new Error("store contended");
        recorded.push({ type: event.mutationType, target: event.target, metadata: event.metadata });
      });

    const processor = new TriageProcessor(store, "/tmp/fn-8600-throttle-root", {});
    (processor as unknown as { running: boolean }).running = true;
    const poll = (processor as unknown as { poll: () => Promise<void> }).poll.bind(processor);

    await poll();
    // Let the fire-and-forget write settle its rejection before the next pass.
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorded.filter((event) => event.type === "task:plan-admission-throttled")).toHaveLength(0);

    await poll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorded.filter((event) => event.type === "task:plan-admission-throttled")).toHaveLength(1);
  });

  it("stays silent when planning has capacity", async () => {
    /*
    FNXC:PlanAdmissionThrottle 2026-07-30-11:25 (PR #2562 review — coderabbit):
    THIS TEST PROVED THE WRONG SILENCE. It used `createStore([])`, which seeds only
    the running claimant and NO eligible card — so it asserted that an EMPTY QUEUE
    emits no throttle, which is true of any implementation, including one that emits
    a throttle on every poll where a card is waiting. The name says "has capacity";
    the setup had no candidate for capacity to matter to.

    Now the real shape: an eligible card AND room to start it. `maxConcurrent: 3`
    against one running claimant leaves projectRoom > 0, so admission proceeds and
    the throttle must stay silent for the reason the name claims.

    `specifyTask` is stubbed because admission now actually dispatches — without it
    the test would drive a real planning session.
    */
    const store = createStore([eligibleTodoTask("FN-8600-ROOM")], recorded, { maxConcurrent: 3 });
    const processor = new TriageProcessor(store, "/tmp/fn-8600-throttle-root", {});
    vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);
    (processor as unknown as { running: boolean }).running = true;
    await (processor as unknown as { poll: () => Promise<void> }).poll();
    await new Promise((resolve) => setImmediate(resolve));

    expect(recorded.filter((event) => event.type === "task:plan-admission-throttled")).toHaveLength(0);
  });

  it("carries no prompt, title, or reason prose — ids and counts only", async () => {
    
    const store = createStore([eligibleTodoTask("FN-8600")], recorded);
    await pollWithExhaustedProjectCapacity(store);

    const throttle = recorded.find((event) => event.type === "task:plan-admission-throttled");
    expect(throttle).toBeDefined();
    const serialized = JSON.stringify(throttle!.metadata ?? {});
    expect(serialized).not.toContain("favorite projects");
  });
});
