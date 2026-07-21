/**
 * FNXC:TestMigrationTail 2026-06-24-16:00:
 * Reusable PostgreSQL test fixture for the SQLite→PostgreSQL migration.
 *
 * `createTaskStoreForTest()` is the canonical helper that test files use to
 * obtain a PG-backed TaskStore (or any store) connected to a fresh, isolated
 * PostgreSQL database. It eliminates the ~60 lines of boilerplate (adminExec,
 * CREATE/DROP DATABASE, connection set, schema baseline, AsyncDataLayer) that
 * every postgres/*.test.ts file previously duplicated.
 *
 * Design:
 *   - Each call creates a uniquely-named test database (DB-per-test isolation).
 *   - The schema baseline is applied via the schema applier.
 *   - The returned `PgTestHarness` exposes the ready `TaskStore`, the raw
 *     `AsyncDataLayer` (for direct row seeding), and a `teardown()` that drops
 *     the database and closes all connections.
 *   - When PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1), the describe
 *     blocks that use `pgDescribe` are skipped so the merge gate stays green.
 *
 * Usage pattern:
 * ```ts
 * import { pgDescribe, createTaskStoreForTest } from "@fusion/test-utils/pg-test-harness";
 *
 * const pgTest = pgDescribe("my PG integration test");
 *
 * pgTest("creates a task and reads it back", async () => {
 *   const h = await createTaskStoreForTest();
 *   try {
 *     const task = await h.store.createTask({ description: "hello" });
 *     expect(task.id).toBeTruthy();
 *   } finally {
 *     await h.teardown();
 *   }
 * });
 * ```
 *
 * The gate-safe contract: tests using this helper are auto-skipped when PG is
 * not available, so they never break the merge gate in CI environments without
 * PostgreSQL. Run locally with PG on 5432 to exercise the PG paths.
 */

import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { describe as vitestDescribe } from "vitest";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import type { ResolvedBackend } from "../postgres/backend-resolver.js";
import { createConnectionSetFromUrl } from "../postgres/connection.js";
import { applySchemaBaseline } from "../postgres/schema-applier.js";
import {
  createAsyncDataLayer,
  type AsyncDataLayer,
} from "../postgres/data-layer.js";
import { TaskStore } from "../store.js";
import {
  PROJECT_SCHEMA,
  CENTRAL_SCHEMA,
  ARCHIVE_SCHEMA,
} from "../postgres/schema/_shared.js";
import {
  projectTableNames,
  centralTableNames,
  archiveTableNames,
} from "../postgres/schema/index.js";

/**
 * Base URL for the test PostgreSQL server. Defaults to the local Homebrew
 * instance on localhost:5432. Override via FUSION_PG_TEST_URL_BASE.
 */
export const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";

/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:00:
 * Parse the host/port out of PG_TEST_URL_BASE so a synchronous TCP probe can
 * detect whether the test PostgreSQL server is actually reachable. Returns a
 * sane default (localhost:5432) when the URL is malformed or has no port.
 */
function parseProbeTarget(url: string): { host: string; port: number } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "localhost";
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
    return { host, port: Number.isFinite(port) ? port : 5432 };
  } catch {
    return { host: "localhost", port: 5432 };
  }
}

/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:00:
 * Synchronous TCP reachability probe. Returns true if a TCP connection to
 * (host, port) succeeds within a short timeout. This MUST be synchronous
 * because `PG_AVAILABLE` is consumed at module-load time by conditional
 * `describe` calls (vitest's describe is synchronous).
 *
 * Implementation: spawns a Worker thread that performs the async connect. The
 * worker writes the outcome (1=connected, 2=failed) into a SharedArrayBuffer
 * and calls Atomics.notify; the main thread blocks on Atomics.wait. This is
 * the only way to bridge async I/O into a synchronous result in Node without
 * a native blocking socket addon.
 *
 * Why not just check env vars? The prior probe was
 *   `process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE)`
 * which is ALWAYS truthy because PG_TEST_URL_BASE defaults non-empty and
 * FUSION_PG_TEST_SKIP is never set in CI — so the 57 pgDescribe suites tried
 * to run in CI without PostgreSQL and failed with ECONNREFUSED, or were
 * silently dead. The real check must verify reachability.
 *
 * Why not the `pg_isready` binary via execSync? execSync is banned by
 * AGENTS.md for non-git-plumbing, and pg_isready may be absent from some CI
 * images. The worker-thread probe has no external binary dependency.
 */

function probeTcpReachable(host: string, port: number, timeoutMs = 1500): boolean {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  view[0] = 0; // 0 = pending, 1 = connected, 2 = failed

  let worker: Worker | null = null;
  try {
    // Spawn a worker that performs the async connect and signals the SAB.
    // The worker source is inline (no temp file) and tiny.
    const workerCode = `
      const { parentPort } = require("node:worker_threads");
      const { Socket } = require("node:net");
      parentPort.on("message", (msg) => {
        const { host, port, timeoutMs, buf } = msg;
        const view = new Int32Array(buf);
        const socket = new Socket();
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => { view[0] = 1; Atomics.notify(view, 0); socket.destroy(); });
        const fail = () => { if (view[0] === 0) { view[0] = 2; Atomics.notify(view, 0); } socket.destroy(); };
        socket.once("error", fail);
        socket.once("timeout", fail);
        socket.connect(port, host);
      });
    `;
    worker = new Worker(workerCode, { eval: true });
    worker.postMessage({ host, port, timeoutMs, buf: shared });
  } catch {
    // If worker threads are unavailable (rare), treat as unreachable so the
    // suite skips rather than hangs.
    return false;
  }

  // Block until the worker signals or we exceed the deadline.
  const deadline = Date.now() + timeoutMs + 500;
  while (view[0] === 0 && Date.now() < deadline) {
    Atomics.wait(view, 0, 0, 100);
  }

  // Tear down the worker asynchronously; don't block on it.
  void worker.terminate().catch(() => {});

  return view[0] === 1;
}

/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:00:
 * Whether PostgreSQL-backed tests should run.
 *
 * A test suite is gated to run only when ALL of the following hold:
 *   1. FUSION_PG_TEST_SKIP is not "1" (explicit opt-out).
 *   2. PG_TEST_URL_BASE is set and non-empty (not disabled entirely).
 *   3. The target host:port is actually accepting TCP connections.
 *
 * The reachability probe (#3) is what was missing: previously PG_AVAILABLE
 * was always truthy because the URL default is non-empty and the skip flag is
 * never set in CI, so pgDescribe suites ran (and failed) in environments
 * without PostgreSQL. Now they correctly skip via describe.skip.
 */
function computePgAvailable(): boolean {
  if (process.env.FUSION_PG_TEST_SKIP === "1") return false;
  if (!PG_TEST_URL_BASE) return false;
  const { host, port } = parseProbeTarget(PG_TEST_URL_BASE);
  return probeTcpReachable(host, port);
}

export const PG_AVAILABLE = computePgAvailable();

/**
 * A conditional `describe` that runs when PG is available and skips otherwise.
 * Use this instead of bare `describe` for any test file that needs a real
 * PostgreSQL connection.
 *
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * When PG is unavailable, this delegates to `describe.skip` (NOT a no-op) so
 * vitest registers a skipped suite. A no-op leaves the test file with zero
 * registered tests, which vitest treats as a failure ("no tests found") —
 * breaking the gate-safe contract in CI environments without PostgreSQL.
 */
export const pgDescribe: typeof vitestDescribe = PG_AVAILABLE
  ? vitestDescribe
  : (vitestDescribe.skip as typeof vitestDescribe);

/**
 * The harness returned by `createTaskStoreForTest()`. Provides the ready
 * TaskStore plus everything needed for direct row seeding and teardown.
 */
export interface PgTestHarness {
  /** A TaskStore constructed in backend mode (asyncLayer injected, no SQLite). */
  readonly store: TaskStore;
  /** The AsyncDataLayer backing the store. Use `.db` for Drizzle queries. */
  readonly layer: AsyncDataLayer;
  /** A separate admin Drizzle connection for direct row inspection/seeding. */
  readonly adminDb: PostgresJsDatabase;
  /** The temp rootDir used for filesystem-backed operations. */
  readonly rootDir: string;
  /** The unique test database name (for diagnostics). */
  readonly dbName: string;
  /** The full test connection URL. */
  readonly testUrl: string;
  /** Drop the test database, close connections, and remove the temp dir. */
  teardown(): Promise<void>;
}

let dbNameCounter = 0;

function uniqueDbName(prefix = "fusion_test"): string {
  dbNameCounter += 1;
  return `${prefix}_${process.pid}_${dbNameCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:05:
 * Async admin DDL (CREATE/DROP DATABASE) via psql. Replaces the prior
 * execSync call that violated AGENTS.md's execSync ban (only short git
 * plumbing may use execSync) and could hang the vitest worker with no
 * timeout. Now uses async exec with a bounded timeout.
 *
 * The statement is passed via stdin (`-f -`) to avoid shell-escaping hazards
 * on database names; the connection target comes from PG_TEST_URL_BASE so CI
 * can point at a non-default host/port/user without editing the harness.
 */
function adminExecAsync(statement: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    // Connect to the 'postgres' maintenance database on the same server.
    const maintUrl = new URL(PG_TEST_URL_BASE);
    maintUrl.pathname = "/postgres";
    const args = [
      `psql`,
      `"${maintUrl.toString()}"`,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ];
    const child = exec(
      args.join(" "),
      { stdio: ["pipe", "pipe", "pipe"], env: process.env, timeout: timeoutMs },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`adminExec psql failed: ${error.message}\nstderr: ${stderr}`));
          return;
        }
        resolve();
      },
    );
    if (child.stdin) {
      child.stdin.end(statement);
    }
  });
}

/**
 * FNXC:PgTestTemplateDb 2026-07-16-17:40:
 * Slow-test fix: applying the full Fusion schema baseline on every fresh test
 * database cost ~530ms per test file. With ~23 pg-gate files fanned across
 * forks against one PostgreSQL server, those DDL applies serialize and dominate
 * gate wall-time (mission-store.pg alone measured 6s isolated / 28s under load).
 *
 * Instead we apply the schema ONCE per worker module instance into a reusable
 * template database, then create each test database with `CREATE DATABASE ... TEMPLATE`
 * — a fast server-side file copy that skips re-running the DDL. Dead-pid templates
 * left by crashed/prior runs are swept before creating a new one.
 *
 * FNXC:PgTestTemplateDb 2026-07-17-14:34:
 * Vitest's `pool: "threads"` plus module isolation gives dashboard files separate
 * harness module registries while they share one process pid. A pid-only template
 * name let those independent memos concurrently drop and create the same database.
 * A shared template guarded only during creation is insufficient because this
 * module-local copy mutex cannot serialize cross-module `CREATE DATABASE ... TEMPLATE`
 * calls against one source. Give each module instance a nonce-bearing template so
 * creation and copying always use disjoint sources; the dead-pid sweep keeps every
 * live sibling's template and reclaims only orphaned process-owned templates.
 */
const SCHEMA_TEMPLATE_PREFIX = "fusion_schema_template";
const schemaTemplateInstanceNonce = randomUUID().replace(/-/g, "").slice(0, 12);
const schemaTemplateName = `${SCHEMA_TEMPLATE_PREFIX}_${process.pid}_${schemaTemplateInstanceNonce}`;

/** The per-module template database name, disjoint across same-pid module registries. */
function templateDbName(): string {
  return schemaTemplateName;
}

/*
FNXC:PgTestTemplateDb 2026-07-19-17:20:
Slow-test fix (gate reliability): the per-module nonce template applied the full
Fusion schema baseline (~530ms of DDL) once PER isolated test file. With ~24
pg-gate files fanned across forks against one PostgreSQL server, those baselines
run concurrently, the DDL/CREATE DATABASE calls serialize server-side, and the
per-file `beforeAll` blew past the 15s hookTimeout nondeterministically (observed
18/23 then 5/23 then 8/23 files failing across back-to-back runs). Raising the
timeout is forbidden appeasement, so instead we remove the redundant work: apply
the baseline exactly ONCE per vitest invocation into a run-shared, read-only
"golden" template, then build each per-module template as a fast server-side
`CREATE DATABASE ... TEMPLATE golden` copy. Concurrent copies from one
connection-free template are safe (empirically verified); only active sessions on
a template trigger "source database is being accessed". Per-module templates and
their drop/half-built/exists lifecycle hooks are preserved so module isolation
and the template-concurrency regression tests keep their exact semantics.

The golden template is named with the vitest MAIN-process pid
(FUSION_PG_TEMPLATE_OWNER_PID, exported by globalSetup and inherited by every
fork) plus the shared run token, so all forks of one run resolve the SAME golden
name and the existing dead-pid sweep reclaims it once the run's main process
exits. Cross-fork build coordination uses a Postgres advisory lock keyed on the
golden name; readiness is tracked by a marker table in the maintenance database
so the readiness check never opens a session on the golden template.
*/
/** Schema-qualified readiness marker table; a compile-time constant, safe to inline in SQL. */
const GOLDEN_MARKER_QUALIFIED = "public._fusion_golden_templates";

/** Lowercase-alnum, bounded suffix safe for a database identifier. */
function sanitizeTemplateToken(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned.length > 0 ? cleaned.slice(-16) : "default";
}

/**
 * Identity shared across every fork of a single vitest invocation. Both come
 * from globalSetup (vitest-teardown.ts): the owner pid is the main vitest
 * process pid; the run token derives from the per-invocation worker root. When
 * either is absent (a direct harness import with no globalSetup), the golden
 * template degrades to a process-local identity so isolated unit tests still
 * work — they simply do not share a golden across processes.
 */
function goldenTemplateOwnerPid(): number {
  const raw = process.env.FUSION_PG_TEMPLATE_OWNER_PID?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return process.pid;
}

function goldenTemplateRunToken(): string {
  const workerRoot = process.env.FUSION_TEST_WORKER_ROOT?.trim();
  if (workerRoot) return sanitizeTemplateToken(basename(workerRoot));
  const runToken = process.env.FUSION_TEST_RUN_TOKEN?.trim();
  if (runToken) return sanitizeTemplateToken(runToken);
  return sanitizeTemplateToken(schemaTemplateInstanceNonce);
}

/**
 * Golden template name. The `<ownerPid>` segment keeps `parseTemplatePid`
 * working so the dead-pid sweep reclaims a finished run's golden; the `golden`
 * marker in the alnum suffix keeps it disjoint from per-module templates that
 * share the same pid namespace.
 */
function goldenTemplateName(): string {
  return `${SCHEMA_TEMPLATE_PREFIX}_${goldenTemplateOwnerPid()}_golden${goldenTemplateRunToken()}`;
}

/** Extract the pid embedded in a template DB name, or null if it doesn't match. */
function parseTemplatePid(dbName: string): number | null {
  const match = new RegExp(`^${SCHEMA_TEMPLATE_PREFIX}_(\\d+)(?:_[a-z0-9]+)?$`).exec(dbName);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isFinite(pid) ? pid : null;
}

/**
 * FNXC:PgTestTemplateDb 2026-07-16-17:40:
 * A template left behind by a crashed/finished process is only reclaimable if
 * its owning pid is gone. `process.kill(pid, 0)` probes liveness without
 * signalling: ESRCH => dead (sweepable); EPERM => alive under another user
 * (keep). Treat any non-ESRCH error as alive so we never drop a live template.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Open a short-lived admin connection to the maintenance ("postgres") database
 * on the same server, run `fn`, and always close. Used for template lifecycle
 * (listing/sweeping/creating template DBs) where we need query results back —
 * unlike `adminExecAsync`, which fires psql and returns no rows.
 */
async function withMaintenanceSql<T>(
  fn: (client: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
  const maintUrl = new URL(PG_TEST_URL_BASE);
  maintUrl.pathname = "/postgres";
  const client = postgres(maintUrl.toString(), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    return await fn(client);
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

/** Test-only lifecycle controls for deterministic template-state regression tests. */
export const __pgTestTemplateTestHooks = {
  templateName: templateDbName,
  async templateExists(): Promise<boolean> {
    const templateName = templateDbName();
    return withMaintenanceSql(async (client) => {
      const rows = await client<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${templateName}) AS exists
      `;
      return rows[0]?.exists === true;
    });
  },
  async dropTemplate(): Promise<void> {
    const templateName = templateDbName();
    await withMaintenanceSql(async (client) => {
      await client.unsafe(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
    });
  },
  async createHalfBuiltTemplate(): Promise<void> {
    const templateName = templateDbName();
    await withMaintenanceSql(async (client) => {
      await client.unsafe(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
      await client.unsafe(`CREATE DATABASE "${templateName}"`);
    });
  },
};

/*
 * FNXC:PgTestTemplateDb 2026-07-17-22:25:
 * Do not register module-local `beforeExit` cleanup. Vitest can reach a transient
 * beforeExit state while sibling isolated module registries still copy from their
 * templates, so that handler races and drops live sources. The dead-pid sweep in
 * ensureSchemaTemplate reclaims templates after the owning worker actually exits.
 */

/**
 * FNXC:PgTestTemplateDb 2026-07-16-17:40:
 * CREATE DATABASE ... TEMPLATE connects to the source template and errors if
 * any other session is attached ("source database is being accessed by other
 * users"). Each module instance now owns a disjoint nonce-bearing template;
 * concurrent calls within that instance still share its source, so serialize
 * its template-copy step through a chained mutex.
 */
let createFromTemplateChain: Promise<unknown> = Promise.resolve();
function serializeTemplateCopy<T>(fn: () => Promise<T>): Promise<T> {
  const run = createFromTemplateChain.then(fn, fn);
  createFromTemplateChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * FNXC:PgTestTemplateDb 2026-07-19-17:20:
 * Ensure the run-shared golden template exists with the full Fusion schema
 * baseline applied, and return its name. Memoized per module instance so the
 * advisory-lock round trip happens at most once per module; the ~530ms baseline
 * apply happens at most once per vitest invocation across ALL forks.
 *
 * On entry it sweeps templates orphaned by crashed/finished processes (dead pid)
 * plus stale golden marker rows, then builds the golden template under a
 * Postgres advisory lock keyed on the golden name so only one fork applies the
 * baseline while siblings block, then reuse. A marker row in the maintenance DB
 * records readiness so the check never opens a session on the golden template
 * (which would break concurrent `CREATE DATABASE ... TEMPLATE golden` copies).
 * On failure the memo is cleared so a later call can rebuild.
 */
let goldenTemplateReady: Promise<string> | null = null;
function ensureGoldenTemplate(): Promise<string> {
  if (goldenTemplateReady) return goldenTemplateReady;
  const ready = (async (): Promise<string> => {
    const goldenName = goldenTemplateName();
    // The advisory lock is a SESSION lock on this maintenance connection, so the
    // whole build (including the baseline apply on a separate connection) must
    // run inside ONE withMaintenanceSql call — closing the connection releases
    // the lock. A sibling fork blocks on pg_advisory_lock until the winner has
    // fully built the golden template and recorded its ready marker.
    await withMaintenanceSql(async (client) => {
      // Ensure the readiness marker table exists before any read/write of it.
      await client.unsafe(
        `CREATE TABLE IF NOT EXISTS ${GOLDEN_MARKER_QUALIFIED} (name text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`,
      );
      // Sweep templates orphaned by crashed/finished processes and drop marker
      // rows whose golden database no longer exists.
      const rows = await client<{ datname: string }[]>`
        SELECT datname FROM pg_database
        WHERE datname LIKE ${SCHEMA_TEMPLATE_PREFIX + "\\_%"}
      `;
      for (const row of rows) {
        if (row.datname === goldenName) continue;
        const pid = parseTemplatePid(row.datname);
        if (pid !== null && isPidAlive(pid)) continue;
        await client
          .unsafe(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`)
          .catch(() => {});
      }
      await client.unsafe(
        `DELETE FROM ${GOLDEN_MARKER_QUALIFIED} WHERE name NOT IN (SELECT datname FROM pg_database)`,
      ).catch(() => {});

      // Serialize the build across forks; the winner applies the baseline while
      // the rest block here, then observe the ready marker and skip the build.
      await client`SELECT pg_advisory_lock(hashtext(${goldenName}))`;
      try {
        const readyRows = await client.unsafe<{ ready: boolean }[]>(
          `SELECT EXISTS(
            SELECT 1 FROM ${GOLDEN_MARKER_QUALIFIED} m
            JOIN pg_database d ON d.datname = m.name
            WHERE m.name = $1
          ) AS ready`,
          [goldenName],
        );
        if (readyRows[0]?.ready === true) return;

        // Not ready (missing or half-built): rebuild from scratch under the lock.
        await client.unsafe(`DROP DATABASE IF EXISTS "${goldenName}" WITH (FORCE)`).catch(() => {});
        await client.unsafe(`DELETE FROM ${GOLDEN_MARKER_QUALIFIED} WHERE name = $1`, [goldenName]);
        await client.unsafe(`CREATE DATABASE "${goldenName}"`);

        // Apply the baseline on a separate connection to the golden database
        // while this maintenance session keeps holding the advisory lock, then
        // close it so the golden template has no open sessions before copies.
        const goldenUrl = `${PG_TEST_URL_BASE}/${goldenName}`;
        const schemaBackend: ResolvedBackend = {
          mode: "external",
          runtimeUrl: goldenUrl,
          migrationUrl: goldenUrl,
          migrationUrlOverridden: false,
        };
        const schemaConnections = await createConnectionSetFromUrl(schemaBackend, {
          poolMax: 1,
          connectTimeoutSeconds: 5,
        });
        try {
          await applySchemaBaseline(schemaConnections.migration);
        } finally {
          await schemaConnections.close();
        }

        // Record readiness only after a fully successful build.
        await client.unsafe(
          `INSERT INTO ${GOLDEN_MARKER_QUALIFIED} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [goldenName],
        );
      } finally {
        await client`SELECT pg_advisory_unlock(hashtext(${goldenName}))`;
      }
    });
    return goldenName;
  })();
  ready.catch(() => {
    if (goldenTemplateReady === ready) goldenTemplateReady = null;
  });
  goldenTemplateReady = ready;
  return ready;
}

/**
 * FNXC:PgTestTemplateDb 2026-07-19-17:20:
 * Ensure this module instance's per-module schema-template database exists, and
 * return its name. Built as a fast server-side `CREATE DATABASE ... TEMPLATE
 * golden` copy of the run-shared golden template (see `ensureGoldenTemplate`)
 * instead of re-running the schema baseline, so the expensive DDL apply happens
 * once per run rather than once per file. Memoized per module instance so the
 * copy happens exactly once for that instance. The per-module template and its
 * drop/half-built/exists lifecycle hooks are retained for module isolation.
 * On failure the memo is cleared so a later call can rebuild.
 */
let schemaTemplateReady: Promise<string> | null = null;
function ensureSchemaTemplate(): Promise<string> {
  if (schemaTemplateReady) return schemaTemplateReady;
  const ready = (async (): Promise<string> => {
    const goldenName = await ensureGoldenTemplate();
    const templateName = templateDbName();
    await serializeTemplateCopy(async () => {
      await withMaintenanceSql(async (client) => {
        // Terminate any stale session on the golden source before copying; the
        // module copy mutex ensures this never interrupts a sibling copy.
        await client`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = ${goldenName} AND pid <> pg_backend_pid()
        `;
        await client
          .unsafe(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`)
          .catch(() => {});
        await client.unsafe(`CREATE DATABASE "${templateName}" TEMPLATE "${goldenName}"`);
      });
    });
    return templateName;
  })();
  ready.catch(() => {
    // Allow a later call to rebuild the template after a transient failure.
    if (schemaTemplateReady === ready) schemaTemplateReady = null;
  });
  schemaTemplateReady = ready;
  return ready;
}

/**
 * FNXC:TestMigrationTail 2026-06-24-16:00:
 * Create a fresh, isolated PostgreSQL database with the Fusion schema applied,
 * construct a backend-mode TaskStore against it, and return the harness.
 *
 * Each call gets its own database (DB-per-test isolation). The caller MUST call
 * `harness.teardown()` in an `afterEach` / `finally` block to avoid leaking
 * databases and connections.
 *
 * @param options.poolMax - Connection pool size (default 5).
 * @param options.prefix - Database name prefix for diagnostics (default "fusion_test").
 * @param options.copyFromGolden - When true, copy the test database DIRECTLY
 *   from the run-shared golden template instead of building/copying a
 *   per-module template first. This halves per-database DDL (one CREATE
 *   DATABASE instead of two), which materially de-contends the pg-gate on
 *   high-core machines. Use it for shared-harness files that create a single
 *   database and do not exercise the per-module template lifecycle hooks.
 */
export async function createTaskStoreForTest(options?: {
  readonly poolMax?: number;
  readonly prefix?: string;
  readonly copyFromGolden?: boolean;
}): Promise<PgTestHarness> {
  const poolMax = options?.poolMax ?? 5;
  const prefix = options?.prefix ?? "fusion_test";

  const dbName = uniqueDbName(prefix);

  // FNXC:PgTestTemplateDb 2026-07-19-17:20:
  // Create the test database as a fast server-side copy of a pre-baked template.
  // `copyFromGolden` copies straight from the run-shared golden template (one
  // CREATE DATABASE); otherwise it copies from this module instance's per-module
  // template (retained for the template-lifecycle hooks/regression tests).
  // Concurrent CREATE DATABASE ... TEMPLATE copies from one connection-free
  // source are safe; only an active session on the source triggers "source
  // database is being accessed".
  const template = options?.copyFromGolden
    ? await ensureGoldenTemplate()
    : await ensureSchemaTemplate();
  await serializeTemplateCopy(async () => {
    /*
     * FNXC:PgTestTemplateDb 2026-07-17-22:34:
     * PostgreSQL can retain a just-closed baseline connection briefly. Terminate
     * stale template sessions immediately before copying; the module-local copy
     * mutex ensures this never interrupts a sibling copy using the same source.
     */
    await withMaintenanceSql(async (client) => {
      await client`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${template} AND pid <> pg_backend_pid()
      `;
    });
    try {
      await adminExecAsync(`DROP DATABASE IF EXISTS "${dbName}"`);
    } catch {
      // may not exist — safe to ignore
    }
    await adminExecAsync(`CREATE DATABASE "${dbName}" TEMPLATE "${template}"`);
  });
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

  // The database already carries the full schema (copied from the template),
  // so open the runtime connection pool and construct the AsyncDataLayer.
  const schemaBackend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: testUrl,
    migrationUrl: testUrl,
    migrationUrlOverridden: false,
  };
  const connections = await createConnectionSetFromUrl(schemaBackend, {
    poolMax,
    connectTimeoutSeconds: 5,
  });
  const layer = createAsyncDataLayer(connections);

  // Admin connection for direct row inspection/seeding in tests.
  const adminSql = postgres(testUrl, {
    max: 2,
    prepare: false,
    onnotice: () => {},
  });
  const adminDb = drizzle(adminSql);

  // Temp rootDir for filesystem operations (agent-logs, task dirs, etc.).
  const rootDir = await mkdtemp(join(tmpdir(), `${prefix}-pg-`));

  // Construct the TaskStore in backend mode.
  const store = new TaskStore(rootDir, undefined, { asyncLayer: layer });
  await store.init();

  let tornDown = false;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    try {
      store.stopWatching();
    } catch {
      // best-effort
    }
    try {
      await store.close();
    } catch {
      // best-effort
    }
    try {
      await layer.close();
    } catch {
      // best-effort
    }
    try {
      await adminSql.end({ timeout: 5 });
    } catch {
      // best-effort
    }
    try {
      await adminExecAsync(`DROP DATABASE IF EXISTS "${dbName}"`);
    } catch {
      // best-effort
    }
    try {
      await rm(rootDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return {
    store,
    layer,
    adminDb,
    rootDir,
    dbName,
    testUrl,
    teardown,
  };
}

/**
 * FNXC:TestMigrationTail 2026-06-24-16:00:
 * A vitest auto-teardown wrapper. Returns a harness that auto-tears-down in
 * afterEach, so individual tests don't need try/finally boilerplate.
 *
 * Usage:
 * ```ts
 * const h = await usePgTaskStore();
 * // h.store is ready; h.teardown() is called automatically after each test.
 * ```
 *
 * Must be called inside a test or beforeEach hook (registers afterEach).
 */
export async function usePgTaskStore(
  vitest: { afterEach: (fn: () => void | Promise<void>) => void },
  options?: { readonly poolMax?: number; readonly prefix?: string },
): Promise<PgTestHarness> {
  const harness = await createTaskStoreForTest(options);
  vitest.afterEach(async () => {
    await harness.teardown();
  });
  return harness;
}

/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * Shared PostgreSQL test harness mirroring `createSharedTaskStoreTestHarness`
 * from store-test-helpers.ts, but backed by PostgreSQL. This is the migration
 * target for the ~53 core test files that today use the SQLite shared harness.
 *
 * Design — one PG database is created in `beforeAll` and reused across every
 * test in the describe block. `beforeEach` resets state by:
 *   1. TRUNCATE-ing every application table (project/central/archive schemas)
 *      with RESTART IDENTITY CASCADE, so sequences reset and FK chains clear.
 *   2. Resetting the singleton `config` row to DEFAULT_PROJECT_SETTINGS.
 *   3. Clearing the TaskStore's in-memory caches so no cross-test state leaks.
 *
 * This is dramatically faster than `createTaskStoreForTest()` (which creates a
 * fresh database per test) because the expensive CREATE DATABASE + schema apply
 * happens once per file, not once per test.
 *
 * The harness is only usable under `pgDescribe` (auto-skipped when PG is
 * unavailable), so it never breaks the merge gate in CI.
 *
 * Usage (mirrors the SQLite shared harness shape):
 * ```ts
 * import { pgDescribe, createSharedPgTaskStoreTestHarness } from "@fusion/test-utils/pg-test-harness";
 *
 * const pgTest = pgDescribe("my feature (PostgreSQL)");
 *
 * pgTest("does a thing", async () => {
 *   const h = createSharedPgTaskStoreTestHarness();
 *   await h.beforeAll();
 *   try {
 *     await h.beforeEach();
 *     const store = h.store();
 *     // ... exercise the store ...
 *   } finally {
 *     await h.afterEach();
 *   }
 * });
 * ```
 *
 * For the common `describe` + `beforeAll/beforeEach/afterEach/afterAll` shape
 * that the existing SQLite shared harness uses, the lifecycle hooks wire up
 * directly.
 */
export interface SharedPgTaskStoreHarness {
  readonly rootDir: () => string;
  readonly globalDir: () => string;
  readonly store: () => TaskStore;
  readonly layer: () => AsyncDataLayer;
  readonly adminDb: () => PostgresJsDatabase;
  readonly beforeAll: () => Promise<void>;
  readonly beforeEach: () => Promise<void>;
  readonly afterEach: () => Promise<void>;
  readonly afterAll: () => Promise<void>;
  readonly createTestTask: () => Promise<import("../types.js").Task>;
  readonly createTaskWithSteps: () => Promise<import("../types.js").Task>;
  readonly teardown: () => Promise<void>;
}

// Eagerly compute the TRUNCATE SQL once (table set is fixed per schema version).
const ALL_APPLICATION_TABLES = [
  ...projectTableNames.map((name) => `${PROJECT_SCHEMA}.${name}`),
  ...centralTableNames.map((name) => `${CENTRAL_SCHEMA}.${name}`),
  ...archiveTableNames.map((name) => `${ARCHIVE_SCHEMA}.${name}`),
];
const TRUNCATE_ALL_SQL = `TRUNCATE TABLE ${ALL_APPLICATION_TABLES.join(", ")} RESTART IDENTITY CASCADE`;

export function createSharedPgTaskStoreTestHarness(options?: {
  readonly poolMax?: number;
  readonly prefix?: string;
}): SharedPgTaskStoreHarness {
  let harness: PgTestHarness | null = null;
  let store: TaskStore | null = null;
  // Lazily import DEFAULT_PROJECT_SETTINGS to avoid pulling the full types
  // graph at module load in environments that only use createTaskStoreForTest.
  let defaultSettingsCache: Record<string, unknown> | null = null;

  const ensureDefaults = async (): Promise<Record<string, unknown>> => {
    if (!defaultSettingsCache) {
      const { DEFAULT_PROJECT_SETTINGS } = await import("../settings-schema.js");
      defaultSettingsCache = DEFAULT_PROJECT_SETTINGS as Record<string, unknown>;
    }
    return defaultSettingsCache;
  };

  const resetStorePrivateState = (s: TaskStore): void => {
    const internal = s as unknown as {
      taskCache?: { clear?: () => void };
      debounceTimers?: { clear?: () => void };
      taskLocks?: { clear?: () => void };
      workflowStepsCache: unknown;
      taskIdStateReconciled: boolean;
      distributedTaskIdAllocator: unknown;
      agentLogFlushTimer: NodeJS.Timeout | null;
      agentLogBuffer: unknown[];
    };
    internal.taskCache?.clear?.();
    internal.debounceTimers?.clear?.();
    internal.taskLocks?.clear?.();
    internal.workflowStepsCache = null;
    internal.taskIdStateReconciled = false;
    internal.distributedTaskIdAllocator = null;
    if (internal.agentLogFlushTimer) {
      clearTimeout(internal.agentLogFlushTimer);
      internal.agentLogFlushTimer = null;
    }
    if (Array.isArray(internal.agentLogBuffer)) {
      internal.agentLogBuffer.length = 0;
    }
  };

  return {
    rootDir: () => harness?.rootDir ?? "",
    globalDir: () => harness?.rootDir ?? "",
    store: () => {
      if (!store) throw new Error("SharedPgTaskStoreHarness: beforeAll not called yet");
      return store;
    },
    layer: () => {
      if (!harness) throw new Error("SharedPgTaskStoreHarness: beforeAll not called yet");
      return harness.layer;
    },
    adminDb: () => {
      if (!harness) throw new Error("SharedPgTaskStoreHarness: beforeAll not called yet");
      return harness.adminDb;
    },
    beforeAll: async () => {
      if (harness) return;
      // FNXC:PgTestTemplateDb 2026-07-19-17:20:
      // The shared harness creates exactly ONE database per file and never uses
      // the per-module template lifecycle hooks, so copy straight from the
      // run-shared golden template to halve per-file CREATE DATABASE DDL and
      // de-contend the pg-gate on high-core machines.
      harness = await createTaskStoreForTest({
        ...options,
        prefix: options?.prefix ?? "fusion_shared",
        copyFromGolden: true,
      });
      store = harness.store;
    },
    beforeEach: async () => {
      if (!harness || !store) throw new Error("SharedPgTaskStoreHarness: beforeAll not called yet");
      // Wipe all application data and reset sequences in one statement.
      await harness.adminDb.execute(sql.raw(TRUNCATE_ALL_SQL));
      // Re-seed the singleton config row with default project settings so the
      // store sees a clean project on every test.
      const defaults = await ensureDefaults();
      const defaultsJson = JSON.stringify(defaults);
      // NOTE: drizzle's sql.identifier(schema, table) does not reliably produce
      // a schema-qualified name in all versions, so the qualification is built
      // as raw SQL with the literal schema/table (both are internal constants,
      // not user input, so interpolation is safe here).
      await harness.adminDb.execute(
        sql.raw(
          // FNXC:MultiProjectIsolation 2026-07-11: config is keyed per-project on
          // project_id (the PK) — id is no longer unique, so the upsert arbiter
          // must be project_id. Harness stores run project-agnostic (projectId '').
          `INSERT INTO ${PROJECT_SCHEMA}.config (id, project_id, next_id, next_workflow_step_id, settings, workflow_steps, updated_at)
           VALUES (1, '', 1, 1, '${defaultsJson.replace(/'/g, "''")}'::jsonb, '[]'::jsonb, now())
           ON CONFLICT (project_id) DO UPDATE SET next_id = 1, next_workflow_step_id = 1, settings = EXCLUDED.settings, workflow_steps = '[]'::jsonb, updated_at = now()`,
        ),
      );
      // Drop any in-memory caches so the store doesn't serve stale rows.
      resetStorePrivateState(store);
      // Force allocator reconciliation to re-seed the distributed state row.
      try {
        const internal = store as unknown as { reconcileTaskIdState?: () => Promise<void> };
        if (typeof internal.reconcileTaskIdState === "function") {
          await internal.reconcileTaskIdState();
        }
      } catch {
        // best-effort: reconciliation is idempotent and fail-soft
      }
    },
    afterEach: async () => {
      // No per-test connection teardown — the shared DB lives until afterAll.
      // Just quiesce any watchers/timers the test may have armed.
      if (store) {
        try {
          store.stopWatching();
        } catch {
          // best-effort
        }
      }
    },
    afterAll: async () => {
      if (harness) {
        await harness.teardown();
        harness = null;
        store = null;
      }
    },
    createTestTask: async () => {
      if (!store) throw new Error("SharedPgTaskStoreHarness: beforeAll not called yet");
      return store.createTask({ description: "Test task" });
    },
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * Creates a task with a 3-step PROMPT.md so step-order tests work.
     * Mirrors the createTaskWithSteps helper from store-test-helpers.ts.
     */
    createTaskWithSteps: async () => {
      if (!store || !harness) throw new Error("SharedPgTaskStoreHarness: beforeAll not called yet");
      const task = await store.createTask({ description: "Task with steps" });
      const dir = join(harness.rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task with steps\n## Steps\n### Step 0: Preflight\n### Step 1: Implementation\n### Step 2: Verification\n`,
      );
      const parsed = await store.parseStepsFromPrompt(task.id);
      await store.updateTask(task.id, { steps: parsed });
      return store.getTask(task.id);
    },
    teardown: async () => {
      if (harness) {
        await harness.teardown();
        harness = null;
        store = null;
      }
    },
  };
}

