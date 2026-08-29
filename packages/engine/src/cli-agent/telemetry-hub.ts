/**
 * TelemetryHub — in-process telemetry ingestion + per-session token registry
 * (CLI Agent Executor, U3).
 *
 * The hub is the single in-process sink for normalized telemetry events about a
 * CLI agent session. It is consumed later by:
 * - the dashboard hook route (U17), which forwards validated hook POSTs, and
 * - log-tailing adapters (Codex rollout, Pi JSONL) that synthesize events.
 *
 * The engine has NO HTTP server — this module is pure engine code. It performs
 * NO networking; it only validates tokens and ingests already-delivered events.
 *
 * Responsibilities (KTD — telemetry tiering, completion gating, security):
 * - Token registry: mint a high-entropy per-session hook token at spawn
 *   (`issueToken`), validate it scoped to its own session (`validateToken`), and
 *   invalidate it on session end (`invalidate`). On construction the registry is
 *   rebuilt ONLY from sessions still live in `CliSessionStore`, so stale on-disk
 *   tokens for non-live sessions never validate after an engine restart.
 *   A forged completion using another session's token is rejected because a
 *   token validates only for the session it was issued to.
 * - Normalization + bounding: per-event payload size caps, per-turn event count
 *   caps, ANSI / control stripping BEFORE any pattern matching, and secret
 *   redaction that survives chunk boundaries (a token split across two chunks is
 *   still caught — uses `redactSecrets` from @fusion/core on the joined tail).
 * - Routing: maps a normalized event onto the session's state machine
 *   (sessionStart→ready, busy→signalBusy, waitingOnInput→signalWaitingOnInput +
 *   notification dispatch, done→signalDone, outputProgress→signalOutputProgress,
 *   idle→signalIdle). Idle/output NEVER advances to done — that gating lives in
 *   the state machine. The `idle` kind is the generic heuristic tier's
 *   quiet-window signal (U6): it surfaces the "looks idle — confirm to advance"
 *   affordance (origin R20) and is mapped to a busy-equivalent idle sub-state,
 *   never to `done`.
 */

import { randomBytes } from "node:crypto";
import { redactSecrets, type CliSessionStore } from "@fusion/core";
import { CliSessionStateMachine } from "./state-machine.js";

// ── Constants (bounding rules) ───────────────────────────────────────────────

/** Max retained text per ingested event after stripping (bytes/chars). */
export const DEFAULT_MAX_EVENT_CHARS = 64 * 1024;
/** Max events accepted per turn before further events are dropped (count cap). */
export const DEFAULT_MAX_EVENTS_PER_TURN = 5000;
/**
 * Carry-over window kept across chunks so a secret straddling a chunk boundary is
 * still redacted (prefix in chunk N, value in chunk N+1).
 */
export const DEFAULT_CHUNK_CARRY_CHARS = 256;

/** A live session that the hub considers "live" when rebuilding tokens. */
const LIVE_STATES = new Set(["starting", "ready", "busy", "waitingOnInput", "resuming"]);

// ── Event contract ───────────────────────────────────────────────────────────

/** Normalized telemetry event kinds the hub understands. */
export type TelemetryEventKind =
  | "sessionStart"
  | "busy"
  | "waitingOnInput"
  | "done"
  | "idle"
  | "toolActivity"
  | "outputProgress"
  | "transcript";

/** A normalized telemetry event. `payload` is event-specific, free-form, bounded. */
export interface TelemetryEvent {
  kind: TelemetryEventKind;
  payload?: Record<string, unknown> & {
    /** Raw text chunk (output / transcript) — stripped + redacted on ingest. */
    text?: string;
    /** Native session id reported by the CLI (e.g. Claude `session_id`). */
    nativeSessionId?: string;
    /** Notification context for a waitingOnInput event (permission/question). */
    notification?: Record<string, unknown>;
  };
}

/** The sanitized form of an event after ingest bounding/stripping/redaction. */
export interface SanitizedTelemetryEvent {
  kind: TelemetryEventKind;
  /** Sanitized text (ANSI/control stripped, secret-redacted, size-capped). */
  text?: string;
  nativeSessionId?: string;
  notification?: Record<string, unknown>;
  /** True when the event text was truncated by the size cap. */
  truncated?: boolean;
}

/** Dispatch invoked when a waitingOnInput event is ingested (banner/notify). */
export type NotificationDispatch = (info: {
  sessionId: string;
  notification: Record<string, unknown> | undefined;
}) => void;

/**
 * Narrow tap invoked synchronously for every successfully-ingested (sanitized)
 * event, AFTER state-machine routing. This is the seam that lets a downstream
 * consumer — e.g. the CLI-backed chat runner (U12) building a durable transcript
 * — observe the same sanitized events the hub already produced, without the hub
 * growing a full subscriber bus. It is best-effort: a throwing listener never
 * breaks ingest (the listener error is swallowed; ingest still returns).
 */
export type TelemetryEventListener = (
  sessionId: string,
  event: SanitizedTelemetryEvent,
) => void;

export interface TelemetryHubOptions {
  store: CliSessionStore;
  /** Notification dispatch for waiting-on-input events (per node config). */
  onNotification?: NotificationDispatch;
  /**
   * Optional sanitized-event tap (e.g. the CLI-backed chat transcript runner).
   * Invoked once per ingested event after routing; best-effort (never throws
   * into ingest). May also be set later via {@link TelemetryHub.setEventListener}.
   */
  onEvent?: TelemetryEventListener;
  /** Per-event text cap. */
  maxEventChars?: number;
  /** Per-turn event count cap. */
  maxEventsPerTurn?: number;
  /** Cross-chunk carry-over window for boundary-spanning secret redaction. */
  chunkCarryChars?: number;
  /** Token byte length (high entropy). Default 32 bytes → 64 hex chars. */
  tokenBytes?: number;
  /** Factory for a session's state machine (test injection). */
  createStateMachine?: (sessionId: string) => CliSessionStateMachine;
}

// ── ANSI / control stripping ─────────────────────────────────────────────────

const ESC = "\\u001b";
// OSC: ESC ] ... terminated by BEL () or ST (ESC \). Strip first — it
// carries ';' the CSI pattern would otherwise eat into.
const OSC_PATTERN = new RegExp(`${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`, "g");
// CSI (ESC [ params intermediates final) + other 2-char ESC sequences.
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]`, "g");
// Remaining lone C0 controls (except \t \n \r) and DEL.
// eslint-disable-next-line no-control-regex
const C0_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Strip ANSI escape sequences and stray control chars from text. */
export function stripAnsiControl(text: string): string {
  return text.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "").replace(C0_PATTERN, "");
}

// ── Per-session telemetry state ──────────────────────────────────────────────

interface SessionTelemetry {
  token: string;
  machine: CliSessionStateMachine;
  /** Event count in the current turn (reset on a new busy turn). */
  turnEventCount: number;
  /** Tail of the previous chunk's text, kept for boundary-spanning redaction. */
  carry: string;
}

// ── Hub ──────────────────────────────────────────────────────────────────────

export class TelemetryHub {
  private readonly store: CliSessionStore;
  private readonly onNotification?: NotificationDispatch;
  /** Sanitized-event tap; settable post-construction (narrow seam, not a bus). */
  private onEvent?: TelemetryEventListener;
  private readonly maxEventChars: number;
  private readonly maxEventsPerTurn: number;
  private readonly chunkCarryChars: number;
  private readonly tokenBytes: number;
  private readonly createStateMachine: (sessionId: string) => CliSessionStateMachine;

  /** token → sessionId reverse index (validates token-belongs-to-session). */
  private readonly tokenToSession = new Map<string, string>();
  private readonly sessions = new Map<string, SessionTelemetry>();

  constructor(opts: TelemetryHubOptions) {
    this.store = opts.store;
    this.onNotification = opts.onNotification;
    this.onEvent = opts.onEvent;
    this.maxEventChars = opts.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;
    this.maxEventsPerTurn = opts.maxEventsPerTurn ?? DEFAULT_MAX_EVENTS_PER_TURN;
    this.chunkCarryChars = opts.chunkCarryChars ?? DEFAULT_CHUNK_CARRY_CHARS;
    this.tokenBytes = opts.tokenBytes ?? 32;
    this.createStateMachine =
      opts.createStateMachine ??
      ((sessionId) => new CliSessionStateMachine({ sessionId, store: this.store }));

    this.rebuildFromLiveSessions();
  }

  /**
   * Rebuild the per-session registry from sessions still live in the store. Stale
   * tokens for non-live sessions are NOT recreated — only sessions in a live
   * state get a fresh token, so a forged POST referencing a dead session's id has
   * no valid token to present. Tokens are NOT persisted, so a restart always
   * mints fresh ones; an attacker holding an old on-disk token cannot validate.
   */
  private rebuildFromLiveSessions(): void {
    const live = this.store
      .listSessions()
      .filter((s) => LIVE_STATES.has(s.agentState));
    for (const session of live) {
      this.register(session.id);
    }
  }

  /** Whether a session id is currently registered (live) with the hub. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Get the state machine for a registered session (for the executor seam). */
  getStateMachine(sessionId: string): CliSessionStateMachine | undefined {
    return this.sessions.get(sessionId)?.machine;
  }

  /**
   * Set (or clear) the sanitized-event tap after construction. Used to wire the
   * CLI-backed chat transcript runner (U12) onto the same hub the hook route
   * already feeds, without the hub becoming a general subscriber bus.
   */
  setEventListener(listener: TelemetryEventListener | undefined): void {
    this.onEvent = listener;
  }

  // ── Token registry ─────────────────────────────────────────────────────────

  /**
   * Register a session and mint its high-entropy hook token. Idempotent: a second
   * call returns the existing token (so rebuild + spawn races don't double-mint).
   */
  private register(sessionId: string): string {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.token;
    const token = randomBytes(this.tokenBytes).toString("hex");
    const machine = this.createStateMachine(sessionId);
    this.sessions.set(sessionId, { token, machine, turnEventCount: 0, carry: "" });
    this.tokenToSession.set(token, sessionId);
    return token;
  }

  /** Mint (or return) the per-session hook token at spawn. */
  issueToken(sessionId: string): string {
    return this.register(sessionId);
  }

  /**
   * Validate a token against a specific session. Returns true ONLY when the token
   * was issued for exactly this session — a valid token for session B never
   * validates for session A (forged-completion rejection).
   */
  validateToken(sessionId: string, token: string | null | undefined): boolean {
    if (!token) return false;
    const owner = this.tokenToSession.get(token);
    if (!owner) return false;
    return owner === sessionId && this.sessions.has(sessionId);
  }

  /** Invalidate a session's token (called on session end). */
  invalidate(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.tokenToSession.delete(entry.token);
    entry.machine.dispose();
    this.sessions.delete(sessionId);
  }

  /**
   * Flush any held-back carry tail as a final redacted chunk. Call on session end
   * (before `invalidate`) so the last bytes — which were held to catch a
   * boundary-spanning secret — are emitted, still redacted. Returns the flushed
   * sanitized text, or undefined when there is nothing held / no such session.
   */
  flush(sessionId: string): string | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.carry.length === 0) return undefined;
    const text = redactSecrets(entry.carry);
    entry.carry = "";
    return text;
  }

  // ── Ingestion ────────────────────────────────────────────────────────────

  /**
   * Ingest a normalized telemetry event for a session. Token validation is the
   * caller's responsibility (the route validates before forwarding); ingest is
   * the in-process bounding + routing seam. An unknown/non-live session is a
   * no-op (never a crash). Returns the sanitized event for observability, or
   * undefined when dropped (unknown session or per-turn cap reached).
   */
  ingest(sessionId: string, event: TelemetryEvent): SanitizedTelemetryEvent | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined; // unknown / non-live session → no-op

    // Lifecycle events (turn boundaries / completion) are never dropped — they
    // drive the authoritative state machine. The per-turn cap bounds high-volume
    // activity/text events within a turn (a flood backstop), and resets when a
    // new turn begins (the `busy` / `sessionStart` route handlers zero it).
    const isLifecycle =
      event.kind === "sessionStart" ||
      event.kind === "busy" ||
      event.kind === "waitingOnInput" ||
      event.kind === "done" ||
      event.kind === "idle";
    if (!isLifecycle) {
      if (entry.turnEventCount >= this.maxEventsPerTurn) {
        return undefined;
      }
      entry.turnEventCount += 1;
    }

    const sanitized = this.sanitize(entry, event);
    this.route(entry, sanitized);
    // Narrow tap: feed the sanitized event to a downstream observer (e.g. the
    // chat transcript runner). Best-effort — a throwing listener must not break
    // ingest or the authoritative state transition that already happened.
    if (this.onEvent) {
      try {
        this.onEvent(sessionId, sanitized);
      } catch {
        // Swallow: telemetry observers are best-effort.
      }
    }
    return sanitized;
  }

  // ── Sanitization ───────────────────────────────────────────────────────────

  private sanitize(entry: SessionTelemetry, event: TelemetryEvent): SanitizedTelemetryEvent {
    const out: SanitizedTelemetryEvent = { kind: event.kind };
    const payload = event.payload ?? {};

    if (typeof payload.nativeSessionId === "string") {
      out.nativeSessionId = payload.nativeSessionId.slice(0, 256);
    }
    if (payload.notification && typeof payload.notification === "object") {
      out.notification = payload.notification as Record<string, unknown>;
    }

    if (typeof payload.text === "string") {
      // 1. Strip ANSI / control BEFORE pattern matching or redaction.
      const stripped = stripAnsiControl(payload.text);
      // 2. Redact across chunk boundaries. We hold back a tail window of raw
      //    (un-redacted) text from each chunk; the held tail is prepended to the
      //    NEXT chunk before redaction, so a secret whose prefix is in chunk N and
      //    value is in chunk N+1 is redacted as one string. We emit, for chunk N,
      //    everything in `carry + chunk` EXCEPT the new held tail.
      const joined = entry.carry + stripped;
      const carryLen = entry.carry.length;
      const newTail = joined.slice(Math.max(carryLen, joined.length - this.chunkCarryChars));
      const toEmit = joined.slice(0, joined.length - newTail.length);
      entry.carry = newTail;

      let visible = redactSecrets(toEmit);
      // 3. Size cap.
      let truncated = false;
      if (visible.length > this.maxEventChars) {
        visible = visible.slice(0, this.maxEventChars);
        truncated = true;
      }
      out.text = visible;
      if (truncated) out.truncated = true;
    }

    return out;
  }

  // ── Routing onto the state machine ──────────────────────────────────────────

  private route(entry: SessionTelemetry, event: SanitizedTelemetryEvent): void {
    const machine = entry.machine;
    // Capture native session id whenever reported.
    if (event.nativeSessionId) {
      const current = this.store.getSession(entry.machine.sessionId);
      if (current && current.nativeSessionId !== event.nativeSessionId) {
        this.store.updateSession(entry.machine.sessionId, {
          nativeSessionId: event.nativeSessionId,
        });
      }
    }

    switch (event.kind) {
      case "sessionStart": {
        if (machine.getState() === "starting") machine.markReady();
        break;
      }
      case "busy": {
        entry.turnEventCount = 0; // new turn → reset per-turn budget
        safeMachineCall(() => machine.signalBusy());
        break;
      }
      case "waitingOnInput": {
        safeMachineCall(() => machine.signalWaitingOnInput());
        // Notification dispatch is invoked per node config; it never advances or
        // fails the state (AE2).
        this.onNotification?.({
          sessionId: machine.sessionId,
          notification: event.notification,
        });
        break;
      }
      case "done": {
        // POSITIVE completion only. Idle / output progress never reach here.
        safeMachineCall(() => machine.signalDone());
        break;
      }
      case "idle": {
        // Generic heuristic quiet-window (U6). Surfaces the confirm-advance
        // affordance via a busy-equivalent idle sub-state; NEVER advances to
        // done. A no-op from any non-busy state (signalIdle guards internally).
        safeMachineCall(() => machine.signalIdle());
        break;
      }
      case "toolActivity":
      case "transcript":
      case "outputProgress": {
        // Activity re-arms the inactivity watchdog but NEVER advances to done.
        machine.signalOutputProgress();
        break;
      }
    }
  }
}

/**
 * State-machine calls can throw InvalidCliTransitionError when a stray event
 * arrives in a state that doesn't accept it (e.g. a `busy` event after `done`).
 * Telemetry is best-effort: swallow the transition error rather than crash
 * ingest — the authoritative state simply doesn't move.
 */
function safeMachineCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === "INVALID_CLI_TRANSITION") {
      return;
    }
    throw err;
  }
}
