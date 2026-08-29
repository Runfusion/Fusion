/**
 * FNXC:PostgresCutover 2026-07-17-00:00:
 * FN-8225 moves these goal-tool tests from a per-test temporary-root
 * `getStore(cwd)` path, which booted embedded PostgreSQL, to the shared
 * injected PostgreSQL harness. This prevents FN-8222's concurrent
 * postmaster.pid locks, leaked initdb processes, and five-second timeouts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
} from "./pg-extension-harness.js";

function makeCtx(cwd: string) {
  return { cwd } as any;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

pgDescribe("extension goal retrieval tools", () => {
  const h = createPgExtensionHarness("fn-goal-tools");
  let api: ReturnType<typeof createMockApi>;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    api = createMockApi();
    registerExtension(api);
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("registers fn_goal_show with expected schema", () => {
    const tool = api.tools.get("fn_goal_show");

    expect(tool).toBeDefined();
    expect(tool?.name).toBe("fn_goal_show");
    expect(tool?.description).toBe("Show full details for a single goal by ID.");
    expect(tool?.parameters).toMatchObject({
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "Goal ID (G-…)",
        },
      },
    });
  });

  it("returns goal details with stable details.goal payload", async () => {
    const createTool = api.tools.get("fn_goal_create");
    const tool = api.tools.get("fn_goal_show");
    expect(createTool).toBeDefined();
    expect(tool).toBeDefined();

    const created = await createTool!.execute(
      "goal-create-1",
      { title: "Improve reliability", description: "Reduce flaky test retries" },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );

    const goalId = created.details.goalId as string;
    const result = await tool!.execute("goal-show-1", { id: goalId }, undefined, undefined, makeCtx(h.rootDir()));

    expect(result.isError).toBeUndefined();
    expect(result.details.goal).toMatchObject({
      id: goalId,
      title: "Improve reliability",
      description: "Reduce flaky test retries",
      status: "active",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(textOf(result)).toContain(goalId);
    expect(textOf(result)).toContain("Improve reliability");
    expect(textOf(result)).toContain("Status: active");
    expect(textOf(result)).toContain("Created:");
    expect(textOf(result)).toContain("Updated:");
  });

  it("returns GOAL_NOT_FOUND error for unknown id", async () => {
    const tool = api.tools.get("fn_goal_show");
    expect(tool).toBeDefined();

    const result = await tool!.execute("goal-show-404", { id: "G-404" }, undefined, undefined, makeCtx(h.rootDir()));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Goal G-404 not found");
    expect(result.details).toEqual({ code: "GOAL_NOT_FOUND", goalId: "G-404" });
  });

  it("keeps fn_goal_list concise for empty and single-goal states", async () => {
    const createTool = api.tools.get("fn_goal_create");
    const listTool = api.tools.get("fn_goal_list");
    expect(createTool).toBeDefined();
    expect(listTool).toBeDefined();

    const emptyResult = await listTool!.execute("goal-list-empty", {}, undefined, undefined, makeCtx(h.rootDir()));
    expect(textOf(emptyResult)).toBe(["Goals (0) [filter: active]", "Active: 0/5", "", "No goals found."].join("\n"));
    expect(emptyResult.details).toEqual({ goals: [], activeCount: 0, softWarning: false, hardLimit: 5 });

    const created = await createTool!.execute(
      "goal-create-2",
      { title: "Ship slice 2" },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );
    const goalId = created.details.goalId as string;
    const result = await listTool!.execute("goal-list-single", { status: "active" }, undefined, undefined, makeCtx(h.rootDir()));

    expect(textOf(result)).toBe([
      "Goals (1) [filter: active]",
      "Active: 1/5",
      "",
      `- ${goalId} [active] Ship slice 2`,
    ].join("\n"));
    expect(result.details.goals).toEqual([{ id: goalId, title: "Ship slice 2", status: "active" }]);
  });

  it("truncates goal descriptions in fn_goal_list while fn_goal_show keeps full detail", async () => {
    const createTool = api.tools.get("fn_goal_create");
    const listTool = api.tools.get("fn_goal_list");
    const showTool = api.tools.get("fn_goal_show");
    expect(createTool).toBeDefined();
    expect(listTool).toBeDefined();
    expect(showTool).toBeDefined();

    const created = await createTool!.execute(
      "goal-create-3",
      {
        title: "Cite goals by ID",
        description: "First line with extra    spaces that should collapse before truncation because it is intentionally very long and verbose.\nSecond line must never appear in fn_goal_list.",
      },
      undefined,
      undefined,
      makeCtx(h.rootDir()),
    );

    const goalId = created.details.goalId as string;
    const listResult = await listTool!.execute("goal-list-long", {}, undefined, undefined, makeCtx(h.rootDir()));
    const listText = textOf(listResult);

    expect(listText).toContain(`- ${goalId} [active] Cite goals by ID — First line with extra spaces`);
    expect(listText).toContain("…");
    expect(listText).not.toContain("Second line must never appear");
    expect(listResult.details.goals).toEqual([
      {
        id: goalId,
        title: "Cite goals by ID",
        status: "active",
        snippet: "First line with extra spaces that should collapse before truncation because it…",
      },
    ]);

    const showResult = await showTool!.execute("goal-show-long", { id: goalId }, undefined, undefined, makeCtx(h.rootDir()));
    expect(textOf(showResult)).toContain("Description: First line with extra    spaces");
    expect(textOf(showResult)).toContain("Second line must never appear in fn_goal_list.");
    expect(showResult.details.goal.description).toContain("Second line must never appear in fn_goal_list.");
  });

  it("supports archived and all filters with soft-warning output", async () => {
    const createTool = api.tools.get("fn_goal_create");
    const archiveTool = api.tools.get("fn_goal_archive");
    const listTool = api.tools.get("fn_goal_list");
    expect(createTool).toBeDefined();
    expect(archiveTool).toBeDefined();
    expect(listTool).toBeDefined();

    const archivedGoal = await createTool!.execute("goal-create-4", { title: "Archive me", description: "one line" }, undefined, undefined, makeCtx(h.rootDir()));
    await archiveTool!.execute("goal-archive-1", { id: archivedGoal.details.goalId }, undefined, undefined, makeCtx(h.rootDir()));
    await createTool!.execute("goal-create-5", { title: "One" }, undefined, undefined, makeCtx(h.rootDir()));
    await createTool!.execute("goal-create-6", { title: "Two" }, undefined, undefined, makeCtx(h.rootDir()));
    await createTool!.execute("goal-create-7", { title: "Three" }, undefined, undefined, makeCtx(h.rootDir()));

    const archivedResult = await listTool!.execute("goal-list-archived", { status: "archived" }, undefined, undefined, makeCtx(h.rootDir()));
    const allResult = await listTool!.execute("goal-list-all", { status: "all" }, undefined, undefined, makeCtx(h.rootDir()));

    expect(textOf(archivedResult)).toBe([
      "Goals (1) [filter: archived]",
      "Active: 3/5",
      "⚠  3/5 active goals — soft warning at 3, hard cap at 5",
      "",
      `- ${archivedGoal.details.goalId} [archived] Archive me — one line`,
    ].join("\n"));
    expect(textOf(allResult)).toContain("Goals (4) [filter: all]");
    expect(textOf(allResult)).toContain("⚠  3/5 active goals — soft warning at 3, hard cap at 5");
    expect((allResult.details.goals as Array<{ id: string }>).map((goal) => goal.id)).toContain(archivedGoal.details.goalId);
  });

  it("supports list to show retrieval with stable json shape", async () => {
    const createTool = api.tools.get("fn_goal_create");
    const listTool = api.tools.get("fn_goal_list");
    const showTool = api.tools.get("fn_goal_show");
    expect(createTool).toBeDefined();
    expect(listTool).toBeDefined();
    expect(showTool).toBeDefined();

    await createTool!.execute("goal-create-8", { title: "Ship slice 2" }, undefined, undefined, makeCtx(h.rootDir()));

    const listResult = await listTool!.execute("goal-list-1", { status: "active" }, undefined, undefined, makeCtx(h.rootDir()));
    expect(Array.isArray(listResult.details.goals)).toBe(true);
    expect(listResult.details.goals.length).toBeGreaterThan(0);

    const listedGoal = listResult.details.goals[0] as { id: string };
    const showResult = await showTool!.execute("goal-show-2", { id: listedGoal.id }, undefined, undefined, makeCtx(h.rootDir()));

    expect(showResult.details.goal.id).toBe(listedGoal.id);
    expect(showResult.details.goal).toMatchObject({
      id: listedGoal.id,
      title: expect.any(String),
      status: "active",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });
});
