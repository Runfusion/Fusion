/**
 * FNXC:ListTasksDeriveOptOut 2026-09-08-21:15 (RUFU-201):
 * Regression cover for the board-list derivation opt-out.
 *
 * A live 22-project instance showed 73.5% of all in-flight SQL statements spent on the
 * `task_workflow_selection` (31.8%) and `workflow_prompt_overrides` (41.7%, on an EMPTY table)
 * reads whose only producer is the per-row derived-signal block in `listTasksImpl`. Engine timer
 * consumers never read those badges, so every 15 s poll was re-deriving values nobody looked at.
 *
 * These tests pin both halves of the contract:
 *  - `derive: false` performs ZERO reads against the hot tables and sets NO derived field;
 *  - the default (`derive` omitted) keeps deriving every badge the board renders (board parity),
 *    which is what makes the baseline read-count assertion the load-bearing one.
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { Task } from "../../types.js";

const pgTest = pgDescribe;

/**
 * Every field the derivation block assigns in `listTasksImpl`. An opted-out row must carry NONE of
 * them — not even as an own property with an `undefined` value — so a consumer cannot mistake "we
 * derived it and found nothing" for "we never derived it".
 */
const DERIVED_FIELDS = [
  "inReviewStall",
  "stalePausedReview",
  "inReviewStalled",
  "stalePausedTodo",
  "ageStaleness",
  "stalledReview",
  "retrySummary",
  "stallReason",
  "reviewBypass",
  "timedExecutionMs",
] as const;

/** The store methods that read the two hot tables plus the workflow definition behind the IR cache. */
function instrumentDerivationReads(store: ReturnType<SharedPgTaskStoreHarness["store"]>) {
  const selectionBatched = { fn: store.getTaskWorkflowSelectionsAsync.bind(store) };
  const reads = {
    selectionBatched: 0,
    selectionSingles: 0,
    promptOverrides: 0,
    workflowDefinitions: 0,
  };
  store.getTaskWorkflowSelectionsAsync = async (ids) => {
    reads.selectionBatched += 1;
    return selectionBatched.fn(ids);
  };
  const singlesOrig = store.getTaskWorkflowSelectionAsync.bind(store);
  store.getTaskWorkflowSelectionAsync = async (id) => {
    reads.selectionSingles += 1;
    return singlesOrig(id);
  };
  const overridesOrig = store.getWorkflowPromptOverridesAsync.bind(store);
  store.getWorkflowPromptOverridesAsync = async (workflowId, projectId) => {
    reads.promptOverrides += 1;
    return overridesOrig(workflowId, projectId);
  };
  const definitionsOrig = store.getWorkflowDefinition.bind(store);
  store.getWorkflowDefinition = ((workflowId: string) => {
    reads.workflowDefinitions += 1;
    return definitionsOrig.call(store, workflowId);
  }) as typeof store.getWorkflowDefinition;
  return reads;
}

pgTest("listTasks derive opt-out (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_derive_optout",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  /**
   * Seeds one in-progress card with a real `log` payload (so the dropped projection is measurably
   * dropping bytes, not an already-empty column) and a PROMPT.md carrying authored step headings
   * (so the slim steps-from-PROMPT.md sync has something to resolve).
   */
  async function seedInProgressCard(taskId: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `RUFU-201 probe ${taskId}`, column: "in-progress" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    const timestamp = new Date().toISOString();
    await store.updateTask(taskId, {
      log: [
        { timestamp, action: "execution.started" },
        { timestamp, action: "step.completed", outcome: "success" },
      ],
    });
    const dir = store.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "PROMPT.md"),
      `# ${taskId}\n\n## Original Description\n\nProbe card.\n\n### Step 1: Read the probe\n\nBody.\n\n### Step 2: Write the answer\n\nBody.\n`,
      "utf-8",
    );
  }

  it("keeps deriving every board badge by default, reading the hot selection table", async () => {
    await seedInProgressCard("RUFU-9201");
    const store = h.store();
    const reads = instrumentDerivationReads(store);

    const rows = await store.listTasks({ column: "in-progress", slim: true, startupMemo: false });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // retrySummary is unconditionally derived and timedExecutionMs is derived for every slim row,
    // so they prove the block ran on this row without depending on threshold timing.
    expect(row.retrySummary).toBeDefined();
    expect(row.timedExecutionMs).toBeDefined();
    expect(row.log).toEqual([]);
    // The baseline that gives the zero-read assertion below its meaning: the derivation's
    // per-pass selection prefetch DOES hit `task_workflow_selection`.
    expect(reads.selectionBatched + reads.selectionSingles).toBeGreaterThan(0);
  });

  it("sets no derived field and issues zero selection/override reads when derive is false", async () => {
    await seedInProgressCard("RUFU-9202");
    const store = h.store();
    const reads = instrumentDerivationReads(store);
    // Records the SQL projection each row was parsed from, to pin the dropped `log` column.
    const parsedRowKeys: string[][] = [];
    const parseOriginal = store.pgRowToTaskRow.bind(store);
    store.pgRowToTaskRow = (pgRow) => {
      parsedRowKeys.push(Object.keys(pgRow as Record<string, unknown>));
      return parseOriginal(pgRow);
    };

    const rows = await store.listTasks({
      column: "in-progress",
      slim: true,
      derive: false,
      startupMemo: false,
    });

    expect(rows).toHaveLength(1);
    const row = rows[0] as Task;
    for (const field of DERIVED_FIELDS) {
      expect(
        Object.prototype.hasOwnProperty.call(row, field),
        `opted-out row must not carry derived field "${field}"`,
      ).toBe(false);
    }
    // Zero reads against the two tables that measured 73.5% of live in-flight statements.
    expect(reads.selectionBatched).toBe(0);
    expect(reads.selectionSingles).toBe(0);
    expect(reads.promptOverrides).toBe(0);
    expect(reads.workflowDefinitions).toBe(0);
    // The log column is only ever read BY the derivation, so an opted-out slim row drops it from
    // the projection entirely while still reporting the same `log: []` wire shape.
    expect(row.log).toEqual([]);
    expect(parsedRowKeys.length).toBeGreaterThan(0);
    for (const keys of parsedRowKeys) {
      expect(keys).not.toContain("log");
    }
    // Opting out must not change the non-derived contracts: the slim steps-from-PROMPT.md sync
    // still resolves. The precondition is read from the raw column (not `getTask`, which syncs the
    // same way) so only the list-time sync can explain a non-empty `steps` on the row.
    const [persisted] = await h.adminSql()<Array<{ steps: unknown }>>`
      select steps from project.tasks where id = ${"RUFU-9202"}
    `;
    expect(persisted!.steps ?? []).toEqual([]);
    expect(row.steps).toEqual(await store.parseStepsFromPrompt("RUFU-9202"));
    expect(row.steps.length).toBeGreaterThan(0);
  });

  /*
  FNXC:StartupSlimListMemo 2026-09-08-21:35 (RUFU-201):
  Each memo test clears the memo first: the shared harness can reuse one store across tests, and its
  `beforeEach` clears tables with raw SQL, which emits no lifecycle event and so cannot invalidate.
  */
  it("keeps a derived snapshot and an opted-out snapshot as separate memo entries", async () => {
    await seedInProgressCard("RUFU-9204");
    const store = h.store();
    store.clearStartupSlimListMemo();

    const derived = await store.listTasks({ column: "in-progress", slim: true, startupMemo: true });
    const raw = await store.listTasks({
      column: "in-progress",
      slim: true,
      derive: false,
      startupMemo: true,
    });

    expect(derived).toHaveLength(1);
    expect(raw).toHaveLength(1);
    // The two shapes differ, which is only possible if `derive` is part of the memo key: a shared
    // key would serve whichever snapshot was filled first.
    expect(derived[0]!.retrySummary).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(raw[0]!, "retrySummary")).toBe(false);
    expect(Object.is(derived, raw)).toBe(false);
  });

  /*
  FNXC:StartupSlimListMemo 2026-09-09-03:55 (RUFU-201 code-review remediation):
  `includeDeleted` is a result-shape dimension of the memo key. Soft deletion stamps the historical
  `archived` sentinel column, so a non-`includeArchived` read hides tombstones through the column
  filter too — the pair that actually produces divergent payloads (and thus the pair that makes a
  shared key harmful) is taken with `includeArchived: true`, where only the `deleted_at IS NULL`
  filter separates live from forensic. That is the shape admin/forensic surfaces read
  (`/api/tasks?includeDeleted=true`). Both fill orders are pinned: whichever shape fills first, the
  other must still read its own payload, and the two snapshots must not be reference-identical —
  the reference check makes the test non-vacuous (a keyless pass shares one snapshot either way).
  */
  it("keeps live-only and forensic (includeDeleted) snapshots as separate memo entries", async () => {
    await seedInProgressCard("RUFU-9207");
    await seedInProgressCard("RUFU-9208");
    const store = h.store();
    await store.deleteTask("RUFU-9208");
    store.clearStartupSlimListMemo();

    // Live-first: the forensic read must not be starved by the live snapshot filled moments ago.
    const live = await store.listTasks({ slim: true, includeArchived: true, startupMemo: true });
    const forensic = await store.listTasks({
      slim: true,
      includeArchived: true,
      includeDeleted: true,
      startupMemo: true,
    });
    expect(live.map((t) => t.id)).not.toContain("RUFU-9208");
    expect(forensic.map((t) => t.id)).toContain("RUFU-9208");
    expect(Object.is(live, forensic)).toBe(false);

    // Forensic-first: the live read must not resurrect the soft-deleted card out of the snapshot.
    store.clearStartupSlimListMemo();
    const forensicFirst = await store.listTasks({
      slim: true,
      includeArchived: true,
      includeDeleted: true,
      startupMemo: true,
    });
    const liveSecond = await store.listTasks({ slim: true, includeArchived: true, startupMemo: true });
    expect(forensicFirst.map((t) => t.id)).toContain("RUFU-9208");
    expect(liveSecond.map((t) => t.id)).not.toContain("RUFU-9208");
    expect(Object.is(forensicFirst, liveSecond)).toBe(false);
  });

  it("hands out one frozen snapshot per memo key instead of deep-copying it on every hit", async () => {
    await seedInProgressCard("RUFU-9205");
    const store = h.store();
    store.clearStartupSlimListMemo();
    const reads = instrumentDerivationReads(store);

    const first = await store.listTasks({ column: "in-progress", slim: true, startupMemo: true });
    // Snapshot the fill's derivation reads, then prove a hit adds none of its own.
    const fillReads = { ...reads };
    const second = await store.listTasks({ column: "in-progress", slim: true, startupMemo: true });

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    // A hit must neither re-read nor re-serialize the board: the snapshot itself is handed out.
    expect(Object.is(first, second)).toBe(true);
    // The anti-churn claim in numbers: a hit re-runs none of the derivation's hot-table reads.
    expect(reads).toEqual(fillReads);
  });

  it("drops the memo on a task lifecycle event, so the TTL is not the only bound", async () => {
    await seedInProgressCard("RUFU-9206");
    const store = h.store();
    store.clearStartupSlimListMemo();

    const first = await store.listTasks({ column: "in-progress", slim: true, startupMemo: true });
    expect(first).toHaveLength(1);
    const staleTitle = first[0]!.title;

    await store.updateTask("RUFU-9206", { title: "Renamed by lifecycle event" });
    const after = await store.listTasks({ column: "in-progress", slim: true, startupMemo: true });

    // A TTL-only memo (15 s) would still be serving `staleTitle` here.
    expect(after).toHaveLength(1);
    expect(after[0]!.title).toBe("Renamed by lifecycle event");
    expect(after[0]!.title).not.toBe(staleTitle);
    expect(Object.is(first, after)).toBe(false);
  });

  /*
  FNXC:StartupSlimListMemo 2026-09-09-02:04 (RUFU-201):
  The `updateTask` arm above covers the event listener. A move is the mutation the engine's own tick
  reads actually react to, and it takes a different invalidation seam: `moveTask` emits `task:moved`,
  which the memo does NOT listen to, so the snapshot is cleared by `writeTaskJsonFileImpl`'s
  unconditional invalidation (`moves.ts` reaches it for every lane-changing move; the same-column
  backend-handoff early return mutates no board-visible field and needs no invalidation). This test names that coupling so a
  future refactor that stops writing the artifact cannot silently turn the 15 s TTL into the only
  freshness bound for movers. `scheduler.ts` cites this file for it.

  The read is deliberately UNFILTERED: `column` is part of the memo key, so a column-scoped read would
  miss on its own key change and prove nothing about invalidation.
  */
  it("drops the memo when a task moves lanes, the mutation path that emits no listened event", async () => {
    await seedInProgressCard("RUFU-9207");
    const store = h.store();
    store.clearStartupSlimListMemo();

    const before = await store.listTasks({ slim: true, startupMemo: true });
    expect(before).toHaveLength(1);
    expect(before[0]!.column).toBe("in-progress");

    await store.moveTask("RUFU-9207", "in-review", { moveSource: "user" });
    const after = await store.listTasks({ slim: true, startupMemo: true });

    // Same memo key, same TTL window: only an invalidation can make this read see the new lane.
    expect(after).toHaveLength(1);
    expect(after[0]!.column).toBe("in-review");
    expect(Object.is(before, after)).toBe(false);
  });

  it("still fetches the log column for the default deriving read (board parity)", async () => {
    await seedInProgressCard("RUFU-9203");
    const store = h.store();
    const parsedRowKeys: string[][] = [];
    const parseOriginal = store.pgRowToTaskRow.bind(store);
    store.pgRowToTaskRow = (pgRow) => {
      parsedRowKeys.push(Object.keys(pgRow as Record<string, unknown>));
      return parseOriginal(pgRow);
    };

    const rows = await store.listTasks({ column: "in-progress", slim: true, startupMemo: false });

    expect(rows).toHaveLength(1);
    expect(parsedRowKeys.length).toBeGreaterThan(0);
    for (const keys of parsedRowKeys) {
      expect(keys).toContain("log");
    }
  });

  /*
  FNXC:ListTasksExcludeLog 2026-09-09-01:50 (RUFU-202):
  `slim` was the only way to drop the heaviest column, and it bundles a per-task PROMPT.md parse
  (`finalizeSlimListTask` → unmemoised `parseStepsFromPrompt`) that a board sweep has no use for.
  These tests pin `excludeLog` as the shape that gets the byte saving WITHOUT that parse: the hold-
  release sweep is the consumer, and it never reads `log` or `steps`.
  */
  it("drops the log column for a non-slim opted-out read without parsing PROMPT.md", async () => {
    await seedInProgressCard("RUFU-9207");
    const store = h.store();
    const parsedRowKeys: string[][] = [];
    const parseOriginal = store.pgRowToTaskRow.bind(store);
    store.pgRowToTaskRow = (pgRow) => {
      parsedRowKeys.push(Object.keys(pgRow as Record<string, unknown>));
      return parseOriginal(pgRow);
    };
    let promptParses = 0;
    const parsePromptOriginal = store.parseStepsFromPrompt.bind(store);
    store.parseStepsFromPrompt = async (taskId) => {
      promptParses += 1;
      return parsePromptOriginal(taskId);
    };

    const rows = await store.listTasks({
      column: "in-progress",
      derive: false,
      excludeLog: true,
      startupMemo: false,
    });

    expect(rows).toHaveLength(1);
    const row = rows[0] as Task;
    // The projection, not just the wire shape: the column was never selected, so ~11 KB/row never
    // crossed the wire. This is the saving `derive: false` alone could not buy.
    expect(row.log).toEqual([]);
    expect(parsedRowKeys.length).toBeGreaterThan(0);
    for (const keys of parsedRowKeys) {
      expect(keys).not.toContain("log");
    }
    // Control: the PROMPT.md is present and parseable, so a zero count below is the read shape
    // declining to parse — not an empty or missing file.
    expect((await parsePromptOriginal("RUFU-9207")).length).toBeGreaterThan(0);
    // Zero-parse proof: `slim` would have parsed exactly once for this empty-`steps` card.
    expect(promptParses).toBe(0);
    expect(row.steps).toEqual([]);
    // Persisted fields survive the narrow projection unchanged — the sweep's release decisions read
    // `prompt`/`description`/`paused*` and must not see them shift as a side effect of bandwidth.
    expect(row.description).toContain("RUFU-201 probe");
  });

  /*
  FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615): this test asserted the OPPOSITE contract.
  It pinned `excludeLog` as a documented NO-OP while deriving, on the reasoning that
  `stalledReview`/`timedExecutionMs` are derived FROM the log so a caller could not ask for both.
  That premise is what RUFU-615 removed: the five log-derived signals are now computed at WRITE time
  into `timing_total_ms` + `log_recent`, so a deriving caller can drop the column and keep every badge.
  Weakening the assertion would be the wrong fix — the guarantee it existed to protect ("a board badge
  cannot be switched off by a bandwidth option") is now asserted directly, by comparing the derived
  fields against a read that did load the log.
  */
  it("honours excludeLog while deriving AND keeps every log-derived figure it protects", async () => {
    await seedInProgressCard("RUFU-9208");
    const store = h.store();
    const parsedRowKeys: string[][] = [];
    const parseOriginal = store.pgRowToTaskRow.bind(store);
    store.pgRowToTaskRow = (pgRow) => {
      parsedRowKeys.push(Object.keys(pgRow as Record<string, unknown>));
      return parseOriginal(pgRow);
    };

    // Control first: what the same card reports when the log IS loaded.
    const withLog = await store.listTasks({ column: "in-progress", slim: true, startupMemo: false });
    expect(withLog).toHaveLength(1);
    expect(parsedRowKeys.length).toBeGreaterThan(0);
    for (const keys of parsedRowKeys) {
      expect(keys).toContain("log");
    }

    parsedRowKeys.length = 0;
    const rows = await store.listTasks({
      column: "in-progress",
      slim: true,
      excludeLog: true,
      startupMemo: false,
    });

    expect(rows).toHaveLength(1);
    // The projection is real now: the column was never selected, yet the figure it produced survives.
    for (const keys of parsedRowKeys) {
      expect(keys).not.toContain("log");
    }
    expect(rows[0]!.timedExecutionMs).toBeDefined();
    expect(rows[0]!.timedExecutionMs).toEqual(withLog[0]!.timedExecutionMs);
    expect(rows[0]!.stalledReview).toEqual(withLog[0]!.stalledReview);
  });

  it("keeps archived cards off the board for an excludeLog read", async () => {
    await seedInProgressCard("RUFU-9209");
    await seedInProgressCard("RUFU-9210");
    const store = h.store();
    /*
    The shared harness exposes `adminSql` as a GETTER-FUNCTION (typed `() => Sql`), so tagging
    `h.adminSql` directly tags the getter itself and issues no query at all. Call it first, then query.
    */
    const admin = h.adminSql();
    await admin`update project.tasks set "column" = 'archived' where id = ${"RUFU-9210"}`;
    // Make the seed observable: without this, a silently-failing archive is indistinguishable from a
    // narrowing regression.
    expect(await admin`select id, "column" as col from project.tasks order by id`).toEqual([
      { id: "RUFU-9209", col: "in-progress" },
      { id: "RUFU-9210", col: "archived" },
    ]);

    /*
    The archived narrowing is only applied when no lane filter is supplied, which is exactly why the
    `excludeColumns: ["log"]` variant was rejected: it is a LANE filter, and setting it re-admitted
    archived cards to a release-decision pass. `excludeLog` must not touch lane selection at all.
    */
    const rows = await store.listTasks({ derive: false, excludeLog: true, startupMemo: false });

    expect(rows.map((row) => row.id)).toContain("RUFU-9209");
    expect(rows.map((row) => row.id)).not.toContain("RUFU-9210");
  });
});
