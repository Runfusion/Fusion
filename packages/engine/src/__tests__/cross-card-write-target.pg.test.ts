/**
 * RUFU-281 symptom acceptance against a real store: two live cards, real rows, real persisted artifacts.
 *
 * FNXC:CrossCardWriteAuth 2026-09-24-01:20:
 * The fake-store sweep (`write-target-conformance.test.ts`) proves WHICH store seam a tool reaches. This file
 * proves the same contract on persisted state read back through the store, because the damage in the RUFU-275
 * incident was bytes on the wrong card and, for a refusal, the absence of bytes on the named card. Lanes are
 * chosen by what a real store can show after the call: task documents and PROMPT.md hydrate through the store
 * in backend mode, so honour and refusal are both asserted as persisted state here. Agent-log entries are NOT
 * readable back through `getAgentLogs` in the PG harness even from a direct `store.logEntry` call (measured in
 * this task: 0 entries for a freshly written log line), so the log lane's honour is pinned by the sweep's
 * store-write assertion instead of a false persisted-state claim here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { TaskStore } from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createTaskDocumentWriteTool,
  createTaskPromptWriteTool,
  createTaskUpdateTool,
} from "../agent-tools.js";

pgDescribe("cross-card write target acceptance (real store)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_rufu281_write_target",
    poolMax: 3,
    projectId: "rufu281-write-target",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** The two cards of the incident: the card the session is bound to, and a different real card. */
  async function twoCards(store: TaskStore) {
    const bound = await store.createTask({ description: "card the session is bound to" });
    const other = await store.createTask({ description: "card named by a supplied task_id" });
    return { bound, other };
  }

  it("fn_task_document_write stores the document on the card the caller named, leaving the bound card with none", async () => {
    const store = h.store();
    const { bound, other } = await twoCards(store);

    const result = await createTaskDocumentWriteTool(store, bound.id).execute!("c1", {
      key: "notes",
      content: "written across cards on purpose",
      task_id: other.id,
    });

    expect(result.isError, "an honouring tool must not error on a named foreign card").toBeFalsy();
    const onTarget = await store.getTaskDocument(other.id, "notes");
    expect(onTarget?.content, "the named card must hold the document").toBe("written across cards on purpose");
    // The RUFU-275 assertion: the pre-fix tools returned success while writing HERE instead of there.
    expect(await store.getTaskDocument(bound.id, "notes"), "the bound card must hold nothing").toBeNull();
  });

  it("fn_task_document_write with no named target stores only on the bound card (the control that keeps the honour test honest)", async () => {
    const store = h.store();
    const { bound, other } = await twoCards(store);

    await createTaskDocumentWriteTool(store, bound.id).execute!("c2", { key: "notes", content: "in-scope note" });

    expect((await store.getTaskDocument(bound.id, "notes"))?.content).toBe("in-scope note");
    expect(await store.getTaskDocument(other.id, "notes")).toBeNull();
  });

  it("fn_task_prompt_write refuses a foreign card, names the bound card as the authority, and changes neither card's PROMPT.md", async () => {
    const store = h.store();
    const { bound, other } = await twoCards(store);
    // A card created from a description already carries a generated PROMPT.md, so "zero bytes" is asserted as
    // no delta from the pre-call baseline rather than as emptiness.
    const boundPromptBefore = (await store.getTask(bound.id)).prompt;
    const otherPromptBefore = (await store.getTask(other.id)).prompt;

    const result = await createTaskPromptWriteTool(store, bound.id).execute!("c3", {
      content: "# replaced spec\n\nThis spec belongs to the other card.",
      task_id: other.id,
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      writeTarget: "refused",
      refusalCode: "cross-card-target",
      toolName: "fn_task_prompt_write",
      boundTaskId: bound.id,
      requestedTaskId: other.id,
    });
    // The operator-facing sentence names the card the caller asked for, so the failure is diagnosable.
    expect(result.content[0]?.text).toContain(other.id);

    expect((await store.getTask(other.id)).prompt, "the named card must be untouched").toBe(otherPromptBefore);
    expect((await store.getTask(bound.id)).prompt, "a refusal must not fall back to the bound card").toBe(boundPromptBefore);
  });

  it("fn_task_prompt_write writes the bound card when the named target IS the bound card (the refusal's non-vacuity control)", async () => {
    const store = h.store();
    const { bound, other } = await twoCards(store);
    const content = "# bound card spec\n\nWritten through the seam by the bound session.";

    const explicitSelf = await createTaskPromptWriteTool(store, bound.id).execute!("c4-self", {
      content,
      task_id: bound.id,
    });
    expect(explicitSelf.isError).toBeFalsy();
    expect((await store.getTask(bound.id)).prompt).toBe(content);
    expect((await store.getTask(other.id)).prompt, "honouring the bound card must leave the other card alone").not.toBe(content);

    const omittedTarget = await createTaskPromptWriteTool(store, bound.id).execute!("c4-omitted", {
      content: "# replaced by the bound session\n\nAn omitted target still writes the bound card.",
    });
    expect(omittedTarget.isError).toBeFalsy();
    expect((await store.getTask(bound.id)).prompt).toContain("An omitted target still writes the bound card.");
  });

  it("fn_task_update refuses a foreign card without moving either card's row", async () => {
    const store = h.store();
    const { bound, other } = await twoCards(store);
    const targetBefore = await store.getTask(other.id);
    const boundBefore = await store.getTask(bound.id);

    const result = await createTaskUpdateTool(store, bound.id).execute!("c5", {
      step: 0,
      status: "done",
      summary: "not mine to complete",
      task_id: other.id,
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ refusalCode: "cross-card-target", boundTaskId: bound.id });

    const targetAfter = await store.getTask(other.id);
    expect(targetAfter.column).toBe(targetBefore.column);
    expect(targetAfter.status).toBe(targetBefore.status);
    const boundAfter = await store.getTask(bound.id);
    expect(boundAfter.column, "the bound card must not be used as the fallback target").toBe(boundBefore.column);
    expect(boundAfter.status).toBe(boundBefore.status);
  });

  it("refuses a target spelled two ways that disagree, and stores nothing on either card", async () => {
    const store = h.store();
    const { bound, other } = await twoCards(store);

    const result = await createTaskDocumentWriteTool(store, bound.id).execute!("c6", {
      key: "notes",
      content: "which card did I mean?",
      task_id: other.id,
      id: "RUFU-999",
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ refusalCode: "conflicting-targets", boundTaskId: bound.id });
    expect(await store.getTaskDocument(other.id, "notes")).toBeNull();
    expect(await store.getTaskDocument(bound.id, "notes")).toBeNull();
  });

  it("classifies a target that cannot name a card as unsafe rather than resolving it to one", async () => {
    const store = h.store();
    const { bound } = await twoCards(store);

    const result = await createTaskDocumentWriteTool(store, bound.id).execute!("c7", {
      key: "notes",
      content: "path-shaped target",
      task_id: "../../etc/passwd",
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ refusalCode: "unsafe-target-id", boundTaskId: bound.id });
    expect(await store.getTaskDocument(bound.id, "notes")).toBeNull();
  });
});
