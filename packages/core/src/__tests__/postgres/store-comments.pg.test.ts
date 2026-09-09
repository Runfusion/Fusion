/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of the comments subset of store-comments.test.ts.
 *
 * Exercises the backend-mode (asyncLayer) path for:
 *   - addTaskComment / updateTaskComment / deleteTaskComment (CRUD)
 *   - addComment (steering comment + refinement task creation on done tasks)
 *   - addSteeringComment (writes to both comments and steeringComments)
 *   - comment deduplication across read-write cycles (FN-5xxx invariant)
 *
 * The original SQLite test remains until SQLite is fully removed; this PG
 * twin is auto-skipped in CI without PostgreSQL (pgDescribe).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildRefinementSeedPrompt } from "../../mesh/mesh-task-replication.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore comments CRUD (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_comments",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("adds a task comment to a task", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "comment target" });
    const updated = await store.addTaskComment(task.id, "Please review this", "alice");

    expect(updated.comments).toHaveLength(1);
    expect(updated.comments![0].text).toBe("Please review this");
    expect(updated.comments![0].author).toBe("alice");
    expect(updated.comments![0].id).toBeDefined();
    expect(updated.comments![0].createdAt).toBeDefined();
    expect(updated.comments![0].updatedAt).toBeDefined();
  });

  it("updates an existing task comment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "update comment" });
    const added = await store.addTaskComment(task.id, "First draft", "alice");
    const commentId = added.comments![0].id;

    const updated = await store.updateTaskComment(task.id, commentId, "Updated draft");

    expect(updated.comments).toHaveLength(1);
    expect(updated.comments![0].text).toBe("Updated draft");
    expect(updated.comments![0].updatedAt).toBeDefined();
  });

  it("deletes a task comment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "delete comment" });
    const added = await store.addTaskComment(task.id, "Disposable", "alice");
    const commentId = added.comments![0].id;

    const updated = await store.deleteTaskComment(task.id, commentId);

    expect(updated.comments).toBeUndefined();
  });

  it("throws when updating a missing task comment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "missing update" });

    await expect(store.updateTaskComment(task.id, "missing", "Nope")).rejects.toThrow(
      `Comment missing not found on task ${task.id}`,
    );
  });

  it("throws when deleting a missing task comment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "missing delete" });

    await expect(store.deleteTaskComment(task.id, "missing")).rejects.toThrow(
      `Comment missing not found on task ${task.id}`,
    );
  });

  it("persists all comments in unified comments field", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "unified" });
    await store.addTaskComment(task.id, "General note", "alice");
    await store.addComment(task.id, "Execution note");

    const reopened = await store.getTask(task.id);
    expect(reopened.comments).toHaveLength(2);
    expect(reopened.comments![0].text).toBe("General note");
    expect(reopened.comments![1].text).toBe("Execution note");
  });
});

pgTest("TaskStore addComment steering + refinement (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_steering",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-17:55 (batch-core):

  AUTO-REFINEMENT MUST FIRE FOR A TASK FINISHED IN A RENAMED COMPLETE LANE.

  A user comment on finished work creates a refinement task. Keyed on `task.column === "done"`, a
  renamed board never entered that branch — the operator got silence where the feature promises a
  follow-up, and nothing was logged because the branch was not reached rather than failing inside it.

  Driven through the real store and a real workflow definition so the assertion is on an OBSERVED
  refinement row, not on my own belief about what the resolver returns for a renamed lineage.
  */
  it("creates a refinement for a user comment on a task in a RENAMED complete lane", async () => {
    const store = h.store();
    const definition = await store.createWorkflowDefinition({
      name: "renamed-complete",
      ir: {
        version: "v2",
        name: "renamed-complete",
        columns: [
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "building" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);
    const task = await store.createTask({ description: "finished on a renamed board", workflowId: definition.id } as never);
    await store.moveTask(task.id, "shipped" as never, { bypassGuards: true } as never);

    const before = (await store.listTasks({ slim: true } as never)).length;
    await store.addComment(task.id, "please also handle the empty case", "user" as never);

    /*
    The witness is a NEW task existing, not a mock call: `refineTask` creates the follow-up, and
    asserting on the row proves the branch ran end to end rather than that a spy was invoked.
    */
    const after = await store.listTasks({ slim: true } as never);
    expect(after.length).toBe(before + 1);
    expect(after.some((t: { description?: string }) => (t.description ?? "").includes("empty case"))).toBe(true);
  });

  /*
  FNXC:RefinementPlanningRouting 2026-08-23-17:20:
  A refinement's workflow comes from the project's refinement ORIGIN selection (pinned
  `refinementTaskWorkflowId`, else the mirrored Board lane, else the project default) — never from
  the source card's workflow (FN-8188 / FNXC:OriginWorkflowSelection in `refineTaskImpl`). Setting
  the source's `workflowId` alone therefore produced a `builtin:coding` child, so this case proved
  nothing about the Coding (Ideas) manual-intake bypass it is named for: the child landed in `todo`
  because that is `builtin:coding`'s intake. Pin the refinement origin so the child really is a
  Coding (Ideas) card and "manual intake (`ideas`) is bypassed for the Planning hold (`todo`)" is
  the assertion actually under test.
  */
  it("routes a user comment refinement from Coding (Ideas) to Planning", async () => {
    const store = h.store();
    await store.updateSettings({ refinementTaskWorkflowId: "builtin:coding-ideas-v2" } as never);
    const source = await store.createTask({
      title: "Ideas comment source",
      description: "Completed Coding (Ideas) work",
      workflowId: "builtin:coding-ideas-v2",
      column: "done",
    } as never);
    const before = await store.listTasks({ slim: true } as never);

    await store.addComment(source.id, "Please make the empty state actionable", "user");

    const after = await store.listTasks({ slim: true } as never);
    const children = after.filter((task: { sourceParentTaskId?: string }) => task.sourceParentTaskId === source.id);
    expect(after.length).toBe(before.length + 1);
    expect(children).toHaveLength(1);
    const child = await store.getTask(children[0].id);
    const prompt = await readFile(join(store.taskDir(child.id), "PROMPT.md"), "utf8");
    expect(child.column).toBe("todo");
    expect(child.column).not.toBe("ideas");
    expect(child.dependencies).toEqual([source.id]);
    expect(await store.getTaskWorkflowSelectionAsync(child.id)).toMatchObject({ workflowId: "builtin:coding-ideas-v2" });
    expect(prompt).toBe(buildRefinementSeedPrompt(child.title ?? child.id, child.description));

    const beforeAgentComment = (await store.listTasks({ slim: true } as never)).length;
    await store.addComment(source.id, "Agent status update", "agent");
    expect((await store.listTasks({ slim: true } as never)).length).toBe(beforeAgentComment);
  });

  it("adds a steering comment and persists it", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "steering target" });
    const updated = await store.addComment(task.id, "Please handle the edge case");

    expect(updated.comments).toHaveLength(1);
    expect(updated.comments![0].text).toBe("Please handle the edge case");
    expect(updated.comments![0].author).toBe("user");
    expect(updated.comments![0].id).toBeDefined();
    expect(updated.comments![0].createdAt).toBeDefined();
  });

  it("appends multiple comments in order", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "order" });
    await store.addComment(task.id, "First comment");
    await store.addComment(task.id, "Second comment");
    await store.addComment(task.id, "Third comment");

    const fetched = await store.getTask(task.id);
    expect(fetched.comments).toHaveLength(3);
    expect(fetched.comments![0].text).toBe("First comment");
    expect(fetched.comments![1].text).toBe("Second comment");
    expect(fetched.comments![2].text).toBe("Third comment");
  });

  it("generates unique IDs for each comment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "unique ids" });
    const updated1 = await store.addComment(task.id, "Comment 1");
    const updated2 = await store.addComment(task.id, "Comment 2");

    const id1 = updated1.comments![0].id;
    const id2 = updated2.comments![1].id;
    expect(id1).not.toBe(id2);
  });

  it("does not create refinement when steering comment added to non-done task", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "non-done" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });

    const allTasksBefore = await store.listTasks();

    await store.addComment(task.id, "Some feedback");

    const allTasksAfter = await store.listTasks();
    expect(allTasksAfter).toHaveLength(allTasksBefore.length);
  });

  // NOTE: The "creates refinement task when steering comment added to done
  // task" and "does not create refinement for agent-authored comments" cases
  // are intentionally omitted from this PG twin. The refineTask() backend-mode
  // path is a known gap (it relies on PROMPT.md filesystem parsing + reserved-id
  // creation that has partial backend wiring). The SQLite test covers that path;
  // this PG twin covers the comment CRUD + persistence invariants that ARE
  // fully wired in backend mode.
});

pgTest("TaskStore addSteeringComment (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_add_steering",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("writes to both comments and steeringComments", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "steering both" });

    const updated = await store.addSteeringComment(task.id, "Focus on error handling");

    expect(updated.comments).toBeDefined();
    expect(updated.comments!.some((c) => c.text === "Focus on error handling")).toBe(true);

    expect(updated.steeringComments).toBeDefined();
    expect(updated.steeringComments!.some((c) => c.text === "Focus on error handling")).toBe(true);
  });

  it("steeringComments persist through round-trip", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "persist steering" });

    await store.addSteeringComment(task.id, "Focus on error handling");

    const fetched = await store.getTask(task.id);
    expect(fetched.steeringComments).toBeDefined();
    expect(fetched.steeringComments!).toHaveLength(1);
    expect(fetched.steeringComments![0].text).toBe("Focus on error handling");
  });

  it("steering comments do not duplicate in comments across read-write cycle", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "no dup" });

    await store.addSteeringComment(task.id, "Focus on error handling");

    const read1 = await store.getTask(task.id);
    expect(read1.comments).toHaveLength(1);
    expect(read1.steeringComments).toHaveLength(1);

    await store.updateTask(task.id, { status: "planning" });

    const read2 = await store.getTask(task.id);
    expect(read2.comments).toHaveLength(1);
    expect(read2.comments![0].text).toBe("Focus on error handling");
  });

  it("no duplication accumulation over multiple read-write cycles", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "multi-cycle" });

    await store.addSteeringComment(task.id, "Comment A");
    await store.addSteeringComment(task.id, "Comment B");

    for (let i = 0; i < 5; i++) {
      const fetched = await store.getTask(task.id);
      expect(fetched.comments).toHaveLength(2);
      expect(fetched.steeringComments).toHaveLength(2);
      await store.updateTask(task.id, { status: "planning" });
    }

    const final = await store.getTask(task.id);
    expect(final.comments).toHaveLength(2);
    expect(final.comments!.map((c) => c.text).sort()).toEqual(["Comment A", "Comment B"]);
  });

  /*
  FNXC:PostCommentRetriage 2026-07-30-00:20 (renamed intake column):
  #2608 fixed the awaiting-approval invalidation by dropping the INNER column re-checks, keeping the
  outer caller gate as `column === "todo" || column === "triage"` on the grounds that it "covers BOTH
  vocabularies".

  It covers both LEGACY vocabularies. It does not cover a RENAMED one. `builtin:coding-ideas-v2` places
  its intake in `ideas`, which matches neither literal, so an operator comment on an Ideas card
  awaiting spec approval still invalidates nothing: the approval stands and the task proceeds on the
  spec the operator was correcting. Same defect as the reported one, one workflow over.

  The caller DOES have what it needs to ask (`store` + `id`), so the gate resolves the intake/hold
  roles rather than listing ids.
  */
  it("invalidates approval on a RENAMED intake column (Coding (Ideas) → \"ideas\")", async () => {
    const store = h.store();
    const task = await store.createTask({
      description: "ideas awaiting approval",
      workflowId: "builtin:coding-ideas-v2",
    });
    expect(task.column, "Ideas' intake role is `ideas` — matching neither legacy literal").toBe("ideas");
    await store.updateTask(task.id, { status: "awaiting-approval" });

    await store.addTaskComment(task.id, "Narrow this to the import path only", "user");

    const after = await store.getTask(task.id);
    expect(
      after.status,
      "a renamed intake column must invalidate the approval too, not leave it standing",
    ).not.toBe("awaiting-approval");
  });

  it("re-triages an already-planned card in the hold column when the operator comments", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "planned card needing respec" });
    await store.moveTask(task.id, "todo");
    // A real (non-bootstrap) PROMPT.md is what distinguishes "planned" from "not yet specified".
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(
      join(store.taskDir(task.id), "PROMPT.md"),
      `# ${task.id}\n\n## Context\nA real planned spec.\n\n## Steps\n1. Do the thing\n`,
      "utf-8",
    );

    await store.addTaskComment(task.id, "The approach changed — replan this", "user");

    const after = await store.getTask(task.id);
    expect(after.status, "a planned hold-column card must be re-specified").toBe("needs-replan");
  });

  it("does NOT re-triage when the comment is not from the user", async () => {
    // The role conversion must not widen the gate to non-user authors.
    const store = h.store();
    const task = await store.createTask({ description: "agent comment target" });
    await store.moveTask(task.id, "todo");
    await store.updateTask(task.id, { status: "awaiting-approval" });

    await store.addTaskComment(task.id, "progress note from the agent", "agent");

    const after = await store.getTask(task.id);
    expect(after.status, "an agent comment must not invalidate the operator's approval").toBe("awaiting-approval");
  });
});
