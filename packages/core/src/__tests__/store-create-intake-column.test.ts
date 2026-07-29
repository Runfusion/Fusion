import { it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "../types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { buildBootstrapPrompt } from "../mesh-task-replication.js";

const pgTest = pgDescribe;

/*
FNXC:CodingIdeasWorkflow 2026-07-04-11:30:
Pin the createTask intake-column wiring: a task created against the Coding (Ideas) workflow (manual autoTriage:false intake) must land in the "ideas" column, not the legacy "triage" default, while the default Coding workflow keeps landing cards in "triage".
*/
pgTest("createTask intake-column wiring (Coding (Ideas))", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_intake",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  /*
  FNXC:MergedPlanningColumn 2026-07-29-14:55 (U11 post-merge audit):
  This guarded "a default-workflow create lands in triage" and was byte-identical for as long as
  the default workflow declared a `triage` column. U11 merged Todo into Planning, so the default's
  intake column IS `todo` — the create landing there is the change working, and the assertion is
  updated to name the invariant (the DEFAULT WORKFLOW'S OWN intake column) rather than the id that
  used to hold it.

  Kept as a guard rather than deleted: it is the assertion that catches a regression back to the
  hard-coded `"triage"` fallback, which is exactly the defect this commit fixes.
  */
  it("lands a default-workflow task in the default workflow's intake column", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "default workflow task" });
    expect(task.column).toBe("todo");
    expect(task.column).not.toBe("triage");
  });

  it("lands a Coding (Ideas) task in the ideas intake column when selected explicitly", async () => {
    const store = h.store();
    const task = await store.createTask({
      description: "ideas workflow task",
      workflowId: "builtin:coding-ideas",
    });
    expect(task.column).toBe("ideas");
  });

  /*
  FNXC:MergedPlanningColumn 2026-07-28-12:40 (U11 precondition):
  The intake column is resolved ONLY inside the two `materializeWorkflowSteps` branches. A create
  that supplies `enabledWorkflowSteps` without an explicit `workflowId` takes NEITHER branch, so
  `resolvedEntryColumn` stays undefined and `column:` falls through to the hard-coded `|| "triage"`.

  Today that lands a Coding (Ideas) card in `triage` — a column that workflow does not declare —
  so the card is created straight into a phantom lane. U11 makes this the DEFAULT workflow's
  problem too: once `triage` is deleted, every create down this path lands in an undeclared column
  and, because `isIntakeColumn` keys on the same literal, also gets `generateSpecifiedPrompt`
  instead of the bootstrap seed. Triage's discovery admits a card only when its PROMPT.md reads as
  a seed, so the card would sit in Planning forever with no log line in any lane — FN-8587's exact
  failure mode, for every new card rather than one edge case.
  */
  /*
  FNXC:MergedPlanningColumn 2026-07-29-14:20 (U11 post-merge audit):
  A project that has never explicitly set a default workflow has no persisted default row, so
  `materializeDefaultWorkflowSteps()` returns nothing, `resolvedEntryColumn` stays undefined, and
  the create falls through to the hard-coded `|| "triage"`.

  That column no longer exists in the default workflow. Measured post-merge: a plain
  `createTask({ description })` on such a project lands in `triage` while the same project's
  default workflow declares intake as `todo`. Triage discovery resolves intake by trait, so
  `isAtIntakeColumn` is false for that card and it is never admitted for planning; it is not in
  the hold column either, so hold-release ignores it too. The card is only rescued when
  `reconcileUndeclaredTaskColumns` re-homes it.

  This is the out-of-the-box state for a fresh project — `builtin:coding` is the IMPLICIT default
  via DEFAULT_WORKFLOW_ID, and nothing writes a default-workflow row until an operator picks one.
  */
  it("lands a plain create in the default workflow's intake column when no default row is persisted", async () => {
    const store = h.store();
    // Deliberately NO setDefaultWorkflowId — the implicit-default, fresh-project shape.
    const task = await store.createTask({ description: "plain create, no default workflow row" });
    expect(task.column).toBe("todo");
    expect(task.column).not.toBe("triage");
  });

  it("still writes a bootstrap PROMPT.md for that create, so triage can discover it", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "plain create, no default workflow row" });
    const prompt = await readFile(join(store.getTasksDir(), task.id, "PROMPT.md"), "utf-8");
    expect(prompt).toBe(buildBootstrapPrompt(task.id, task.title, task.description));
  });

  it("lands a Coding (Ideas) task in ideas even when enabledWorkflowSteps is supplied", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas");
    const task = await store.createTask({
      description: "ideas task created with explicit optional-group toggles",
      enabledWorkflowSteps: [],
    });
    expect(task.column).toBe("ideas");
  });

  it("writes a bootstrap PROMPT.md for that same create (so triage can still discover it)", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas");
    const task = await store.createTask({
      description: "ideas task created with explicit optional-group toggles",
      enabledWorkflowSteps: [],
    });
    const prompt = await readFile(join(store.getTasksDir(), task.id, "PROMPT.md"), "utf-8");
    expect(prompt).toBe(buildBootstrapPrompt(task.id, task.title, task.description));
  });

  it("lands a Coding (Ideas) task in ideas when it is the project default workflow", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas");
    const task = await store.createTask({ description: "default ideas task" });
    expect(task.column).toBe("ideas");
  });

  /*
  FNXC:MergedPlanningColumn 2026-07-29-12:25 (U11):
  The INVARIANT here is "an explicit create-time workflowId beats the project default", not "the
  answer is the literal `triage`". U11 merges Todo into Planning on builtin:coding, so its intake
  column is now `todo` — the test asserts the invariant through the selected workflow's own
  resolved intake column so it cannot drift again the next time a column id moves.
  */
  it("lands a task explicitly selecting builtin:coding in ITS intake column, even when the project default is coding-ideas", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas");
    const task = await store.createTask({
      description: "explicit default coding workflow task",
      workflowId: "builtin:coding",
    });
    // builtin:coding's merged Planning column; explicitly NOT coding-ideas' `ideas` intake.
    expect(task.column).toBe("todo");
    expect(task.column).not.toBe("ideas");
  });

  it("does not throw and falls back to triage when workflowId is explicitly null (\"No workflow\")", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas");
    const task = await store.createTask({
      description: "explicit no-workflow task",
      workflowId: null,
    });
    expect(task.column).toBe("triage");
  });

  it("writes a bootstrap PROMPT.md for an ideas-column task (unplanned)", async () => {
    const store = h.store();
    const task: Task = await store.createTask({
      description: "ideas bootstrap prompt task",
      workflowId: "builtin:coding-ideas",
    });
    const prompt = await readFile(
      join(h.rootDir(), ".fusion", "tasks", task.id, "PROMPT.md"),
      "utf-8",
    );
    expect(prompt).toBe(`# ${task.id}\n\n${task.description}\n`);
  });

  /*
  FNXC:CodingIdeasWorkflow 2026-07-25-14:20:
  Regression for the stranded quick-add "Start" card (FN-8587). Start collapses create+promote into
  one request — workflow id AND the post-intake `todo` column together — so the card never sits in
  the manual intake column. It got generateSpecifiedPrompt, whose hard-coded boilerplate steps
  ("Implement the required changes") no planner ever wrote. Triage then classified the non-seed
  PROMPT.md as "already planned" and never planned it, so the card sat in Todo permanently with no
  log line in any lane.

  Surface enumeration (invariant: an unplanned card gets the seed no matter which column of a
  manual-intake workflow it is created into, while pre-specified creates keep their spec):
   - Create into the intake column itself (covered above) -> seed.
   - Create straight into todo on a manual-intake workflow (this case, the Start path) -> seed.
   - Promote intake -> todo via moveTask (covered below) -> seed preserved.
   - Default-workflow direct create into todo -> still generateSpecifiedPrompt (next test).
   - An explicit promptOverride always wins over all of the above.
  */
  it("writes a bootstrap PROMPT.md for a quick-add Start create landing straight in todo", async () => {
    const store = h.store();
    const task = await store.createTask({
      description: "quick add start task",
      workflowId: "builtin:coding-ideas",
      column: "todo",
    });
    expect(task.column).toBe("todo");

    const prompt = await readFile(
      join(h.rootDir(), ".fusion", "tasks", task.id, "PROMPT.md"),
      "utf-8",
    );
    expect(prompt).toBe(buildBootstrapPrompt(task.id, task.title, task.description));
    // The placeholder-spec boilerplate that stranded FN-8587 must not appear.
    expect(prompt).not.toContain("Implement the required changes");
    expect(prompt).not.toContain("## Steps");
  });

  it("keeps generateSpecifiedPrompt for a direct create into todo (not bootstrap)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "direct todo create", column: "todo" });
    expect(task.column).toBe("todo");
    const prompt = await readFile(
      join(h.rootDir(), ".fusion", "tasks", task.id, "PROMPT.md"),
      "utf-8",
    );
    // A direct todo create is NOT an intake column, so it must NOT get the bootstrap stub.
    expect(prompt).not.toBe(`# ${task.id}\n\n${task.description}\n`);
    // FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
    // Non-AI specified prompts must surface the operator description near the top.
    expect(prompt).toContain("## Original Description");
    expect(prompt).toContain("direct todo create");
    const originalIdx = prompt.indexOf("## Original Description");
    const missionIdx = prompt.indexOf("## Mission");
    expect(originalIdx).toBeGreaterThan(-1);
    expect(missionIdx).toBeGreaterThan(originalIdx);
  });

  /*
  FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
  FN-7596 pins the store-level contract the engine's todo-discovery poll (packages/engine/src/triage.ts eligibleTodoTasks) depends on: promoting a parked Ideas card via moveTask alone must NOT plan it. Only the triage service's bootstrap-prompt discovery loop plans a promoted-but-unplanned todo card; moveTask is a pure column transition.
  */
  it("promotes an Ideas-parked task to todo without planning it (still bootstrap-stub PROMPT.md)", async () => {
    const store = h.store();
    // FNXC:WorkflowColumns 2026-07-05: workflow columns graduated to always-on;
    // the retired experimental flag is no longer needed (and setting it mid-test
    // invalidates the cached workflow signature, causing a stale preflight).
    const task = await store.createTask({
      description: "ideas lifecycle promotion task",
      workflowId: "builtin:coding-ideas",
    });
    expect(task.column).toBe("ideas");

    const moved = await store.moveTask(task.id, "todo", { moveSource: "user" });
    expect(moved.column).toBe("todo");

    const prompt = await readFile(
      join(h.rootDir(), ".fusion", "tasks", task.id, "PROMPT.md"),
      "utf-8",
    );
    expect(prompt).toBe(buildBootstrapPrompt(task.id, task.title, task.description));
  });
});
