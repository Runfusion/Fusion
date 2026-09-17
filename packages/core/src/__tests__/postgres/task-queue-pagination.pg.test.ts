/*
FNXC:TaskQueueOrder 2026-09-17-13:51:
FN-509 — the lane-scoped board page against a REAL PostgreSQL database.

WHAT ONLY A DATABASE CAN PROVE. The whole point of putting the queue rank in SQL is that the order
is applied BEFORE the `LIMIT`. A fake store sorts an array it already holds entirely, so it cannot
distinguish a correct implementation from one that truncates first and sorts the remainder — which
is exactly the defect this file exists to catch. The cases below therefore always create more cards
than the page size and assert on the HEAD of the first page.

The keyset walk is proven by exhaustion: every page is collected and compared to the complete
expected order, so a gap or a duplicate fails rather than hiding inside an unread page.
*/
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { resolveTaskColumnEntryAt } from "../../tasks/task-queue-order.js";
import type { Task } from "../../types.js";

const pgTest = pgDescribe;

pgTest("Lane-scoped board pagination (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_queue_page",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seed(count: number, column: string): Promise<Task[]> {
    const created: Task[] = [];
    for (let index = 0; index < count; index++) {
      const task = await h.store().createTask({ description: `${column}-${index}` });
      created.push(column === task.column ? task : await h.store().moveTask(task.id, column as never));
    }
    return created;
  }

  /** Walk every page of one lane and return the ids in the order the server returned them. */
  async function walk(columns: string[], order: "queue" | "intake", limit: number): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await h.store().listTaskQueuePage({ columns, order, limit, ...(cursor ? { cursor } : {}) });
      ids.push(...page.tasks.map((task) => task.id));
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return ids;
  }

  it("brings a boosted card beyond the page limit to the head of the first page", async () => {
    const store = h.store();
    const tasks = await seed(12, "todo");
    const late = tasks.at(-1)!;

    const firstPageBefore = await store.listTaskQueuePage({ columns: ["todo"], order: "queue", limit: 3 });
    expect(firstPageBefore.tasks.map((task) => task.id)).not.toContain(late.id);

    const boosted = await store.boostTask(late.id, {
      requestId: "req-late",
      workflowId: "builtin:coding",
      expectedColumn: late.column,
      expectedColumnEntryAt: resolveTaskColumnEntryAt(late),
    });
    expect(boosted.ok).toBe(true);

    const firstPageAfter = await store.listTaskQueuePage({ columns: ["todo"], order: "queue", limit: 3 });
    expect(firstPageAfter.tasks[0]?.id).toBe(late.id);
    // The rest of the page is still plain arrival order behind the boosted head.
    expect(firstPageAfter.tasks.slice(1).map((task) => task.id)).toEqual(tasks.slice(0, 2).map((task) => task.id));
    expect(firstPageAfter.total).toBe(12);
  });

  it("puts the latest boost ahead of an earlier one, then arrival order behind both", async () => {
    const store = h.store();
    const tasks = await seed(6, "todo");
    const boost = async (task: Task, requestId: string) => store.boostTask(task.id, {
      requestId,
      workflowId: "builtin:coding",
      expectedColumn: task.column,
      expectedColumnEntryAt: resolveTaskColumnEntryAt(task),
    });

    await boost(tasks[4]!, "req-a");
    await boost(tasks[5]!, "req-b");

    const page = await store.listTaskQueuePage({ columns: ["todo"], order: "queue", limit: 6 });
    expect(page.tasks.map((task) => task.id)).toEqual([
      tasks[5]!.id,
      tasks[4]!.id,
      tasks[0]!.id,
      tasks[1]!.id,
      tasks[2]!.id,
      tasks[3]!.id,
    ]);
  });

  it("serves a manual-capture lane newest-first, so a recent card is on the first page", async () => {
    const store = h.store();
    const tasks = await seed(9, "todo");
    const newest = tasks.at(-1)!;

    const page = await store.listTaskQueuePage({ columns: ["todo"], order: "intake", limit: 4 });
    expect(page.tasks[0]?.id).toBe(newest.id);
    expect(page.tasks.map((task) => task.id)).toEqual([...tasks].reverse().slice(0, 4).map((task) => task.id));
  });

  it("walks every page without a gap or a duplicate, in both orders", async () => {
    const store = h.store();
    const tasks = await seed(11, "todo");
    await store.boostTask(tasks[7]!.id, {
      requestId: "req-mid",
      workflowId: "builtin:coding",
      expectedColumn: tasks[7]!.column,
      expectedColumnEntryAt: resolveTaskColumnEntryAt(tasks[7]!),
    });

    const expectedQueue = [tasks[7]!.id, ...tasks.filter((task) => task.id !== tasks[7]!.id).map((task) => task.id)];
    const walked = await walk(["todo"], "queue", 3);
    expect(walked).toEqual(expectedQueue);
    expect(new Set(walked).size).toBe(walked.length);

    const walkedIntake = await walk(["todo"], "intake", 4);
    expect(walkedIntake).toEqual([...tasks].reverse().map((task) => task.id));
    expect(new Set(walkedIntake).size).toBe(walkedIntake.length);
  });

  it("keeps lanes independent and refuses a cursor minted for another lane or order", async () => {
    const store = h.store();
    await seed(4, "todo");
    // The WIP lane enforces its own capacity, so this scope is deliberately small.
    const working = await seed(2, "in-progress");

    const workingPage = await store.listTaskQueuePage({ columns: ["in-progress"], order: "intake", limit: 1 });
    expect(workingPage.total).toBe(2);
    expect(workingPage.tasks.every((task) => task.column === "in-progress")).toBe(true);
    expect(workingPage.tasks[0]?.id).toBe(working.at(-1)!.id);
    expect(workingPage.nextCursor).toBeTruthy();

    // A continuation belongs to ONE (lane, order) total order; replaying it elsewhere would
    // interleave two different orders and silently skip or repeat rows.
    await expect(store.listTaskQueuePage({ columns: ["todo"], order: "intake", limit: 1, cursor: workingPage.nextCursor! }))
      .rejects.toThrow(TypeError);
    await expect(store.listTaskQueuePage({ columns: ["in-progress"], order: "queue", limit: 1, cursor: workingPage.nextCursor! }))
      .rejects.toThrow(TypeError);
    await expect(store.listTaskQueuePage({ columns: ["in-progress"], order: "intake", limit: 1, cursor: "not-a-cursor" }))
      .rejects.toThrow(TypeError);
  });

  it("returns an empty page for an empty scope without touching the database", async () => {
    const page = await h.store().listTaskQueuePage({ columns: [], order: "queue", limit: 10 });
    expect(page).toEqual({ tasks: [], total: 0, hasMore: false, nextCursor: null });
  });
});
