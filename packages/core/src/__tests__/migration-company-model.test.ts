// @vitest-environment node
//
// Company-model U1: persisted Board entity + universal lanes→boards migration
// (v114). Proves the U1 plan scenarios:
//   - Fresh DB has the boards table + tasks.boardId.
//   - Seed-at-v113: two workflows-in-use migrate to two boards, tasks homed, no
//     task ids rewritten, non-triage default-board columns untouched.
//   - SCHEMA_VERSION equals the highest applyMigration target (regex over db.ts).
//   - Triage remap: a triage task with planning status lands in todo, status kept.
//   - Null selection → default board; dangling selection → default board;
//     same-workflow duplicate selections collapse to one board.
//   - Conform-on-migrate: a custom 3-column workflow maps onto the template, the
//     extra column is carried, and the rewrites are recorded in the audit.
//   - Idempotency: re-running the migration body changes nothing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function customIr(name: string, cols: Array<{ id: string; traits: string[] }>): WorkflowIr {
  return {
    version: "v2",
    name,
    columns: cols.map((c) => ({ id: c.id, name: c.id, traits: c.traits.map((trait) => ({ trait })) })),
    nodes: [
      { id: "start", kind: "start", column: cols[0].id },
      { id: "work", kind: "prompt", column: cols[1]?.id ?? cols[0].id, config: { prompt: "do" } },
      { id: "end", kind: "end", column: cols[cols.length - 1].id },
    ],
    edges: [
      { from: "start", to: "work", condition: "success" },
      { from: "work", to: "end", condition: "success" },
    ],
  };
}

type RawDb = {
  prepare: (s: string) => {
    run: (...a: unknown[]) => unknown;
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
  init: () => void;
};

function rawDb(store: ReturnType<ReturnType<typeof createTaskStoreTestHarness>["store"]>): RawDb {
  return (store as unknown as { db: RawDb }).db;
}

/**
 * Simulate a DB seeded at v113 (pre-board): null every task's boardId, drop the
 * boards rows, and reset the stored schema version to 113. A subsequent
 * `db.init()` re-runs SCHEMA_SQL (boards table already present — no-op) then the
 * v114 migration body, which homes the nulled tasks and converts the lanes.
 */
function rewindToV113AndMigrate(db: RawDb): void {
  db.prepare(`UPDATE tasks SET boardId = NULL`).run();
  db.prepare(`DELETE FROM boards`).run();
  db.prepare(`UPDATE __meta SET value = '113' WHERE key = 'schemaVersion'`).run();
  db.init();
}

describe("U1 migration — fresh DB shape", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  it("a fresh DB has the boards table and tasks.boardId", () => {
    const db = rawDb(store);
    const boardsTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='boards'`)
      .get() as { name: string } | undefined;
    expect(boardsTable?.name).toBe("boards");

    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "boardId")).toBe(true);
  });
});

describe("U1 migration — SCHEMA_VERSION invariant", () => {
  it("SCHEMA_VERSION equals the highest applyMigration target", () => {
    const src = readFileSync(join(__dirname, "..", "db.ts"), "utf8");
    const versionMatch = src.match(/const SCHEMA_VERSION = (\d+);/);
    expect(versionMatch).toBeTruthy();
    const declared = Number(versionMatch![1]);

    const targets = [...src.matchAll(/applyMigration\((\d+),/g)].map((m) => Number(m[1]));
    const highest = Math.max(...targets);
    expect(declared).toBe(highest);
  });
});

describe("U1 migration — seed-at-v113 conversion", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  it("two workflows-in-use migrate to two boards; tasks homed; no task ids rewritten; non-triage default columns untouched", async () => {
    // Default-workflow task (no selection) sitting in in-progress.
    const def = await store.createTask({ description: "default-lane" });
    await store.moveTask(def.id, "todo", { moveSource: "user" });
    await store.moveTask(def.id, "in-progress", { moveSource: "user" });

    // A custom workflow with a task selected onto it.
    const wf = await store.createWorkflowDefinition({
      name: "Content",
      ir: customIr("Content", [
        { id: "intake", traits: ["intake"] },
        { id: "writing", traits: ["wip"] },
        { id: "shipped", traits: ["complete"] },
      ]),
    });
    const custom = await store.createTask({ description: "custom-lane" });
    await store.selectTaskWorkflowAndReconcile(custom.id, wf.id);

    const idsBefore = (rawDb(store).prepare(`SELECT id FROM tasks ORDER BY id`).all() as Array<{ id: string }>)
      .map((r) => r.id);
    const defColBefore = (await store.getTask(def.id)).column;

    rewindToV113AndMigrate(rawDb(store));

    // Two boards: default (builtin:coding) + the custom workflow.
    const boards = store.getBoardStore().listBoards();
    expect(boards.length).toBe(2);
    expect(boards.map((b) => b.workflowId).sort()).toEqual([wf.id, "builtin:coding"].sort());

    // Tasks homed onto the right boards.
    const defBoardId = store.getTaskBoardId(def.id)!;
    const customBoardId = store.getTaskBoardId(custom.id)!;
    expect(store.getBoardWorkflowId(defBoardId)).toBe("builtin:coding");
    expect(store.getBoardWorkflowId(customBoardId)).toBe(wf.id);

    // No task ids rewritten.
    const idsAfter = (rawDb(store).prepare(`SELECT id FROM tasks ORDER BY id`).all() as Array<{ id: string }>)
      .map((r) => r.id);
    expect(idsAfter).toEqual(idsBefore);

    // Non-triage default-board column untouched.
    expect((await store.getTask(def.id)).column).toBe(defColBefore);
    expect((await store.getTask(def.id)).column).toBe("in-progress");
  });

  it("triage remap: a triage task with planning status lands in todo, retaining status and session linkage", async () => {
    const triaged = await store.createTask({ description: "mid-spec" });
    // Force the stored column + status out-of-band: triage with a planning status.
    rawDb(store).prepare(`UPDATE tasks SET "column" = 'triage', status = 'planning' WHERE id = ?`).run(triaged.id);

    rewindToV113AndMigrate(rawDb(store));

    const after = await store.getTask(triaged.id);
    expect(after.column).toBe("todo");
    expect(after.status).toBe("planning");
    // Homed on the default board.
    expect(store.getBoardWorkflowId(store.getTaskBoardId(triaged.id)!)).toBe("builtin:coding");
  });

  it("null selection → default board; dangling selection → default board; duplicate same-workflow selections collapse to one board", async () => {
    // Null selection (no workflow chosen).
    const nullSel = await store.createTask({ description: "null-sel" });

    // Two tasks selecting the SAME custom workflow → one board.
    const wf = await store.createWorkflowDefinition({
      name: "Shared",
      ir: customIr("Shared", [
        { id: "intake", traits: ["intake"] },
        { id: "doing", traits: ["wip"] },
        { id: "fin", traits: ["complete"] },
      ]),
    });
    const dupA = await store.createTask({ description: "dup-a" });
    const dupB = await store.createTask({ description: "dup-b" });
    await store.selectTaskWorkflowAndReconcile(dupA.id, wf.id);
    await store.selectTaskWorkflowAndReconcile(dupB.id, wf.id);

    // Dangling selection: a selection row whose workflowId no longer resolves.
    const dangling = await store.createTask({ description: "dangling" });
    rawDb(store)
      .prepare(
        `INSERT OR REPLACE INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt) VALUES (?, ?, '[]', ?)`,
      )
      .run(dangling.id, "ghost-workflow-id", new Date().toISOString());

    rewindToV113AndMigrate(rawDb(store));

    const boards = store.getBoardStore().listBoards();
    // Exactly two boards: default + the one shared custom workflow (no duplicate,
    // no orphan board for the dangling id).
    expect(boards.length).toBe(2);
    expect(boards.map((b) => b.workflowId).sort()).toEqual([wf.id, "builtin:coding"].sort());

    // Null + dangling both land on the default board.
    expect(store.getBoardWorkflowId(store.getTaskBoardId(nullSel.id)!)).toBe("builtin:coding");
    expect(store.getBoardWorkflowId(store.getTaskBoardId(dangling.id)!)).toBe("builtin:coding");

    // Duplicate selections collapse to one board.
    expect(store.getTaskBoardId(dupA.id)).toBe(store.getTaskBoardId(dupB.id));
    expect(store.getBoardWorkflowId(store.getTaskBoardId(dupA.id)!)).toBe(wf.id);
  });

  it("conform-on-migrate: a custom 3-column workflow maps onto the template, carries the extra column, and records rewrites in the audit", async () => {
    // entry (intake) → todo, a custom "design" column carried, review → in-review.
    const wf = await store.createWorkflowDefinition({
      name: "Conform",
      ir: customIr("Conform", [
        { id: "inbox", traits: ["intake"] },
        { id: "design", traits: [] }, // unclassifiable → carried as custom (id kept)
        { id: "review", traits: ["merge-blocker"] },
      ]),
    });
    // One task per source column so every conform mapping is exercised.
    const tEntry = await store.createTask({ description: "at-entry" });
    const tDesign = await store.createTask({ description: "at-design" });
    const tReview = await store.createTask({ description: "at-review" });
    for (const t of [tEntry, tDesign, tReview]) {
      await store.selectTaskWorkflowAndReconcile(t.id, wf.id);
    }
    // Force their stored columns to the workflow's column ids.
    rawDb(store).prepare(`UPDATE tasks SET "column" = 'inbox' WHERE id = ?`).run(tEntry.id);
    rawDb(store).prepare(`UPDATE tasks SET "column" = 'design' WHERE id = ?`).run(tDesign.id);
    rawDb(store).prepare(`UPDATE tasks SET "column" = 'review' WHERE id = ?`).run(tReview.id);

    rewindToV113AndMigrate(rawDb(store));

    // entry → todo, review → in-review, design carried (id unchanged).
    expect((await store.getTask(tEntry.id)).column).toBe("todo");
    expect((await store.getTask(tReview.id)).column).toBe("in-review");
    expect((await store.getTask(tDesign.id)).column).toBe("design");

    // The rewrites are recorded in the audit (persisted, not stdout).
    const audits = rawDb(store)
      .prepare(`SELECT taskId, metadata FROM runAuditEvents WHERE mutationType = 'board:column-conform'`)
      .all() as Array<{ taskId: string; metadata: string }>;
    const byTask = new Map(audits.map((a) => [a.taskId, JSON.parse(a.metadata) as { fromColumn: string; toColumn: string }]));
    expect(byTask.get(tEntry.id)).toMatchObject({ fromColumn: "inbox", toColumn: "todo" });
    expect(byTask.get(tReview.id)).toMatchObject({ fromColumn: "review", toColumn: "in-review" });
    // The carried column is NOT rewritten → no audit entry.
    expect(byTask.has(tDesign.id)).toBe(false);
  });

  it("idempotency: re-running the migration body on a converted DB changes nothing", async () => {
    const def = await store.createTask({ description: "idem-default" });
    await store.moveTask(def.id, "todo", { moveSource: "user" });
    const wf = await store.createWorkflowDefinition({
      name: "Idem",
      ir: customIr("Idem", [
        { id: "intake", traits: ["intake"] },
        { id: "doing", traits: ["wip"] },
        { id: "fin", traits: ["complete"] },
      ]),
    });
    const custom = await store.createTask({ description: "idem-custom" });
    await store.selectTaskWorkflowAndReconcile(custom.id, wf.id);

    rewindToV113AndMigrate(rawDb(store));

    const snapshot = () => ({
      boards: (rawDb(store).prepare(`SELECT id, workflowId, ordering FROM boards ORDER BY ordering`).all() as unknown[]),
      tasks: (rawDb(store).prepare(`SELECT id, "column" AS col, boardId FROM tasks ORDER BY id`).all() as unknown[]),
      audits: (rawDb(store).prepare(`SELECT COUNT(*) AS c FROM runAuditEvents`).get() as { c: number }).c,
    });
    const before = JSON.stringify(snapshot());

    // Re-run the v114 body directly (boards present, boardIds set) — no-op.
    rawDb(store).prepare(`UPDATE __meta SET value = '113' WHERE key = 'schemaVersion'`).run();
    rawDb(store).init();

    expect(JSON.stringify(snapshot())).toBe(before);
  });
});
