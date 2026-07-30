/*
FNXC:WorkflowCustomFields 2026-07-30-22:40 (E2E evidence — custom fields are unwritable off the default board):

This is the same inert-sync-resolution class as #2789 and #2791, but the consequence is not latency and
not a silently wrong id. It is a HARD WRITE REJECTION of a declared feature.

`TaskStore.resolveTaskCustomFieldDefsSync` reads the task's field definitions through
`store.resolveTaskWorkflowIrSync`, which under PostgreSQL answers `undefined` for every task and so
resolves the DEFAULT workflow IR. The default declares no `fields`, so the function returns `[]` for
every task on every board. `task-update.ts` then validates every `customFields` write against that
empty list:

    const defs = store.resolveTaskCustomFieldDefsSync(id);
    const result = validateCustomFieldPatch(defs, updates.customFields);
    if (!result.ok) throw new CustomFieldRejectionError(result.rejection);

so a workflow that DOES declare fields cannot have any of them written. The rejection reason is
`no-fields-defined`, and its message — "the resolved workflow declares no custom fields" — is a true
statement about the workflow that got resolved and a false one about the workflow the card is on.

WHAT MAKES THIS WORTH ITS OWN FILE rather than a line in the ledger: the two halves of the feature
disagree with each other in production. The executor resolves the SAME definitions through the async
resolver (`executor.ts`'s `resolveTaskCustomFieldDefs` -> `resolveWorkflowIrForTask`) and sees the
real fields, so an agent can be prompted to supply a value that the store will then refuse to store.
The last case below asserts exactly that pair against one store and one task.

THREE WRITE PATHS share the sync resolver — `task-update.ts` (the one driven here),
`workflow-task-create-ops.ts`, and `workflow-ops.ts`. Only the first is exercised; the other two are
named so the surface is on record rather than implied. See the PR body.

OBSERVED STATE. The assertions are the thrown typed rejection and the ABSENCE of a persisted value on
a re-read row — not a spy on the validator.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import { resolveWorkflowIrForTask, type TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { DEFAULT_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

/** One declared field. `text` keeps the validator's type rules out of the subject. */
const RISK_FIELD = { id: "risk", name: "Risk", type: "text" } as const;

pgDescribe("custom field definitions resolved for a live task", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_custom_fields",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** Persist a real workflow that DECLARES `risk`, and a task bound to it.
   *
   *  `createWorkflowDefinition` allocates its own id and ignores one passed in, so the task binds to
   *  the id the STORE returned — binding to the requested id silently resolves the default builtin
   *  IR, which is a custom-field fixture that tests nothing. */
  async function taskOnFieldWorkflow(store: TaskStore, key: string): Promise<string> {
    const ir = { ...lifecycleIr(DEFAULT_VOCAB, `custom:${key}`), fields: [RISK_FIELD] };
    const created = await store.createWorkflowDefinition({
      name: `Fields ${key}`,
      kind: "workflow",
      ir,
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `field probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    return task.id;
  }

  it("the workflow definition really does declare the field (fixture integrity)", async () => {
    /* First, because every assertion below is about a MISSING definition and would pass just as well
       against a workflow that never declared one. */
    const store = h.store();
    const taskId = await taskOnFieldWorkflow(store, "wf-integrity");

    const ir = await resolveWorkflowIrForTask(store, taskId);

    expect((ir as { fields?: unknown[] }).fields).toEqual([RISK_FIELD]);
  });

  it("CHARACTERIZATION — the sync resolver reports NO fields for that task", async () => {
    const store = h.store();
    const taskId = await taskOnFieldWorkflow(store, "wf-sync-defs");

    expect(store.resolveTaskCustomFieldDefsSync(taskId)).toEqual([]);
  });

  it("CHARACTERIZATION — so writing the declared field is REJECTED and nothing persists", async () => {
    /*
    The operator-visible failure. Not a wrong column id and not a missed wake: the write is refused
    with a typed rejection whose reason is that no fields are defined, on a board that defines one.
    */
    const store = h.store();
    const taskId = await taskOnFieldWorkflow(store, "wf-write");

    await expect(
      store.updateTask(taskId, { customFields: { risk: "high" } } as never),
    ).rejects.toThrow(/no-fields-defined|declares no custom fields/);

    /* And the row is untouched — the rejection is not a partial write. */
    store.taskCache.delete(taskId);
    const row = await store.getTask(taskId);
    expect((row?.customFields as Record<string, unknown> | undefined)?.risk).toBeUndefined();
  });

  it("CHARACTERIZATION — the two halves of the feature disagree on the SAME task", async () => {
    /*
    The async resolver is the one the executor uses to decide what to ask an agent for
    (`executor.ts` -> `resolveTaskCustomFieldDefs` -> `resolveWorkflowIrForTask`). It sees `risk`.
    The sync resolver, which is what every write path validates against, sees nothing. One store, one
    task, one workflow, two answers — which is why this cannot be dismissed as a fixture artefact.
    */
    const store = h.store();
    const taskId = await taskOnFieldWorkflow(store, "wf-disagree");

    const asyncIr = await resolveWorkflowIrForTask(store, taskId);
    const asyncFields = (asyncIr as { fields?: { id: string }[] }).fields ?? [];

    expect(asyncFields.map((f) => f.id)).toEqual(["risk"]);
    expect(store.resolveTaskCustomFieldDefsSync(taskId).map((f) => f.id)).toEqual([]);
  });
});
