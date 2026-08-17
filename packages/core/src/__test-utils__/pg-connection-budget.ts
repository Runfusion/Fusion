import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";

/** A server backend is the unit used by the PostgreSQL test-harness budget. */
export interface PgSlotSpace {
  slotCount: number;
  maxParticipants: number;
  leaseBand: readonly [number, number];
  workBand: readonly [number, number];
}

export interface PgForkWorkReserve {
  minHarnessSlotCost: number;
  forkWorkReserve: number;
  floorSlotCost: number;
}

export interface PgHarnessConnectionBudget {
  poolMax: number;
  adminMax: number;
  migrationSlots: number;
  totalSlots: number;
  floored: boolean;
}

export type PgBudgetDegradation =
  | "capacity-unreadable"
  | "bootstrap-gate-unavailable"
  | "bootstrap-connect-failed";

export class PgConnectionBudgetConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgConnectionBudgetConcurrencyError";
  }
}

export const MAX_LIVE_HARNESSES_PER_PARTICIPANT = 2;
export const MIGRATION_SLOTS_PER_HARNESS = 1;
export const TEMPLATE_BUILD_SLOTS = 3;
export const FOREIGN_RESERVE = 8;
export const BOOTSTRAP_RESERVE = 4;
export const TOKEN_STALE_MS = 30_000;
export const IDLE_LINGER_MS = 250;
export const BOOTSTRAP_DEBURST_WINDOW_MS = 2_000;
/** This is intentionally a minimum supported cluster capacity, never a typical value. */
export const DEGRADED_MIN_MAX_CONNECTIONS = 20;
/** This deliberately over-estimates reserved superuser capacity for conservative fallback. */
export const DEGRADED_MAX_SUPERUSER_RESERVED = 5;

const LEASE_CLASS_ID = 1_913_101;
const TOKEN_DIRECTORY = join(tmpdir(), "fusion-pg-connection-budget");
let moduleInstanceSequence = 0;

/*
FNXC:PgTestConnectionBudget 2026-08-17-00:41:
FN-9131 fixes the 27-worker / 100-backend PostgreSQL harness failure by making
admission cluster-shared instead of dividing a lane-local worker count. A live
harness consumes its pool ceiling plus its dedicated migration pool and admin
pool; template construction needs three funded backends before it takes its
blocking golden-template lock.

The bootstrap session is the one unavoidable pre-slot connection: it reads
cluster settings then becomes the lease session. Fixed-name payload-free mkdir
tokens shape that burst on one host; stale entries are reclaimed after
TOKEN_STALE_MS and all correctness still comes from close-on-failure plus the
server advisory-lock registry. If the token directory is unavailable, a
participant uses an identity-derived delay and retries connects, never a local
token presented as a cross-process bound. Capacity-read failure uses a low
floor and high reserved value, so degraded lock ranges are subsets of healthy
ranges and mixed participants can under-issue but cannot over-issue.

A participant is a loaded module instance, not a PID. It claims lease and all
work reserve once per active window, then lends slots locally without waiting.
Template slots are acquired before a golden lock; acquiring after that lock
could deadlock a holder behind its own live harness. This namespace is fixed
and distinct from the harness hashtext locks and FN-9130 DDL admission.

FNXC:PgTestConnectionBudget 2026-08-17-01:36:
At P=27 against 12 participants, registry over-subscription is normal rather
than an exceptional test failure. A participant now retains its lease while it
waits for an all-or-nothing work reserve; this avoids re-bootstrap and lease
band churn, while a participant without a lease holds no backend or token.
Only a local request exceeding MAX_LIVE_HARNESSES_PER_PARTICIPANT or the held
reserve may raise PgConnectionBudgetConcurrencyError.

FNXC:PgTestConnectionBudget 2026-08-17-01:55:
A healthy exhausted bootstrap-token band is ordinary queue pressure, not the
R11 gate-unavailable condition: it must wait without opening a bootstrap
backend. The first-window promise is shared by concurrent callers in one
loaded module instance, so one participant cannot create or leak multiple
lease sessions while its reserve is being acquired.
*/

export function derivePgForkWorkReserve(input: {
  maxLiveHarnesses: number;
  flooredPoolMax: number;
  migrationSlots: number;
  flooredAdminMax: number;
  templateBuildSlots: number;
}): PgForkWorkReserve {
  const minHarnessSlotCost = input.flooredPoolMax + input.migrationSlots + input.flooredAdminMax;
  const forkWorkReserve = Math.max(
    input.maxLiveHarnesses * minHarnessSlotCost,
    input.templateBuildSlots + minHarnessSlotCost,
  );
  return { minHarnessSlotCost, forkWorkReserve, floorSlotCost: 1 + forkWorkReserve };
}

export const PG_FORK_WORK_RESERVE = derivePgForkWorkReserve({
  maxLiveHarnesses: MAX_LIVE_HARNESSES_PER_PARTICIPANT,
  flooredPoolMax: 1,
  migrationSlots: MIGRATION_SLOTS_PER_HARNESS,
  flooredAdminMax: 1,
  templateBuildSlots: TEMPLATE_BUILD_SLOTS,
});

export function derivePgSlotSpace(input: {
  maxConnections: number;
  superuserReserved: number;
  foreignReserve: number;
  bootstrapReserve: number;
  floorSlotCost: number;
}): PgSlotSpace {
  const slotCount = Math.max(
    input.floorSlotCost,
    Math.floor(input.maxConnections) - Math.floor(input.superuserReserved) - input.foreignReserve - input.bootstrapReserve,
  );
  const maxParticipants = Math.floor(slotCount / input.floorSlotCost);
  return {
    slotCount,
    maxParticipants,
    leaseBand: [0, maxParticipants],
    workBand: [maxParticipants, slotCount],
  };
}

export function deriveDegradedPgSlotSpace(): PgSlotSpace {
  return derivePgSlotSpace({
    maxConnections: DEGRADED_MIN_MAX_CONNECTIONS,
    superuserReserved: DEGRADED_MAX_SUPERUSER_RESERVED,
    foreignReserve: FOREIGN_RESERVE,
    bootstrapReserve: BOOTSTRAP_RESERVE,
    floorSlotCost: PG_FORK_WORK_RESERVE.floorSlotCost,
  });
}

export function derivePgConnectionBudget(input: {
  lentWorkSlots: number;
  liveHarnesses: number;
}): PgHarnessConnectionBudget {
  if (input.liveHarnesses < 1 || input.lentWorkSlots < 3) {
    throw new PgConnectionBudgetConcurrencyError("FORK_WORK_RESERVE cannot fund the minimum three-slot harness");
  }
  // Reserve one migration and one admin backend; any remaining funded capacity is runtime pool.
  const poolMax = Math.max(1, Math.min(5, input.lentWorkSlots - 2));
  const adminMax = 1;
  const migrationSlots = 1;
  const totalSlots = poolMax + adminMax + migrationSlots;
  return { poolMax, adminMax, migrationSlots, totalSlots, floored: totalSlots === 3 };
}

export function expectedPgAdmissionWaitMs(input: {
  participants: number;
  maxParticipants: number;
  p95WindowMs: number;
  lingerMs: number;
  deburstMs: number;
}): number {
  if (input.maxParticipants < 1) return Number.POSITIVE_INFINITY;
  return Math.ceil(input.participants / input.maxParticipants) * (input.p95WindowMs + input.lingerMs) + input.deburstMs;
}

export interface PgConnectionBudgetObservation {
  slotCount?: number;
  maxParticipants?: number;
  forkWorkReserve: number;
  minHarnessSlotCost: number;
  derivationMode?: "healthy" | "degraded-floor";
  leaseHeld: boolean;
  heldWorkSlots: number;
  lentWorkSlots: number;
  templateSlotsHeld: number;
  liveHarnesses: number;
  degradedCount: Readonly<Record<PgBudgetDegradation, number>>;
  bootstrapAttempts: number;
  bootstrapRetries: number;
  bootstrapTokenWaits: number;
  bootstrapTokenReclaims: number;
  deburstDelayMs: number;
  maxBootstrapWaitMs: number;
  floorAdmissionWaits: number;
  maxFloorWaitMs: number;
  concurrencyRejections: number;
}

interface Token { release(): Promise<void>; }

type TokenAttempt =
  | { kind: "acquired"; token: Token }
  | { kind: "exhausted" }
  | { kind: "unavailable" };

async function tryAcquireToken(index: number): Promise<TokenAttempt> {
  const path = join(TOKEN_DIRECTORY, `token-${index}`);
  try {
    await mkdir(TOKEN_DIRECTORY, { recursive: true });
  } catch {
    return { kind: "unavailable" };
  }

  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { kind: "unavailable" };
    try {
      if (Date.now() - (await stat(path)).mtimeMs > TOKEN_STALE_MS) {
        await rm(path, { recursive: true, force: true });
        await mkdir(path);
        tokenReclaims += 1;
      } else {
        // A healthy semaphore at capacity is queueing, not R11 degradation.
        return { kind: "exhausted" };
      }
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return { kind: "exhausted" };
      return { kind: "unavailable" };
    }
  }
  let released = false;
  return {
    kind: "acquired",
    token: { async release() { if (!released) { released = true; await rm(path, { recursive: true, force: true }); } } },
  };
}

/** Test-only exact-name access; production admission only scans the fixed token band. */
export async function __tryAcquirePgConnectionBudgetTokenForTest(index: number): Promise<TokenAttempt> {
  return tryAcquireToken(index);
}

let tokenReclaims = 0;

class ConnectionBudget {
  readonly instance = ++moduleInstanceSequence;
  readonly degradedCount: Record<PgBudgetDegradation, number> = {
    "capacity-unreadable": 0,
    "bootstrap-gate-unavailable": 0,
    "bootstrap-connect-failed": 0,
  };
  readonly heldWork = new Set<number>();
  private lease?: Sql;
  private space?: PgSlotSpace;
  private derivationMode?: "healthy" | "degraded-floor";
  private reserveHeld = false;
  /** One module instance may own only one bootstrap/lease acquisition at a time. */
  private windowAcquisition?: Promise<void>;
  private liveHarnesses = 0;
  private lentWorkSlots = 0;
  private templateSlotsHeld = 0;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private contention = false;
  bootstrapAttempts = 0;
  bootstrapRetries = 0;
  bootstrapTokenWaits = 0;
  deburstDelayMs = 0;
  maxBootstrapWaitMs = 0;
  floorAdmissionWaits = 0;
  maxFloorWaitMs = 0;
  concurrencyRejections = 0;

  private degrade(reason: PgBudgetDegradation): void {
    this.degradedCount[reason] += 1;
    if (this.degradedCount[reason] === 1) console.warn(`[pg-connection-budget] degraded=${reason}`);
  }

  private async acquireLease(urlBase: string): Promise<"acquired" | "token-exhausted"> {
    const started = Date.now();
    let token: Token | undefined;
    let client: Sql | undefined;
    let retainedLease = false;
    try {
      let gateUnavailable = false;
      for (let index = 0; index < BOOTSTRAP_RESERVE; index += 1) {
        const attempt = await tryAcquireToken((this.instance + index) % BOOTSTRAP_RESERVE);
        if (attempt.kind === "acquired") { token = attempt.token; break; }
        if (attempt.kind === "unavailable") { gateUnavailable = true; break; }
      }
      if (!token && !gateUnavailable) {
        // The healthy host semaphore is saturated: do not turn this into an ungated connect.
        this.bootstrapTokenWaits += 1;
        return "token-exhausted";
      }
      if (!token) {
        this.degrade("bootstrap-gate-unavailable");
        this.deburstDelayMs = ((process.pid * 31 + this.instance * 17) >>> 0) % BOOTSTRAP_DEBURST_WINDOW_MS;
        await new Promise<void>((resolve) => setTimeout(resolve, this.deburstDelayMs));
      }
      const maintenanceUrl = new URL(urlBase);
      maintenanceUrl.pathname = "/postgres";
      this.bootstrapAttempts += 1;
      client = postgres(maintenanceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
      let maxConnections = DEGRADED_MIN_MAX_CONNECTIONS;
      let superuserReserved = DEGRADED_MAX_SUPERUSER_RESERVED;
      try {
        const rows = await client.unsafe<{ max_connections: string; superuser_reserved_connections: string }>(
          "SELECT current_setting('max_connections') AS max_connections, current_setting('superuser_reserved_connections') AS superuser_reserved_connections",
        );
        maxConnections = Number(rows[0]?.max_connections);
        superuserReserved = Number(rows[0]?.superuser_reserved_connections);
        if (!Number.isFinite(maxConnections) || !Number.isFinite(superuserReserved)) throw new Error("invalid capacity settings");
        this.derivationMode = "healthy";
      } catch {
        this.degrade("capacity-unreadable");
        this.derivationMode = "degraded-floor";
      }
      this.space = derivePgSlotSpace({ maxConnections, superuserReserved, foreignReserve: FOREIGN_RESERVE, bootstrapReserve: BOOTSTRAP_RESERVE, floorSlotCost: PG_FORK_WORK_RESERVE.floorSlotCost });
      for (let index = this.space.leaseBand[0]; index < this.space.leaseBand[1]; index += 1) {
        const rows = await client.unsafe<{ acquired: boolean }>(`SELECT pg_try_advisory_lock(${LEASE_CLASS_ID}, ${index}) AS acquired`);
        if (rows[0]?.acquired) {
          this.lease = client;
          retainedLease = true;
          return "acquired";
        }
      }
      return "token-exhausted";
    } catch (error) {
      // Connect and registry-query failures are real failures, not degradation aliases.
      this.degrade("bootstrap-connect-failed");
      throw error;
    } finally {
      if (!retainedLease) await client?.end({ timeout: 0 }).catch(() => {});
      await token?.release().catch(() => {});
      this.maxBootstrapWaitMs = Math.max(this.maxBootstrapWaitMs, Date.now() - started);
    }
  }

  private async claimReserve(): Promise<boolean> {
    if (!this.lease || !this.space) return false;
    const started = Date.now();
    const claimed: number[] = [];
    for (let index = this.space.workBand[0]; index < this.space.workBand[1] && claimed.length < PG_FORK_WORK_RESERVE.forkWorkReserve; index += 1) {
      const rows = await this.lease.unsafe<{ acquired: boolean }>(`SELECT pg_try_advisory_lock(${LEASE_CLASS_ID}, ${index}) AS acquired`);
      if (rows[0]?.acquired) claimed.push(index);
    }
    if (claimed.length !== PG_FORK_WORK_RESERVE.forkWorkReserve) {
      for (const index of claimed) await this.lease.unsafe(`SELECT pg_advisory_unlock(${LEASE_CLASS_ID}, ${index})`);
      this.floorAdmissionWaits += 1;
      this.contention = true;
      this.maxFloorWaitMs = Math.max(this.maxFloorWaitMs, Date.now() - started);
      return false;
    }
    claimed.forEach((index) => this.heldWork.add(index));
    this.reserveHeld = true;
    return true;
  }

  async acquireWindow(urlBase: string): Promise<void> {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = undefined; }
    if (this.reserveHeld) return;
    if (this.windowAcquisition) return this.windowAcquisition;
    const acquisition = this.acquireWindowInner(urlBase);
    this.windowAcquisition = acquisition;
    try {
      await acquisition;
    } finally {
      if (this.windowAcquisition === acquisition) this.windowAcquisition = undefined;
    }
  }

  private async acquireWindowInner(urlBase: string): Promise<void> {
    /*
    FNXC:PgTestConnectionBudget 2026-08-17-01:36:
    Registry contention queues here instead of consuming a harness test or hook
    with a bounded-attempt failure. Failed bootstrap attempts have already
    closed their client and released their token. Once a lease is held, R4's
    separate work band makes it safe to retain only that lease across partial
    reserve rollbacks; releasing it would let late arrivals thrash the lease
    band and multiply bootstrap connections.
    */
    let attempt = 0;
    while (!this.reserveHeld) {
      if (!this.lease) {
        const leaseAttempt = await this.acquireLease(urlBase);
        if (leaseAttempt === "token-exhausted") {
          this.bootstrapRetries += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, 5 * 2 ** Math.min(attempt, 4))));
          attempt += 1;
          continue;
        }
      }
      if (await this.claimReserve()) return;
      this.bootstrapRetries += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, 5 * 2 ** Math.min(attempt, 4))));
      attempt += 1;
    }
  }

  acquireHarness(): PgHarnessConnectionBudget {
    if (!this.reserveHeld || this.liveHarnesses >= MAX_LIVE_HARNESSES_PER_PARTICIPANT) {
      this.concurrencyRejections += 1;
      throw new PgConnectionBudgetConcurrencyError("MAX_LIVE_HARNESSES_PER_PARTICIPANT reserve cannot fund another harness");
    }
    const available = this.heldWork.size - this.lentWorkSlots - this.templateSlotsHeld;
    // Keep the minimum allotment for every allowed sibling harness. This makes
    // Promise.all creation fail fast only above the declared local limit.
    const siblingsStillAllowed = MAX_LIVE_HARNESSES_PER_PARTICIPANT - this.liveHarnesses - 1;
    const fundedForThisHarness = available - siblingsStillAllowed * PG_FORK_WORK_RESERVE.minHarnessSlotCost;
    const budget = derivePgConnectionBudget({ lentWorkSlots: fundedForThisHarness, liveHarnesses: this.liveHarnesses + 1 });
    this.lentWorkSlots += budget.totalSlots;
    this.liveHarnesses += 1;
    return budget;
  }

  releaseHarness(budget: PgHarnessConnectionBudget): void {
    this.lentWorkSlots = Math.max(0, this.lentWorkSlots - budget.totalSlots);
    this.liveHarnesses = Math.max(0, this.liveHarnesses - 1);
    if (this.liveHarnesses === 0) {
      const linger = this.contention ? 0 : IDLE_LINGER_MS;
      this.releaseTimer = setTimeout(() => { void this.closeWindow(); }, linger);
    }
  }

  acquireTemplate(): () => void { return this.acquireLocal(TEMPLATE_BUILD_SLOTS, "TEMPLATE_BUILD_SLOTS must be funded before the golden advisory lock"); }

  acquireMaintenance(): () => void { return this.acquireLocal(1, "the funded reserve cannot open a maintenance client"); }

  acquireCharge(cost: number): () => void {
    return this.acquireLocal(cost, "requested connection charge exceeds the held reserve");
  }

  private acquireLocal(cost: number, message: string): () => void {
    if (!this.reserveHeld || this.heldWork.size - this.lentWorkSlots - this.templateSlotsHeld < cost) {
      this.concurrencyRejections += 1;
      throw new PgConnectionBudgetConcurrencyError(message);
    }
    this.templateSlotsHeld += cost;
    return () => { this.templateSlotsHeld = Math.max(0, this.templateSlotsHeld - cost); };
  }

  async closeWindow(): Promise<void> {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = undefined; }
    if (!this.lease) return;
    for (const slot of this.heldWork) await this.lease.unsafe(`SELECT pg_advisory_unlock(${LEASE_CLASS_ID}, ${slot})`).catch(() => {});
    this.heldWork.clear();
    await this.lease.end({ timeout: 0 }).catch(() => {});
    this.lease = undefined;
    this.space = undefined;
    this.reserveHeld = false;
    this.lentWorkSlots = 0;
  }

  observe(): PgConnectionBudgetObservation {
    return {
      slotCount: this.space?.slotCount, maxParticipants: this.space?.maxParticipants,
      forkWorkReserve: PG_FORK_WORK_RESERVE.forkWorkReserve, minHarnessSlotCost: PG_FORK_WORK_RESERVE.minHarnessSlotCost,
      derivationMode: this.derivationMode, leaseHeld: Boolean(this.lease), heldWorkSlots: this.heldWork.size,
      lentWorkSlots: this.lentWorkSlots, templateSlotsHeld: this.templateSlotsHeld, liveHarnesses: this.liveHarnesses,
      degradedCount: { ...this.degradedCount }, bootstrapAttempts: this.bootstrapAttempts, bootstrapRetries: this.bootstrapRetries,
      bootstrapTokenWaits: this.bootstrapTokenWaits, bootstrapTokenReclaims: tokenReclaims, deburstDelayMs: this.deburstDelayMs,
      maxBootstrapWaitMs: this.maxBootstrapWaitMs, floorAdmissionWaits: this.floorAdmissionWaits,
      maxFloorWaitMs: this.maxFloorWaitMs, concurrencyRejections: this.concurrencyRejections,
    };
  }
}

const budget = new ConnectionBudget();

export async function resolvePgConnectionBudget(input: { available: boolean; urlBase: string }): Promise<void> {
  if (!input.available || process.env.FUSION_PG_TEST_SKIP === "1") return;
  await budget.acquireWindow(input.urlBase);
}

export async function acquirePgHarnessConnectionBudget(input: { available: boolean; urlBase: string }): Promise<PgHarnessConnectionBudget> {
  await resolvePgConnectionBudget(input);
  return budget.acquireHarness();
}

export function releasePgHarnessConnectionBudget(allotment: PgHarnessConnectionBudget): void { budget.releaseHarness(allotment); }
export function acquirePgTemplateBuildAllotment(): () => void { return budget.acquireTemplate(); }
/** Maintenance callers may only borrow a funded reserve; they never wait or touch registry locks. */
export function acquirePgMaintenanceAllotment(): () => void { return budget.acquireMaintenance(); }
export function observePgConnectionBudget(): PgConnectionBudgetObservation { return budget.observe(); }
export async function __resetPgConnectionBudgetForTest(): Promise<void> { await budget.closeWindow(); }
export async function withConnectionCharge<T>(cost: number, fn: () => Promise<T>): Promise<T> {
  // Transient maintenance work is charged at its requested ceiling, not as a
  // fictitious second harness that would consume the local concurrency limit.
  const release = budget.acquireCharge(cost);
  try { return await fn(); } finally { release(); }
}
