// @vitest-environment node

/*
FNXC:CodingIdeasWorkflow 2026-07-26-15:30:
Original symptom: a Todo card sat on the "Queued to plan" badge while the engine had no intention of
planning it — TaskCard inferred "unplanned" from `steps.length === 0`, but triage's todo-discovery and
the scheduler's dispatch filter both decide from PROMPT.md seed-ness, so the board named the wrong cap.

These tests pin the server half: `GET /api/tasks` annotates Todo rows with `awaitingPlanning` derived
from the shared `isTaskAwaitingPlanning` predicate.

Surface enumeration (the invariant, not just the reported repro):
  - seed PROMPT.md (bootstrap stub) -> true, whatever the step count says.
  - real spec -> false, INCLUDING the reported repro shape (real spec, zero steps).
  - re-seeded card still carrying steps from a previous pass -> true (the reverse mislabel).
  - missing PROMPT.md -> true (triage regenerates the spec).
  - unreadable-for-another-reason PROMPT.md -> field omitted, so the client falls back rather than
    asserting a wrong label.
  - `needs-replan` -> true even though its PROMPT.md is a real (rejected) spec.
  - non-Todo rows -> field omitted entirely (payload stays byte-identical for them).
*/

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore, Task } from "@fusion/core";
import { buildBootstrapPrompt } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const REAL_SPEC = "# FN-X: Real spec\n\n## Steps\n\n1. Do the thing\n\n## File Scope\n\n- src/a.ts\n";

let tasksRoot: string;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "A card",
    description: "A description",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/** Write PROMPT.md for a task; omit `content` to leave the file missing. */
async function seedTaskDir(taskId: string, content?: string): Promise<void> {
  const dir = join(tasksRoot, ".fusion", "tasks", taskId);
  await mkdir(dir, { recursive: true });
  if (content !== undefined) await writeFile(join(dir, "PROMPT.md"), content);
}

/**
 * A board whose waiting lane is `queued`, carrying the SAME hold trait the builtins put on `todo`.
 * `listWorkflowDefinitions` is what `resolveProjectColumnsForRoles` reads — omit it and the helper
 * degrades to the legacy ids, so a fixture without it cannot distinguish the fix from the literal.
 */
const RENAMED_HOLD_IR = {
  version: "v2",
  name: "renamed-hold",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "planning" }],
  edges: [],
};

function createHarness(tasks: Task[], workflowIrs?: unknown[]) {
  const store: TaskStore = {
    getRootDir: vi.fn(() => tasksRoot),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTaskDir: vi.fn((id: string) => join(tasksRoot, ".fusion", "tasks", id)),
    getSettingsFast: vi.fn(async () => ({})),
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    updateTask: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error("Task not found");
      const { sourceMetadataPatch, ...directUpdates } = updates;
      Object.assign(task, directUpdates);
      if (sourceMetadataPatch && typeof sourceMetadataPatch === "object") {
        task.sourceMetadata = { ...task.sourceMetadata, ...sourceMetadataPatch };
      }
      return task;
    }),
    listTasks: vi.fn(async () => tasks),
    ...(workflowIrs ? { listWorkflowDefinitions: vi.fn(async () => workflowIrs.map((ir) => ({ ir }))) } : {}),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app };
}

async function fetchTasks(tasks: Task[], workflowIrs?: unknown[]): Promise<Array<Record<string, unknown>>> {
  const { app } = createHarness(tasks, workflowIrs);
  const res = await REQUEST(app, "GET", "/api/tasks");
  expect(res.status).toBe(200);
  return res.body as Array<Record<string, unknown>>;
}

beforeEach(async () => {
  tasksRoot = await mkdtemp(join(tmpdir(), "fusion-awaiting-planning-"));
});

afterEach(async () => {
  await rm(tasksRoot, { recursive: true, force: true });
});

describe("GET /tasks awaitingPlanning enrichment", () => {
  it("marks a seed-prompt Todo card as awaiting planning", async () => {
    const task = makeTask({ id: "FN-SEED" });
    await seedTaskDir("FN-SEED", buildBootstrapPrompt("FN-SEED", task.title, task.description));

    const [row] = await fetchTasks([task]);

    expect(row!.awaitingPlanning).toBe(true);
  });

  it("marks a real spec with ZERO parsed steps as NOT awaiting planning (the reported repro)", async () => {
    // The exact shape that produced the wrong badge: no steps, but a real spec on disk, so the
    // scheduler already treats the card as a dispatch candidate — it waits for a WIP slot.
    const task = makeTask({ id: "FN-SPEC", steps: [] });
    await seedTaskDir("FN-SPEC", REAL_SPEC);

    const [row] = await fetchTasks([task]);

    expect(row!.awaitingPlanning).toBe(false);
  });

  it("marks a re-seeded card that still carries old steps as awaiting planning", async () => {
    // The reverse mislabel: steps survive from a previous pass, so the step-count heuristic said
    // "Ready" while triage was about to plan the card.
    const task = makeTask({
      id: "FN-RESEED",
      steps: [{ name: "stale step from a previous pass", status: "todo" }],
    } as Partial<Task>);
    await seedTaskDir("FN-RESEED", buildBootstrapPrompt("FN-RESEED", task.title, task.description));

    const [row] = await fetchTasks([task]);

    expect(row!.awaitingPlanning).toBe(true);
  });

  it("treats a missing PROMPT.md as awaiting planning", async () => {
    const task = makeTask({ id: "FN-NOPROMPT" });
    await seedTaskDir("FN-NOPROMPT");

    const [row] = await fetchTasks([task]);

    expect(row!.awaitingPlanning).toBe(true);
  });

  it("omits the field when PROMPT.md is unreadable for another reason", async () => {
    // A directory where the file should be: EISDIR, not ENOENT. That is not evidence either way, so
    // the client must fall back instead of being handed a fabricated label.
    const task = makeTask({ id: "FN-EISDIR" });
    await mkdir(join(tasksRoot, ".fusion", "tasks", "FN-EISDIR", "PROMPT.md"), { recursive: true });

    const [row] = await fetchTasks([task]);

    expect(row).not.toHaveProperty("awaitingPlanning");
  });

  it("marks a needs-replan card as awaiting planning despite a real spec on disk", async () => {
    const task = makeTask({ id: "FN-REPLAN", status: "needs-replan" } as Partial<Task>);
    await seedTaskDir("FN-REPLAN", REAL_SPEC);

    const [row] = await fetchTasks([task]);

    expect(row!.awaitingPlanning).toBe(true);
  });

  it("leaves non-Todo rows untouched", async () => {
    const inProgress = makeTask({ id: "FN-WIP", column: "in-progress" });
    const inReview = makeTask({ id: "FN-REVIEW", column: "in-review" });
    await seedTaskDir("FN-WIP", buildBootstrapPrompt("FN-WIP", inProgress.title, inProgress.description));
    await seedTaskDir("FN-REVIEW", REAL_SPEC);

    const rows = await fetchTasks([inProgress, inReview]);

    for (const row of rows) {
      expect(row).not.toHaveProperty("awaitingPlanning");
    }
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:10:
  THE INVARIANT: the enrichment finds the board's HOLD lane, whatever that lane is named.

  The filter named `todo`, so a workflow whose waiting lane is called anything else got no
  enrichment at all — no error, no log, just a silent fall back to the client's step-count
  heuristic, which is the exact mislabel this whole enrichment exists to correct. The card most
  likely to be wrong (real spec, zero steps) is the one that read "Queued to plan" forever.

  The store here declares `listWorkflowDefinitions`, which the harness above deliberately does not:
  every other case in this file exercises the degraded path where the legacy `todo` is all there is,
  and they must stay green — that compatibility is half the contract.

  REVERT PROOF, measured: restore `task.column === "todo"` and this case fails with
  `expected undefined to be false`, because the row is not enriched at all. Every other case in the
  file stays green.
  */
  it("enriches a card in a RENAMED hold lane, not only one literally named todo", async () => {
    const task = makeTask({ id: "FN-RENAMED", column: "backlog" as Task["column"], steps: [] });
    await seedTaskDir("FN-RENAMED", REAL_SPEC);

    const store = {
      getRootDir: vi.fn(() => tasksRoot),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTaskDir: vi.fn((id: string) => join(tasksRoot, ".fusion", "tasks", id)),
      getSettingsFast: vi.fn(async () => ({})),
      listTasks: vi.fn(async () => [task]),
      listWorkflowDefinitions: vi.fn(async () => [{
        ir: {
          version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
          columns: [{ id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] }],
        },
      }]),
    } as unknown as TaskStore;
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(app, "GET", "/api/tasks");

    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows[0]!.awaitingPlanning).toBe(false);
    // Flat cost, not per-row: the lane vocabulary is resolved once for the whole board load.
    expect((store as unknown as { listWorkflowDefinitions: { mock: { calls: unknown[] } } }).listWorkflowDefinitions.mock.calls).toHaveLength(1);
  });

  /*
  FNXC:DuplicateIntake 2026-08-09-02:29:
  A title-only redirect reaches the same Keep endpoint as a PROMPT.md redirect. The endpoint must
  clear the exact title marker and preserve the full prompt, or the next triage pass re-flags the
  dismissed duplicate after operator-authored work was destroyed.
  */
  it("keeps a title-only redirect without deleting its executable prompt", async () => {
    const task = makeTask({
      title: "DUPLICATE: KB-123",
      paused: true,
      pausedReason: "duplicate-decision-required",
      sourceMetadata: { duplicateSource: "triage-marker", nearDuplicateOf: "KB-123" },
    });
    await seedTaskDir(task.id, REAL_SPEC);
    const { app } = createHarness([task]);

    const res = await REQUEST(
      app,
      "PATCH",
      `/api/tasks/${task.id}`,
      JSON.stringify({ dismissNearDuplicate: true }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(task.title).toBe("Duplicate redirect cleared: KB-123");
    expect(task.sourceMetadata).toMatchObject({ nearDuplicateDismissed: true });
    await expect(readFile(join(tasksRoot, ".fusion", "tasks", task.id, "PROMPT.md"), "utf8")).resolves.toBe(REAL_SPEC);
  });

  it("cleans both matching sources when keeping a dual-source redirect", async () => {
    const task = makeTask({
      title: "DUPLICATE: KB-123",
      paused: true,
      pausedReason: "duplicate-decision-required",
      sourceMetadata: { duplicateSource: "triage-marker", nearDuplicateOf: "KB-123" },
    });
    await seedTaskDir(task.id, "DUPLICATE: KB-123\n");
    const { app } = createHarness([task]);

    const res = await REQUEST(
      app,
      "PATCH",
      `/api/tasks/${task.id}`,
      JSON.stringify({ dismissNearDuplicate: true }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(task.title).toBe("Duplicate redirect cleared: KB-123");
    await expect(readFile(join(tasksRoot, ".fusion", "tasks", task.id, "PROMPT.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still returns the board when the enrichment cannot resolve task directories", async () => {
    // Best-effort contract: a store without getTaskDir must not fail the board load.
    const task = makeTask({ id: "FN-NODIR" });
    const store = {
      getRootDir: vi.fn(() => process.cwd()),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getSettingsFast: vi.fn(async () => ({})),
      listTasks: vi.fn(async () => [task]),
    } as unknown as TaskStore;
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(app, "GET", "/api/tasks");

    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("awaitingPlanning");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:55 (batch-dashboard-src):

  THE WAITING LANE IS THE `hold` ROLE, NOT THE ID `todo`.

  The enrichment filter named `todo`, so on a board whose waiting lane is called anything else NO card
  was enriched and every one of them silently fell back to TaskCard's step-count heuristic — the exact
  disagreement between badge and engine this enrichment was added to remove. It failed quietly, which
  is why it survived: the board still rendered, with badges that were merely wrong.

  A per-task workflow read was tried once and reverted for cost, on a board-load path whose own note
  warns about turning a load into thousands of reads. `resolveProjectColumnsForRoles` is one read for
  the whole board, so the objection was to the arity, not the idea.

  THE NEGATIVE MATTERS AS MUCH: widening to "enrich everything" would pass the case above and put a
  planning badge on in-progress and review cards, whose payloads are contractually byte-identical
  without the field.
  */
  it("enriches a card in a RENAMED hold lane", async () => {
    const task = makeTask({ id: "FN-RENAMED", column: "queued" });
    await seedTaskDir("FN-RENAMED", buildBootstrapPrompt("FN-RENAMED", task.title, task.description));

    const [row] = await fetchTasks([task], [RENAMED_HOLD_IR]);

    /* Keyed on the literal this row had no `awaitingPlanning` at all. */
    expect(row.awaitingPlanning).toBe(true);
  });

  it("does NOT enrich a card outside the board's hold lanes, even on a renamed board", async () => {
    const task = makeTask({ id: "FN-WIP", column: "building" });
    await seedTaskDir("FN-WIP", buildBootstrapPrompt("FN-WIP", task.title, task.description));

    const [row] = await fetchTasks([task], [RENAMED_HOLD_IR]);

    expect(row).not.toHaveProperty("awaitingPlanning");
  });

  it("still enriches the legacy `todo` lane on a renamed board — the union keeps a mid-rename board working", async () => {
    /* `resolveProjectColumnsForRoles` unions the legacy ids deliberately: rows still stored under the
       old id during a rename must not lose their badge. */
    const task = makeTask({ id: "FN-LEGACY", column: "todo" });
    await seedTaskDir("FN-LEGACY", buildBootstrapPrompt("FN-LEGACY", task.title, task.description));

    const [row] = await fetchTasks([task], [RENAMED_HOLD_IR]);

    expect(row.awaitingPlanning).toBe(true);
  });
});
