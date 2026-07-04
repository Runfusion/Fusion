/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(rootDir)` harness to the
 * PostgreSQL extension harness. The goal tools resolve a PG-backed store via
 * `getStore(cwd)` (injected by the harness for the canonical project root).
 * worktree→canonical-root resolution is exercised by laying out a
 * `.fusion/worktrees/<id>` directory under the harness rootDir, so a tool call
 * whose cwd lives inside the worktree maps back to the injected store's cache
 * key. Goals are seeded through `h.store().getGoalStore()` (AsyncGoalStore in
 * backend mode) instead of the removed sync SQLite path.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getProjectRootFromWorktree, type AsyncGoalStore } from "@fusion/core";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

const pgTest = pgDescribe;

pgTest("extension goal tools store resolution", () => {
  const h = createPgExtensionHarness("fn-goal-resolution");

  let worktreeCwd = "";

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    // Lay out a canonical project root + a `.fusion/worktrees/<id>` cwd so the
    // extension's worktree→canonical-root resolution maps worktreeCwd back to
    // the harness rootDir (the injected PG store's cache key).
    const rootDir = h.rootDir();
    await mkdir(join(rootDir, ".fusion"), { recursive: true });
    const worktreeRoot = join(rootDir, ".fusion", "worktrees", "FN-5851");
    await mkdir(join(worktreeRoot, ".fusion"), { recursive: true });
    worktreeCwd = join(worktreeRoot, "packages", "cli");
    await mkdir(worktreeCwd, { recursive: true });
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getGoalStore() returns the async (AsyncDataLayer-backed) store.
  const goals = (): AsyncGoalStore => h.store().getGoalStore() as AsyncGoalStore;

  it("returns canonical project goals when invoked from a .fusion/worktrees cwd", async () => {
    expect(getProjectRootFromWorktree(worktreeCwd)).toBe(h.rootDir());

    const goal = await goals().createGoal({
      title: "Canonical goal",
      description: "Created in the project root store",
    });

    const api = createMockApi();
    registerExtension(api);
    const listTool = requireTool(api, "fn_goal_list");
    const showTool = requireTool(api, "fn_goal_show");

    const listResult = await listTool.execute(
      "goal-list-worktree",
      { status: "active" },
      undefined,
      undefined,
      { cwd: worktreeCwd },
    );

    expect(listResult.isError).toBeUndefined();
    expect(listResult.details?.goals).toEqual([
      expect.objectContaining({
        id: goal.id,
        title: "Canonical goal",
        snippet: "Created in the project root store",
        status: "active",
      }),
    ]);

    const showResult = await showTool.execute(
      "goal-show-worktree",
      { id: goal.id },
      undefined,
      undefined,
      { cwd: worktreeCwd },
    );

    expect(showResult.isError).toBeUndefined();
    expect(showResult.details?.goal).toMatchObject({
      id: goal.id,
      title: "Canonical goal",
      description: "Created in the project root store",
      status: "active",
    });
  });
});
