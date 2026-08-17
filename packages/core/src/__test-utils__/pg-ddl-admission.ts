import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";

export type PgDdlAdmissionDegradation =
  | "acquire-timeout"
  | "acquire-error"
  | "connect-failed"
  | "session-lost";

export interface PgDdlAdmissionSession {
  tryLock(slot: number): Promise<boolean>;
  unlock(slot: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface PgDdlAdmissionObservation {
  admittedDepth: number;
  observedMaxAdmittedConcurrency: number;
  ledger: readonly number[];
  observedMaxDistinctIndexCount: number;
  degradedCount: Readonly<Record<PgDdlAdmissionDegradation, number>>;
  connected: boolean;
  reconnectCount: number;
  sessionCount: number;
}

export interface PgDdlAdmissionGate {
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  observe(): PgDdlAdmissionObservation;
  reset(): Promise<void>;
}

export interface PgDdlAdmissionGateOptions {
  available: () => boolean;
  createSession: () => Promise<PgDdlAdmissionSession>;
  maxConcurrency?: number;
  acquireTimeoutMs?: number;
  random?: () => number;
  warn?: (message: string) => void;
}

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const ADMISSION_NAMESPACE = "fusion_pg_test_ddl_admission";

// Read configuration once while loading the test helper. A running worker must
// not change its semaphore size when another test mutates process.env.
const configuredMaxConcurrency = positiveEnvNumber(
  process.env.FUSION_PG_TEST_DDL_MAX_CONCURRENCY,
  DEFAULT_MAX_CONCURRENCY,
);
const configuredAcquireTimeoutMs = positiveEnvNumber(
  process.env.FUSION_PG_TEST_DDL_ADMISSION_ACQUIRE_TIMEOUT_MS,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
);

function positiveEnvNumber(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : fallback;
}

export function getPgDdlAdmissionMaxConcurrency(): number {
  return configuredMaxConcurrency;
}

export function getPgDdlAdmissionAcquireTimeoutMs(): number {
  return configuredAcquireTimeoutMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

interface Region {
  slot?: number;
  released: boolean;
  degraded?: PgDdlAdmissionDegradation;
}

interface Context {
  gate: symbol;
}

/**
 * FNXC:PgTestDdlAdmission 2026-08-16-20:30:
 * FN-9130 bounds test-harness CREATE/DROP DATABASE contention after FN-9127
 * recorded 30 drop watchdogs (maximum 3,582ms). DROP DATABASE forces a
 * cluster-wide checkpoint and ProcSignalBarrier round trip, so drops queue at
 * global server serialization points instead of parallelizing.
 *
 * Slots are session advisory locks so PostgreSQL releases them if a killed fork
 * disconnects. The one reused session is pinned to maintenance `postgres`: a
 * test-db admission session could be terminated by sibling DROP ... WITH
 * (FORCE), silently voiding live slots, while per-statement connections add
 * avoidable authentication latency. PostgreSQL counts repeat acquisitions from
 * one session; therefore the synchronous local ledger is part of correctness,
 * not an optimization. It prevents concurrent siblings in one fork from both
 * acquiring slot zero. AsyncLocalStorage rejects reentrant calls because JavaScript
 * cannot distinguish an immediately-awaited child from child work spawned in
 * parallel; reusing the parent admission would let both execute under one slot.
 *
 * Lock order is golden-marker lock, golden-build lock, template-copy chain,
 * then this innermost statement-only slot. Never gate withMaintenanceSql, a
 * baseline apply, outer advisory-lock wait, or clone retry sleep: forks holding
 * slots while awaiting the golden build lock would deadlock its winner. The
 * admitted bound never includes fail-open degradation: acquisition failures are
 * counted and warned so proof runs reject degraded measurements rather than
 * silently treating unbounded DDL as compliant.
 */
export function createPgDdlAdmissionGate(options: PgDdlAdmissionGateOptions): PgDdlAdmissionGate {
  const maxConcurrency = options.maxConcurrency ?? getPgDdlAdmissionMaxConcurrency();
  const acquireTimeoutMs = options.acquireTimeoutMs ?? getPgDdlAdmissionAcquireTimeoutMs();
  const random = options.random ?? Math.random;
  const warn = options.warn ?? console.warn;
  const ledger = new Set<number>();
  const active = new Set<Region>();
  const warned = new Set<PgDdlAdmissionDegradation>();
  const degradedCount: Record<PgDdlAdmissionDegradation, number> = {
    "acquire-timeout": 0,
    "acquire-error": 0,
    "connect-failed": 0,
    "session-lost": 0,
  };
  const asyncContext = new AsyncLocalStorage<Context>();
  const gateIdentity = Symbol("pg-ddl-admission-gate");
  let session: PgDdlAdmissionSession | undefined;
  let sessionPromise: Promise<PgDdlAdmissionSession> | undefined;
  let reconnectCount = 0;
  let sessionCount = 0;
  let observedMaxAdmittedConcurrency = 0;
  let observedMaxDistinctIndexCount = 0;
  let exitHookInstalled = false;

  const markDegraded = (region: Region, reason: PgDdlAdmissionDegradation): void => {
    if (region.degraded) return;
    region.degraded = reason;
    degradedCount[reason] += 1;
    if (!warned.has(reason)) {
      warned.add(reason);
      warn(
        `[pg-ddl-admission] degraded=${reason} maxConcurrency=${maxConcurrency} acquireTimeoutMs=${acquireTimeoutMs}`,
      );
    }
  };

  const discardSession = async (): Promise<void> => {
    const previous = session;
    session = undefined;
    sessionPromise = undefined;
    // The server has already released all session-owned locks; retaining these
    // local claims would permanently shrink this fork's available slot range.
    ledger.clear();
    for (const region of active) {
      if (!region.released) markDegraded(region, "session-lost");
    }
    // Reclassified regions are no longer admitted: the server has voided their
    // locks, so observations must not report them as live slot holders.
    active.clear();
    await previous?.close().catch(() => {});
  };

  const getSession = async (): Promise<PgDdlAdmissionSession> => {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = options.createSession().then((created) => {
        session = created;
        sessionCount += 1;
        if (sessionCount > 1) reconnectCount += 1;
        if (!exitHookInstalled) {
          exitHookInstalled = true;
          // This hook is installed only after lazy connection succeeds. It owns
          // no timer/handle, is idempotent through discardSession(), and does
          // not reconnect during shutdown if availability was turned off.
          process.once("beforeExit", () => {
            if (options.available()) void discardSession();
          });
        }
        return created;
      });
    }
    try {
      return await sessionPromise;
    } catch (error) {
      sessionPromise = undefined;
      throw error;
    }
  };

  const release = async (region: Region): Promise<void> => {
    if (region.released) return;
    region.released = true;
    active.delete(region);
    if (region.slot === undefined) return;
    const slot = region.slot;
    // A session-loss discard already cleared the ledger because PostgreSQL
    // released every server lock. Do not unlock a potentially reissued slot.
    if (!ledger.has(slot)) return;
    try {
      const unlocked = await session?.unlock(slot);
      if (!unlocked) throw new Error("advisory unlock rejected");
      ledger.delete(slot);
    } catch {
      // This region's unlock failed, so its session-owned slot is already
      // suspect. Mark it before discardSession() sees its released guard.
      markDegraded(region, "session-lost");
      await discardSession();
    }
  };

  const acquire = async (): Promise<Region> => {
    const region: Region = { released: false };
    if (!options.available()) return region;
    const deadline = Date.now() + acquireTimeoutMs;
    while (Date.now() < deadline) {
      let candidate: number | undefined;
      const offset = Math.floor(random() * maxConcurrency);
      // Claim before awaiting the server; synchronous Set mutation prevents a
      // same-session counted advisory lock from double-booking this index.
      for (let step = 0; step < maxConcurrency; step += 1) {
        const slot = (offset + step) % maxConcurrency;
        if (!ledger.has(slot)) {
          ledger.add(slot);
          candidate = slot;
          break;
        }
      }
      if (candidate === undefined) {
        await sleep(5 + Math.floor(random() * 10));
        continue;
      }
      try {
        const current = await getSession();
        const locked = await current.tryLock(candidate);
        if (locked) {
          region.slot = candidate;
          active.add(region);
          observedMaxAdmittedConcurrency = Math.max(observedMaxAdmittedConcurrency, active.size);
          observedMaxDistinctIndexCount = Math.max(observedMaxDistinctIndexCount, ledger.size);
          return region;
        }
        ledger.delete(candidate);
      } catch {
        ledger.delete(candidate);
        const reason: PgDdlAdmissionDegradation = session ? "acquire-error" : "connect-failed";
        await discardSession();
        markDegraded(region, reason);
        return region;
      }
      await sleep(5 + Math.floor(random() * 10));
    }
    markDegraded(region, "acquire-timeout");
    return region;
  };

  return {
    async run<T>(fn: () => Promise<T> | T): Promise<T> {
      if (asyncContext.getStore()?.gate === gateIdentity) {
        /*
         * FNXC:PgTestDdlAdmission 2026-08-16-22:54:
         * A reentrant callback cannot safely borrow its parent's advisory slot.
         * AsyncLocalStorage propagates into both awaited and spawned work, so
         * borrowing lets a parent and any number of children run concurrently
         * while observations still report one admission. Fail closed instead;
         * callers must keep admission regions leaf-level and statement-scoped.
         */
        throw new Error("pg DDL admission regions cannot be nested");
      }
      const region = await acquire();
      return asyncContext.run({ gate: gateIdentity }, async () => {
        try {
          return await fn();
        } finally {
          await release(region);
        }
      });
    },
    observe(): PgDdlAdmissionObservation {
      return {
        admittedDepth: active.size,
        observedMaxAdmittedConcurrency,
        ledger: [...ledger].sort((a, b) => a - b),
        observedMaxDistinctIndexCount,
        degradedCount: { ...degradedCount },
        connected: Boolean(session),
        reconnectCount,
        sessionCount,
      };
    },
    async reset(): Promise<void> {
      await discardSession();
      active.clear();
      ledger.clear();
      observedMaxAdmittedConcurrency = 0;
      observedMaxDistinctIndexCount = 0;
      for (const reason of Object.keys(degradedCount) as PgDdlAdmissionDegradation[]) {
        degradedCount[reason] = 0;
      }
      warned.clear();
      reconnectCount = 0;
      sessionCount = 0;
    },
  };
}

export function createPostgresDdlAdmissionGate(options: {
  available: () => boolean;
  urlBase: string;
}): PgDdlAdmissionGate {
  return createPgDdlAdmissionGate({
    available: options.available,
    async createSession(): Promise<PgDdlAdmissionSession> {
      const url = new URL(options.urlBase);
      url.pathname = "/postgres";
      const client = postgres(url.toString(), {
        max: 1,
        prepare: false,
        connect_timeout: 1,
        onnotice: () => {},
      });
      try {
        await client`SELECT 1`;
      } catch (error) {
        await client.end({ timeout: 0 }).catch(() => {});
        throw error;
      }
      return {
        async tryLock(slot): Promise<boolean> {
          const rows = await client.unsafe<{ locked: boolean }[]>(
            "SELECT pg_try_advisory_lock(hashtext($1), $2) AS locked",
            [ADMISSION_NAMESPACE, slot],
          );
          return rows[0]?.locked === true;
        },
        async unlock(slot): Promise<boolean> {
          const rows = await client.unsafe<{ unlocked: boolean }[]>(
            "SELECT pg_advisory_unlock(hashtext($1), $2) AS unlocked",
            [ADMISSION_NAMESPACE, slot],
          );
          return rows[0]?.unlocked === true;
        },
        async close(): Promise<void> {
          await client.end({ timeout: 5 }).catch(() => {});
        },
      };
    },
  });
}
