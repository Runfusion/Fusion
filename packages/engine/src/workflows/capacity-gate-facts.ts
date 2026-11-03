/*
FNXC:CapacityGateFacts 2026-11-02-19:56 (RUFU-372):
"Why won't this card start?" was unanswerable from the audit store. The RunFusion freeze measured
156 `task:workflow-run-suspended` rows in 50 minutes all reading `reason=capacity` with no limit,
no used count, and no gate identity, and two of three gate guesses during the ~48h investigation
were wrong — the actually-binding running-agent predicate (`isRunningAgentTask` + the IR-trait
running-lane walk + the process-local `isPlanningLive` proof) is not reconstructible from the
database BY DESIGN, so only the emitting site can record the answer. SKEN-009 then hid the second
failure shape: 98/152 capacity rows in one 30-minute window were ONE card in a project with zero
in-progress cards and zero worktree holders — no gate was full at all.

This module answers the question once, from ONE snapshot host, so gate/used/holders can never
disagree the way three separate reads did during the incident:

- `capacityGate` is the machine-readable deliverable, a fixed enum with precedence EXACTLY
  `columnWip` → `schedulerAgentActive` → `maxConcurrent` → `unknown`:
  - `columnWip` — the target column's OWN wip-trait configured ceiling bound (the store's
    in-transaction check refuses with these facts; a column without the wip trait can never
    produce this value — `unknown` is its honest answer, per the operator's ruling that null
    must not be relabeled).
  - `schedulerAgentActive` — the card's assigned agent is active (running state or heartbeat
    within the recency window) and the canonical store-backed running-agent walk already places
    that agent's live cards at its per-agent `maxConcurrentRuns` ceiling. The incident's
    "agent gate is 8 with a population of 5" is this gate answering NOT binding.
  - `maxConcurrent` — the column ceiling arriving through the `settings.maxConcurrent`
    read-through (no explicit per-column config) bound, or an owner-supplied cross-project
    semaphore sample is at its limit. The incident's freeze is this gate.
  - `unknown` — nothing was provable at emit time. Unknown is a REAL ANSWER and still emits the
    keys with nulls: a missing key is indistinguishable from the pre-fix blind shape, which is
    exactly the blindness this task removes.
- Numbers are never collapsed: each gate reports its own limit/used pair, because a reader must
  see WHICH ceiling bound, not a min() composite.
- Holder ids are capped at five and ages derive from `columnMovedAt` first (RUFU-350's rule:
  recovery writes bump `updatedAt`, so the shared row clock cannot name how long a holder has
  been standing in its column).
- A rejecting store yields `unknown` + a bounded `capacityAgentGateError` enum + a null agent
  count — NEVER 0, which would read as an empty gate (the SKEN-009 misread rewritten).
- `safeComputeDeferralCapacityGateFacts` is the ONLY form any deferral catch/reject path may
  call: the lifecycle `suspended` branch's catch converts throws into a terminal task:graph-failed
  park + task.error, so a diagnostic that can throw would convert an explain-wait into a failure,
  and an unbounded await would park the card forever on the very gate it is diagnosing. It owns a
  wall-clock bound, never rethrows, never writes the task row, and never logs payload text.
*/

import {
  isFailedWipPark,
  resolveColumnCapacity,
  resolveMaxConcurrentSetting,
  resolveWipBudgetColumns,
  type CapacityRejectionFacts,
  type ListTasksOptions,
  type Settings,
  type Task,
  type WorkflowIr,
  type WorkflowIrResolverStore,
} from "@fusion/core";

import {
  persistedTopLevelAgentTaskIdsFromStore,
  persistedWorktreeHolderTaskIdsFromStore,
  type CapacityEnrichmentCaches,
} from "../concurrency/concurrency.js";

/** The four machine-readable gate identities. Do not rename `columnWip` — docs and monitors
 *  already name it, and its precise meaning (a wip-trait CONFIGURED ceiling bound) is
 *  disambiguated in docs/run-audit.md instead of a new spelling. */
export const CAPACITY_GATE_IDS = ["columnWip", "schedulerAgentActive", "maxConcurrent", "unknown"] as const;
export type CapacityGateId = (typeof CAPACITY_GATE_IDS)[number];

/** Bounded vocabulary for why the agent gate could not be evaluated. `store-rejected` covers
 *  every store-path rejection (an agent-execution breaker's breaker-open rejection included);
 *  `unavailable` means no agent surface was reachable at all. */
export const CAPACITY_AGENT_GATE_ERRORS = ["store-rejected", "unavailable"] as const;
export type CapacityAgentGateError = (typeof CAPACITY_AGENT_GATE_ERRORS)[number];

/** Bounded vocabulary for the safe wrapper's terminal state. */
export const CAPACITY_COMPUTE_OUTCOMES = ["complete", "partial", "timed-out", "threw"] as const;
export type CapacityComputeOutcome = (typeof CAPACITY_COMPUTE_OUTCOMES)[number];

/** Bounded vocabulary for the snapshot host. `not-required` is the host-free path (carried
 *  rejection facts only), NOT a failure. */
export const CAPACITY_STORE_OUTCOMES = ["ok", "failed", "not-required"] as const;
export type CapacityStoreOutcome = (typeof CAPACITY_STORE_OUTCOMES)[number];

/** Monitors read single rows under time pressure; five holder ids answer "who holds the slots"
 *  while keeping the metadata row bounded. */
export const CAPACITY_HOLDER_ID_CAP = 5;

/** Default bound for the safe wrapper. A deferral path must not stall on a diagnostic; 750 ms is
 *  comfortably above a healthy listTasks+walk and far below any watchdog budget. */
export const CAPACITY_SAFE_COMPUTE_DEFAULT_TIMEOUT_MS = 750;

/** Agent-activity recency window: an agent whose heartbeat is newer than this counts active
 *  (the assumeRunningIfRecent shape; injectable so tests never wait on real clocks). */
export const CAPACITY_AGENT_ACTIVITY_WINDOW_MS = 5 * 60_000;

/** The ids/counts-only diagnostic a capacity-bearing deferral records. `capacityHeldBy` is
 *  absent (not empty) when the holder set was uncomputable, so "no holders" and "holders
 *  uncomputable" stay distinguishable; the two counts stay present-and-null per the unknown
 *  rule in the header. */
export interface CapacityGateFacts {
  capacityGate: CapacityGateId;
  capacityLimit: number | null;
  capacityUsed: number | null;
  capacityHeldBy?: string[];
  capacityOldestHolderAgeMs: number | null;
  capacityAgentGateError?: CapacityAgentGateError;
  capacityComputeOutcome?: CapacityComputeOutcome;
  capacityStoreOutcome?: CapacityStoreOutcome;
}

/** The minimal store surface the snapshot host needs. `listAgents` is optional: without it the
 *  agent gate is unprovable (skipped), not failed. */
export interface CapacityFactsStoreSurface {
  listTasks?: (options?: ListTasksOptions) => Promise<Task[]> | Task[];
  listAgents?: (filter?: { includeEphemeral?: boolean }) => Promise<unknown[]> | unknown[];
}

/*
FNXC:CapacityGateFacts 2026-11-02-21:45 (RUFU-372 code review P1):
Agent rows do not live on the task store. `TaskStore` exposes no `listAgents` at all — the agent ledger is
`AgentStore`'s — so both production wirings that passed a TaskStore as the whole snapshot surface silently
DISABLED the `schedulerAgentActive` gate: `typeof store.listAgents !== "function"` set
`capacityAgentGateError: "unavailable"`, and the gate the incident's wrong guesses were about became
unreachable from every real path while the unit tests injected a hand-built `{listTasks, listAgents}` fake
and stayed green. A dedicated surface type is what makes the wiring say out loud that a second reader is
required, instead of an optional field whose absence is invisible in a type-check.
*/
/** An agent-row reader — the second store a full snapshot needs. */
export interface CapacityFactsAgentSurface {
  listAgents: (filter?: { includeEphemeral?: boolean }) => Promise<unknown[]> | unknown[];
}

/** The narrow slice of a task store this resolution needs. Declared structurally rather than importing
 *  `TaskStore`: a test fake without the accessor must still compile, and the helper must not depend on
 *  anything but the accessor's own contract. */
interface CapacityAgentStoreHost {
  getIntakeOwnerAgentStore?: () => CapacityFactsAgentSurface | null | undefined;
}

/**
 * Resolve the agent-row reader a wiring should hand the snapshot, in precedence order: the caller's own
 * AgentStore (the engine's, when it has one) → the project-scoped AgentStore the task store already owns
 * (`getIntakeOwnerAgentStore`, the same reuse seam task intake uses, chosen over constructing a
 * disposable AgentStore per deferral) → nothing.
 * Never throws. That is load-bearing, not hygiene: the accessor raises when the deployment has no async
 * agent backend, and this runs on a deferral path where a throw would convert an explain-wait into a
 * terminal `task:graph-failed` park. A `undefined` result keeps the honest diagnosis — the snapshot then
 * reports `capacityAgentGateError: "unavailable"` rather than inventing an evaluation.
 */
export function resolveCapacityAgentSurface(
  host: CapacityAgentStoreHost | undefined,
  preferred?: CapacityFactsAgentSurface | null,
): CapacityFactsAgentSurface | undefined {
  const listOwn = preferred?.listAgents;
  /*
  FNXC:CapacityGateFacts 2026-11-02-21:58 (RUFU-372 code review P1):
  The `?? undefined` is not decoration: the typeof guard narrows `preferred?.listAgents`, not `preferred`
  itself, and the wiring hands this parameter `AgentStore | null | undefined` — the executor's store is
  nullable by its own options type. Collapsing null to undefined keeps the return type at the surface the
  snapshot declares (`CapacityFactsInput["agents"]`, which has no null) instead of widening every caller.
  */
  if (typeof listOwn === "function") return preferred ?? undefined;
  const owned = host?.getIntakeOwnerAgentStore;
  if (typeof owned !== "function") return undefined;
  try {
    const store = host?.getIntakeOwnerAgentStore?.();
    return typeof store?.listAgents === "function" ? store : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ambient inputs a wiring supplies for a deferral — everything except the fields the deferring
 * branch itself owns (its IR pin, the target column, the deferred card, the carried rejection). Split out
 * so a wiring can hand over a PROVIDER of these and keep its `catch` path to a single bounded await.
 */
export type CapacityFactsAmbientSource = Partial<Pick<
  CapacityGateFactsInput,
  "store" | "agents" | "settings" | "assignedAgentId" | "caches" | "agentActivityWindowMs"
>>;

export interface CapacityGateFactsInput {
  /** The snapshot host. Absent or missing `listTasks` → host-free construction: carried facts
   *  still classify, live gates stay unknown, storeOutcome is `not-required`. */
  store?: CapacityFactsStoreSurface;
  /*
  FNXC:CapacityGateFacts 2026-11-02-21:45 (RUFU-372 code review P1):
  The agent-row reader, kept SEPARATE from `store` because the two live on different stores. A wiring that
  supplies only a TaskStore leaves this unset and the gate reports `unavailable`, which is exactly the
  blindfold this field exists to remove — so pass `resolveCapacityAgentSurface(store, agentStore)`.
  `store.listAgents` still works (test fixtures, one-store hosts) and is the fallback.
  */
  agents?: CapacityFactsAgentSurface | null;
  /** The run's resolved IR, when the caller holds one. Absent → column gates cannot be
   *  classified live (carried rejection facts still classify as `columnWip`). */
  ir?: WorkflowIr;
  /** Resolves the IR lazily, INSIDE the bounded host. A caller that must read the IR from the store
   *  uses this rather than awaiting before the call: a deferral catch may add exactly one await and
   *  that await must be the wrapper's own bound, or an unreachable store turns an explain-wait into a
   *  hang the wrapper never sees. A rejecting resolver degrades to "no IR", never to a throw. */
  irResolver?: (context: { taskId: string | undefined }) => Promise<WorkflowIr | undefined>;
  /*
  FNXC:CapacityGateFacts 2026-11-02-23:58 (RUFU-372 second revision):
  The deferral path's ambient inputs (store, settings sample, caches, assigned agent) may arrive through
  a PROVIDER resolved HERE, inside the caller's wall-clock bound — rather than by the caller awaiting them
  first. A wiring that reads `store.getSettings()` before the wrapper puts an unbounded store read on a
  `catch` path, and in the column boundary a throw from that catch converts an explain-wait into a terminal
  `task:graph-failed` park plus `task.error`: the diagnostic would then CAUSE the failure it reports.
  A provider that throws degrades to no ambient inputs (the carried refusal triple still classifies).
  Fields set directly on the input always win over the provider's.
  */
  sourceProvider?: () => CapacityFactsAmbientSource | undefined | Promise<CapacityFactsAmbientSource | undefined>;
  /** The column the deferred move targeted. */
  targetColumn?: string;
  /** The deferring card itself — never one of its own holders. */
  deferredTaskId?: string;
  /** Project ceilings consulted when naming a column ceiling. Partial on purpose: a wiring that could
   *  not read settings passes what it has (or nothing) and the read-through ceiling falls back to the
   *  code default, which is what `resolveColumnCapacity` already does. */
  settings?: Partial<Pick<Settings, "maxConcurrent">> | undefined;
  /** The store rejection's structured refusal, when the deferral came from a capacity
   *  rejection. An input to the classification, never a substitute for the live gates. */
  carried?: CapacityRejectionFacts;
  /** Owner-supplied cross-project semaphore sample (only the Scheduler process holds it).
   *  Absent → the cross-project dimension is unprovable at this site, by explicit non-goal. */
  semaphore?: { activeCount: number; limit: number } | undefined;
  /** The card's assigned agent id, when wired. Absent → the per-agent gate is unprovable. */
  assignedAgentId?: string | undefined;
  /** Agent activity recency window; injectable for fake-timer tests. */
  agentActivityWindowMs?: number;
  now?: number;
  /** Safe-wrapper wall-clock bound; injectable for fake-timer tests. */
  timeoutMs?: number;
  /** Shared IR-resolution cache so the two canonical walks cannot re-read the same workflow. */
  caches?: CapacityEnrichmentCaches;
}

interface AgentRowShape {
  id: string;
  state?: string;
  lastHeartbeatAt?: string | number;
  maxConcurrentRuns?: number;
}

/** Progressive scratch the compute fills between awaits so the safe wrapper can return a bounded
 *  PARTIAL on its own timeout instead of discarding what the compute already proved. */
interface FactsScratch {
  gate?: CapacityGateId;
  limit?: number | null;
  used?: number | null;
  heldBy?: string[];
  oldestAgeMs?: number | null;
  agentGateError?: CapacityAgentGateError;
  storeOutcome?: CapacityStoreOutcome;
}

function factsFromScratch(scratch: FactsScratch): CapacityGateFacts {
  const facts: CapacityGateFacts = {
    capacityGate: scratch.gate ?? "unknown",
    capacityLimit: scratch.limit ?? null,
    capacityUsed: scratch.used ?? null,
    capacityOldestHolderAgeMs: scratch.oldestAgeMs ?? null,
    capacityStoreOutcome: scratch.storeOutcome ?? "not-required",
  };
  // `[]` is a distinct answer from absent: it means the pool WAS consulted and is genuinely empty (or
  // has no recorded occupants), while absence means nobody could record holders at all. Collapsing them
  // is what the operator-facing "holders not recorded" sentence exists to avoid.
  if (scratch.heldBy !== undefined) facts.capacityHeldBy = scratch.heldBy.slice(0, CAPACITY_HOLDER_ID_CAP);
  if (scratch.agentGateError) facts.capacityAgentGateError = scratch.agentGateError;
  return facts;
}

function withOutcome(scratch: FactsScratch, outcome: CapacityComputeOutcome): CapacityGateFacts {
  return { ...factsFromScratch(scratch), capacityComputeOutcome: outcome };
}

function parseTimeMs(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How long the longest-holding card has held: `columnMovedAt` first (an entry stamp into the
 * holding column), then `createdAt`. `updatedAt` is deliberately NOT a base — recovery writes
 * bump the shared row clock (RUFU-350), so an age derived from it would reset every time a
 * self-healing pass touched the holder. Unparseable candidates are skipped; zero parseable
 * candidates report null, not 0.
 */
function oldestHolderAgeMs(holders: readonly Task[], now: number): number | null {
  let oldest: number | null = null;
  for (const holder of holders) {
    const base = parseTimeMs(holder.columnMovedAt) ?? parseTimeMs(holder.createdAt);
    if (base === null) continue;
    const age = now - base;
    if (age < 0) continue; // clock-skewed future stamp: untrustworthy, skip
    if (oldest === null || age > oldest) oldest = age;
  }
  return oldest;
}

/** Live occupants of the shared WIP budget: the deferring card excluded, dead parks excluded
 *  (the same `isFailedWipPark` predicate all four capacity counters share, RUFU-362), paused
 *  cards excluded, restricted to the budget column set. */
function columnOccupants(tasks: readonly Task[], budgetColumns: ReadonlySet<string>, deferredTaskId?: string): Task[] {
  return tasks.filter((task) => {
    if (task.id === deferredTaskId) return false;
    if (isFailedWipPark(task)) return false;
    if (task.paused === true || task.userPaused === true) return false;
    return budgetColumns.has(task.column);
  });
}

/** Does the target column carry its OWN configured wip ceiling (explicit `limit` /
 *  `limitSetting`)? When it does not and a finite limit still binds, the limit arrived through
 *  the `settings.maxConcurrent` read-through — a different ceiling with a different remedy, so
 *  it must report as `maxConcurrent`, not `columnWip`. Null = not evaluable (no IR/column). */
function columnHasOwnWipConfig(ir: WorkflowIr | undefined, columnId: string | undefined): boolean | null {
  if (!ir || !columnId) return null;
  // WorkflowIr is a v1|v2 union; only v2 carries the column table (core resolves v1 through
  // synthesized columns, so a v1 run classifies via carried rejection facts or unknown here).
  const columns = (ir as { columns?: Array<{ id: string; traits?: Array<{ config?: Record<string, unknown> }> }> }).columns;
  if (!Array.isArray(columns)) return null;
  const column = columns.find((candidate) => candidate.id === columnId);
  if (!column) return null;
  for (const trait of column.traits ?? []) {
    const cfg = (trait.config ?? {}) as { limit?: unknown; limitSetting?: unknown };
    if (typeof cfg.limit === "number" || typeof cfg.limitSetting === "string") return true;
  }
  return false;
}

function agentLooksActive(agent: AgentRowShape, now: number, windowMs: number): boolean {
  if (agent.state === "running" || agent.state === "active") return true;
  const beat = parseTimeMs(agent.lastHeartbeatAt);
  if (beat === null) return false;
  return now - beat >= 0 && now - beat <= windowMs;
}

/** Resolve the agent-row reader for one snapshot: the wiring's dedicated `agents` surface wins, the task
 *  store's own optional `listAgents` is the fallback (single-store hosts and test fixtures), and `undefined`
 *  means no agent surface is reachable — which the caller must report as `unavailable`, never evaluate. */
function resolveAgentRowReader(
  input: CapacityGateFactsInput,
  store: CapacityFactsStoreSurface | undefined,
): (() => Promise<unknown[]> | unknown[]) | undefined {
  const dedicated = input.agents?.listAgents;
  if (typeof dedicated === "function") {
    const agents = input.agents!;
    return () => agents.listAgents({ includeEphemeral: true });
  }
  const onStore = store?.listAgents;
  if (typeof onStore === "function") return () => onStore.call(store, { includeEphemeral: true });
  return undefined;
}

/** Shared live column-capacity evaluation for both the `columnWip` (own configured ceiling) and
 *  `maxConcurrent` (settings.maxConcurrent read-through) identities — one evaluation, one naming
 *  decision, so the two arms can never double-count from separate passes. Returns the bound
 *  facts, or null when no finite ceiling binds (caller may then consult the semaphore). */
function evaluateLiveColumnGate(
  input: CapacityGateFactsInput,
  tasks: readonly Task[],
  now: number,
): Partial<FactsScratch> | null {
  if (!input.ir || !input.targetColumn) return null;
  // A settings sample that could not be read still resolves the read-through ceiling to the code
  // default, which is what the store's own admission check does — the snapshot must not disagree with
  // the gate it is describing just because the diagnostic's own settings read failed.
  const capacity = resolveColumnCapacity(
    input.ir,
    input.targetColumn,
    { maxConcurrent: resolveMaxConcurrentSetting(input.settings) },
  );
  if (!capacity.hasCapacity || !Number.isFinite(capacity.limit)) return null;
  const holders = columnOccupants(tasks, new Set(resolveWipBudgetColumns(input.ir, input.targetColumn)), input.deferredTaskId);
  if (holders.length < capacity.limit) return null;
  const own = columnHasOwnWipConfig(input.ir, input.targetColumn);
  return {
    gate: own === false ? "maxConcurrent" : "columnWip",
    limit: capacity.limit,
    used: holders.length,
    heldBy: holders.map((holder) => holder.id),
    oldestAgeMs: oldestHolderAgeMs(holders, now),
  };
}

/** The single evaluation core, writing into the caller's scratch between awaits.
 *  ONE host: exactly one `listTasks()` call, its result reused by every gate and both holder
 *  walks, so gate identity, used counts, and holder ids describe the SAME instant — during the
 *  incident three separate reads disagreed with each other. */
async function computeGateFactsProgressive(
  input: CapacityGateFactsInput,
  scratch: FactsScratch,
): Promise<CapacityGateFacts> {
  /*
  FNXC:CapacityGateFacts 2026-11-02-21:20 / 23:58 (RUFU-372):
  The ambient-source read and the lazy IR read happen HERE, inside the caller's wall-clock bound, so a
  deferral path keeps exactly one await — the wrapper's. Resolving either before the call would put an
  unbounded store read on a `catch` path, which is the failure mode the safe wrapper exists to prevent.
  Both are best-effort: a throw degrades to "no ambient inputs" / "no IR", never to a rethrow.

  The merge is FIRST, above every capture out of `input`: resolving a provider after `store` and
  `windowMs` were already read would leave the snapshot host-less, and a host-less host reports
  `storeOutcome: "not-required"` while still classifying from the carried triple — a row that looks
  complete and quietly names no holders at all.
  */
  if (input.sourceProvider) {
    let ambient: CapacityFactsAmbientSource | undefined;
    try {
      ambient = await input.sourceProvider();
    } catch {
      ambient = undefined;
    }
    if (ambient) {
      // The deferring branch's own fields outrank the wiring's: a provider must never be able to name a
      // different target column or a different carried refusal than the move that was actually refused.
      input = {
        ...ambient,
        ...input,
        sourceProvider: undefined,
      };
    }
  }

  const now = input.now ?? Date.now();
  const windowMs = input.agentActivityWindowMs ?? CAPACITY_AGENT_ACTIVITY_WINDOW_MS;
  const store = input.store;
  let tasks: Task[] | undefined;

  if (input.ir === undefined && input.irResolver) {
    let resolvedIr: WorkflowIr | undefined;
    try {
      resolvedIr = await input.irResolver({ taskId: input.deferredTaskId });
    } catch {
      resolvedIr = undefined;
    }
    input = { ...input, ir: resolvedIr };
  }

  if (typeof store?.listTasks === "function") {
    try {
      tasks = await store.listTasks();
      scratch.storeOutcome = "ok";
    } catch {
      scratch.storeOutcome = "failed";
    }
  } else {
    scratch.storeOutcome = "not-required";
  }

  // Gate 1 — the store's own refusal. The rejection came from the in-transaction check, which
  // only ever fires on a capacity-bearing column, so a carried refusal always names a column
  // ceiling; the naming rule then splits it the same way the live branch does (an explicit wip
  // config is `columnWip`, a `settings.maxConcurrent` read-through is `maxConcurrent`, and an
  // IR that cannot be inspected keeps the conservative `columnWip`). Holder ids are best-effort
  // from the same snapshot (CapacityRejectionFacts carries column/occupants/limit only), so
  // "at-limit with no ids" stays representable — the spec's empty-heldBy data state.
  if (input.carried) {
    const own = columnHasOwnWipConfig(input.ir, input.targetColumn ?? input.carried.column);
    scratch.gate = own === false ? "maxConcurrent" : "columnWip";
    scratch.limit = input.carried.limit;
    scratch.used = input.carried.occupants;
    if (tasks) {
      const holderColumn = input.targetColumn ?? input.carried.column;
      const budgetColumns = input.ir && holderColumn
        ? new Set<string>(resolveWipBudgetColumns(input.ir, holderColumn))
        : new Set<string>(holderColumn ? [holderColumn] : []);
      const holders = budgetColumns.size > 0 ? columnOccupants(tasks, budgetColumns, input.deferredTaskId) : [];
      if (holders.length > 0) {
        scratch.heldBy = holders.map((holder) => holder.id);
        scratch.oldestAgeMs = oldestHolderAgeMs(holders, now);
      }
    }
    return withOutcome(scratch, "complete");
  }

  if (!tasks) {
    // Host-free or host-failed without carried facts: nothing live is provable. The keys stay
    // (unknown + nulls) — never an omission.
    return withOutcome(scratch, "complete");
  }

  // Gate 1 (live) — the target column's ceiling bound (own-config vs read-through naming).
  const liveColumn = evaluateLiveColumnGate(input, tasks, now);
  if (liveColumn) {
    Object.assign(scratch, liveColumn);
    return withOutcome(scratch, "complete");
  }

  // Gate 2 — schedulerAgentActive: the assigned agent is active AND the canonical store-backed
  // running-agent walk (isRunningAgentTask ⊕ IR-trait lane enrichment ⊕ isPlanningLive — reused
  // via the concurrency helpers, never reimplemented) already places that agent's live cards at
  // its per-agent maxConcurrentRuns ceiling.
  if (input.assignedAgentId && store) {
    const agentReader = resolveAgentRowReader(input, store);
    if (!agentReader) {
      scratch.agentGateError = "unavailable";
    } else {
      try {
        const agents = (await agentReader()) as AgentRowShape[];
        const agent = agents.find((candidate) => candidate.id === input.assignedAgentId);
        if (agent && agentLooksActive(agent, now, windowMs)) {
          const runningIds = await persistedTopLevelAgentTaskIdsFromStore(
            store as unknown as WorkflowIrResolverStore,
            tasks,
            input.caches,
          );
          const runningSet = new Set(runningIds);
          const busy = tasks.filter((task) => runningSet.has(task.id)
            && (task.assignedAgentId === input.assignedAgentId || task.checkedOutBy === input.assignedAgentId));
          const limit = typeof agent.maxConcurrentRuns === "number" && Number.isFinite(agent.maxConcurrentRuns) && agent.maxConcurrentRuns > 0
            ? agent.maxConcurrentRuns
            : 1;
          if (busy.length >= limit) {
            scratch.gate = "schedulerAgentActive";
            scratch.limit = limit;
            scratch.used = busy.length;
            scratch.heldBy = busy.map((task) => task.id);
            scratch.oldestAgeMs = oldestHolderAgeMs(busy, now);
            return withOutcome(scratch, "complete");
          }
        }
      } catch {
        scratch.agentGateError = "store-rejected";
        // The agent count stays null — never 0 (an empty gate is the opposite diagnosis).
        // Holder ids fall back to the worktree holder set, best-effort.
        try {
          const holders = await persistedWorktreeHolderTaskIdsFromStore(
            store as unknown as WorkflowIrResolverStore,
            tasks,
            undefined,
            input.caches,
          );
          const holderTasks = tasks.filter((task) => holders.includes(task.id) && task.id !== input.deferredTaskId);
          if (holderTasks.length > 0) {
            scratch.heldBy = holderTasks.map((holder) => holder.id);
            scratch.oldestAgeMs = oldestHolderAgeMs(holderTasks, now);
          }
        } catch {
          // Both agent surfaces failed: ids stay absent (not empty) — uncomputable, honest.
        }
        return withOutcome(scratch, "complete");
      }
    }
  }

  // Gate 3 — maxConcurrent: an owner-supplied cross-project semaphore sample at its limit.
  // (The column read-through shape of this same ceiling already named itself in Gate 1-live.)
  // The cross-project used count is only ever what its owner sampled; durable exposure of the
  // number and its holder ids is an explicit non-goal.
  if (input.semaphore && input.semaphore.activeCount >= input.semaphore.limit) {
    scratch.gate = "maxConcurrent";
    scratch.limit = input.semaphore.limit;
    scratch.used = input.semaphore.activeCount;
    return withOutcome(scratch, "complete");
  }

  /*
  FNXC:CapacityGateFacts 2026-11-02-23:05 (RUFU-372 second revision):
  Nothing binds. The keys still go out (unknown + nulls, never an omission), and the target column's
  CURRENT occupants are still reported even though they are not a ceiling: "the pool looks free" is the
  other half of the SKEN-009 question — a card parked at a structural seam while zero cards stand in the
  column — and it is answerable from the snapshot this call already took. Occupants are never dressed up
  as a limit here: `capacityGate`/`capacityLimit`/`capacityUsed` describe only a gate that BINDS.
  */
  if (tasks && input.ir && input.targetColumn) {
    const budgetColumns = new Set<string>(resolveWipBudgetColumns(input.ir, input.targetColumn));
    const occupants = columnOccupants(tasks, budgetColumns, input.deferredTaskId);
    scratch.heldBy = occupants.map((holder) => holder.id);
    // No occupants means no age to report: `heldBy: []` already says the pool is empty, and an age of 0
    // would read as "a holder that arrived this instant", which is a different claim.
    if (occupants.length > 0) scratch.oldestAgeMs = oldestHolderAgeMs(occupants, now) ?? 0;
  }

  // Nothing binds, or nothing was provable: unknown + nulls, still emitted. A
  // scheduler-owned-seam park with every gate empty (the measured SKEN-009 shape) lands here
  // beside a reason that finally means "look at the scheduler, not at capacity".
  return withOutcome(scratch, "complete");
}

/**
 * The shared snapshot evaluator. Never throws on store rejections; classification degrades to
 * unknown + bounded enums. Its outcome is complete-by-construction (no timeout of its own).
 */
export async function computeGateFacts(input: CapacityGateFactsInput): Promise<CapacityGateFacts> {
  return computeGateFactsProgressive(input, {});
}

/**
 * The gate facts from ONE snapshot host for a deferral. Same evaluation as
 * {@link computeGateFacts}; named separately so the call-site ratchet reads honestly: deferral
 * catch/reject paths may only call the `safe` spelling below.
 */
export async function computeDeferralCapacityGateFacts(input: CapacityGateFactsInput): Promise<CapacityGateFacts> {
  return computeGateFactsProgressive(input, {});
}

/**
 * The ONLY form a deferral catch/reject path may call. Own wall-clock bound (default
 * {@link CAPACITY_SAFE_COMPUTE_DEFAULT_TIMEOUT_MS}), host isolation, and it NEVER rethrows:
 * whatever the compute already proved is returned as a bounded `partial`, otherwise
 * unknown + nulls with `timed-out`/`threw`. The lifecycle suspended branch's catch converts
 * throws into a terminal task:graph-failed park + task.error — a diagnostic that could reach
 * that catch would convert an explain-wait into a failure, which is the defect class this
 * wrapper exists to delete. It never writes the task row and never logs payload text.
 */
export async function safeComputeDeferralCapacityGateFacts(
  input: CapacityGateFactsInput,
): Promise<CapacityGateFacts> {
  const timeoutMs = input.timeoutMs ?? CAPACITY_SAFE_COMPUTE_DEFAULT_TIMEOUT_MS;
  const scratch: FactsScratch = {};
  let computePromise: Promise<CapacityGateFacts>;
  try {
    computePromise = computeGateFactsProgressive(input, scratch);
  } catch {
    // Synchronous programmer error before any await: bounded outcome, never a rethrow.
    return {
      capacityGate: "unknown",
      capacityLimit: null,
      capacityUsed: null,
      capacityOldestHolderAgeMs: null,
      capacityComputeOutcome: "threw",
      capacityStoreOutcome: "not-required",
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const winner = await Promise.race([
    computePromise.then((facts) => ({ kind: "done" as const, facts })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
    }),
  ]).catch(() => ({ kind: "threw" as const }));
  if (timer) clearTimeout(timer);
  // A dropped-but-still-running compute must not surface as an unhandled rejection when it
  // later settles (the timeout arm won the race).
  void computePromise.catch(() => undefined);

  if (winner.kind === "done") return winner.facts;
  if (winner.kind === "threw") {
    // Whatever the compute proved before throwing survives — a carried refusal's classification is
    // written first, so a throw later in the walk still reports which gate bound. Only the error
    // classification is added on top of the partial.
    const threwPartial = factsFromScratch(scratch);
    return {
      ...threwPartial,
      capacityLimit: threwPartial.capacityLimit ?? null,
      capacityUsed: threwPartial.capacityUsed ?? null,
      capacityOldestHolderAgeMs: threwPartial.capacityOldestHolderAgeMs ?? null,
      capacityComputeOutcome: "threw",
      capacityStoreOutcome: scratch.storeOutcome,
    };
  }
  // Timeout: return the partial the compute already proved, or the empty unknown. The compute
  // continues harmlessly in the background (its result is dropped); the timer is cleared above.
  const partial = factsFromScratch(scratch);
  return {
    ...partial,
    capacityComputeOutcome: partial.capacityGate === "unknown" ? "timed-out" : "partial",
  };
}

/*
FNXC:CapacityGateFacts 2026-11-02-21:25 (RUFU-372):
The ONE mapping from a snapshot to run-audit metadata, so no emit site invents its own spelling.
Every key is an id, a count, an age, or a fixed enum, per the run-audit rule that no prose (reason
text, holder titles, file paths, error strings) may enter the audit store; holder TASK IDS are
permitted ids — the same class as the already-shipped `stallPoolId`.

The keys form a closed set on a capacity-bearing row: the two counts are always present and null
when unprovable, because a row that omits them is indistinguishable from one written by a build
that never had the keys. `capacityHeldBy` is the documented exception — an ABSENT list means
"holders uncomputable" while an EMPTY list means "the pool is genuinely empty at zero occupancy",
and collapsing those two would recreate the ambiguity this event exists to remove.

A non-capacity row gets `{}` from the CALLER rather than a null-filled object: a pause or a
principal hold that grew capacity keys would claim a limit was consulted when none was.
*/
export function capacityGateFactsAuditMetadata(
  facts: CapacityGateFacts | undefined,
): Record<string, unknown> {
  if (!facts) return {};
  return {
    capacityGate: facts.capacityGate,
    capacityLimit: facts.capacityLimit ?? null,
    capacityUsed: facts.capacityUsed ?? null,
    ...(facts.capacityHeldBy ? { capacityHeldBy: facts.capacityHeldBy } : {}),
    ...(facts.capacityOldestHolderAgeMs !== undefined
      ? { capacityOldestHolderAgeMs: facts.capacityOldestHolderAgeMs }
      : {}),
    capacityComputeOutcome: facts.capacityComputeOutcome ?? "complete",
    capacityStoreOutcome: facts.capacityStoreOutcome ?? "not-required",
    ...(facts.capacityAgentGateError ? { capacityAgentGateError: facts.capacityAgentGateError } : {}),
  };
}
