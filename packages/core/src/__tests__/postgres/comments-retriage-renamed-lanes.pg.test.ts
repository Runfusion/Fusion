/*
FNXC:WorkflowLifecycleColumns 2026-07-30-09:10 (Phase B vocabulary conversion — comments-ops):

`addComment`'s post-comment RE-TRIAGE decides, from the card's column, whether a user
comment should invalidate an approved spec or send already-planned work back for
re-specification. It asked that question with three legacy literals:

    task.column === "todo" || task.column === "triage"                 -> in a planner lane
    task.column === "triage" && status === "awaiting-approval"          -> intake, awaiting approval
    hasRealPrompt && (todo || (triage && status !== awaiting-approval)) -> planned, re-triage

On a renamed board none of them match, so a user comment on a planned card does nothing:
no invalidation, no re-specification, no error. The operator types a correction and the
agent never sees it — silent by construction, which is why no test caught it.

RED-GREEN: every renamed case below fails against the pre-conversion literals (verified by
reverting), and the default-vocabulary cases are the regression floor.

Real store, real persisted workflow, assertions on the persisted row — the transition this
path performs is a status write, so it is observable.
*/
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("addComment re-triage under a renamed planner vocabulary (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_comments_retriage_renamed",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** A workflow whose intake is `drafting` and whose hold is `queued` — neither is a
   *  legacy id, so a literal-keyed guard matches nothing. */
  async function seedRenamedWorkflow(): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: "Renamed Planner",
      kind: "workflow",
      ir: {
        version: "v2",
        id: "custom:renamed-planner",
        nodes: [
          { id: "start", kind: "start", column: "drafting" },
          { id: "end", kind: "end", column: "shipped" },
        ],
        edges: [{ from: "start", to: "end" }],
        columns: [
          { id: "drafting", label: "Drafting", traits: [{ trait: "intake" }] },
          { id: "queued", label: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
          { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
          { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
        ],
      },
    } as never);
    return (created as { id: string }).id;
  }

  /** A card with a REAL (non-bootstrap) spec resting in `column`. */
  async function seedPlannedTask(
    id: string,
    column: string,
    opts: { workflowId?: string; status?: string } = {},
  ): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `retriage ${id}`, column } as never,
      { taskId: id, applyDefaultWorkflowSteps: false } as never,
    );
    if (opts.workflowId) await store.writeTaskWorkflowSelection(id, opts.workflowId, []);
    /* A real (non-bootstrap) spec written where the guard reads it. Written directly
       rather than through a store API so the fixture does not depend on task creation's
       prompt side effects — `hasRealPrompt` is a precondition of two of the three branches
       and a bootstrap stub would make those cases pass or fail for the wrong reason. */
    mkdirSync(store.taskDir(id), { recursive: true });
    writeFileSync(
      join(store.taskDir(id), "PROMPT.md"),
      "## Goal\nA genuine specification with real content.\n\n## Steps\n### Step 1: do it\n",
      "utf-8",
    );
    if (opts.status) {
      await h.adminSql()`UPDATE project.tasks SET status = ${opts.status} WHERE id = ${id}`;
    }
    await h.adminSql()`UPDATE project.tasks SET "column" = ${column} WHERE id = ${id}`;
    store.taskCache.delete(id);
    const seeded = await store.getTask(id);
    // Prove the fixture: a bootstrap-stub prompt or the wrong column would make every
    // assertion below pass or fail for reasons unrelated to the vocabulary.
    expect(seeded.column).toBe(column);
    if (opts.status) expect(seeded.status).toBe(opts.status);
  }

  async function persistedStatus(id: string): Promise<string | null | undefined> {
    const store = h.store();
    store.taskCache.delete(id);
    return (await store.getTask(id)).status;
  }

  /*
  FNXC:PostCommentRetriage 2026-07-30-10:20 (PR #2612 review — coderabbit):
  `needs-replan` is written by BOTH branches — approval invalidation and ordinary
  planned-task re-triage — so asserting the status alone cannot tell them apart. A
  card taking the WRONG branch persists the same status and the test still passes.

  The audited phrase is the only durable thing that distinguishes them, so the
  awaiting-approval case asserts that instead of merely alongside.
  */
  async function persistedLogPhrases(id: string): Promise<string[]> {
    const store = h.store();
    store.taskCache.delete(id);
    const task = await store.getTask(id);
    return (task.log ?? []).map((entry) => `${entry.action ?? ""} ${entry.details ?? ""}`.trim());
  }

  it("re-triages a planned card resting in the RENAMED hold column", async () => {
    const wf = await seedRenamedWorkflow();
    await seedPlannedTask("FN-CR-1", "queued", { workflowId: wf });

    await h.store().addComment("FN-CR-1", "please also handle the empty case", "user");

    expect(await persistedStatus("FN-CR-1")).toBe("needs-replan");
  });

  it("re-triages a planned card resting in the RENAMED intake column", async () => {
    const wf = await seedRenamedWorkflow();
    await seedPlannedTask("FN-CR-2", "drafting", { workflowId: wf });

    await h.store().addComment("FN-CR-2", "scope changed", "user");

    expect(await persistedStatus("FN-CR-2")).toBe("needs-replan");
  });

  it("invalidates spec approval for a RENAMED intake card that is awaiting-approval", async () => {
    /* The second literal: `column === "triage" && status === "awaiting-approval"`. This is
       the branch that stops an approved-but-now-stale spec from executing. */
    const wf = await seedRenamedWorkflow();
    await seedPlannedTask("FN-CR-3", "drafting", { workflowId: wf, status: "awaiting-approval" });

    await h.store().addComment("FN-CR-3", "actually, do it differently", "user");

    expect(await persistedStatus("FN-CR-3")).toBe("needs-replan");
    /* The discriminator. Without it this test passes when the card falls through to
       the ordinary re-triage arm, which writes the same status under a different
       audit phrase — the exact confusion this branch exists to prevent. */
    expect(await persistedLogPhrases("FN-CR-3")).toContainEqual(
      expect.stringContaining("invalidated spec approval"),
    );
  });

  it("does NOT re-triage a card in the renamed WIP column", async () => {
    /* The negative half: re-triaging executing work would discard an in-flight session.
       `building` is neither intake nor hold. */
    const wf = await seedRenamedWorkflow();
    await seedPlannedTask("FN-CR-4", "building", { workflowId: wf });

    await h.store().addComment("FN-CR-4", "a note mid-implementation", "user");

    expect(await persistedStatus("FN-CR-4")).not.toBe("needs-replan");
  });

  it("does NOT re-triage on a non-user comment", async () => {
    /* The author gate is orthogonal to the vocabulary and must survive the conversion. */
    const wf = await seedRenamedWorkflow();
    await seedPlannedTask("FN-CR-5", "queued", { workflowId: wf });

    await h.store().addComment("FN-CR-5", "agent progress note", "agent");

    expect(await persistedStatus("FN-CR-5")).not.toBe("needs-replan");
  });

  it("still re-triages a default-vocabulary card in `todo` (regression floor)", async () => {
    await seedPlannedTask("FN-CR-6", "todo");

    await h.store().addComment("FN-CR-6", "please adjust", "user");

    expect(await persistedStatus("FN-CR-6")).toBe("needs-replan");
  });
});
