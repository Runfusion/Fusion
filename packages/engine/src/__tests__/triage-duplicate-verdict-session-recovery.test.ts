import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskDetail, TaskStore } from "@fusion/core";
import { TriageProcessor } from "../triage.js";

/*
FNXC:DuplicateIntake 2026-07-26-10:40:
Regression suite for the FN-8600 duplicate-verdict loop.

Original symptom: the planner correctly identified FN-8600 as a duplicate of FN-8595, replied
"DUPLICATE: FN-8595 ... No new PROMPT.md written", and wrote no spec file. The engine reads the
verdict only from PROMPT.md's contents, so it saw a planner that produced no plan: deterministic
validation failed as "PROMPT.md file not found or empty", the task retried, terminalized to failed,
emitted a task-wedge mail, was recovered to todo by self-healing, and re-planned — three full Opus
cycles, with no keep-or-delete decision ever surfaced because `sourceMetadata.nearDuplicateOf` is
only written on the branch that parses the file.

The invariant under test is "a duplicate verdict the planner actually reached is recorded", not
merely "the parser works": recovery must persist the canonical marker file so every downstream
consumer (marker parse, keep/delete resolution, the metadata the dashboard decision renders from)
runs on the same contract, and must never override a planner that produced a real spec.
*/

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../reviewer.js", () => ({ reviewStep: vi.fn() }));

vi.mock("../pi.js", () => {
  class ModelFallbackExhaustedError extends Error {}
  return {
    ModelFallbackExhaustedError,
    createFnAgent: mockCreateFnAgent,
    describeModel: vi.fn().mockReturnValue("mock-model"),
    formatModelMarkerDetails: vi.fn((model: string) => model),
    promptWithFallback: mockPromptWithFallback,
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original));
});

const DUPLICATE_REPLY = [
  "DUPLICATE: FN-8595",
  "",
  "FN-8595 (done) already delivered the mobile favorites section including the per-row star toggle",
  "to favorite/unfavorite projects from mobile. No new PROMPT.md written.",
].join("\n");

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8600",
    description: "Add ability to favorite projects on mobile",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-26T15:37:52.786Z",
    updatedAt: "2026-07-26T15:37:52.786Z",
    ...overrides,
  };
}

function createStore(task: Task): TaskStore {
  return {
    getTask: vi.fn().mockImplementation(async (id: string) => {
      if (id === task.id) return { ...task, prompt: "", attachments: [], comments: [] } as TaskDetail;
      // The canonical the planner points at: a real, active task.
      return { ...createTask({ id, column: "done" }), prompt: "", attachments: [], comments: [] } as TaskDetail;
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 12, maxWorktrees: 4, pollIntervalMs: 600_000,
      groupOverlappingFiles: false, autoMerge: true,
    } as Settings),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn(), createTask: vi.fn(), deleteTask: vi.fn(), mergeTask: vi.fn(),
    updateSettings: vi.fn(), getAgentLogs: vi.fn().mockResolvedValue([]), addSteeringComment: vi.fn(),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(), emit: vi.fn(),
  } as unknown as TaskStore;
}

/** Streams `reply` as the planner's visible text, writing `specBody` to PROMPT.md when given. */
function stubPlanner(rootDir: string, taskId: string, reply: string, specBody?: string): void {
  mockCreateFnAgent.mockImplementationOnce(async (opts: { onText?: (t: string) => void }) => ({
    session: {
      state: {},
      sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      navigateTree: vi.fn(),
      __onText: opts.onText,
    },
  }));
  mockPromptWithFallback.mockImplementationOnce(async (session: { __onText?: (t: string) => void }) => {
    // Stream in chunks, as a real runtime does — recovery must not depend on one whole-text callback.
    for (const chunk of reply.match(/[\s\S]{1,17}/g) ?? []) session.__onText?.(chunk);
    if (specBody !== undefined) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(rootDir, ".fusion", "tasks", taskId, "PROMPT.md"), specBody, "utf-8");
    }
  });
}

describe("duplicate verdict reported in the planner's reply (FN-8600)", () => {
  let rootDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    rootDir = await mkdtemp(join(tmpdir(), "fn8600-dupe-"));
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-8600"), { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("persists the canonical marker file when the planner reported the duplicate in prose only", async () => {
    const task = createTask();
    stubPlanner(rootDir, task.id, DUPLICATE_REPLY);

    await new TriageProcessor(createStore(task), rootDir, {
      acquirePlanningWorktree: async () => null,
    }).specifyTask(task);

    const promptPath = join(rootDir, ".fusion", "tasks", "FN-8600", "PROMPT.md");
    expect(existsSync(promptPath)).toBe(true);
    // Recovery must produce the exact file contract, so downstream consumers are unchanged.
    expect((await readFile(promptPath, "utf-8")).trim()).toBe("DUPLICATE: FN-8595");
  });

  it("does not let a prose mention override a planner that wrote a real spec", async () => {
    const task = createTask({ id: "FN-8600" });
    const realSpec = "# FN-8600\n\n## Mission\nShip the thing.\n";
    stubPlanner(
      rootDir,
      task.id,
      "I checked whether to emit DUPLICATE: FN-8595 but the scope differs, so I wrote a spec.",
      realSpec,
    );

    await new TriageProcessor(createStore(task), rootDir, {
      acquirePlanningWorktree: async () => null,
    }).specifyTask(task);

    const written = await readFile(join(rootDir, ".fusion", "tasks", "FN-8600", "PROMPT.md"), "utf-8");
    expect(written).toBe(realSpec);
    expect(written).not.toContain("DUPLICATE:");
  });
});
