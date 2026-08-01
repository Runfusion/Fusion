/*
FNXC:WorkflowResolvedColumns 2026-08-01-03:35:
PLANNING ADMISSION'S WORKTREE LEDGER EXCLUDES TERMINAL LANES BY ROLE, NOT BY NAME.

`374956ef23` gave planning admission a maxWorktrees dimension — correctly, a live board was running
8 planners against a 4-slot budget — and counted holders with
`t.column !== "done" && t.column !== "archived"`.

On a RENAMED board neither literal matches, so every FINISHED card whose worktree has not been
reaped yet still counts as a live holder. `heldWorktrees` only grows, `worktreeRoom` reaches zero,
and planning admission is withheld forever on a board with free slots. That is the mirror of the
breach the commit set out to fix and strictly worse: the breach is visible as 8 planners, the stall
is silent — cards sit "Queued to plan" and the recorded reason names the worktree budget, which the
operator then checks and finds has room.

WHY THIS FILE RATHER THAN A CASE IN `triage-plan-admission-throttle-audit.test.ts`: that suite's
fixture deliberately exhausts `maxConcurrent` (1 slot, consumed by a running card) so the AGENT gate
binds. The agent gate is checked with the worktree gate via `Math.min`, so an exhausted agent count
masks the worktree answer entirely — the conversion under test would never decide anything. This
fixture leaves agent headroom so the worktree ledger is the only gate that can bind.

MEASURED FIRST, per the blinding procedure: before this file existed, reverting the resolver to the
two literals left all 19 tests in the capacity suites green. Nothing in the tree could tell the
conversion from what it replaced.

The assertion is the run-audit event, not a return value: `task:plan-admission-throttled` is what
the withhold path DOES, and it names the binding gate. A boolean "did anything start" would also be
satisfied by an unrelated early return.
*/

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { TriageProcessor } from "../triage.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original));
});

/** Hold lane `drafting`, wip `building`, complete `shipped`, archive `filed`. No legacy ids. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "drafting", name: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "filed", name: "Filed", traits: [{ trait: "archived" }] },
  ],
};

interface RecordedEvent { type: string; target: string; metadata?: Record<string, unknown> }

function task(id: string, column: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    description: "Add ability to favorite projects on mobile",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-26T15:37:52.786Z",
    updatedAt: "2026-07-26T15:37:52.786Z",
    ...extra,
  } as Task;
}

/**
 * `maxConcurrent` is generous on purpose — admission takes `min(projectRoom, worktreeRoom)`, so an
 * exhausted agent count would mask the ledger this file is about.
 */
function createStore(tasks: Task[], recorded: RecordedEvent[], maxWorktrees: number): TaskStore {
  return {
    getTask: vi.fn(async (id: string) => {
      const found = tasks.find((candidate) => candidate.id === id);
      return found ? { ...found, prompt: "", attachments: [], comments: [] } : null;
    }),
    listTasks: vi.fn().mockResolvedValue(tasks),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 20,
      maxWorktrees,
      pollIntervalMs: 600_000,
      groupOverlappingFiles: false,
      autoMerge: true,
    } as Settings),
    /* The only store read `resolveProjectColumnsForRoles` makes. */
    listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; target: string; metadata?: Record<string, unknown> }) => {
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
    /*
    The candidate scan resolves each task's OWN workflow (`resolveWorkflowIrForTask`), which reads
    the SELECTION — not `listWorkflowDefinitions`. Omitting these makes every card fall back to the
    DEFAULT board, where `drafting` is not a hold lane, so nothing is eligible, nothing throttles,
    and the absence assertion below passes for the wrong reason. Caught by the paired positive.
    */
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-renamed", stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "wf-renamed", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: RENAMED_IR })),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as TaskStore;
}

async function pollOnce(store: TaskStore): Promise<void> {
  const processor = new TriageProcessor(store, "/tmp/fn-admission-renamed-root", {});
  /* poll() no-ops unless running; driving one pass directly keeps this time-independent. */
  (processor as unknown as { running: boolean }).running = true;
  await (processor as unknown as { poll: () => Promise<void> }).poll();
  /* The audit write is fire-and-forget. */
  await new Promise((resolve) => setImmediate(resolve));
  processor.stop();
}

describe("planning admission's worktree ledger on a renamed board", () => {
  let recorded: RecordedEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    recorded = [];
  });

  it("does not count a card in a RENAMED complete lane against the worktree budget", async () => {
    const store = createStore([
      task("FN-WAITING", "drafting"),
      /* Finished work whose worktree is cleanup-owned, not capacity. */
      task("FN-SHIPPED", "shipped", { worktree: "/tmp/wt-shipped" }),
    ], recorded, 1);

    await pollOnce(store);

    /* Against the literals `shipped` is counted, worktreeRoom is 0, and admission is withheld. */
    const throttle = recorded.filter((event) => event.type === "task:plan-admission-throttled");
    expect(throttle, "a finished card must not consume a worktree slot").toHaveLength(0);
  });

  /*
  THE PAIRED POSITIVE. The case above asserts an ABSENCE, which a processor that never throttled at
  all would also satisfy — including one broken into ignoring `maxWorktrees` entirely. This pins that
  the SAME renamed board still withholds when a live card genuinely holds the last worktree, so the
  first case is measuring the lane role rather than a dead gate.
  */
  it("still withholds when a card in a live RENAMED lane holds the last worktree", async () => {
    const store = createStore([
      task("FN-WAITING", "drafting"),
      task("FN-LIVE", "building", { worktree: "/tmp/wt-live" }),
    ], recorded, 1);

    await pollOnce(store);

    const throttle = recorded.filter((event) => event.type === "task:plan-admission-throttled");
    expect(throttle.length, "a live worktree holder must still consume its slot").toBeGreaterThan(0);
  });
});
