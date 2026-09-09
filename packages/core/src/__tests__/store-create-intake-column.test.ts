import { it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "../types.js";
import { setTaskCreatedHook } from "../tasks/task-creation-hooks.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { buildBootstrapPrompt } from "../mesh/mesh-task-replication.js";

const pgTest = pgDescribe;

/*
FNXC:TitleSummarization 2026-08-19-14:10:
The PostgreSQL create path owns the automatic title policy and deferred lifecycle fence. Keep these
helpers on the real TaskStore so enabled/disabled settings, late writes, duplicate claims, and hook
ordering cannot be proven only through gateway mocks.
*/
function observeTaskCreatedHook(): Promise<Task> {
  return new Promise((resolve) => {
    setTaskCreatedHook((task) => resolve(task));
  });
}

async function settleTaskCreatedHook(hook: Promise<Task>): Promise<Task> {
  // The hook is invoked after the deferred title write, so it fences the persisted result.
  return hook;
}

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
    setTaskCreatedHook(undefined);
    await h.afterEach();
  });

  /*
  FNXC:TitleSummarization 2026-08-19-14:10:
  Automatic title generation is project-controlled but independent of description length. These
  cases use a controlled callback at the PostgreSQL TaskStore boundary, proving the setting snapshot
  and late lifecycle behavior without making a real model call or adding timing sleeps.
  */
  it.each([1, 200, 201, 4001])("summarizes a titleless description of length %i when enabled", async (length) => {
    const store = h.store();
    await store.updateSettings({ autoSummarizeTitles: true });
    let summarizeCalls = 0;
    const hook = observeTaskCreatedHook();
    const created = await store.createTask(
      { description: "x".repeat(length) },
      {
        onSummarize: async () => {
          summarizeCalls += 1;
          return `Generated title ${length}`;
        },
      },
    );

    await settleTaskCreatedHook(hook);
    const persisted = await store.getTask(created.id);
    expect(summarizeCalls).toBe(1);
    expect(persisted?.title).toBe(`Generated title ${length}`);
  });

  it.each([1, 200, 201, 4001])("does not summarize a titleless description of length %i when disabled", async (length) => {
    const store = h.store();
    await store.updateSettings({ autoSummarizeTitles: false });
    let summarizeCalls = 0;
    const hook = observeTaskCreatedHook();
    const created = await store.createTask(
      { description: "x".repeat(length) },
      {
        onSummarize: async () => {
          summarizeCalls += 1;
          return "Should not be used";
        },
      },
    );

    await settleTaskCreatedHook(hook);
    const persisted = await store.getTask(created.id);
    expect(summarizeCalls).toBe(0);
    expect(persisted?.title).toBeUndefined();
  });

  it("preserves an explicit title and allows summarize:true to force generation", async () => {
    const store = h.store();
    await store.updateSettings({ autoSummarizeTitles: false });
    let summarizeCalls = 0;
    const hook = observeTaskCreatedHook();
    const explicit = await store.createTask(
      { title: "Operator title", description: "short description" },
      { onSummarize: async () => { summarizeCalls += 1; return "Unexpected title"; } },
    );
    await settleTaskCreatedHook(hook);
    expect(summarizeCalls).toBe(0);
    expect((await store.getTask(explicit.id))?.title).toBe("Operator title");

    const forcedHook = observeTaskCreatedHook();
    const forced = await store.createTask(
      { description: "short forced description", summarize: true },
      { onSummarize: async () => { summarizeCalls += 1; return "Forced title"; } },
    );
    await settleTaskCreatedHook(forcedHook);
    expect(summarizeCalls).toBe(1);
    expect((await store.getTask(forced.id))?.title).toBe("Forced title");
  });

  it("does not invoke a second summarizer for a proposal-claim replay", async () => {
    const store = h.store();
    await store.updateSettings({ autoSummarizeTitles: true });
    let summarizeCalls = 0;
    const hook = observeTaskCreatedHook();
    const first = await store.createTask(
      { description: "replayed description", proposalClaimId: "title-summary-replay" },
      { onSummarize: async () => { summarizeCalls += 1; return "Replay-safe title"; } },
    );
    const replay = await store.createTask(
      { description: "replayed description", proposalClaimId: "title-summary-replay" },
      { onSummarize: async () => { summarizeCalls += 1; return "Wrong second title"; } },
    );

    await settleTaskCreatedHook(hook);
    expect(replay.id).toBe(first.id);
    expect(summarizeCalls).toBe(1);
    expect((await store.getTask(first.id))?.title).toBe("Replay-safe title");
  });

  it("does not overwrite a title supplied while summarization is pending", async () => {
    const store = h.store();
    await store.updateSettings({ autoSummarizeTitles: true });
    let releaseSummary!: (title: string | null) => void;
    let markStarted!: () => void;
    const summaryStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const summary = new Promise<string | null>((resolve) => { releaseSummary = resolve; });
    const hook = observeTaskCreatedHook();
    const created = await store.createTask(
      { description: "concurrent title description" },
      {
        onSummarize: async () => {
          markStarted();
          return summary;
        },
      },
    );

    await summaryStarted;
    await store.updateTask(created.id, { title: "Concurrent operator title" });
    releaseSummary("Late AI title");
    await settleTaskCreatedHook(hook);

    expect((await store.getTask(created.id))?.title).toBe("Concurrent operator title");
  });

  it("does not overwrite a title written after the deferred preflight read", async () => {
    const store = h.store();
    await store.updateSettings({ autoSummarizeTitles: true });
    const hook = observeTaskCreatedHook();
    let created!: Task;
    const originalGetTask = store.getTask.bind(store);
    let injected = false;
    store.getTask = async (id: string) => {
      const current = await originalGetTask(id);
      if (!injected && id === created.id && !current?.title) {
        injected = true;
        await store.updateTask(id, { title: "Concurrent operator title" });
      }
      return current;
    };

    created = await store.createTask(
      { description: "preflight race description" },
      { onSummarize: async () => "Late AI title" },
    );

    await settleTaskCreatedHook(hook);
    expect(injected).toBe(true);
    expect((await originalGetTask(created.id))?.title).toBe("Concurrent operator title");
  });

  it.each([
    { label: "null", result: null },
    { label: "throw", result: "throw" },
  ])("settles the task-created hook after a $label summary result", async ({ result }) => {
    const store = h.store();
    await store.updateSettings({ autoSummarizeTitles: true });
    let summarizeCalls = 0;
    const hook = observeTaskCreatedHook();
    const created = await store.createTask(
      { description: `summary ${result}` },
      {
        onSummarize: async () => {
          summarizeCalls += 1;
          if (result === "throw") throw new Error("controlled summarizer failure");
          return null;
        },
      },
    );

    await settleTaskCreatedHook(hook);
    expect(summarizeCalls).toBe(1);
    expect((await store.getTask(created.id))?.title).toBeUndefined();
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
      workflowId: "builtin:coding-ideas-v2",
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

  /*
  FNXC:MergedPlanningColumn 2026-07-29-17:05 (PR #2589 review — greptile):
  `_createTaskInternalImpl` (the reserved-id / legacy path) had the same gap the backend path did:
  it assigns `fallbackIntakeColumn` to the task's column but omitted it from `isIntakeColumn`, so a
  create down that path lands in the resolved intake column and is then classified NOT-intake —
  receiving `generateSpecifiedPrompt` instead of the bootstrap seed. Triage admits a card for
  planning only when its PROMPT.md reads as a seed, so the card would rest in Planning already
  looking "planned" and never be planned.

  Exercised through `createTaskWithReservedId`, which is the path the engine and mesh replication
  use; the backend path is covered by the test above. Both paths need the assertion because they
  are two independent copies of the same predicate.
  */
  it("writes a bootstrap PROMPT.md on the RESERVED-ID path too (both create paths)", async () => {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "reserved-id create, no default workflow row" },
      { taskId: "FN-RSV-1" },
    );
    expect(task.column).toBe("todo");
    const prompt = await readFile(join(store.getTasksDir(), task.id, "PROMPT.md"), "utf-8");
    expect(prompt).toBe(buildBootstrapPrompt(task.id, task.title, task.description));
  });

  it("still writes a bootstrap PROMPT.md for that create, so triage can discover it", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "plain create, no default workflow row" });
    const prompt = await readFile(join(store.getTasksDir(), task.id, "PROMPT.md"), "utf-8");
    expect(prompt).toBe(buildBootstrapPrompt(task.id, task.title, task.description));
  });

  it("lands a Coding (Ideas) task in ideas even when enabledWorkflowSteps is supplied", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas-v2");
    const task = await store.createTask({
      description: "ideas task created with explicit optional-group toggles",
      enabledWorkflowSteps: [],
    });
    expect(task.column).toBe("ideas");
  });

  it("writes a bootstrap PROMPT.md for that same create (so triage can still discover it)", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas-v2");
    const task = await store.createTask({
      description: "ideas task created with explicit optional-group toggles",
      enabledWorkflowSteps: [],
    });
    const prompt = await readFile(join(store.getTasksDir(), task.id, "PROMPT.md"), "utf-8");
    expect(prompt).toBe(buildBootstrapPrompt(task.id, task.title, task.description));
  });

  it("lands a Coding (Ideas) task in ideas when it is the project default workflow", async () => {
    const store = h.store();
    await store.setDefaultWorkflowId("builtin:coding-ideas-v2");
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
    await store.setDefaultWorkflowId("builtin:coding-ideas-v2");
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
    await store.setDefaultWorkflowId("builtin:coding-ideas-v2");
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
      workflowId: "builtin:coding-ideas-v2",
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
      workflowId: "builtin:coding-ideas-v2",
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

  /*
  FNXC:MergedPlanningColumn 2026-07-30-10:45 (Phase B — task-creation.ts conversion):
  EXPECTATION INVERTED BY THE MERGE, deliberately.

  This asserted "a direct create into `todo` is NOT an intake create, so it keeps
  generateSpecifiedPrompt". That was true while the default workflow's intake was `triage`. U11
  merged Todo into Planning, so `todo` IS the default's intake column — and a card created there
  with no spec MUST get the bootstrap seed, because triage admits a card for planning only when its
  PROMPT.md reads as a seed. Keeping the old expectation would pin the FN-8587 stall: a boilerplate
  spec that reads as "already planned" and is never planned.

  The old behavior survived only by accident of resolution failing: the harness has no persisted
  default-workflow row, so `resolvedEntryColumn` was undefined and the sole remaining clause was the
  literal `task.column === "triage"`. Removing that literal is what surfaced it — which is the point
  of the conversion.

  Renamed and re-pointed rather than deleted: the case it still guards is that an EXPLICIT column on
  a create is honoured and classified against the workflow's own intake, not silently overridden.
  */
  it("treats a direct create into the default workflow's intake column as an intake create", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "direct intake create", column: "todo" });
    expect(task.column).toBe("todo");
    const prompt = await readFile(join(store.getTasksDir(), task.id, "PROMPT.md"), "utf-8");
    // `todo` is the merged Planning column and therefore the intake column: bootstrap seed.
    expect(prompt).toBe(buildBootstrapPrompt(task.id, task.title, task.description));
  });

  /*
  FNXC:MergedPlanningColumn 2026-07-30-13:10 (PR #2613 review — greptile):
  `isUnplannedStartCreate` must stay narrow. My conversion replaced `&& task.column === "todo"`
  with "any column other than intake", which on a MANUAL-intake workflow classified a direct create
  into `in-review` (or `done`) as an unplanned quick-add Start — handing it a bootstrap stub instead
  of a specified prompt. Quick-add Start lands the card in the workflow's PLANNING column, so the
  narrowing belongs on the hold column, resolved from the IR rather than named.
  */
  it("does not treat an Ideas create into a REVIEW column as an unplanned Start create", async () => {
    const store = h.store();
    const task = await store.createTask({
      description: "direct ideas create past planning",
      workflowId: "builtin:coding-ideas-v2",
      column: "in-review",
    });
    expect(task.column).toBe("in-review");
    const prompt = await readFile(join(store.getTasksDir(), task.id, "PROMPT.md"), "utf-8");
    expect(prompt).not.toBe(buildBootstrapPrompt(task.id, task.title, task.description));
  });

  it("still treats an Ideas quick-add Start create into the planning column as unplanned", async () => {
    // The case `isUnplannedStartCreate` exists for (FN-8587): create+promote in one request, so the
    // card never sat in the manual intake but has no spec.
    const store = h.store();
    const task = await store.createTask({
      description: "ideas quick-add start",
      workflowId: "builtin:coding-ideas-v2",
      column: "todo",
    });
    expect(task.column).toBe("todo");
    const prompt = await readFile(join(store.getTasksDir(), task.id, "PROMPT.md"), "utf-8");
    expect(prompt).toBe(buildBootstrapPrompt(task.id, task.title, task.description));
  });

  it("keeps generateSpecifiedPrompt for a direct create into a NON-intake column", async () => {
    // The contract the old test was really protecting — an explicit column past intake is a
    // specified create, not an unplanned one.
    const store = h.store();
    const task = await store.createTask({ description: "direct wip create", column: "in-progress" });
    expect(task.column).toBe("in-progress");
    const prompt = await readFile(join(store.getTasksDir(), task.id, "PROMPT.md"), "utf-8");
    expect(prompt).not.toBe(buildBootstrapPrompt(task.id, task.title, task.description));
    expect(prompt).toContain("## Original Description");
    expect(prompt).toContain("direct wip create");
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
      workflowId: "builtin:coding-ideas-v2",
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
