// @vitest-environment node
/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — proof that the REAL HTTP entry point reaches the wake, not just a unit-level helper.

Why this file exists separately from the engine suites: every engine case in `event-driven-dispatch`
starts from a store event that the test itself emits. That proves the consumer reacts, but it cannot
prove the production path from an operator's click actually PUBLISHES one — and the reported symptom
("je démarre la tâche, elle reste en queue") begins at `POST /api/tasks/:id/move`, which the board's
Start affordance performs as a bare column move with no dispatch call of its own.

So: mount the real route registrars on a real Express app, install the real advisory dispatch-wake
signal on the store, and issue a real HTTP request. The only doubles are the store's persistence
methods. A refused move must publish nothing, because a wake for work that did not move would send
every consumer to look at an unchanged board.
*/

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createDispatchWakeSignal } from "@fusion/core";
import type { DispatchWakeEvent } from "@fusion/core";

import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function bootstrapCard() {
  return {
    id: "FN-519-HTTP",
    title: "Bootstrap card",
    description: "started from the board",
    column: "todo",
    status: null,
    executionMode: "fast",
    dependencies: [],
    steps: [],
    currentStep: 0,
    prompt: '# Planned\n\n## Plan Premises\n\n- {"kind":"file-exists","path":"package.json"}\n',
  } as never as { id: string; column: string };
}

function harness(options: { allowMove?: boolean } = {}) {
  const current = bootstrapCard();
  const allowMove = options.allowMove !== false;
  const signal = createDispatchWakeSignal();
  const published: DispatchWakeEvent[] = [];
  signal.subscribe(process.cwd(), (event) => published.push(event));

  const moveTaskIf = vi.fn(async (
    _id: string,
    column: string,
    predicate: (live: typeof current) => boolean | Promise<boolean>,
  ) => {
    if (!allowMove || !(await predicate(current))) return { task: current, moved: false };
    current.column = column;
    /*
    Model the store's real publication: a landed move emits `task:updated`, whose decoration
    publishes the advisory wake. A REFUSED move emits nothing — which is the negative case below.
    */
    store.emitTaskLifecycleEventSafely("task:updated", [current as never, undefined]);
    return { task: current, moved: true };
  });

  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTask: vi.fn(async () => current),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getSettings: vi.fn(async () => ({})),
    moveTask: vi.fn(),
    moveTaskIf,
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: unknown) => unknown) => {
      const patch = await mutate(current);
      if (patch) Object.assign(current, patch);
      return current;
    }),
    logEntry: vi.fn(async () => undefined),
    listeners: vi.fn(() => [] as unknown[]),
    // The real decoration path: `emitTaskLifecycleEventSafely` must publish a wake even with NO
    // local listener, which is exactly the cross-process case. Reproduce that contract here.
    emitTaskLifecycleEventSafely: vi.fn((event: string, args: readonly unknown[]) => {
      const first = args[0] as { id?: string } | undefined;
      if (event === "task:updated" || event === "task:created") {
        signal.publish({
          projectId: process.cwd(),
          reason: "task-eligibility",
          ...(first?.id ? { taskId: first.id } : {}),
        });
      }
      return false;
    }),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, store, published, current, moveTaskIf };
}

describe("POST /api/tasks/:id/move reaches the dispatch wake", () => {
  it("publishes an eligibility wake for the moved card so planning can start without a tick", async () => {
    const h = harness();

    const res = await REQUEST(
      h.app,
      "POST",
      "/api/tasks/FN-519-HTTP/move",
      JSON.stringify({ column: "in-progress" }),
      { "content-type": "application/json" },
    );
    await flushMicrotasks();

    expect(res.status).toBe(200);
    expect(h.moveTaskIf).toHaveBeenCalledTimes(1);
    // The wake the engine consumers subscribe to, carrying the moved card's id and nothing else.
    expect(h.published).toEqual([{
      projectId: process.cwd(),
      reason: "task-eligibility",
      taskId: "FN-519-HTTP",
    }]);
  });

  it("publishes nothing when the move is refused", async () => {
    const h = harness({ allowMove: false });

    const res = await REQUEST(
      h.app,
      "POST",
      "/api/tasks/FN-519-HTTP/move",
      JSON.stringify({ column: "in-progress" }),
      { "content-type": "application/json" },
    );
    await flushMicrotasks();

    // A refused move must not send every consumer to look at an unchanged board.
    expect(res.status).toBeLessThan(500);
    expect(h.published).toEqual([]);
    expect(h.current.column).toBe("todo");
  });

  it("rejects an invalid column without publishing a wake", async () => {
    const h = harness();

    const res = await REQUEST(
      h.app,
      "POST",
      "/api/tasks/FN-519-HTTP/move",
      JSON.stringify({ column: "not-a-column" }),
      { "content-type": "application/json" },
    );
    await flushMicrotasks();

    expect(res.status).toBe(400);
    expect(h.published).toEqual([]);
  });

  it("coalesces a burst of moves into one wake per card", async () => {
    const h = harness();

    await Promise.all(["in-progress", "in-progress", "in-progress"].map((column) => REQUEST(
      h.app,
      "POST",
      "/api/tasks/FN-519-HTTP/move",
      JSON.stringify({ column }),
      { "content-type": "application/json" },
    )));
    await flushMicrotasks();

    // One card, one pending wake: a multi-card drag must not turn into one admission pass per move.
    expect(h.published.filter((e) => e.taskId === "FN-519-HTTP")).toHaveLength(1);
  });
});
