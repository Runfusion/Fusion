/**
 * Node-agnostic GitHub reconcile (PR-lifecycle-as-workflow-nodes, U4).
 *
 * This is the per-repo, node-kind-agnostic poller that corroborates each active
 * {@link PrEntity} against GitHub and fires the *generic* external-event hold
 * releases that advance whatever card is parked in a PR-await hold. It is the
 * load-bearing R20 invariant made concrete: the scheduler contains ZERO PR
 * knowledge — this reconciler lives in the PR feature's own module and is
 * started/stopped from the RUNTIME layer (project-engine), never from
 * `scheduler.ts`.
 *
 * Shape mirrors {@link PrMonitor} (adaptive interval map, exponential backoff,
 * injected GitHub ops, start/stop/stopAll) but operates per-repo (not per-task)
 * so N entities in one repo cost one ETag probe per tick, not N (rate-limit
 * safety, R17).
 *
 * Flow per repo per tick:
 *   1. ETag probe (304 is rate-limit-free) — if unchanged, no deep-fetch / no
 *      writes for that entity.
 *   2. On change, deep-fetch the mirror state.
 *   3. Persist the mirror (state, prNumber/prUrl/headOid, mergeable, checks,
 *      reviewDecision) via {@link TaskStore.updatePrEntity}; clear `unverified`
 *      on the first successful reconcile.
 *   4. If an unverified entity has NO real PR on GitHub, transition it to
 *      `closed` (fiction cleared) and DO NOT advance it on stale state (R19).
 *   5. For each detected transition fire
 *      `releaseHeldTaskByEvent(store, taskId, "github:pr-<event>")` — the
 *      generic sweep moves the card; it never learns PR semantics.
 *   6. Drop terminal (merged/closed) entities from the poll set (R18).
 *   7. Every caught error persists an audit event (silent catch-and-continue is
 *      the documented stall mode) and the repo backs off; the poller survives.
 */

import type { PrEntity, PrConflictState, PrChecksRollup, PrReadinessSnapshot, PrReviewDecision } from "@fusion/core";
import { isCurrentHeadReadinessReady, isPrEntityActive } from "@fusion/core";
import { prReconcileLog } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { releaseHeldTaskByEvent } from "../execution/hold-release.js";

// ── Injected GitHub ops (node-agnostic; engine never imports the dashboard) ────

/** Result of a deep-fetch of a single PR's GitHub-corroborated mirror state. */
export interface PrReconcileFetchResult {
  /**
   * Whether the PR actually exists on GitHub. `false` means there is no PR
   * behind this entity (the fiction case for unverified imported entities, R19).
   */
  exists: boolean;
  /** Open / merged / closed (draft maps to open for reconcile purposes). */
  prState?: "open" | "merged" | "closed";
  prNumber?: number;
  prUrl?: string;
  headOid?: string;
  mergeable?: PrConflictState;
  checksRollup?: PrChecksRollup;
  reviewDecision?: PrReviewDecision;
  /** Canonical provider-neutral evidence for the observed head. */
  readiness?: PrReadinessSnapshot;
  readinessProvider?: string;
}

/**
 * The CLI-injected GitHub callbacks backing the reconcile. Mirrors
 * {@link PrNodeGithubOps}: only plain callbacks that close over the dashboard
 * `GitHubClient`; the engine receives no client reference. Wired alongside
 * `prNodeGithubOps` at the three CLI composition sites.
 */
export interface PrReconcileGithubOps {
  /**
   * ETag-conditional change probe. `changed:false` (HTTP 304) is rate-limit-free
   * and means the caller may skip the deep-fetch. Returns a fresh `etag` to
   * store for the next probe.
   */
  probe(repo: string, prNumber: number, etag?: string): Promise<{ changed: boolean; etag?: string }>;
  /** Deep-fetch the GitHub-corroborated mirror state for a PR. */
  fetchPrState(repo: string, prNumber: number): Promise<PrReconcileFetchResult>;
}

// ── Store + release seams (kept structural so the reconciler is unit-testable) ─

/** The slice of the task store the reconciler reads/writes. */
export interface PrReconcileStore {
  listActivePrEntities(): Promise<PrEntity[]>;
  getPrEntity(id: string): Promise<PrEntity | null>;
  updatePrEntity(id: string, patch: import("@fusion/core").PrEntityUpdate): Promise<PrEntity>;
  /** SHA-fenced writer; a null result means a newer observation won the race. */
  updatePrReadiness?(
    id: string,
    expectedStoredHeadOid: string | undefined,
    provider: string,
    snapshot: PrReadinessSnapshot,
    options?: { deferMergedTerminalState?: boolean },
  ): Promise<PrEntity | null>;
  recordRunAuditEvent?: (input: import("@fusion/core").RunAuditEventInput) => unknown | Promise<unknown>;
}

/**
 * Release function injected for testability. Defaults to the real
 * {@link releaseHeldTaskByEvent}, which only acts on `external-event` holds (a
 * no-op otherwise, so firing it for a task that is not parked in an await hold
 * is harmless). Tests inject a spy to assert the transition→event-tag mapping
 * without driving a full workflow graph.
 */
export type PrReleaseByEventFn = (taskId: string, eventTag: string) => Promise<unknown>;

/**
 * Resolve a branch-group entity to a representative task id to release, or
 * `null` to skip release for that group. v1 has no group→task resolver wired
 * (documented choice): groups persist their reconciled mirror state but do not
 * fire hold releases until a resolver is injected.
 */
export type ResolveGroupReleaseTaskFn = (entity: PrEntity) => string | null;

export interface PrReconcilerOptions {
  store: PrReconcileStore;
  ops: PrReconcileGithubOps;
  /** Defaults to {@link releaseHeldTaskByEvent} bound to the store. */
  releaseByEvent?: PrReleaseByEventFn;
  /** Branch-group → representative task resolver (v1: omitted ⇒ skip groups). */
  resolveGroupReleaseTask?: ResolveGroupReleaseTaskFn;
  /** Releases a legacy PR wait only after its current-head evidence is ready. */
  releaseAwaitingChecks?: (taskId: string, prEntityId: string, expectedHeadOid: string) => Promise<void>;
  /**
   * Receives a fresh, provider-corroborated external landing before generic
   * hold releases or any recovery path can select stale pre-merge work.
   */
  onMergedCurrentHead?: (entity: PrEntity, result: PrReconcileFetchResult) => Promise<boolean>;
  /** Override cadence/backoff knobs (tests use tiny intervals). */
  intervals?: Partial<PrReconcileIntervals>;
  /** Injected clock for the next-tick scheduler (defaults to setTimeout). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface PrReconcileIntervals {
  /** ~15-30s when there is recent activity. */
  active: number;
  /** ~60-120s when idle. */
  idle: number;
  /** 5min when dormant (no changes for a while). */
  dormant: number;
  /** Max backoff cap. */
  maxBackoff: number;
  /** Errors before a repo is considered failing (still survives, just backs off). */
  maxConsecutiveErrors: number;
}

const DEFAULT_INTERVALS: PrReconcileIntervals = {
  active: 20 * 1000,
  idle: 90 * 1000,
  dormant: 5 * 60 * 1000,
  maxBackoff: 15 * 60 * 1000,
  maxConsecutiveErrors: 5,
};

// ── Transition → event-tag mapping (the load-bearing semantics) ────────────────

/** A detected GitHub-state transition for one entity, with its release event tag. */
export interface PrReconcileTransition {
  event:
    | "merged"
    | "closed"
    | "changes-requested"
    | "approved"
    | "conflict"
    | "conflict-cleared"
    | "ready";
  /** The hold-release event tag: `github:pr-<event>`. */
  tag: string;
  /** Whether this transition makes the entity terminal (drop from poll). */
  terminal: boolean;
}

/**
 * Derive the list of transitions between a previously-persisted entity mirror
 * and a freshly-fetched GitHub state. Pure + exported for unit testing.
 *
 * Ordering: terminal states (merged/closed) short-circuit — once merged/closed,
 * review/conflict transitions are irrelevant. Otherwise review-decision and
 * mergeability transitions are independent and may both fire.
 */
export function deriveTransitions(prev: PrEntity, next: PrReconcileFetchResult): PrReconcileTransition[] {
  const tag = (event: PrReconcileTransition["event"]): string => `github:pr-${event}`;

  if (next.prState === "merged") {
    return [{ event: "merged", tag: tag("merged"), terminal: true }];
  }
  if (next.prState === "closed") {
    return [{ event: "closed", tag: tag("closed"), terminal: true }];
  }

  const out: PrReconcileTransition[] = [];

  // Review decision transitions (fire only on the edge into the new state).
  if (next.reviewDecision !== undefined && next.reviewDecision !== prev.reviewDecision) {
    if (next.reviewDecision === "CHANGES_REQUESTED") {
      out.push({ event: "changes-requested", tag: tag("changes-requested"), terminal: false });
    } else if (next.reviewDecision === "APPROVED") {
      out.push({ event: "approved", tag: tag("approved"), terminal: false });
    }
  }

  // A current-head readiness success is a distinct external event. It is not
  // inferred from legacy rollups: unsupported, denied, stale, or partial
  // provider evidence remains held and actionable rather than waking a merge.
  const previouslyReady = isCurrentHeadReadinessReady(prev.readiness, prev.headOid);
  const newlyReady = next.readiness !== undefined
    && next.headOid === next.readiness.observedHeadOid
    && isCurrentHeadReadinessReady(next.readiness, next.headOid);
  if (!previouslyReady && newlyReady) {
    out.push({ event: "ready", tag: tag("ready"), terminal: false });
  }

  // Mergeability transitions. "conflicting" is the only conflict signal that
  // fires a conflict release; UNKNOWN never maps to conflict (never gates as
  // conflicting). Clearing FROM conflicting back to clean fires conflict-cleared.
  if (next.mergeable !== undefined && next.mergeable !== prev.mergeable) {
    if (next.mergeable === "conflicting") {
      out.push({ event: "conflict", tag: tag("conflict"), terminal: false });
    } else if (prev.mergeable === "conflicting" && next.mergeable === "clean") {
      out.push({ event: "conflict-cleared", tag: tag("conflict-cleared"), terminal: false });
    }
  }

  return out;
}

// ── Per-repo tracking ──────────────────────────────────────────────────────────

interface RepoTracker {
  repo: string;
  /** Per-entity ETag for conditional probes (entityId → etag). */
  etags: Map<string, string>;
  consecutiveErrors: number;
  /** True if the last tick saw a change (drives active cadence). */
  active: boolean;
  /** Ticks with no change (drives idle → dormant). */
  quietTicks: number;
  timer?: ReturnType<typeof setTimeout>;
}

// ── The reconciler ─────────────────────────────────────────────────────────────

export class PrReconciler {
  private readonly store: PrReconcileStore;
  private readonly ops: PrReconcileGithubOps;
  private readonly releaseByEvent: PrReleaseByEventFn;
  private readonly resolveGroupReleaseTask?: ResolveGroupReleaseTaskFn;
  private readonly releaseAwaitingChecks?: (taskId: string, prEntityId: string, expectedHeadOid: string) => Promise<void>;
  private readonly onMergedCurrentHead?: (entity: PrEntity, result: PrReconcileFetchResult) => Promise<boolean>;
  private readonly intervals: PrReconcileIntervals;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private readonly repos = new Map<string, RepoTracker>();
  private running = false;

  constructor(options: PrReconcilerOptions) {
    this.store = options.store;
    this.ops = options.ops;
    this.releaseByEvent =
      options.releaseByEvent ??
      ((taskId, eventTag) =>
        releaseHeldTaskByEvent(this.store as unknown as import("@fusion/core").TaskStore, taskId, eventTag));
    this.resolveGroupReleaseTask = options.resolveGroupReleaseTask;
    this.releaseAwaitingChecks = options.releaseAwaitingChecks;
    this.onMergedCurrentHead = options.onMergedCurrentHead;
    this.intervals = { ...DEFAULT_INTERVALS, ...(options.intervals ?? {}) };
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  /**
   * Start the reconciler. Schedules the first tick for every repo that currently
   * has active entities, then re-derives the repo set on each tick (so newly
   * created entities are picked up and terminal ones drop out).
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.syncReposAndSchedule();
    prReconcileLog.log("PR reconcile started");
  }

  /** Stop a single repo's polling. */
  stopRepo(repo: string): void {
    const tracker = this.repos.get(repo);
    if (tracker?.timer) this.clearTimer(tracker.timer);
    this.repos.delete(repo);
  }

  /** Stop all polling. */
  stopAll(): void {
    for (const tracker of this.repos.values()) {
      if (tracker.timer) this.clearTimer(tracker.timer);
    }
    this.repos.clear();
    this.running = false;
    prReconcileLog.log("PR reconcile stopped");
  }

  /** Currently tracked repos (for tests/observability). */
  getTrackedRepos(): string[] {
    return [...this.repos.keys()];
  }

  /**
   * Run exactly one tick for one repo. Exposed for deterministic testing without
   * the timer loop. Returns the transitions fired this tick (across entities).
   */
  async reconcileRepoOnce(repo: string): Promise<PrReconcileTransition[]> {
    const tracker = this.repos.get(repo) ?? this.ensureTracker(repo);
    return this.tickRepo(tracker);
  }

  /** Refresh every active provider-backed repository before a recovery pass selects work. */
  async reconcileAllOnce(): Promise<PrReconcileTransition[]> {
    const repos = [...(await this.groupActiveByRepo()).keys()];
    const transitions: PrReconcileTransition[] = [];
    for (const repo of repos) transitions.push(...await this.reconcileRepoOnce(repo));
    return transitions;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private ensureTracker(repo: string): RepoTracker {
    let tracker = this.repos.get(repo);
    if (!tracker) {
      tracker = { repo, etags: new Map(), consecutiveErrors: 0, active: true, quietTicks: 0 };
      this.repos.set(repo, tracker);
    }
    return tracker;
  }

  /** Group active entities by repo; ensure a tracker + scheduled tick per repo. */
  private async syncReposAndSchedule(): Promise<void> {
    if (!this.running) return;
    const byRepo = await this.groupActiveByRepo();
    // Drop repos with no active entities.
    for (const repo of [...this.repos.keys()]) {
      if (!byRepo.has(repo)) this.stopRepo(repo);
    }
    for (const repo of byRepo.keys()) {
      const tracker = this.ensureTracker(repo);
      if (!tracker.timer) this.scheduleNextTick(tracker);
    }
  }

  private async groupActiveByRepo(): Promise<Map<string, PrEntity[]>> {
    const byRepo = new Map<string, PrEntity[]>();
    let entities: PrEntity[];
    try {
      entities = await this.store.listActivePrEntities();
    } catch (err) {
      prReconcileLog.error("Failed to list active PR entities:", err);
      return byRepo;
    }
    for (const entity of entities) {
      if (!isPrEntityActive(entity)) continue; // R18: terminal entities are out.
      if (!entity.repo) continue;
      const list = byRepo.get(entity.repo) ?? [];
      list.push(entity);
      byRepo.set(entity.repo, list);
    }
    return byRepo;
  }

  private resolveInterval(tracker: RepoTracker): number {
    let base: number;
    if (tracker.active) base = this.intervals.active;
    else if (tracker.quietTicks >= 3) base = this.intervals.dormant;
    else base = this.intervals.idle;

    if (tracker.consecutiveErrors > 0) {
      const mult = Math.pow(2, Math.min(tracker.consecutiveErrors, 5));
      base = Math.min(base * mult, this.intervals.maxBackoff);
    }
    return base;
  }

  private scheduleNextTick(tracker: RepoTracker): void {
    if (!this.running) return;
    const interval = this.resolveInterval(tracker);
    tracker.timer = this.setTimer(() => {
      void this.tickRepo(tracker).finally(() => {
        // Re-derive the repo set (pick up new entities, drop emptied repos),
        // then reschedule this repo if it still has work.
        tracker.timer = undefined;
        void this.syncReposAndSchedule();
      });
    }, interval);
  }

  /**
   * One reconcile pass over all active entities in a single repo. Per-repo error
   * handling: a deep-fetch error on one entity is recorded as an audit event and
   * bumps the repo's backoff, but the loop continues to the next entity and the
   * poller survives.
   */
  private async tickRepo(tracker: RepoTracker): Promise<PrReconcileTransition[]> {
    const byRepo = await this.groupActiveByRepo();
    const entities = byRepo.get(tracker.repo) ?? [];
    if (entities.length === 0) {
      this.stopRepo(tracker.repo);
      return [];
    }

    const fired: PrReconcileTransition[] = [];
    let sawChange = false;
    let sawError = false;

    for (const entity of entities) {
      try {
        const transitions = await this.reconcileEntity(entity, tracker);
        if (transitions === "changed" || transitions.length > 0) sawChange = true;
        if (Array.isArray(transitions)) fired.push(...transitions);
      } catch (err) {
        sawError = true;
        this.recordError(entity, err);
      }
    }

    // Cadence + backoff bookkeeping.
    if (sawError) {
      tracker.consecutiveErrors += 1;
    } else {
      tracker.consecutiveErrors = 0;
    }
    if (sawChange) {
      tracker.active = true;
      tracker.quietTicks = 0;
    } else {
      tracker.active = false;
      tracker.quietTicks += 1;
    }

    return fired;
  }

  /**
   * Reconcile one entity. Returns the transitions fired, or the literal
   * `"changed"` when GitHub changed but produced no card-advancing transition
   * (still counts as activity for cadence). Throws on deep-fetch error so the
   * repo loop can record it and back off.
   */
  private async reconcileEntity(
    entity: PrEntity,
    tracker: RepoTracker,
  ): Promise<PrReconcileTransition[] | "changed"> {
    // An entity without a PR number can only be reconciled by source-of-truth
    // existence: for unverified imports with no number, treat as fiction.
    if (entity.prNumber == null) {
      if (entity.unverified) {
        this.clearFiction(entity);
        return [];
      }
      // Verified entity still mid-create (no number yet): nothing to reconcile.
      return [];
    }

    // 1. ETag-cheap probe. 304 ⇒ unchanged ⇒ no deep-fetch / no writes.
    const probe = await this.ops.probe(entity.repo, entity.prNumber, tracker.etags.get(entity.id));
    if (probe.etag) tracker.etags.set(entity.id, probe.etag);
    // A provider-confirmed landing can be deferred by a pause or live owner.
    // Keep refreshing that active entity even on 304 so closeout is retried once
    // the fence is available rather than being lost behind the cached ETag.
    const retryDeferredExternalLanding = entity.readiness?.state === "merged";
    if (!probe.changed && !retryDeferredExternalLanding) return [];

    // 2. Deep-fetch the mirror state (may throw → caller records + backs off).
    const fetched = await this.ops.fetchPrState(entity.repo, entity.prNumber);

    // 3. Fiction: unverified entity whose PR does not actually exist (R19). Clear
    //    it to a terminal/cleared state and DO NOT advance it on stale state.
    if (!fetched.exists) {
      if (entity.unverified) {
        this.clearFiction(entity);
      } else {
        // A verified entity that vanished from GitHub: treat as closed.
        void this.store.updatePrEntity(entity.id, { state: "closed", unverified: false });
      }
      return [];
    }

    // 4. Derive transitions BEFORE persisting (compare against the prior mirror).
    const transitions = deriveTransitions(entity, fetched);

    const provenCurrentHeadLanding = fetched.prState === "merged"
      && fetched.headOid === entity.headOid
      && fetched.readiness?.state === "merged"
      && fetched.readiness.observedHeadOid === entity.headOid
      && Boolean(fetched.readiness.mergeCommitSha)
      && fetched.readiness.mergeCommitIncludesHead === true;
    const deferredExternalLanding = provenCurrentHeadLanding && Boolean(this.onMergedCurrentHead);

    // 5. Persist the corroborated mirror; clear `unverified` on first success.
    // A stale provider response must not release a hold after a newer head has won.
    //
    // FNXC:ExternalPrCloseout 2026-10-05-04:23:
    // A proven landing remains an active poll target until the task-fenced
    // closeout handoff succeeds. Marking it terminal before that handoff would
    // hide a paused or live-owned task from restart recovery and let stale work
    // resume through a generic merged-event release.
    if (fetched.readiness && this.store.updatePrReadiness) {
      const fenced = await this.store.updatePrReadiness(
        entity.id,
        entity.headOid,
        fetched.readinessProvider ?? "github",
        fetched.readiness,
        { deferMergedTerminalState: deferredExternalLanding },
      );
      // Do not follow a successful CAS with an unfenced mirror write: another
      // poll can persist a new head between those two operations.
      if (!fenced) return "changed";
    } else {
      const nextState = deferredExternalLanding
        ? entity.state
        : fetched.prState === "merged" ? "merged" : fetched.prState === "closed" ? "closed" : entity.state;
      await this.store.updatePrEntity(entity.id, {
        state: nextState,
        prNumber: fetched.prNumber ?? entity.prNumber,
        prUrl: fetched.prUrl ?? null,
        headOid: fetched.headOid ?? null,
        mergeable: fetched.mergeable ?? null,
        checksRollup: fetched.checksRollup ?? null,
        reviewDecision: fetched.reviewDecision,
        unverified: false,
      });
    }

    /*
    FNXC:ExternalCheckWait 2026-10-05-00:37:
    A reconciled current-head readiness transition releases the durable legacy
    wait through the engine, never through a model session. Pending polls leave
    the task untouched, so CI latency cannot spend execution or merge retries.
    */
    const readyTransition = transitions.find((transition) => transition.event === "ready");
    const readyTaskId = readyTransition ? this.resolveReleaseTaskId(entity) : null;
    if (readyTaskId && fetched.readiness?.observedHeadOid && this.releaseAwaitingChecks) {
      await this.releaseAwaitingChecks(readyTaskId, entity.id, fetched.readiness.observedHeadOid);
    }

    /*
    FNXC:ExternalPrCloseout 2026-10-05-02:58:
    Fresh current-head merge proof must reach lifecycle reconciliation before a
    generic release can select retries. A closed or mismatched observation never
    reaches this callback, and callback failure leaves the durable task untouched.
    */
    let externalMergeAccepted = false;
    if (provenCurrentHeadLanding && this.onMergedCurrentHead) {
      try {
        externalMergeAccepted = await this.onMergedCurrentHead(entity, fetched);
        if (externalMergeAccepted) {
          await this.store.updatePrEntity(entity.id, { state: "merged" });
        }
      } catch (err) {
        this.recordError(entity, err, "external-merge-closeout");
        externalMergeAccepted = false;
      }
    }

    // 6. A deferred proven landing has its own closeout owner. Never release a
    // stale pre-merge hold while that owner is paused or live; it stays active
    // and the next fresh/restart pass retries the fenced handoff.
    // The unverified gate (R19) is already cleared above only AFTER a real PR
    // was corroborated, so a just-cleared non-landing entity may advance here.
    for (const transition of transitions) {
      if (deferredExternalLanding && transition.event === "merged") {
        if (externalMergeAccepted && transition.terminal) tracker.etags.delete(entity.id);
        continue;
      }
      const taskId = this.resolveReleaseTaskId(entity);
      if (taskId) {
        try {
          await this.releaseByEvent(taskId, transition.tag);
        } catch (err) {
          // A release failure must not abort reconcile; record + continue.
          this.recordError(entity, err, `release:${transition.tag}`);
        }
      }
      // 7. Terminal transition ⇒ entity is now terminal; it drops from the poll
      //    set on the next groupActiveByRepo() pass (R18). Clear its ETag.
      if (transition.terminal) tracker.etags.delete(entity.id);
    }

    return transitions.length > 0 ? transitions : "changed";
  }

  /** Resolve the task id whose hold should be released for this entity. */
  private resolveReleaseTaskId(entity: PrEntity): string | null {
    if (entity.sourceType === "task") return entity.sourceId;
    // branch-group: requires an injected resolver; otherwise skip (v1 choice).
    if (this.resolveGroupReleaseTask) return this.resolveGroupReleaseTask(entity);
    return null;
  }

  /**
   * Clear a fictional unverified entity (no real PR behind it, R19): transition
   * to `closed` and never advance it on stale state.
   */
  private clearFiction(entity: PrEntity): void {
    void this.store.updatePrEntity(entity.id, {
      state: "closed",
      unverified: false,
      failureReason: "reconcile: no PR exists on GitHub (cleared fictional unverified entity)",
    });
    this.recordAudit(entity, "pr-reconcile:cleared-fiction", {
      prNumber: entity.prNumber ?? null,
    });
    prReconcileLog.log(`Cleared fictional unverified PR entity ${entity.id} (no real PR)`);
  }

  private recordError(entity: PrEntity, err: unknown, phase = "deep-fetch"): void {
    const message = err instanceof Error ? err.message : String(err);
    prReconcileLog.error(`PR reconcile error (${phase}) for entity ${entity.id}: ${message}`);
    this.recordAudit(entity, "pr-reconcile:error", { phase, error: message });
  }

  private recordAudit(entity: PrEntity, mutationType: string, metadata: Record<string, unknown>): void {
    try {
      void emitBoundedRunAudit(this.store, {
        taskId: entity.sourceType === "task" ? entity.sourceId : undefined,
        agentId: "pr-reconcile",
        runId: `pr-reconcile:${entity.id}`,
        domain: "database",
        mutationType,
        target: entity.id,
        metadata: { repo: entity.repo, entityId: entity.id, ...metadata },
      }, { log: prReconcileLog });
    } catch {
      // Audit is best-effort, but a thrown audit must never break the poller.
    }
  }
}
