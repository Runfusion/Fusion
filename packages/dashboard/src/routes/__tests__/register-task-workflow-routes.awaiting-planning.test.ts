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
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
  const dir = join(tasksRoot, taskId);
  await mkdir(dir, { recursive: true });
  if (content !== undefined) await writeFile(join(dir, "PROMPT.md"), content);
}

function createHarness(tasks: Task[]) {
  const store: TaskStore = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTaskDir: vi.fn((id: string) => join(tasksRoot, id)),
    getSettingsFast: vi.fn(async () => ({})),
    listTasks: vi.fn(async () => tasks),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app };
}

async function fetchTasks(tasks: Task[]): Promise<Array<Record<string, unknown>>> {
  const { app } = createHarness(tasks);
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
    await mkdir(join(tasksRoot, "FN-EISDIR", "PROMPT.md"), { recursive: true });

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
});
