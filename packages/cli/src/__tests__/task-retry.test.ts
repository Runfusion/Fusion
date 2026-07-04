/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(tmpDir)` harness to the
 * PostgreSQL extension harness. `runTaskRetry` resolves its store through the
 * CLI command path (`project-context.resolveProject`), which is independent of
 * the extension store cache the harness injects — so `resolveProject` is
 * redirected to the harness's PG-backed store, and the full retry lifecycle
 * (moveTask / updateTask / getTask / logEntry) runs against real PostgreSQL
 * state instead of the removed SQLite runtime.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createPgExtensionHarness } from "./pg-extension-harness.js";

// `runTaskRetry` resolves its store via resolveProject() (commands/task.ts →
// project-context.ts), a separate cache from the extension store the harness
// injects. Redirect resolveProject to the harness PG store so the command path
// and the seeded task share one isolated PostgreSQL database.
const resolveProjectMock = vi.hoisted(() => vi.fn());
vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
}));

import { runTaskRetry } from "../commands/task.js";

const pgTest = pgDescribe;

pgTest("runTaskRetry", () => {
  const h = createPgExtensionHarness("fn-task-retry");

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    resolveProjectMock.mockResolvedValue({
      store: h.store(),
      projectId: h.rootDir(),
      projectPath: h.rootDir(),
      projectName: "test",
      isRegistered: false,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resolveProjectMock.mockReset();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("clears the deadlock auto-pause when retrying a failed task", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "deadlock-paused task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "merge deadlock",
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      steps: [{ name: "implemented", status: "done" }],
      mergeRetries: 4,
    });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    expect(updated.paused).toBeFalsy();
    expect(updated.pausedReason).toBeFalsy();
    expect(updated.mergeRetries).toBe(0);
  });
});
