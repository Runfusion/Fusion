/**
 * FNXC:StoreOpenProvenance 2026-10-31-22:15 (RUFU-344):
 * Symptom-verification suite for the `store:open` provenance row. The original defect: `AGENTS.md`
 * promised that every `TaskStore.init()` stamps `store:open` with ids/paths-only process identity,
 * while the source emitted no such row at all — so "which process opened the shared project database"
 * (the FN-7910 forensic question) had no durable answer, and the only remaining channel, the
 * `[taskstore-boot]` console line, is process-local and is not a permissible test subject.
 *
 * Before the fix this file's first case failed on `0 === 1`: `init()` resolved and the table stayed
 * empty. That is the exact reported failure, reproduced through the real store-open path — not a
 * source-text or documentation assertion (AGENTS.md prose is deliberately never a test subject).
 *
 * The assertions pinned here are the whole contract:
 *  (a) exactly one row per `init()` for the opened store, (b) `task_id` stays NULL — a store open is
 * not a task mutation, (c) the metadata key set is EXACTLY
 * `{pid, ppid, execPath, entry, cwd, nodeVersion}` (set equality, not containment, because one row is
 * written per store open fleet-wide and a stray key is multiplied across every CLI call), (d) a second
 * `init()` adds a second row — `AGENTS.md` says "every init", so two opens are two rows, (e) an
 * absent, throwing, rejecting, or never-settling audit sink cannot destroy `init()`, and (f) aged rows
 * of THIS project are pruned while fresh rows, other projects' rows, and other taskless audit rows
 * survive — otherwise one immortal row would accumulate per store open forever.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../../store.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS } from "../../run-audit/emit-bounded-run-audit.js";
import { pruneOperationalLogsAsync } from "../../task-store/async/async-maintenance.js";
import * as schema from "../../postgres/schema/index.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const STORE_OPEN = "store:open";

/** The closed metadata contract from the route decision — set equality, so a key is added/renamed here too. */
const PROVENANCE_KEYS = ["cwd", "entry", "execPath", "nodeVersion", "pid", "ppid"] as const;

interface StoreOpenRow {
  id: string;
  task_id: string | null;
  agent_id: string;
  run_id: string;
  domain: string;
  mutation_type: string;
  target: string;
  project_id: string;
  metadata: Record<string, unknown> | null;
}

pgDescribe("store-open provenance row (RUFU-344)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "rufu344_store_open" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /**
   * A store I can open myself, on the harness's already-baselined layer — the same construction shape
   * the harness itself uses, so the test exercises `TaskStore.init()` rather than a harness side effect.
   */
  function openableStore(): TaskStore {
    return new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
  }

  async function storeOpenRows(): Promise<StoreOpenRow[]> {
    return (await h.adminSql()`
      SELECT id, task_id, agent_id, run_id, domain, mutation_type, target, project_id, metadata
      FROM project.run_audit_events
      WHERE mutation_type = ${STORE_OPEN}
      ORDER BY timestamp, id
    `) as unknown as StoreOpenRow[];
  }

  /** Light init: the provenance row is the deliverable, the archive/patchnode backlog is unrelated here. */
  async function initLight(store: TaskStore): Promise<void> {
    await store.init({ skipArchiveReintegration: true, skipPatchnodeReconcile: true });
  }

  describe("emission on store open", () => {
    it("writes exactly one store:open row whose metadata is ids/paths only", async () => {
      // The shared-harness beforeEach empties every application table, so a non-zero count here can
      // only come from the init below — the pre-fix tree measured 0 and that is the reported failure.
      expect(await storeOpenRows()).toHaveLength(0);

      await initLight(openableStore());

      const rows = await storeOpenRows();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      // (b) a store open belongs to no task.
      expect(row.task_id).toBeNull();
      expect(row.domain).toBe("database");
      expect(row.agent_id).toBe("store");
      // The project-agnostic harness binds no project id, and `target` is NOT NULL, so the documented
      // fallback is what a project-agnostic host must produce.
      expect(row.target).toBe("unscoped");
      expect(row.run_id).toMatch(new RegExp(`^store-open-${process.pid}-\\d+$`));

      // (c) exact key set — `Object.keys(...).sort()` equality, not containment.
      const metadata = row.metadata ?? {};
      expect(Object.keys(metadata).sort()).toEqual([...PROVENANCE_KEYS].sort());
      expect(metadata).toMatchObject({
        pid: process.pid,
        ppid: process.ppid,
        execPath: process.execPath,
        cwd: process.cwd(),
        nodeVersion: process.version,
      });
      // A missing entry point is `unknown`, never a thrown error or an empty value that could be
      // mistaken for "the store opened for a task".
      expect(typeof metadata.entry).toBe("string");
      expect((metadata.entry as string).length).toBeGreaterThan(0);
    });

    it("adds a second row for a second init, because the promise is per store open", async () => {
      await initLight(openableStore());
      expect(await storeOpenRows()).toHaveLength(1);

      await initLight(openableStore());

      const rows = await storeOpenRows();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.task_id === null)).toBe(true);
      // Two opens by the same process may land in the same millisecond, so the run id is a hint, and
      // the row identity (distinct ids) is what proves two writes rather than one re-read.
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    });

    it("keeps the provenance row in the project the layer is bound to", async () => {
      /*
      The row's `project_id` is what makes retention project-bound instead of cross-project deletion,
      so the unbound case must land in the same quarantine partition the insert trigger uses for every
      other unscoped row — otherwise retention could never find it.
      */
      await initLight(openableStore());
      const [row] = await storeOpenRows();
      expect(row).toBeDefined();
      const partition = h.layer().projectId?.trim() || "__legacy_unscoped__";
      expect(row!.project_id).toBe(partition);
    });
  });

  describe("hostile audit sink cannot destroy init", () => {
    it.each([
      ["synchronously throwing", () => { throw new Error("audit sink threw"); }],
      ["rejecting", () => Promise.reject(new Error("audit sink rejected"))],
    ])("resolves init for a %s sink and records no row", async (_label, sink) => {
      const store = openableStore();
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation(sink as never);

      await expect(initLight(store)).resolves.toBeUndefined();

      // Non-vacuous control: the store still works after the refused stamp, and the refused stamp
      // really wrote nothing (a sink that fell back to a raw insert would be invisible otherwise).
      expect(await storeOpenRows()).toHaveLength(0);
      await expect(store.getSettings()).resolves.toBeDefined();
    });

    it("resolves init for an absent sink", async () => {
      /*
      `vi.spyOn(...).mockImplementation(undefined)` is NOT an absent sink — Vitest treats a missing
      implementation as "fall through to the original", so that fixture still writes the row. Absence is
      shadowed on the instance instead, which is the state the seam probes with `typeof sink !==
      "function"` (a host that never gained the method, e.g. a partial fake store).
      */
      const store = openableStore();
      Object.defineProperty(store, "recordRunAuditEvent", { value: undefined, configurable: true });

      await expect(initLight(store)).resolves.toBeUndefined();
      expect(await storeOpenRows()).toHaveLength(0);
    });

    it("resolves init for a never-settling sink once the bounded seam expires", async () => {
      /*
      Real timers, deliberately: the seam's own 2 000 ms bound IS the wait under test, and faking timers
      starves the PostgreSQL client — measured here, `vi.advanceTimersByTimeAsync(2_100)` never let the
      open's own queries finish and the case hit the 15 s test timeout instead of proving anything. This
      asserts the shipped ceiling (the seam, not a widened per-test timeout): init must resolve on its
      own after the bound expires, with the refused stamp leaving no row.
      */
      const store = openableStore();
      vi.spyOn(store, "recordRunAuditEvent").mockImplementation(() => new Promise<never>(() => undefined));
      const startedAt = Date.now();

      await expect(initLight(store)).resolves.toBeUndefined();

      expect(await storeOpenRows()).toHaveLength(0);
      // The seam bounds the wait; a hang would have failed the assertion above by timing out instead.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
    });
  });

  describe("retention for otherwise immortal taskless rows", () => {
    /*
    FNXC:StoreOpenProvenance 2026-10-31-22:15 (RUFU-344):
    The pre-existing run-audit retention branch deletes only rows reachable through an owning task, so
    a taskless `store:open` row could never be collected — one immortal row per store open, i.e. per CLI
    invocation. These cases pin the project-bound exception and its boundaries: a fresh row, another
    project's equally old row, and another taskless mutation_type all survive the same pass.
    */
    const old = () => new Date(Date.now() - 10 * 86_400_000).toISOString();
    const recent = () => new Date().toISOString();

    async function seedAuditRows(): Promise<void> {
      await h.adminDb().insert(schema.project.runAuditEvents).values([
        { id: "open-old-a", projectId: "project-a", timestamp: old(), taskId: null, agentId: "store", runId: "run-old-a", domain: "database", mutationType: STORE_OPEN, target: "project-a" },
        { id: "open-new-a", projectId: "project-a", timestamp: recent(), taskId: null, agentId: "store", runId: "run-new-a", domain: "database", mutationType: STORE_OPEN, target: "project-a" },
        { id: "open-old-b", projectId: "project-b", timestamp: old(), taskId: null, agentId: "store", runId: "run-old-b", domain: "database", mutationType: STORE_OPEN, target: "project-b" },
        { id: "taskless-other-a", projectId: "project-a", timestamp: old(), taskId: null, agentId: "system", runId: "run-taskless", domain: "database", mutationType: "task:handoff", target: "unscoped" },
      ]);
    }

    async function survivingIds(): Promise<string[]> {
      const rows = await h.adminSql()`
        SELECT id FROM project.run_audit_events
        WHERE id IN ('open-old-a', 'open-new-a', 'open-old-b', 'taskless-other-a')
      `;
      return (rows as Array<{ id: string }>).map((row) => row.id).sort();
    }

    it("deletes only this project's aged store:open rows", async () => {
      await seedAuditRows();

      const result = await pruneOperationalLogsAsync({ ...h.layer(), projectId: "project-a" }, 86_400_000);

      expect(result.deletedByTable.storeOpenAuditEvents).toBe(1);
      expect(await survivingIds()).toEqual(["open-new-a", "open-old-b", "taskless-other-a"]);
    });

    it("prunes the legacy unscoped partition only for an unbound pass", async () => {
      await h.adminDb().insert(schema.project.runAuditEvents).values([
        { id: "open-old-unscoped", projectId: "__legacy_unscoped__", timestamp: old(), taskId: null, agentId: "store", runId: "run-unscoped", domain: "database", mutationType: STORE_OPEN, target: "unscoped" },
        { id: "open-old-bound", projectId: "project-a", timestamp: old(), taskId: null, agentId: "store", runId: "run-bound", domain: "database", mutationType: STORE_OPEN, target: "project-a" },
      ]);

      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const result = await pruneOperationalLogsAsync({ ...h.layer(), projectId: undefined }, 86_400_000);
        expect(result.deletedByTable.storeOpenAuditEvents).toBe(1);
      } finally {
        warn.mockRestore();
      }

      const rows = await h.adminSql()`SELECT id FROM project.run_audit_events WHERE id IN ('open-old-unscoped', 'open-old-bound')`;
      expect((rows as Array<{ id: string }>).map((row) => row.id)).toEqual(["open-old-bound"]);
    });

    it("collects a real provenance row once it ages past the retention window", async () => {
      /*
      End-to-end form of the retention rule: the row the emitter actually writes (trigger-assigned
      partition, no explicit project_id) must be reachable by retention, not just a hand-seeded fixture.
      */
      await initLight(openableStore());
      const [row] = await storeOpenRows();
      expect(row).toBeDefined();

      await h.adminSql()`UPDATE project.run_audit_events SET timestamp = ${old()} WHERE id = ${row!.id}`;
      const partition = h.layer().projectId?.trim() || "__legacy_unscoped__";
      const result = await pruneOperationalLogsAsync({ ...h.layer(), projectId: partition }, 86_400_000);

      expect(result.deletedByTable.storeOpenAuditEvents).toBe(1);
      expect(await storeOpenRows()).toHaveLength(0);
    });
  });
});
