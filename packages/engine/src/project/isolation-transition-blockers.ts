import type { Task } from "@fusion/core";

/*
FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
An isolation-mode transition asks "is anything running?" and then destroys the runtime, so a false
"yes" is an operator who cannot change the setting at all. The count that guard reads
(`RuntimeMetrics.inFlightTasks`) is process memory, and process memory lags the board in BOTH
directions: a card whose run ended can keep its worktree binding (RUFU-323 fixed the most common
producer of that, not the shape), and a card the operator cleared by hand can still be held by a live
session that has not unwound. The recorded incident was the first shape — two cards whose rows read
`status: "failed"` refused every unforced `in-process -> child-process` transition for hours while the
project executed nothing.

This module is the durable half of the answer. It is consulted ONLY when the in-memory count says
busy, and it answers one of exactly three things:
  • `{ blockers: [] }`            — durable state proved every named card is a terminal in-progress park.
  • `{ blockers: [ids…] }`        — durable state named at least one card that still counts.
  • `{ blockers: null }`          — CANNOT ANSWER. Never `[]`; an empty list is a claim about the
    board, and a read that timed out, rejected, or had no store behind it proves nothing, so the
    caller must keep its historical refusal instead of laundering uncertainty into permission.
Uncertainty is therefore expressed by `null`, never by an empty list.

Two independent time bounds, outer strictly greater than inner: a single board read must never cost
more than the whole decision may spend. Both live here and nowhere else, and no caller may invent a
third — this task's budget surface is closed.
*/

/** Outer bound: the maximum wall time the whole transition decision may consume. */
export const ISOLATION_BLOCKER_READ_TIMEOUT_MS = 500;

/**
 * Inner bound for one batched durable read. It must stay strictly below
 * {@link ISOLATION_BLOCKER_READ_TIMEOUT_MS}: a read that is allowed to run as long as its own caller
 * is waiting would leave the caller with no budget to notice the overrun.
 */
export const ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS = 300;

/*
FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
The lanes a holder may legitimately be waiting in, using the SAME lane literals the canonical
terminal-failure classifier (`executor/worktree-release-classifier.ts`) reads. A candidate outside
this set is not "not in flight" — it is a card the read did not describe, which counts as unknown and
therefore blocking.
*/
const BLOCKER_CANDIDATE_LANES = ["in-progress", "todo", "in-review"] as const;
/** The lane a plain execute-node terminal park leaves its card in — see `worktree-release-classifier.ts`. */
const TERMINAL_PARK_LANE = "in-progress";

/** The board-shaped row fields the classification needs; anything else is projection cost for nothing. */
export type IsolationBlockerRow = Pick<Task, "id" | "column" | "status">;

/** Sentinel that turns "the store rejected or threw" into a value, so a rejection is not read as a timeout. */
const READ_REJECTED = Symbol("isolation-blocker-read-rejected");

/** The minimum durable surface this decision needs. Structural so a runtime can hand its own store. */
export interface IsolationBlockerReadStore {
  listTasks(options: {
    columns: readonly string[];
    derive: false;
    excludeLog: true;
  }): Promise<readonly IsolationBlockerRow[]>;
}

/** Why the decision came out the way it did. Fixed vocabulary: it is what a refusal sentence quotes. */
export type IsolationBlockerDecisionReason =
  /** Durable state answered and every named holder is a terminal in-progress park. */
  | "declared-clear"
  /** Durable state answered and named at least one card that still counts as blocking. */
  | "declared-blocked"
  /** No store (or one without a board-shaped list read) was reachable at all. */
  | "store-unavailable"
  /** The batched read exceeded its own bound. */
  | "read-timed-out"
  /** The batched read rejected or threw. */
  | "read-rejected"
  /** The outer budget was already spent before the read could be issued. */
  | "budget-exhausted"
  /*
   * FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
   * Transport-origin causes. An isolated project answers the same question across a process boundary, and
   * a lost channel is a different operator remedy from a slow store: nothing in the database can be
   * repaired to unblock the transition. They live in this closed vocabulary rather than a parallel one so
   * every `taskIds: null` answer in every isolation mode names its cause from the same enum, and a
   * `[]` (proven-clear) answer can never carry one of them.
   */
  /** The channel to the runtime that owns the cards was unusable (disconnected child, no engine in the worker). */
  | "transport-unavailable"
  /** A frame came back but did not carry a usable blocker array. */
  | "transport-answer-unusable"
  /** The round trip itself failed or exceeded its bound. */
  | "transport-failed";

export interface IsolationBlockerDecision {
  /**
   * Blocker ids, or `null` when durable state could not be consulted. `[]` is a PROVEN all-clear and
   * is only ever produced together with `reason: "declared-clear"`.
   */
  blockers: string[] | null;
  reason: IsolationBlockerDecisionReason;
  /**
   * Milliseconds left of the caller's post-abort stop drain, after charging the time this decision
   * consumed. Carried on every decision — including `blockers: null` — so a durable read that
   * succeeded can never hand `stop()` the unbounded wait the historical path risks.
   */
  drainMs: number;
  /** Rows whose status contradicted the in-memory signal; the caller logs these, they are drift evidence. */
  contradictedInMemory: string[];
  /** Held cards the batched read did not describe at all — unknown, therefore blocking. */
  unknownIds: string[];
}

export interface IsolationBlockerAnswer {
  /**
   * Blocker ids, `[]` for a proven all-clear, or `null` when durable state could not be consulted.
   * Every implementation — in-process, child process, or remote node — must reach the caller with
   * this same three-way meaning, because a transport that loses the distinction silently turns
   * "nobody can tell" into "nothing is running" and lets a restart destroy live work.
   */
  taskIds: string[] | null;
  /**
   * Milliseconds left of this runtime's configured post-abort stop drain after charging the time the
   * decision consumed. Carried on the answer so the caller hands `stop()` a number that is already
   * paid for, instead of re-deriving a fresh full budget on top of the decision's own wait.
   */
  drainMs?: number;
  /** Why the answer came out this way. Fixed vocabulary; `null` answers always name their cause. */
  reason?: IsolationBlockerDecisionReason;
  /** Held cards whose durable `failed` row contradicted a still-live in-memory surface. Drift evidence. */
  contradictedInMemory?: string[];
  /** Held cards the durable read never described. Unknown, therefore blocking. */
  unknownIds?: string[];
}

export interface ResolveIsolationBlockersDeps {
  /** Card ids the in-memory accounting currently holds a worktree for. */
  holderIds: readonly string[];
  /** Durable store, or null/undefined when the runtime cannot reach one (isolated/remote runtimes). */
  store?: IsolationBlockerReadStore | null;
  /**
   * The true in-memory signal (canonical liveness triple). It no longer decides — see
   * {@link classifyIsolationBlockers}: the durable row is authoritative, and this predicate only marks
   * the cards where the two disagree so the caller can log the drift.
   */
  isLive: (taskId: string) => boolean;
  /**
   * `Date.now()` taken at the transition's ENTRY, so the budget covers the settings fetch and the
   * metrics read that came before this call, not just the read issued here.
   */
  entryAtMs: number;
  /** The runtime's configured post-abort drain (`runtimeStopDrainMs`), same key and default as `stop()`. */
  configuredDrainMs?: number;
  /** Override only for tests; production uses the module constants. */
  outerBudgetMs?: number;
  /** Override only for tests; production uses the module constants. */
  storeBudgetMs?: number;
  /** Override only for tests. */
  now?: () => number;
}

/**
 * Bound one awaited read by a wall-clock budget: `null` on timeout or rejection, never a throw, and
 * never an unhandled rejection (both settle handlers are attached synchronously, and the losing
 * result is deliberately dropped because a late answer cannot un-refuse a transition that already
 * answered).
 *
 * @param start Produces the read lazily, so an exhausted budget does not issue I/O it cannot use.
 * @param budgetMs Wall-clock allowance; anything <= 0 means "no budget left", which is `null`.
 */
export function withBoundedRead<T>(start: () => Promise<T>, budgetMs: number): Promise<T | null> {
  if (!(budgetMs > 0)) {
    return Promise.resolve(null);
  }

  let work: Promise<T>;
  try {
    work = start();
  } catch {
    return Promise.resolve(null);
  }

  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, budgetMs);
    // A decision that already answered must not hold the event loop open.
    (timer as unknown as { unref?: () => void })?.unref?.();

    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Classify held cards against durable board rows. Pure and exported so the classification can be
 * pinned without a store: `rows` is whatever ONE batched read returned (possibly nothing for a card
 * that no lane described).
 *
 * Release rule — deliberately the SAME narrow shape as the canonical terminal-failure classifier:
 * a card stops counting only when its durable row carries `status: "failed"` AND lives in the
 * in-progress lane. `failed` in any other lane stays blocking, because a `failed` row in `todo`
 * (e.g. merge-fix bounced the card back) or `in-review` describes work the engine may still resume.
 * A row the read did not return is unknown, and unknown blocks.
 *
 * FNXC:IsolationTransitionBlockers 2026-10-15-03:20 (RUFU-328):
 * The durable row is the DECIDING signal; the in-memory liveness signal is not a veto. It cannot be one:
 * `RuntimeMetrics.inFlightTasks` counts exactly the holders whose in-memory predicate is true, so a rule
 * that exempted only `!isLive` cards could never release the guard it exists to release — the guard fires
 * precisely when that predicate says busy, and the veto would then re-block the same card. The recorded
 * incident is this shape: the leaked binding IS the still-true in-memory signal (an unreleased ownership
 * entry, an active-session entry that never unwound), which is why RUFU-323's liveness derivation covers
 * the clean park and nothing else.
 *
 * So `isLive` survives here as drift evidence only: a card the board calls a terminal in-progress park
 * while an execution surface still claims it is exempt from the blocker set AND recorded in
 * `contradictedInMemory`, which the caller logs. The safety bound on that exemption is the lane gate — a
 * `failed` row anywhere else, an undescribed row, or any read failure keeps blocking — plus the unchanged
 * `force: true` path, which never consults any of this.
 */
export function classifyIsolationBlockers(deps: {
  holderIds: readonly string[];
  rows: readonly IsolationBlockerRow[] | null;
  isLive: (taskId: string) => boolean;
}): { blockers: string[]; contradictedInMemory: string[]; unknownIds: string[] } {
  const { holderIds, isLive } = deps;
  const rowsById = new Map<string, IsolationBlockerRow>();
  for (const row of deps.rows ?? []) {
    if (row && typeof row.id === "string") rowsById.set(row.id, row);
  }

  const blockers: string[] = [];
  const contradictedInMemory: string[] = [];
  const unknownIds: string[] = [];
  for (const taskId of holderIds) {
    const row = rowsById.get(taskId);
    if (!row) {
      unknownIds.push(taskId);
      blockers.push(taskId);
      continue;
    }
    const terminalPark = row.status === "failed" && row.column === TERMINAL_PARK_LANE;
    if (terminalPark) {
      if (isLive(taskId)) {
        // Board says the run is over, an in-memory surface still says otherwise: exempt as decided, but
        // the disagreement is the leaked binding this whole guard exists to look past. Record it.
        contradictedInMemory.push(taskId);
      }
      continue;
    }
    blockers.push(taskId);
  }

  return { blockers, contradictedInMemory, unknownIds };
}

/**
 * The bounded durable decision behind the isolation-transition guard. Issues AT MOST ONE batched
 * read — the fan-out this replaces (`store.getTask(id)` per holder) takes the per-task advisory lock
 * at `task-store/reads.ts` `getTaskImpl`, so N unresponsive cards would have cost N serialized
 * lock round-trips, and two of them already held their checkout.
 */
export async function resolveIsolationTransitionBlockers(
  deps: ResolveIsolationBlockersDeps,
): Promise<IsolationBlockerDecision> {
  const now = deps.now ?? Date.now;
  const outerBudgetMs = deps.outerBudgetMs ?? ISOLATION_BLOCKER_READ_TIMEOUT_MS;
  const storeBudgetMs = deps.storeBudgetMs ?? ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS;
  const configuredDrainMs = deps.configuredDrainMs ?? 2_000;

  /** Charge everything the transition has already spent before this decision was asked. */
  const remainingDrainMs = (): number =>
    Math.max(0, configuredDrainMs - (now() - deps.entryAtMs));

  /** Every decision carries a drain number, including the cannot-answer ones. */
  const decide = (
    blockers: string[] | null,
    reason: IsolationBlockerDecisionReason,
    contradictedInMemory: string[] = [],
    unknownIds: string[] = [],
  ): IsolationBlockerDecision => ({
    blockers,
    reason,
    drainMs: remainingDrainMs(),
    contradictedInMemory,
    unknownIds,
  });

  if (deps.holderIds.length === 0) {
    // Nothing is held, so there is nothing to prove. This is a fact, not an inference from a read.
    return decide([], "declared-clear");
  }

  if (!deps.store || typeof deps.store.listTasks !== "function") {
    return decide(null, "store-unavailable");
  }

  const elapsedBeforeRead = now() - deps.entryAtMs;
  const outerRemainingMs = outerBudgetMs - elapsedBeforeRead;
  if (outerRemainingMs <= 0) {
    return decide(null, "budget-exhausted");
  }
  const innerBudgetMs = Math.min(storeBudgetMs, outerRemainingMs);

  const rows = await withBoundedRead(
    // Board-shaped options: `derive: false` skips the nine per-row UI derivations (and the
    // selection/override reads that feed ONLY those badges) and `excludeLog: true` drops the log
    // column this decision never reads. `slim` is deliberately NOT used: its finalize re-parses
    // PROMPT.md for every row whose persisted `steps` is empty, which is unbounded per-pass file I/O.
    // The rejection sentinel keeps "the store threw" distinguishable from "the store was too slow"
    // in the log, because the operator-facing remedy differs (repair the store vs wait it out).
    () =>
      Promise.resolve()
        .then(() =>
          deps.store!.listTasks({
            columns: BLOCKER_CANDIDATE_LANES,
            derive: false,
            excludeLog: true,
          }),
        )
        .catch(() => READ_REJECTED),
    innerBudgetMs,
  );

  if (rows === null) {
    return decide(null, "read-timed-out");
  }
  if (rows === READ_REJECTED || !Array.isArray(rows)) {
    return decide(null, "read-rejected");
  }

  const { blockers, contradictedInMemory, unknownIds } = classifyIsolationBlockers({
    holderIds: deps.holderIds,
    rows,
    isLive: deps.isLive,
  });
  return decide(
    blockers,
    blockers.length > 0 ? "declared-blocked" : "declared-clear",
    contradictedInMemory,
    unknownIds,
  );
}

/**
 * The runtime-facing wrapper: one bounded decision, and one answer that can never throw.
 *
 * A durable read that wedges or rejects is an ordinary outcome for a store on another host, so the
 * whole resolution is re-bounded here at the outer budget and any unexpected throw degrades to
 * `null` (cannot-answer). Without this, a transport answer could exceed its declared bound simply
 * because a step taken before the batched read (the drain-settings fetch) was slower than expected.
 */
export async function resolveIsolationBlockerAnswer(
  deps: ResolveIsolationBlockersDeps,
): Promise<IsolationBlockerAnswer> {
  const budgetMs = deps.outerBudgetMs ?? ISOLATION_BLOCKER_READ_TIMEOUT_MS;
  const decision = await withBoundedRead(
    () => resolveIsolationTransitionBlockers(deps),
    budgetMs,
  );
  if (decision) {
    return {
      taskIds: decision.blockers,
      drainMs: decision.drainMs,
      reason: decision.reason,
      contradictedInMemory: decision.contradictedInMemory,
      unknownIds: decision.unknownIds,
    };
  }
  return {
    taskIds: null,
    reason: "budget-exhausted",
    drainMs: Math.max(0, (deps.configuredDrainMs ?? 2_000) - (Date.now() - deps.entryAtMs)),
  };
}

/*
FNXC:IsolationTransitionBlockers 2026-10-15-04:35 (RUFU-328):
The runtime seam of the same decision, as plain functions rather than class methods. A runtime answers
the guard question and votes in its own shutdown drain from ONE enumeration, and both call sites must
reach the identical code path — a fork here is exactly the drift this module exists to prevent: the
guard and the drain disagreeing about which cards they are discussing. These are module-level for a
second, mechanical reason too: the guard-facing method is exercised against a minimal `this` double,
and a private-method hop through that double is a wiring artefact, not a behaviour under test.
*/

/**
 * The executor surface the holder enumeration walks, feature-detected down a ladder so an executor
 * double that models only the raw ownership map still gets an honest answer.
 */
export interface WorktreeHolderHost {
  listWorktreeHolderIds?: () => Iterable<string>;
  listWorktreeHolders?: () => Iterable<{ taskId?: string } | null | undefined>;
  activeWorktrees?: Map<string, unknown>;
  isTaskLiveForOverseerRetry?: (taskId: string) => boolean;
}

/**
 * Which cards hold a checkout right now (liveness aside), plus how to ask whether each is live.
 *
 * The set-wide enumeration is deliberate: the veto asks what a transition would DESTROY, so a card the
 * in-memory triple calls not-live is still named and left to the durable row (see
 * {@link classifyIsolationBlockers}). Deduped per card — a workspace task bound to N sub-repos is one
 * blocker, named once. An executor that cannot answer the liveness question is treated as BUSY,
 * matching the conservative derivation `RuntimeMetrics.inFlightTasks` uses for the same doubles.
 */
export function readWorktreeHolderEvidence(
  executor?: WorktreeHolderHost | null,
): { holderIds: string[]; isLive: (taskId: string) => boolean } {
  const holderIdSet = new Set<string>();
  if (executor) {
    if (typeof executor.listWorktreeHolderIds === "function") {
      for (const taskId of executor.listWorktreeHolderIds()) {
        if (taskId) holderIdSet.add(taskId);
      }
    } else if (typeof executor.listWorktreeHolders === "function") {
      for (const holder of executor.listWorktreeHolders()) {
        if (holder?.taskId) holderIdSet.add(holder.taskId);
      }
    } else {
      for (const taskId of executor.activeWorktrees?.keys() ?? []) {
        holderIdSet.add(taskId);
      }
    }
  }

  const isLive = (taskId: string): boolean => {
    if (!executor || typeof executor.isTaskLiveForOverseerRetry !== "function") return true;
    try {
      return executor.isTaskLiveForOverseerRetry(taskId);
    } catch {
      return true;
    }
  };

  return { holderIds: [...holderIdSet], isLive };
}

/** Deps for one runtime-facing durable answer, given a drain budget the caller already resolved. */
export interface RuntimeIsolationBlockerDeps {
  /** The runtime's executor (holder enumeration + liveness), or nothing when it never booted one. */
  executor?: WorktreeHolderHost | null;
  /** The runtime's TaskStore, or nothing when the mode cannot reach one. */
  store?: IsolationBlockerReadStore | null;
  /** The runtime's configured post-abort drain, already resolved by the caller — never re-read here. */
  configuredDrainMs: number;
  /** Milliseconds this answer may still spend. */
  budgetMs: number;
  /** Wall-clock entry stamp for the whole attempt. */
  entryAtMs: number;
}

/**
 * One bounded durable answer for a runtime, and never a throw: `resolveIsolationBlockerAnswer` already
 * absorbs a hung or rejecting store, and a holder listing that throws on a broken double degrades to
 * `null` here rather than escaping into a guard or a shutdown.
 */
export async function resolveRuntimeIsolationBlockers(
  deps: RuntimeIsolationBlockerDeps,
): Promise<IsolationBlockerAnswer> {
  try {
    const { holderIds, isLive } = readWorktreeHolderEvidence(deps.executor);
    return await resolveIsolationBlockerAnswer({
      holderIds,
      store: deps.store ?? null,
      isLive,
      entryAtMs: deps.entryAtMs,
      configuredDrainMs: deps.configuredDrainMs,
      outerBudgetMs: deps.budgetMs,
    });
  } catch {
    return {
      taskIds: null,
      reason: "store-unavailable",
      drainMs: Math.max(0, deps.configuredDrainMs - (Date.now() - deps.entryAtMs)),
    };
  }
}

/**
 * One shutdown-drain vote: does durable state prove there is nothing left to WAIT for?
 *
 * Only a proven-empty blocker set answers `true`. A `null` answer (no store, hung read, rejection,
 * exhausted budget) and a non-empty set both answer `false`, so a runtime that cannot prove the board
 * is quiet keeps waiting exactly as it did before this vote existed, and an unknown card is never read
 * as an idle runtime.
 */
export async function isolationDrainVoteIsSettled(
  deps: RuntimeIsolationBlockerDeps,
): Promise<boolean> {
  const answer = await resolveRuntimeIsolationBlockers(deps);
  return Array.isArray(answer.taskIds) && answer.taskIds.length === 0;
}
