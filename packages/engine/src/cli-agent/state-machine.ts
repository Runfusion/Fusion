/**
 * CliSessionStateMachine — authoritative per-session agent state machine
 * (CLI Agent Executor, U3).
 *
 * Implements the HTD state diagram exactly:
 *
 *   [*] → starting
 *   starting → ready            (readiness detected)
 *   ready → busy                (prompt injected)
 *   busy → waitingOnInput       (permission / question signal)
 *   waitingOnInput → busy       (user answers)
 *   busy → idle                 (heuristic quiet-window — generic tier; NEVER done)
 *   idle → busy                 (output resumes)
 *   busy → done                 (POSITIVE completion signal — idle NEVER does this)
 *   done → busy                 (follow-up; resume first if the PTY was reaped)
 *   busy → dead                 (PTY end / engine death)
 *   waitingOnInput → dead       (PTY end / engine death)
 *   dead → {killed|userExited|authFailed|resuming}   (classification choice)
 *   resuming → busy             (native resume ok)
 *   resuming → needsAttention   (2 attempts exhausted)
 *   userExited → needsAttention (advance / retry / cancel prompt)
 *   authFailed → needsAttention (re-authenticate message)
 *
 * Key behaviors (KTD — completion gating, termination taxonomy, stall backstop):
 * - Positive completion is distinct from idleness. `signalDone()` advances to
 *   `done`; output progress / idleness NEVER advance to done.
 * - Stall backstop: no output progress past a configurable threshold WITHOUT a
 *   done/waiting signal → needsAttention. The inactivity watchdog is re-armed by
 *   any telemetry/output event (no fixed turn timeout); `waitingOnInput`
 *   suppresses it (expected idleness).
 * - Termination classification helper maps the manner of a PTY end onto the
 *   taxonomy (killed / userExited / crashed / authFailed / engineDeath).
 * - Resume attempt cap = 2 with backoff metadata; exhaustion → needsAttention.
 * - Per-turn latches/budgets reset between turns (a new busy turn re-arms the
 *   completion latch so a second turn through one handler is tracked cleanly).
 *
 * Persistence + observability:
 * - Every transition persists through `CliSessionStore.updateSession` (state +
 *   terminationReason + resumeAttempts written atomically by the store).
 * - A throttled `onStateChange` callback is exposed for the SSE bridge to
 *   subscribe to later. This module NEVER imports dashboard code.
 */

import type {
  CliAgentState,
  CliAutonomyPosture,
  CliSessionStore,
  CliTerminationReason,
} from "@fusion/core";

// ── Public types ───────────────────────────────────────────────────────────

/**
 * The machine's own state space. This is the U1 `CliAgentState` plus two
 * transient sub-states that are NOT persisted store enums (U1's union has
 * neither):
 * - `"resuming"` (HTD) maps onto the persisted `dead` store state while the
 *   resume-eligible termination reason (crashed / engineDeath) carries the
 *   recovery intent.
 * - `"idle"` (generic heuristic tier, U6) maps onto the persisted `busy` store
 *   state. The generic adapter has no native done signal; a quiet output window
 *   yields an "looks idle — confirm to advance" affordance (origin R20) WITHOUT
 *   advancing the pipeline. Persisting `busy` keeps the session honestly live —
 *   idle NEVER reaches `done`; resumed output flips back to `busy`.
 *
 * Surfaces that subscribe to `onStateChange` see the richer machine state so the
 * SSE bridge can render "resuming…" / the idle confirm-advance affordance
 * without a schema change.
 */
export type CliMachineState = CliAgentState | "resuming" | "idle";

/** Map a machine state onto the persisted U1 store enum. */
export function toPersistedState(state: CliMachineState): CliAgentState {
  if (state === "resuming") return "dead";
  if (state === "idle") return "busy";
  return state;
}

/** A throttled state-change notification handed to subscribers (e.g. the SSE bridge). */
export interface CliStateChange {
  sessionId: string;
  /** The machine state moved into (may be the transient `resuming`). */
  state: CliMachineState;
  /** Termination reason when relevant (set on dead-classification transitions). */
  terminationReason: CliTerminationReason | null;
  /** Resume attempt count at the time of the change. */
  resumeAttempts: number;
  /** Backoff (ms) to wait before the next resume attempt, when resuming. */
  resumeBackoffMs?: number;
  /** ISO timestamp of the change. */
  at: string;
}

export type CliStateChangeListener = (change: CliStateChange) => void;

/**
 * How a PTY ended, as observed by the manager / restart sweep. Fed into the
 * classification helper to derive the termination taxonomy.
 */
export interface CliProcessEndInfo {
  /** Whether the engine itself died and found the session dead on restart. */
  foundDeadOnRestart?: boolean;
  /** Whether the end was a deliberate hard cancel (SIGKILL-from-cancel). */
  cancelled?: boolean;
  /** Process exit code (0 = clean). Undefined when killed by signal. */
  exitCode?: number | null;
  /** Signal that terminated the process, if any (e.g. "SIGKILL"). */
  signal?: string | number | null;
  /**
   * Recent (ANSI-stripped) output, scanned for a credential-failure pattern.
   * Supplied by the caller (the hub strips ANSI before pattern matching).
   */
  recentOutput?: string;
  /** Whether the session had observed a positive `done` before the end. */
  hadDone?: boolean;
}

export interface CliStateMachineOptions {
  sessionId: string;
  store: CliSessionStore;
  /** Autonomy posture (supplies maxResumeAttempts override). */
  posture?: CliAutonomyPosture | null;
  /**
   * Inactivity / stall threshold (ms). If no output progress and no done/waiting
   * signal arrives within this window of a busy turn, the backstop fires
   * (needsAttention). Default 5 minutes.
   */
  stallThresholdMs?: number;
  /** Max resume attempts before giving up. Default 2 (KTD). */
  maxResumeAttempts?: number;
  /** Base backoff (ms) for resume attempts; doubled per attempt. Default 1000. */
  resumeBackoffBaseMs?: number;
  /** Throttle window (ms) for `onStateChange`. Default 0 (emit every change). */
  stateChangeThrottleMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /**
   * Timer scheduler injection for tests (fake timers). Returns a cancel handle.
   * Defaults to setTimeout/clearTimeout.
   */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Default credential-failure detector. Scans (already ANSI-stripped) recent
 * output for common auth-rejection phrasing.
 */
const AUTH_FAILURE_PATTERN =
  /\b(authentication failed|invalid api key|unauthorized|401 unauthorized|not authenticated|please (?:re-?)?(?:login|log in|authenticate)|credential[s]? (?:rejected|invalid|expired)|your session has expired|token (?:expired|invalid|revoked))\b/i;

/** Detect a credential-failure pattern in recent (ANSI-stripped) output. */
export function looksLikeAuthFailure(recentOutput: string | undefined): boolean {
  if (!recentOutput) return false;
  return AUTH_FAILURE_PATTERN.test(recentOutput);
}

/**
 * Classify a PTY end onto the termination taxonomy (KTD). Pure — no side effects.
 *
 * - found-dead-on-restart                → engineDeath
 * - SIGKILL-from-cancel / hard cancel    → killed
 * - credential-failure in recent output  → authFailed
 * - clean exit-0 mid-task (no done)      → userExited
 * - nonzero exit / killed by signal      → crashed
 * - any exit AFTER a positive done       → completed
 */
export function classifyTermination(info: CliProcessEndInfo): CliTerminationReason {
  if (info.foundDeadOnRestart) return "engineDeath";
  if (info.cancelled) return "killed";
  if (looksLikeAuthFailure(info.recentOutput)) return "authFailed";
  if (info.hadDone) return "completed";
  // Killed by a signal (no clean exit) → crashed.
  if (info.signal != null && info.signal !== 0) return "crashed";
  if (info.exitCode === 0) return "userExited";
  // Any nonzero / unknown exit code → crashed.
  return "crashed";
}

/** Resume-eligible termination reasons (KTD): only crash / engine death auto-resume. */
export function isResumeEligible(reason: CliTerminationReason): boolean {
  return reason === "crashed" || reason === "engineDeath";
}

/** Error thrown when a transition is attempted from an incompatible state. */
export class InvalidCliTransitionError extends Error {
  readonly code = "INVALID_CLI_TRANSITION";
  constructor(
    public readonly from: CliMachineState,
    public readonly intent: string,
  ) {
    super(`Invalid CLI session transition: cannot ${intent} from state "${from}"`);
    this.name = "InvalidCliTransitionError";
  }
}

// ── State machine ──────────────────────────────────────────────────────────

export class CliSessionStateMachine {
  readonly sessionId: string;
  private readonly store: CliSessionStore;
  private readonly stallThresholdMs: number;
  private readonly maxResumeAttempts: number;
  private readonly resumeBackoffBaseMs: number;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private state: CliMachineState;
  private terminationReason: CliTerminationReason | null = null;
  private resumeAttempts = 0;

  /** Per-turn latch: has a positive done fired in the current busy turn. */
  private doneLatched = false;
  /** Per-turn latch: has waiting-on-input fired in the current busy turn. */
  private waitingLatched = false;

  private stallTimer: unknown = null;
  private listeners = new Set<CliStateChangeListener>();

  // Throttle bookkeeping.
  private lastEmitAt = 0;
  private pendingEmit: CliStateChange | null = null;
  private throttleTimer: unknown = null;

  constructor(opts: CliStateMachineOptions) {
    this.sessionId = opts.sessionId;
    this.store = opts.store;
    this.stallThresholdMs = opts.stallThresholdMs ?? 5 * 60_000;
    this.maxResumeAttempts =
      opts.maxResumeAttempts ??
      (typeof opts.posture?.maxResumeAttempts === "number"
        ? opts.posture.maxResumeAttempts
        : 2);
    this.resumeBackoffBaseMs = opts.resumeBackoffBaseMs ?? 1000;
    this.throttleMs = opts.stateChangeThrottleMs ?? 0;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer =
      opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

    // Seed from the persisted record so a rebuilt machine reflects reality.
    const existing = this.store.getSession(this.sessionId);
    this.state = existing?.agentState ?? "starting";
    this.terminationReason = existing?.terminationReason ?? null;
    this.resumeAttempts = existing?.resumeAttempts ?? 0;
  }

  // ── Observation ──────────────────────────────────────────────────────────

  getState(): CliMachineState {
    return this.state;
  }

  getTerminationReason(): CliTerminationReason | null {
    return this.terminationReason;
  }

  getResumeAttempts(): number {
    return this.resumeAttempts;
  }

  /** Subscribe to throttled state changes. Returns an unsubscribe handle. */
  onStateChange(listener: CliStateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Transitions (HTD diagram) ────────────────────────────────────────────

  /** starting → ready (readiness detected). */
  markReady(): void {
    if (this.state !== "starting") {
      throw new InvalidCliTransitionError(this.state, "markReady");
    }
    this.transition("ready");
  }

  /**
   * ready → busy (prompt injected) and done → busy (follow-up).
   * Begins a new turn: per-turn latches reset, stall watchdog armed.
   */
  injectPrompt(): void {
    if (this.state !== "ready" && this.state !== "done" && this.state !== "resuming") {
      throw new InvalidCliTransitionError(this.state, "injectPrompt");
    }
    this.beginTurn();
    this.transition("busy");
  }

  /*
  FNXC:CliAgentStateMachine 2026-07-30-12:20 DELIBERATE-LITERAL:
  `done` here is a `CliMachineState`, NOT a lifecycle column — this machine tracks one CLI agent
  process (`ready`/`busy`/`waitingOnInput`/`done`/`resuming`/`idle`) and never reads a board column.
  The lifecycle-column census matches the bare string and counted it; converting it to a workflow role
  would be nonsense, so it is marked rather than left to be "fixed" by a later sweep.
  */
  /** done → busy (follow-up). Alias for injectPrompt from the done state. */
  followUp(): void {
    if (this.state !== "done") {
      throw new InvalidCliTransitionError(this.state, "followUp");
    }
    this.beginTurn();
    this.transition("busy");
  }

  /**
   * Output progress / activity. Re-arms the inactivity watchdog. NEVER advances
   * state — idleness and activity are both gated away from `done`.
   *
   * From the generic-tier `idle` sub-state, fresh output means the agent resumed
   * work → flip back to `busy` (the confirm-advance affordance is withdrawn).
   */
  signalOutputProgress(): void {
    if (this.state === "idle") {
      this.transition("busy");
      this.armStallWatchdog();
      return;
    }
    if (this.state === "busy") {
      this.armStallWatchdog();
    }
  }

  /**
   * busy → idle (generic heuristic quiet-window). The generic tier has no native
   * done signal; a quiet output window past the configured threshold surfaces an
   * "looks idle — confirm to advance" affordance (origin R20). This NEVER
   * advances to `done` and persists as `busy` (the session stays honestly live).
   * Clears the stall watchdog: a detected idle is expected quiet, so it must not
   * also trip the stall backstop into needsAttention. Idempotent. From any state
   * other than `busy` it is a no-op (idle is only meaningful mid-turn).
   */
  signalIdle(): void {
    if (this.state === "idle") return; // idempotent
    if (this.state !== "busy") return; // only busy turns can go idle
    this.clearStallWatchdog();
    this.transition("idle");
  }

  /**
   * busy → waitingOnInput (permission / question signal). Suppresses the stall
   * watchdog (expected idleness). Does NOT advance the pipeline or fail.
   */
  signalWaitingOnInput(): void {
    if (this.state === "waitingOnInput") return; // idempotent
    if (this.state !== "busy") {
      throw new InvalidCliTransitionError(this.state, "signalWaitingOnInput");
    }
    this.waitingLatched = true;
    this.clearStallWatchdog();
    this.transition("waitingOnInput");
  }

  /** waitingOnInput → busy (user answered) and idle → busy (output resumed). */
  signalBusy(): void {
    if (this.state === "busy") {
      this.armStallWatchdog();
      return;
    }
    if (this.state !== "waitingOnInput" && this.state !== "idle") {
      throw new InvalidCliTransitionError(this.state, "signalBusy");
    }
    this.armStallWatchdog();
    this.transition("busy");
  }

  /**
   * busy → done (POSITIVE completion signal). This is the ONLY path to `done`.
   * Idle / output progress never reach here.
   */
  signalDone(): void {
    /* DELIBERATE-LITERAL — `CliMachineState`, not a board column. See followUp() above. */
    if (this.state === "done") return; // idempotent
    if (this.state !== "busy" && this.state !== "waitingOnInput") {
      throw new InvalidCliTransitionError(this.state, "signalDone");
    }
    this.doneLatched = true;
    this.clearStallWatchdog();
    this.transition("done", "completed");
  }

  /**
   * busy/waitingOnInput → dead, then classify. Provide the observed end info;
   * the taxonomy is derived by `classifyTermination`. After classification:
   * - killed / userExited / authFailed → terminal (userExited/authFailed will be
   *   surfaced as needsAttention by the caller's escalation, but the recorded
   *   reason stays precise — `escalateToNeedsAttention` moves the state).
   * - crashed / engineDeath → `resuming` (caller drives resume attempts).
   * - completed → done.
   *
   * @returns the classified termination reason.
   */
  processEnded(info: CliProcessEndInfo): CliTerminationReason {
    // dead is reachable from any active state.
    this.clearStallWatchdog();
    const reason = classifyTermination({ ...info, hadDone: info.hadDone ?? this.doneLatched });
    this.terminationReason = reason;

    if (reason === "completed") {
      this.transition("done", "completed");
      return reason;
    }
    if (isResumeEligible(reason)) {
      this.transition("resuming", reason);
      return reason;
    }
    // killed / userExited / authFailed are recorded on a `dead` landing; the
    // diagram's killed → [*] is terminal, while userExited / authFailed escalate
    // to needsAttention via escalateToNeedsAttention().
    this.transition("dead", reason);
    return reason;
  }

  /**
   * Record a resume attempt result.
   * - success → busy (a fresh turn).
   * - failure → another `resuming` with backoff, until the cap (2) is hit, then
   *   needsAttention. The third attempt is never made.
   */
  recordResumeResult(success: boolean): void {
    if (this.state !== "resuming") {
      throw new InvalidCliTransitionError(this.state, "recordResumeResult");
    }
    if (success) {
      this.resumeAttempts = 0;
      this.beginTurn();
      this.transition("busy");
      return;
    }
    this.resumeAttempts += 1;
    if (this.resumeAttempts >= this.maxResumeAttempts) {
      this.transition("needsAttention");
      return;
    }
    // Stay in resuming with backoff metadata so the coordinator schedules a retry.
    const backoff = this.resumeBackoffBaseMs * 2 ** (this.resumeAttempts - 1);
    this.persistAndEmit("resuming", this.terminationReason, backoff);
  }

  /** Backoff (ms) the coordinator should wait before the next resume attempt. */
  nextResumeBackoffMs(): number {
    return this.resumeBackoffBaseMs * 2 ** this.resumeAttempts;
  }

  /**
   * Escalate the current dead/auth/userExit landing to needsAttention (the
   * userExited → needsAttention and authFailed → needsAttention edges). The
   * recorded terminationReason is preserved.
   */
  escalateToNeedsAttention(): void {
    if (
      this.state !== "dead" &&
      this.state !== "resuming" &&
      this.state !== "busy" &&
      this.state !== "waitingOnInput"
    ) {
      throw new InvalidCliTransitionError(this.state, "escalateToNeedsAttention");
    }
    this.clearStallWatchdog();
    this.transition("needsAttention");
  }

  /** Force-dispose: cancel timers and drop listeners. */
  dispose(): void {
    this.clearStallWatchdog();
    if (this.throttleTimer != null) {
      this.clearTimer(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.listeners.clear();
  }

  // ── Per-turn latches / stall watchdog ────────────────────────────────────

  private beginTurn(): void {
    // Reset per-turn latches and budgets between turns (KTD).
    this.doneLatched = false;
    this.waitingLatched = false;
    this.armStallWatchdog();
  }

  private armStallWatchdog(): void {
    this.clearStallWatchdog();
    this.stallTimer = this.setTimer(() => {
      this.onStall();
    }, this.stallThresholdMs);
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer != null) {
      this.clearTimer(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /**
   * Stall backstop: quiet busy turn past the threshold with no done/waiting
   * signal → needsAttention. Never fires from waitingOnInput (cleared) and never
   * from a streaming session (re-armed by output progress).
   */
  private onStall(): void {
    this.stallTimer = null;
    if (this.state !== "busy") return;
    if (this.doneLatched || this.waitingLatched) return;
    this.transition("needsAttention");
  }

  // ── Persistence + throttled emit ─────────────────────────────────────────

  private transition(next: CliMachineState, reason?: CliTerminationReason): void {
    this.state = next;
    if (reason !== undefined) this.terminationReason = reason;
    if (next === "busy" || next === "ready" || next === "idle") {
      // Live again (idle persists as busy): clear any stale termination reason.
      this.terminationReason = null;
    }
    this.persistAndEmit(next, this.terminationReason);
  }

  private persistAndEmit(
    next: CliMachineState,
    reason: CliTerminationReason | null,
    resumeBackoffMs?: number,
  ): void {
    // Persist the U1 store enum (resuming → dead); the machine state and the
    // resume-eligible reason carry the recovery intent for surfaces.
    this.store.updateSession(this.sessionId, {
      agentState: toPersistedState(next),
      terminationReason: reason,
      resumeAttempts: this.resumeAttempts,
    });
    const change: CliStateChange = {
      sessionId: this.sessionId,
      state: next,
      terminationReason: reason,
      resumeAttempts: this.resumeAttempts,
      ...(resumeBackoffMs !== undefined ? { resumeBackoffMs } : {}),
      at: new Date(this.now()).toISOString(),
    };
    this.emitThrottled(change);
  }

  private emitThrottled(change: CliStateChange): void {
    if (this.throttleMs <= 0) {
      this.deliver(change);
      return;
    }
    // Leading-edge: when no throttle window is open, deliver immediately and
    // open a window. Subsequent changes within the window coalesce into a single
    // trailing emit of the latest change at the window edge.
    if (this.throttleTimer == null) {
      this.deliver(change);
      this.throttleTimer = this.setTimer(() => {
        this.throttleTimer = null;
        if (this.pendingEmit) {
          const pending = this.pendingEmit;
          this.pendingEmit = null;
          this.deliver(pending);
        }
      }, this.throttleMs);
      return;
    }
    // Within an open window → coalesce (keep only the latest).
    this.pendingEmit = change;
  }

  private deliver(change: CliStateChange): void {
    this.lastEmitAt = this.now();
    for (const listener of this.listeners) {
      listener(change);
    }
  }
}
