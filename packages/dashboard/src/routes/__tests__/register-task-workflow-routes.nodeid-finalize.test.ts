// @vitest-environment node
//
// FNXC:StateMachine 2026-07-07-12:00:
// FN-7641 Signature 2 route-level regression: PATCH /api/tasks/:id with
// nodeId='end' must never silently no-op. (a) with durable merge proof the
// card advances to done; (b) without merge proof the route returns an
// explicit non-2xx error; (c) neither case is a silent 2xx no-op that leaves
// the card exactly where it started with no error and no advancement
// (NEXT-322 / NEXT-375 / NEXT-340).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

describe("PATCH /tasks/:id nodeId='end' finalize-on-proof-or-error (FN-7641)", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "nodeid-finalize-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "nodeid-finalize-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  const patch = (path: string, body: unknown) =>
    REQUEST(app, "PATCH", path, JSON.stringify(body), { "content-type": "application/json" });

  async function taskInReviewWithSteps() {
    const task = await store.createTask({ description: "out-of-band merge repro" });
    await store.updateTask(task.id, { steps: [{ name: "Only step", status: "done" }] });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    return task;
  }

  it("(a) advances to done when merge proof exists — never a silent no-op", async () => {
    const task = await taskInReviewWithSteps();
    await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

    const res = await patch(`/api/tasks/${task.id}`, { nodeId: "end" });

    expect(res.status).toBe(200);
    const body = res.body as { id: string; column: string; nodeId?: string };
    expect(body.column).toBe("done");
    expect(body.nodeId).toBe("end");
  });

  it("(b) returns an explicit non-2xx error when there is no merge proof — never a silent no-op", async () => {
    const task = await taskInReviewWithSteps();

    const res = await patch(`/api/tasks/${task.id}`, { nodeId: "end" });

    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // (c) confirm the card was NOT silently advanced or mutated by the rejected request.
    const unchanged = await store.getTask(task.id);
    expect(unchanged.column).toBe("in-review");
    expect(unchanged.nodeId).toBeUndefined();
  });

  it("leaves the existing in-progress guard behavior unchanged (still blocks, still 409)", async () => {
    const task = await store.createTask({ description: "in-progress guard" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");

    const res = await patch(`/api/tasks/${task.id}`, { nodeId: "some-node" });

    expect(res.status).toBe(409);
  });
});
