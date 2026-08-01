/*
FNXC:WorkflowResolvedColumns 2026-07-31-14:10:
THE INVARIANT: a card in the board's OWN wip lane is refused a mid-flight node override, BY THE CLI's
own guard, with the structured reason code rather than a prose message from deeper down.

Two guards sit on this path and both refuse, so "is the change blocked?" cannot tell them apart:
`fn_task_update` pre-checks with `validateNodeOverrideChange`, and `TaskStore.updateTask` checks again
with its own resolved lanes (`resolveNodeOverrideLanes`) and throws. What separates them is the ERROR
CONTRACT, and that is what these cases pin:

  pre-check fires   ->  details.error === "task-in-progress"          (machine-readable reason)
  pre-check misses  ->  details.error === "Cannot change node ..."    (the store's thrown prose)

Measured both ways, not reasoned about. With #3019's wiring removed the first case fails exactly
there. That difference is the real cost of the unwired pre-check: on a legacy board a caller could
branch on `task-in-progress`, and on a renamed board it silently got a sentence instead — an API
inconsistency visible only to whoever was parsing it.

WHAT THIS DOES NOT SHOW, since I claimed the opposite twice before measuring: the operator was never
able to make the change. The store refuses either way. This is an error-contract regression test, not
proof of a bypassable guard.

Two traps inherited from `merge-blocker-renamed-review-lane.test.ts`, whose own header records paying
for both:
  - The real API is `createWorkflowDefinition` + `selectTaskWorkflow`. The plausible-looking
    `saveWorkflowDefinition?.()` / `setTaskWorkflowSelection?.()` do not exist on TaskStore, and the
    optional call swallows that silently — the task then resolves the BUILTIN workflow and every
    assertion is about the wrong board.
  - Moving a card takes `moveTask`, not `updateTask({ column })`. The latter does not move it, so the
    card sits in intake and the case is vacuous.
Both are guarded below by asserting the premise (the card really is in `building`) before the subject.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkflowIr } from "@fusion/core";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
  pgDescribe,
} from "./pg-extension-harness.js";

const h = createPgExtensionHarness("fn-node-override-wip");

/* A real lifecycle spine: column adjacency is derived from the graph, so an IR whose nodes do not
   cover a column cannot be moved into it and the setup moves would fail as if they were the subject. */
const RENAMED_IR = {
  version: "v2",
  id: "node-override-lifecycle",
  name: "renamed",
  columns: [
    { id: "backlog", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "merge" }] },
    { id: "shipped", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "backlog" },
    { id: "exec", kind: "prompt", column: "building", config: { seam: "execute" } },
    { id: "merge-gate", kind: "merge-gate", column: "checking", config: { gate: "auto-merge" } },
    { id: "end", kind: "end", column: "shipped" },
  ],
  edges: [
    { from: "start", to: "exec" },
    { from: "exec", to: "merge-gate", condition: "success" },
    { from: "merge-gate", to: "end", condition: "success" },
  ],
} as unknown as WorkflowIr;

async function seedCardInRenamedWip(description: string): Promise<string> {
  const store = h.store();
  const definition = await store.createWorkflowDefinition({ name: "renamed node override", ir: RENAMED_IR as never });
  const task = await store.createTask({ description });
  await store.selectTaskWorkflow(task.id, definition.id);
  /* Created in the builtin intake, so it enters the custom board through `backlog`. */
  for (const lane of ["backlog", "building"]) {
    await store.moveTask(task.id, lane as never, { moveSource: "user" } as never);
  }
  /* The premise, asserted rather than assumed — see the header. */
  expect((await store.getTask(task.id)).column).toBe("building");
  return task.id;
}

pgDescribe("fn_task_update node override respects the board's own wip lane", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("refuses a mid-flight node override for a card in a RENAMED wip lane", async () => {
    const api = createMockApi();
    registerExtension(api);
    const taskId = await seedCardInRenamedWip("renamed wip node override");

    const updateTool = requireTool(api, "fn_task_update");
    const result = await updateTool.execute(
      "u1",
      { id: taskId, nodeId: "merge-gate" },
      undefined,
      undefined,
      { cwd: h.rootDir() },
    );

    expect(result.isError).toBe(true);
    /* The reason CODE, not the message: this is the assertion that separates the CLI pre-check from
       the store's throw. See the header — with the pre-check unwired this line receives prose. */
    expect(result.details?.error).toBe("task-in-progress");
    expect(String(result.content?.[0]?.text ?? "")).toContain("routing cannot be changed mid-flight");

    /* And it really did not write: the override must be absent, not merely reported as refused. */
    expect((await h.store().getTask(taskId)).nodeId ?? null).toBeNull();
  });

  it("still allows the override once the card leaves that wip lane", async () => {
    const api = createMockApi();
    registerExtension(api);
    const taskId = await seedCardInRenamedWip("renamed wip node override, moved on");
    await h.store().moveTask(taskId, "checking" as never, { moveSource: "user" } as never);

    const updateTool = requireTool(api, "fn_task_update");
    const result = await updateTool.execute(
      "u2",
      { id: taskId, nodeId: "merge-gate" },
      undefined,
      undefined,
      { cwd: h.rootDir() },
    );

    expect(result.isError).toBeFalsy();
    expect((await h.store().getTask(taskId)).nodeId).toBe("merge-gate");
  });
});
