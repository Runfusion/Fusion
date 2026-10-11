import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS } from "@fusion/core";
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

/*
FNXC:ConcurrencyAdmission 2026-10-11-00:37 (RUFU-382):
The FN-8600 half of that invariant was tested; its card-side mirror was not, and that untested half is
what broke (RUFU-365 audit, public board, 2026-09-28): 45 central rows in six hours while the named
cards' History showed NOTHING — the 03:00–16:00Z window carried ZERO mirrored lines (the sole surviving
line, 18:45:47Z, sits outside the audited window, so a card-side line has never been soundly observed).
The dedupe marker committed BEFORE the mirror was even started, so a mirror that never landed still
silenced every later attempt, and its rejection reached only `planLog.warn` — persisted nowhere.

The invariant the cases below add is therefore about PROVENANCE, not ordering prose: the signature that
silences the retry is committed only after every eligible card's explanatory mirror is proven landed, a
fulfilled `logEntryOnce` counts as landed whether it appended or deduped (only a throw is a failure), and
the poll still never awaits any of it. Write amplification stays bounded by the card's own dedupe key, so
the accepted cost of a retry is one visible central row — never a second History row on the card.
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

/** One captured `updateTask` call, narrowed to what the planning-stall episode tests assert. */
interface RecordedPatch { taskId: string; patch: Record<string, unknown> | undefined }

/** What the engine hands the card-side once-seam. */
interface MirrorInput { action: string; outcome?: string; dedupeKey: string; windowMs: number }
/** One mirror the fixture actually APPENDED (a deduped or failed call appends nothing). */
interface RecordedMirror extends MirrorInput { taskId: string; at: string }

/*
The poll's writes are deliberately detached, so every case here needs the same two-flush settle: one
macrotask drains the audit sink's microtask chain and the `allSettled` mirror join that follows it.
*/
async function settleDetachedWrites(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Attempts the poll made against the card-side once-seam (attempts, not appends). */
function onceSeamCalls(store: TaskStore): Array<{ taskId: string } & MirrorInput> {
  const seam = (store as unknown as { logEntryOnce?: { mock?: { calls: Array<[string, MirrorInput]> } } }).logEntryOnce;
  return (seam?.mock?.calls ?? []).map(([taskId, input]) => ({ taskId, ...input }));
}

/** Attempts the poll made against the legacy non-deduped seam — the fallback path only. */
function legacySeamCalls(store: TaskStore): Array<{ taskId: string; action: string }> {
  const seam = (store as unknown as { logEntry: { mock?: { calls: Array<[string, string]> } } }).logEntry;
  return (seam?.mock?.calls ?? []).map(([taskId, action]) => ({ taskId, action }));
}

/*
FNXC:PlanningAdmissionStall 2026-09-25-18:20 (RUFU-273):
Apply a `sourceMetadataPatch` onto the in-memory fixture the way the real store does: key-level merge,
`null` deletes, everything else in the field survives. Without this the fake would hand back the
UNPATCHED row on the next poll, and a "refreshes at most once per floor" assertion would be vacuous —
it would pass for an implementation that rewrote the episode every single poll.
*/
function applySourceMetadataPatch(task: Task, patch: Record<string, unknown>): void {
  const merged: Record<string, unknown> = { ...(task.sourceMetadata ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  task.sourceMetadata = merged;
}

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

/*
FNXC:CapacitySlotLeak 2026-09-19-04:07:
A durable `status:"planning"` claim with NO planner session behind it — the leak this suite pins.
`status` is a row field, so it survives a stuck-killed, crashed, or never-started planner.
*/
function orphanedPlanningTask(id: string): Task {
  return {
    id,
    description: "planning status with no live planner",
    column: "todo",
    status: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-18T22:00:00.000Z",
    updatedAt: "2026-09-18T22:00:00.000Z",
  } as Task;
}

function createStore(
  tasks: Task[],
  recorded: RecordedEvent[],
  settings: Partial<Settings> = {},
  patches?: RecordedPatch[],
  mirrors?: RecordedMirror[],
): TaskStore {
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
    updateTask: vi.fn().mockImplementation(async (id: string, updates: { sourceMetadataPatch?: Record<string, unknown> | null }) => {
      if (patches) patches.push({ taskId: id, patch: updates?.sourceMetadataPatch ?? undefined });
      const target = tasks.find((candidate) => candidate.id === id);
      if (target && updates?.sourceMetadataPatch) applySourceMetadataPatch(target, updates.sourceMetadataPatch);
      return target ?? null;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    /*
    FNXC:ConcurrencyAdmission 2026-10-11-00:37 (RUFU-382):
    Mirrors the real once-seam (`logEntryOnceImpl`): a same-key call inside the window appends nothing
    and still FULFILLS, only a real write appends. A fixture that always appended would make "the marker
    commits on a proven mirror" indistinguishable from "the marker commits on a duplicate that landed
    nothing", and the FN-8600 one-row-per-stall guarantee would be asserted against a store that does
    not dedupe.
    */
    logEntryOnce: vi.fn(async (id: string, input: MirrorInput) => {
      const sink = mirrors ?? [];
      const duplicate = sink.some((entry) => entry.taskId === id
        && entry.dedupeKey === input.dedupeKey
        && Date.now() - Date.parse(entry.at) < input.windowMs);
      if (duplicate) return false;
      sink.push({ taskId: id, at: new Date().toISOString(), ...input });
      return true;
    }),
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
  // The audit write and the card mirrors are fire-and-forget, so let them settle before asserting.
  await settleDetachedWrites();
  return processor;
}

/** Drives `passes` polls of the same steady stall, settling the detached writes after each one. */
async function pollRepeatedly(processor: TriageProcessor, passes: number): Promise<void> {
  const poll = (processor as unknown as { poll: () => Promise<void> }).poll.bind(processor);
  for (let pass = 0; pass < passes; pass++) {
    await poll();
    await settleDetachedWrites();
  }
}

/** The central row count the throttle signature has produced so far. */
function centralRows(recorded: RecordedEvent[]): number {
  return recorded.filter((event) => event.type === "task:plan-admission-throttled").length;
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
    
    const mirrors: RecordedMirror[] = [];
    const store = createStore([eligibleTodoTask("FN-8600")], recorded, {}, undefined, mirrors);
    const processor = new TriageProcessor(store, "/tmp/fn-8600-throttle-root", {});
    (processor as unknown as { running: boolean }).running = true;
    const poll = (processor as unknown as { poll: () => Promise<void> }).poll.bind(processor);
    await poll();
    await poll();
    await poll();
    await settleDetachedWrites();

    expect(centralRows(recorded)).toBe(1);
    /*
    FNXC:ConcurrencyAdmission 2026-10-11-00:37 (RUFU-382):
    The card-side half of the same guarantee. Counting only the central row let the mirror be attempted
    three times while the row was written once — the asymmetry RUFU-382 removes. A sustained stall now
    collapses on BOTH surfaces, which also proves the marker did commit (an unproven mirror would keep
    re-attempting on every poll).
    */
    expect(onceSeamCalls(store)).toHaveLength(1);
    expect(mirrors).toHaveLength(1);
  });

  /*
  FNXC:ConcurrencyAdmission 2026-10-11-00:37 (RUFU-382):
  Original symptom (RUFU-365 audit of the public board, 2026-09-28): 45 central `task:plan-admission-throttled`
  rows over six hours while the cards the rows NAMED carried nothing — the 03:00–16:00Z window recorded
  ZERO card-side mirrors, and the only surviving mirrored line (18:45:47Z) sits outside the audited window,
  so the card-side line has never been soundly observed. Cause: the marker that silences every later
  attempt was set before the mirror was even started, and the mirror's rejection reached only an unpersisted
  `planLog.warn`.

  Exact reproduction: capacity exhausted with eligible cards waiting, the central write succeeding, and the
  card mirror failing. Assertion it is gone: when the central row is proven, every refused card is handed its
  own explanatory row — and a mirror that does not land is retried instead of being silenced by a marker that
  was set on an unproven write.

  Substring assertions only: RUFU-380 widens `formatAdmissionCapacityQueuedReason` with a project clause, so
  a full-sentence equality here would fail for someone else's accepted change.
  */
  it("mirrors the capacity sentence onto every refused card once the central row is proven", async () => {
    const mirrors: RecordedMirror[] = [];
    const store = createStore(
      [eligibleTodoTask("FN-382-A"), eligibleTodoTask("FN-382-B"), eligibleTodoTask("FN-382-C")],
      recorded, {}, undefined, mirrors,
    );
    await pollWithExhaustedProjectCapacity(store);

    expect(centralRows(recorded)).toBe(1);
    const calls = onceSeamCalls(store);
    // ONE mirror per CARD — a key that fanned out per signature-token would show up as more than three calls.
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.taskId).sort()).toEqual(["FN-382-A", "FN-382-B", "FN-382-C"]);
    for (const call of calls) {
      expect(call.action).toContain("capacity exhausted");
      /*
      The key is the SAME for every card in one stall episode, which is what lets the next poll re-run
      the emission without duplicating a History row, and it carries the signature rather than a per-poll
      nonce so the store's own window can dedupe it.
      */
      expect(call.dedupeKey.startsWith("plan-admission-throttled:")).toBe(true);
      expect(call.windowMs).toBe(PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS);
    }
    expect(new Set(calls.map((call) => call.dedupeKey))).toHaveLength(1);
    expect(mirrors).toHaveLength(3);
    // The refresh-emitting legacy seam is not the mirror's route when the once-seam exists.
    expect(legacySeamCalls(store)).toEqual([]);
  });

  /*
  FNXC:ConcurrencyAdmission 2026-10-11-00:37 (RUFU-382):
  The generalized FN-8600 rule: "mark the stall as recorded ONLY once the write lands" now covers the
  card-side write too. Accepted cost, stated explicitly: while a mirror keeps failing the central row
  repeats per poll — write amplification bounded by the failure, the same shape as the accepted audit-write
  retry two cases below, and the price of not silently dropping the operator-facing explanation.
  The card is protected from that amplification by its own dedupe key, so the retry NEVER costs the card a
  second History row.
  */
  it("retries the whole emission on the next poll when the card mirror fails, without double-rowing the card", async () => {
    const mirrors: RecordedMirror[] = [];
    const store = createStore([eligibleTodoTask("FN-382-RETRY")], recorded, {}, undefined, mirrors);
    const landingSeam = (store as unknown as { logEntryOnce: (id: string, input: MirrorInput) => Promise<boolean> }).logEntryOnce;
    let attempts = 0;
    (store as unknown as { logEntryOnce: unknown }).logEntryOnce = vi.fn(async (id: string, input: MirrorInput) => {
      attempts += 1;
      if (attempts === 1) throw new Error("task row contended");
      return landingSeam(id, input);
    });
    const processor = new TriageProcessor(store, "/tmp/rufu-382-throttle-root", {});
    (processor as unknown as { running: boolean }).running = true;

    await pollRepeatedly(processor, 1);
    // The central row landed, so under the pre-RUFU-382 order this is where the stall went silent forever.
    expect(centralRows(recorded)).toBe(1);
    expect(onceSeamCalls(store)).toHaveLength(1);
    expect(mirrors).toEqual([]);

    await pollRepeatedly(processor, 1);
    // No silent drop: the unproven mirror left the marker alone, so the stall re-announces itself.
    expect(centralRows(recorded)).toBe(2);
    expect(onceSeamCalls(store)).toHaveLength(2);
    // …and the card was appended to exactly once, because the retry is dedupe-keyed, not row-counted.
    expect(mirrors).toHaveLength(1);

    // Marker finally committed on the proven pass: a third poll adds nothing anywhere.
    await pollRepeatedly(processor, 1);
    expect(centralRows(recorded)).toBe(2);
    expect(onceSeamCalls(store)).toHaveLength(2);
    expect(mirrors).toHaveLength(1);
  });

  /*
  FNXC:ConcurrencyAdmission 2026-10-11-00:37 (RUFU-382):
  Partial failure is the case a `Promise.all`-style "did anything throw" check gets wrong in the other
  direction: one card's mirror must not cancel its siblings', and one landed sibling must not stand in for
  the card that was NOT written — the marker belongs to the whole named set, so it commits only when every
  card in that set is proven.
  */
  it("keeps writing the healthy card's mirror and re-attempts the failing one until the whole set is proven", async () => {
    const mirrors: RecordedMirror[] = [];
    const store = createStore([eligibleTodoTask("FN-382-BROKEN"), eligibleTodoTask("FN-382-HEALTHY")], recorded, {}, undefined, mirrors);
    const landingSeam = (store as unknown as { logEntryOnce: (id: string, input: MirrorInput) => Promise<boolean> }).logEntryOnce;
    const brokenAttempts: string[] = [];
    (store as unknown as { logEntryOnce: unknown }).logEntryOnce = vi.fn(async (id: string, input: MirrorInput) => {
      if (id === "FN-382-BROKEN") {
        brokenAttempts.push(id);
        if (brokenAttempts.length < 3) throw new Error("task row contended");
      }
      return landingSeam(id, input);
    });
    const processor = new TriageProcessor(store, "/tmp/rufu-382-throttle-root", {});
    (processor as unknown as { running: boolean }).running = true;

    await pollRepeatedly(processor, 2);

    // Sibling isolation: the healthy card got its row on the first pass and was deduped on the second.
    expect(mirrors.filter((m) => m.taskId === "FN-382-HEALTHY")).toHaveLength(1);
    // The failing card has nothing durable to show for it, so the set is unproven and the stall stays loud.
    expect(mirrors.filter((m) => m.taskId === "FN-382-BROKEN")).toEqual([]);
    expect(centralRows(recorded)).toBe(2);
    expect(onceSeamCalls(store)).toHaveLength(4);

    await pollRepeatedly(processor, 1);
    // Third pass lands the last card, so the whole named set is proven from here on.
    expect(mirrors).toHaveLength(2);
    expect(onceSeamCalls(store)).toHaveLength(6);
    /*
    The accepted cost, measured rather than described: the third pass still repeats the CENTRAL row, because
    at the moment it emitted, its named set was still unproven. Amplification is bounded by the failure — one
    extra row per poll a mirror is refused — and stops the moment the mirror lands, which the fourth pass proves.
    */
    expect(centralRows(recorded)).toBe(3);

    await pollRepeatedly(processor, 1);
    expect(centralRows(recorded)).toBe(3);
    expect(onceSeamCalls(store)).toHaveLength(6);
    expect(mirrors).toHaveLength(2);
  });

  /*
  FNXC:ConcurrencyAdmission 2026-10-11-00:37 (RUFU-382):
  Duck-typed access is required, not stylistic: 170 of the 185 TaskStore literals in `__tests__` declare no
  `logEntryOnce`, and the type has 71 implementations (7 production), so a store without the once-seam is a
  reachable shape. The fallback keeps `logEntry` — but inside the SAME proof path, so a fallback that rejects
  still cannot commit the marker. `logEntry` returns `Promise<Task>`, which allSettled can join.
  */
  it("falls back to the legacy seam for a store without the once-seam, and still refuses an unproven marker", async () => {
    const store = createStore([eligibleTodoTask("FN-382-LEGACY")], recorded);
    (store as unknown as { logEntryOnce?: unknown }).logEntryOnce = undefined;
    const logWrite = (store as unknown as { logEntry: (id: string, action: string) => Promise<unknown> }).logEntry;
    let attempts = 0;
    (store as unknown as { logEntry: unknown }).logEntry = vi.fn(async (id: string, action: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error("task row contended");
      return logWrite(id, action);
    });
    const processor = new TriageProcessor(store, "/tmp/rufu-382-throttle-root", {});
    (processor as unknown as { running: boolean }).running = true;

    await pollRepeatedly(processor, 1);
    expect(centralRows(recorded)).toBe(1);
    expect(legacySeamCalls(store)).toHaveLength(1);

    // Rejected fallback write → marker unproven → the stall re-announces and the mirror is retried.
    await pollRepeatedly(processor, 1);
    expect(centralRows(recorded)).toBe(2);
    expect(legacySeamCalls(store)).toHaveLength(2);

    // Proven fallback write → settled.
    await pollRepeatedly(processor, 1);
    expect(centralRows(recorded)).toBe(2);
    expect(legacySeamCalls(store)).toHaveLength(2);
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

  /*
  FNXC:CapacitySlotLeak 2026-09-19-04:07:
  Original symptom (production, 2026-09-18): planning admission was withheld for HOURS while
  `claimed=2, processing=0` — two durable planning statuses and no planner in the process — with one
  eligible card waiting (677 "Plan throttled by running-agent cap" lines; FUSI-018 idle 32 min; the
  20-minute `sweepStalePlanningStatuses` repair cleared two rows in the whole log and never unblocked it).

  Exact reproduction: two todo cards carrying `status:"planning"` with no live planner, one eligible
  todo card, and `maxConcurrent` equal to the orphan count. Assertion it is gone: the orphans consume
  no capacity, so the eligible card is not throttled — and the inverse case below proves a claim whose
  planner IS live still consumes its slot.
  */
  it("does not throttle planning on a stale planning status with no live planner", async () => {
    const orphans = [orphanedPlanningTask("FN-LEAK-1"), orphanedPlanningTask("FN-LEAK-2")];
    const store = createStore([...orphans, eligibleTodoTask("FN-LEAK-ELIGIBLE")], recorded, { maxConcurrent: 2 });
    // Drop the seeded in-progress claimant: the ONLY claims under test are the two orphaned statuses.
    (store.listTasks as unknown as { mockResolvedValue: (v: Task[]) => void })
      .mockResolvedValue([...orphans, eligibleTodoTask("FN-LEAK-ELIGIBLE")]);
    const processor = new TriageProcessor(store, "/tmp/fn-capacity-slot-leak-root", {});
    vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);
    (processor as unknown as { running: boolean }).running = true;
    await (processor as unknown as { poll: () => Promise<void> }).poll();
    await new Promise((resolve) => setImmediate(resolve));

    expect(recorded.filter((event) => event.type === "task:plan-admission-throttled")).toHaveLength(0);
  });

  it("still counts a planning claim while its planner session is live", async () => {
    const live = orphanedPlanningTask("FN-LEAK-LIVE");
    const store = createStore([live, eligibleTodoTask("FN-LEAK-WAITING")], recorded, { maxConcurrent: 1 });
    (store.listTasks as unknown as { mockResolvedValue: (v: Task[]) => void })
      .mockResolvedValue([live, eligibleTodoTask("FN-LEAK-WAITING")]);
    const processor = new TriageProcessor(store, "/tmp/fn-capacity-slot-leak-root", {});
    vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);
    /*
    The processor's constructor registers the process-wide liveness probe, so owning the task in
    `processing` is exactly how production proves a live planner (FN-8453 keeps planning on the same
    maxConcurrent claim as execute/review, and this case must not regress that).
    */
    (processor as unknown as { processing: Set<string> }).processing.add("FN-LEAK-LIVE");
    (processor as unknown as { running: boolean }).running = true;
    await (processor as unknown as { poll: () => Promise<void> }).poll();
    await new Promise((resolve) => setImmediate(resolve));

    const throttle = recorded.filter((event) => event.type === "task:plan-admission-throttled");
    expect(throttle).toHaveLength(1);
    expect(throttle[0].metadata).toMatchObject({
      maxConcurrent: 1,
      claimed: 1,
      eligibleTaskIds: ["FN-LEAK-WAITING"],
    });
  });

  /*
  FNXC:PlanningAdmissionStall 2026-09-25-18:20 (RUFU-273):
  The row-side half of the same incident. FN-8600 made the withheld gate answerable by query; the
  operator standing at the board still saw a card that said nothing. These cases pin that the SAME
  refusal also lands on the card, that it does not land on a card that was not refused, and that a
  sustained stall refreshes on the floor rather than every 15 s poll.
  */
  it("records the throttle episode on the card the cap refused", async () => {
    const patches: RecordedPatch[] = [];
    const store = createStore([eligibleTodoTask("FN-273-THROTTLED")], recorded, {}, patches);
    await pollWithExhaustedProjectCapacity(store);

    const written = patches.filter((p) => p.patch && "planAdmissionStall" in p.patch);
    expect(written.map((p) => p.taskId)).toEqual(["FN-273-THROTTLED"]);
    const episode = written[0].patch!.planAdmissionStall as Record<string, unknown>;
    expect(episode.code).toBe("plan-admission-throttled");
    expect(typeof episode.firstAt).toBe("string");
    expect(typeof episode.lastAt).toBe("string");
    expect(episode.stallCount).toBe(1);
    /*
    The episode carries ids, counts, and timestamps ONLY — the same metadata discipline the run-audit
    row two lines above follows. A title/description/reason field appearing here is the regression.
    */
    expect(Object.keys(episode).sort()).toEqual(["ageMs", "code", "firstAt", "lastAt", "signature", "stallCount"]);
    expect(typeof episode.ageMs).toBe("number");
    expect(JSON.stringify(episode)).not.toContain("favorite projects");
  });

  it("never stamps a card the throttle did not refuse", async () => {
    const patches: RecordedPatch[] = [];
    const store = createStore([eligibleTodoTask("FN-273-ROOM")], recorded, { maxConcurrent: 3 }, patches);
    const processor = new TriageProcessor(store, "/tmp/rufu-273-throttle-root", {});
    vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);
    (processor as unknown as { running: boolean }).running = true;
    await (processor as unknown as { poll: () => Promise<void> }).poll();
    await new Promise((resolve) => setImmediate(resolve));

    expect(patches.filter((p) => p.patch && "planAdmissionStall" in p.patch)).toEqual([]);
  });

  it("refreshes a sustained stall at most once per refresh floor, not once per poll", async () => {
    const patches: RecordedPatch[] = [];
    const store = createStore([eligibleTodoTask("FN-273-SUSTAINED")], recorded, {}, patches);
    const processor = new TriageProcessor(store, "/tmp/rufu-273-throttle-root", {});
    (processor as unknown as { running: boolean }).running = true;
    const poll = (processor as unknown as { poll: () => Promise<void> }).poll.bind(processor);

    // Four polls of the same steady stall = the 15 s poll repeating four times.
    for (let pass = 0; pass < 4; pass++) {
      await poll();
      await new Promise((resolve) => setImmediate(resolve));
    }

    const episodeWrites = patches.filter((p) => p.patch && "planAdmissionStall" in p.patch);
    expect(episodeWrites).toHaveLength(1);
    // And the one write is a real episode, not an empty patch that only satisfies the counter.
    expect((episodeWrites[0].patch!.planAdmissionStall as Record<string, unknown>).code).toBe("plan-admission-throttled");

    // Aging the stored episode PAST the floor (a stall the poll has not restamped in one floor)
    // is what lets the next poll refresh `lastAt` instead of skipping.
    const aged = new Date(Date.now() - PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS - 1_000).toISOString();
    (store.listTasks as unknown as { mockResolvedValue: (v: Task[]) => void }).mockResolvedValue([
      runningTask("FN-RUNNING"),
      {
        ...eligibleTodoTask("FN-273-SUSTAINED"),
        sourceMetadata: {
          planAdmissionStall: {
            code: "plan-admission-throttled",
            firstAt: "2026-07-26T15:37:52.786Z",
            lastAt: aged,
            stallCount: 1,
          },
        },
      },
    ]);
    await poll();
    await new Promise((resolve) => setImmediate(resolve));

    const refreshed = patches.filter((p) => p.patch && "planAdmissionStall" in p.patch);
    expect(refreshed).toHaveLength(2);
    const second = refreshed[1].patch!.planAdmissionStall as Record<string, unknown>;
    // A same-code repeat preserves the origin of the episode and counts the repeat.
    expect(second.firstAt).toBe("2026-07-26T15:37:52.786Z");
    expect(second.stallCount).toBe(2);
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
