// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";
import { TaskDeletedError, TaskNotFoundError, type TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

interface HarnessOptions {
  missing?: boolean;
  deleted?: boolean;
  rejectStepTransition?: boolean;
  wedgeEpisodeId?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const task = {
    id: "FN-001",
    description: "legacy checklist task",
    column: "in-review",
    dependencies: [],
    steps: [
      { title: "Implement", status: "pending" },
      { title: "Verify", status: "pending" },
    ],
    currentStep: 0,
    log: [],
    wedgeNotification: {
      reasonKey: "failed:stale",
      episodeId: options.wedgeEpisodeId ?? "episode-observed",
      status: "active",
      transitionedAt: "2026-07-29T00:00:00.000Z",
    },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  } as any;
  const getTask = vi.fn(async () => {
    if (options.missing) throw new TaskNotFoundError("FN-001");
    return task;
  });
  const updateStep = vi.fn(async (_id: string, index: number, status: string) => {
    if (options.deleted) throw new TaskDeletedError("FN-001", "2026-07-29T00:00:00.000Z");
    if (!options.rejectStepTransition) task.steps[index].status = status;
    return task;
  });
  const resolveTaskWedgeNotificationEpisode = vi.fn(async (_id: string, episodeId: string) => {
    if (options.missing) throw new TaskNotFoundError("FN-001");
    if (options.deleted) throw new TaskDeletedError("FN-001", "2026-07-29T00:00:00.000Z");
    if (task.wedgeNotification.episodeId !== episodeId || task.wedgeNotification.status !== "active") {
      return { task, resolved: false };
    }
    task.wedgeNotification = {
      ...task.wedgeNotification,
      status: "resolved",
      transitionedAt: "2026-07-29T00:01:00.000Z",
    };
    return { task, resolved: true };
  });
  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTask,
    updateStep,
    resolveTaskWedgeNotificationEpisode,
  } as unknown as TaskStore;
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, getTask, updateStep, resolveTaskWedgeNotificationEpisode, task };
}

describe("task checklist step update route", () => {
  it("updates one step through the live project store", async () => {
    const { app, updateStep } = createHarness();
    const response = await REQUEST(
      app,
      "PATCH",
      "/api/tasks/FN-001/steps/1",
      JSON.stringify({ status: "done" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(updateStep).toHaveBeenCalledWith("FN-001", 1, "done");
    expect((response.body as { steps: Array<{ status: string }> }).steps[1].status).toBe("done");
  });

  it.each([
    ["not-an-index", { status: "done" }],
    ["-1", { status: "done" }],
    ["2", { status: "done" }],
    ["0", { status: "invalid" }],
  ])("rejects invalid step update %s", async (index, body) => {
    const { app, updateStep } = createHarness();
    const response = await REQUEST(
      app,
      "PATCH",
      `/api/tasks/FN-001/steps/${index}`,
      JSON.stringify(body),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(updateStep).not.toHaveBeenCalled();
  });

  it("returns 409 when the store rejects the requested step transition", async () => {
    const { app } = createHarness({ rejectStepTransition: true });
    const response = await REQUEST(
      app,
      "PATCH",
      "/api/tasks/FN-001/steps/1",
      JSON.stringify({ status: "done" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({ error: expect.stringContaining("was rejected") }));
  });

  it("resolves only the observed stale task wedge episode", async () => {
    const { app, resolveTaskWedgeNotificationEpisode } = createHarness();
    const response = await REQUEST(
      app,
      "POST",
      "/api/tasks/FN-001/wedge/resolve",
      JSON.stringify({ episodeId: "episode-observed" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(resolveTaskWedgeNotificationEpisode).toHaveBeenCalledWith("FN-001", "episode-observed");
    expect((response.body as { wedgeNotification: { status: string } }).wedgeNotification.status).toBe("resolved");
  });

  it("does not clear a replacement wedge episode", async () => {
    const { app, task } = createHarness({ wedgeEpisodeId: "episode-new" });
    const response = await REQUEST(
      app,
      "POST",
      "/api/tasks/FN-001/wedge/resolve",
      JSON.stringify({ episodeId: "episode-observed" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(409);
    expect(task.wedgeNotification).toEqual(expect.objectContaining({ episodeId: "episode-new", status: "active" }));
  });

  it("requires the observed wedge episode id", async () => {
    const { app, resolveTaskWedgeNotificationEpisode } = createHarness();
    const response = await REQUEST(
      app,
      "POST",
      "/api/tasks/FN-001/wedge/resolve",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(resolveTaskWedgeNotificationEpisode).not.toHaveBeenCalled();
  });

  /**
   * FNXC:TaskStateReconciliation 2026-07-29-17:43:
   * Both live mutation routes expose the same deleted-task 404 contract; testing only wedge resolution leaves checklist updates free to regress to a server error.
   */
  it.each([
    ["PATCH", "/api/tasks/FN-001/steps/0", { status: "done" }],
    ["POST", "/api/tasks/FN-001/wedge/resolve", { episodeId: "episode-observed" }],
  ])("maps a soft-deleted task to 404 for %s %s", async (method, path, body) => {
    const { app } = createHarness({ deleted: true });
    const response = await REQUEST(
      app,
      method,
      path,
      JSON.stringify(body),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual(expect.objectContaining({ error: expect.stringContaining("Task FN-001 is soft-deleted") }));
  });

  it.each([
    ["PATCH", "/api/tasks/FN-001/steps/0", { status: "done" }],
    ["POST", "/api/tasks/FN-001/wedge/resolve", { episodeId: "episode-observed" }],
  ])("maps a missing task to 404 for %s %s", async (method, path, body) => {
    const { app } = createHarness({ missing: true });
    const response = await REQUEST(
      app,
      method,
      path,
      JSON.stringify(body),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual(expect.objectContaining({ error: "Task FN-001 not found" }));
  });
});
