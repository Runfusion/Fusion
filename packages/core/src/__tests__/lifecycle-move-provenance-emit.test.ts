import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/*
FNXC:LifecycleContainment 2026-08-28-04:47:
FN-207 requires every automatic move to be attributable in the operator log. The reported symptom was
not a wrong move but an unreadable one: the canonical `task:moved` emitter held the mover's
`workflowMoveSource` and dropped it, so the lifecycle log rendered fully-provenanced forward graph
transitions as "unattributed automatic move" — indistinguishable from the unexplained wander this task
exists to eliminate.

Two layers, deliberately:
  1. A CODE-CONSTRUCT guard on the canonical emitter, which runs on the thin merge gate. The emit sits
     after a committed transaction inside `moveTaskInternalImpl` and cannot be driven without a real
     backend, so the gate would otherwise carry no regression guard for the forwarding itself. This
     asserts a construct, never a comment (see AGENTS "Tests Assert Behavior, Never Source Text").
  2. A BEHAVIOURAL payload assertion over the real move path, PostgreSQL-gated like the sibling
     `in-review-entry-audit.test.ts`, which drives the same production `moveTask` API.
*/
/* Resolved from THIS file, not `process.cwd()`: the core suite runs workers from a sandboxed temp cwd. */
const CANONICAL_EMITTER = fileURLToPath(new URL("../task-store/moves.ts", import.meta.url));

function canonicalMovedEmitBody(): string {
  const source = readFileSync(CANONICAL_EMITTER, "utf8");
  const start = source.indexOf('store.emit("task:moved"');
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("});", start));
}

describe("the canonical task:moved emitter forwards mover provenance", () => {
  it("passes the raw workflowMoveSource option into the payload", () => {
    expect(canonicalMovedEmitBody()).toContain("workflowMoveSource: options?.workflowMoveSource");
  });

  it("still forwards the reason and requested source it already carried", () => {
    const body = canonicalMovedEmitBody();

    expect(body).toContain("requestedSource: options?.moveSource");
    expect(body).toContain("lifecycleReason: options?.lifecycleReason");
  });
});

pgDescribe("task:moved provenance payload (real move path)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_move_provenance",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  type MovedPayload = { from: string; to: string; workflowMoveSource?: string; lifecycleReason?: string };

  const captureMoved = (store: ReturnType<SharedPgTaskStoreHarness["store"]>): { events: MovedPayload[]; stop: () => void } => {
    const events: MovedPayload[] = [];
    const listener = (data: MovedPayload) => { events.push(data); };
    store.on("task:moved", listener as never);
    return { events, stop: () => store.off("task:moved", listener as never) };
  };

  it("carries workflowMoveSource for a graph-owned forward transition", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "graph-owned forward transition" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    const captured = captureMoved(store);

    try {
      // Exact option shape produced by the executor's workflow column boundary.
      await store.moveTask(task.id, "in-progress", {
        moveSource: "engine",
        workflowMoveSource: "workflow-graph",
        bypassGuards: true,
        preserveProgress: true,
      });
    } finally {
      captured.stop();
    }

    const forward = captured.events.find((event) => event.to === "in-progress");
    expect(forward?.workflowMoveSource).toBe("workflow-graph");
  });

  it("leaves provenance undefined for a mover that declares none", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "operator drag declares no provenance" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    const captured = captureMoved(store);

    try {
      await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    } finally {
      captured.stop();
    }

    const forward = captured.events.find((event) => event.to === "in-progress");
    expect(forward).toBeDefined();
    expect(forward?.workflowMoveSource).toBeUndefined();
  });
});
