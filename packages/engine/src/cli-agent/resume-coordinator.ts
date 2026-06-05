/**
 * CliResumeCoordinator — engine-restart recovery for CLI agent sessions
 * (CLI Agent Executor, U8).
 *
 * On engine start, sessions persisted as live (starting / ready / busy /
 * waitingOnInput) were orphaned by the engine's death — there is no live PTY
 * behind them. This coordinator finds those records, classifies them as
 * `engineDeath`, and queues a resume that respects the session-manager
 * concurrency ceiling.
 *
 * Resume semantics (KTD — termination taxonomy, resume-the-CLI):
 * - Eligibility: ONLY `crashed` and `engineDeath` are resume-eligible
 *   (`isResumeEligible`). `killed` / `userExited` are never auto-resumed;
 *   `authFailed` and `completed` are never resumed. A record found live on
 *   restart is reclassified to `engineDeath` (it had no chance to record a
 *   terminal reason), making it eligible.
 * - Worktree-existence precondition: the recorded worktree MUST still exist —
 *   a missing worktree routes the session to `needsAttention`, NEVER a CLI
 *   spawned into a vanished directory.
 * - Dirty-tree detection: a dirty `git status` is logged and flagged on the
 *   session record (under `autonomyPosture.resumeDirtyWorktree`), then resume
 *   PROCEEDS — the flag surfaces to the UI.
 * - Relaunch: via the manager's resume path (adapter `buildResume` with the
 *   recorded `nativeSessionId`, in the recorded worktree). Telemetry is
 *   re-attached (a fresh hook token + scripts via `wireTelemetry`/the hub).
 *   NO prompt is re-injected — scrollback replays to viewers, the agent
 *   continues from its own native transcript.
 * - Attempt cap: 2 attempts with backoff (tracked on `resumeAttempts`).
 *   Exhaustion, an adapter without resume support, a missing vendor session
 *   store, or an immediate spawn error route to `needsAttention` (a permanent
 *   failure path, NOT an infinite retry loop).
 *
 * The coordinator NEVER imports dashboard code. The worktree-existence check
 * and the dirty-tree probe are injected seams so tests need no real git/FS.
 */

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliSession, CliSessionStore, CliTerminationReason } from "@fusion/core";
import type { CliSessionManager } from "./session-manager.js";
import { CliConcurrencyLimitError, CliResumeUnsupportedError } from "./session-manager.js";
import type { CliAdapterRegistry } from "./adapter.js";
import { isResumeEligible } from "./state-machine.js";

const execFileAsync = promisify(execFile);

/** Persisted-as-live states that, found on restart, imply an orphaned PTY. */
const ORPHANED_LIVE_STATES = new Set<CliSession["agentState"]>([
  "starting",
  "ready",
  "busy",
  "waitingOnInput",
]);

/** Default resume attempt cap (KTD = 2). */
export const DEFAULT_MAX_RESUME_ATTEMPTS = 2;
/** Default base backoff (ms) between resume attempts; doubled per attempt. */
export const DEFAULT_RESUME_BACKOFF_BASE_MS = 1000;

/** Outcome of a single session's resume disposition. */
export type ResumeDisposition =
  | "resumed"
  | "needsAttention-missingWorktree"
  | "needsAttention-ineligible"
  | "needsAttention-exhausted"
  | "needsAttention-resumeUnsupported"
  | "needsAttention-spawnError"
  | "skipped-noCapacity";

export interface ResumeResult {
  sessionId: string;
  taskId: string | null;
  disposition: ResumeDisposition;
  /** Whether the worktree was dirty at resume (flag also persisted on the record). */
  dirtyWorktree?: boolean;
  /** Reason string for needsAttention dispositions. */
  reason?: string;
}

export interface CliResumeCoordinatorOptions {
  store: CliSessionStore;
  manager: CliSessionManager;
  registry: CliAdapterRegistry;
  /**
   * Re-attach telemetry for a resumed session — typically wires a fresh hook
   * token + scripts via the TelemetryHub. Called AFTER a successful relaunch and
   * BEFORE returning. Best-effort; a throw is logged, never fatal to the sweep.
   */
  reattachTelemetry?: (session: CliSession) => void | Promise<void>;
  /** Max resume attempts before needsAttention. Default 2 (KTD). */
  maxResumeAttempts?: number;
  /** Base backoff (ms); doubled per prior attempt. Default 1000. */
  resumeBackoffBaseMs?: number;
  /** Worktree-existence probe (injected for tests). Default `fs.existsSync`. */
  worktreeExists?: (worktreePath: string) => boolean;
  /**
   * Dirty-tree probe (injected for tests). Returns true when `git status` shows
   * uncommitted changes. Default: runs `git status --porcelain` in the worktree.
   */
  isWorktreeDirty?: (worktreePath: string) => Promise<boolean>;
  /** Best-effort logger. */
  log?: (msg: string) => void;
}

/** Default dirty-tree probe: `git status --porcelain` is non-empty. */
async function defaultIsWorktreeDirty(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
    });
    return stdout.trim().length > 0;
  } catch {
    // Not a git worktree / git unavailable: treat as not-dirty (don't block resume).
    return false;
  }
}

export class CliResumeCoordinator {
  private readonly store: CliSessionStore;
  private readonly manager: CliSessionManager;
  private readonly registry: CliAdapterRegistry;
  private readonly reattachTelemetry?: (session: CliSession) => void | Promise<void>;
  private readonly maxResumeAttempts: number;
  private readonly resumeBackoffBaseMs: number;
  private readonly worktreeExists: (worktreePath: string) => boolean;
  private readonly isWorktreeDirty: (worktreePath: string) => Promise<boolean>;
  private readonly log: (msg: string) => void;

  constructor(opts: CliResumeCoordinatorOptions) {
    this.store = opts.store;
    this.manager = opts.manager;
    this.registry = opts.registry;
    this.reattachTelemetry = opts.reattachTelemetry;
    this.maxResumeAttempts = opts.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS;
    this.resumeBackoffBaseMs = opts.resumeBackoffBaseMs ?? DEFAULT_RESUME_BACKOFF_BASE_MS;
    this.worktreeExists = opts.worktreeExists ?? ((p) => existsSync(p));
    this.isWorktreeDirty = opts.isWorktreeDirty ?? defaultIsWorktreeDirty;
    this.log = opts.log ?? (() => {});
  }

  /**
   * The set of worktree paths backing resume-eligible session records. Exposed
   * for the self-healing seam so idle-worktree sweeps treat them as in-use. A
   * record is resume-eligible if it is found live-on-restart (→ engineDeath) or
   * already carries a resume-eligible termination reason AND has not exhausted
   * its attempt cap. The path is `resolve`d-free (raw recorded path); callers
   * normalize as needed.
   */
  resumeReservedWorktrees(): Set<string> {
    const reserved = new Set<string>();
    for (const session of this.store.listSessions()) {
      if (!session.worktreePath) continue;
      if (!this.isRecordResumeEligible(session)) continue;
      reserved.add(session.worktreePath);
    }
    return reserved;
  }

  /** Whether a recorded session is currently resume-eligible (for sweep skipping). */
  isRecordResumeEligible(session: CliSession): boolean {
    if (session.resumeAttempts >= this.maxResumeAttempts) return false;
    // Found-live-on-restart → engineDeath (eligible).
    if (ORPHANED_LIVE_STATES.has(session.agentState)) return true;
    // Reaped-but-resumable: a dead record whose recorded reason is resume-eligible.
    if (
      session.agentState === "dead" &&
      session.terminationReason != null &&
      isResumeEligible(session.terminationReason)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Engine-start sweep. Finds orphaned-live sessions, classifies engineDeath,
   * and resumes each (respecting the manager's concurrency ceiling). Returns a
   * per-session disposition list. Idempotent: a second run after a successful
   * resume finds the session live (re-spawned record is `starting`/`ready`) but
   * the manager's `isLive` guard prevents a duplicate spawn — see `resumeOne`.
   */
  async recoverOnStart(): Promise<ResumeResult[]> {
    const candidates = this.store
      .listSessions()
      .filter((s) => ORPHANED_LIVE_STATES.has(s.agentState))
      // Never reclaim a session the manager already owns (idempotent re-run).
      .filter((s) => !this.manager.isLive(s.id));

    const results: ResumeResult[] = [];
    for (const session of candidates) {
      // Concurrency ceiling: stop queuing once slots are exhausted. The
      // remaining records stay persisted-live and are picked up next sweep.
      if (this.manager.availableSlots() <= 0) {
        results.push({
          sessionId: session.id,
          taskId: session.taskId,
          disposition: "skipped-noCapacity",
        });
        continue;
      }
      results.push(await this.resumeOne(session));
    }
    return results;
  }

  /**
   * Resume a single orphaned session through the eligibility predicate and
   * worktree precondition. Public for targeted tests.
   */
  async resumeOne(session: CliSession): Promise<ResumeResult> {
    const base = { sessionId: session.id, taskId: session.taskId };

    // Idempotency: the manager already owns a live PTY for this id → no-op.
    if (this.manager.isLive(session.id)) {
      return { ...base, disposition: "resumed" };
    }

    // Reclassify a found-live record to engineDeath (it never recorded a reason).
    // A dead record keeps its recorded reason (crashed / killed / userExited / …).
    const reason: CliTerminationReason = ORPHANED_LIVE_STATES.has(session.agentState)
      ? "engineDeath"
      : session.terminationReason ?? "engineDeath";

    // Eligibility predicate: only crashed / engineDeath ever resume.
    if (!isResumeEligible(reason)) {
      this.toNeedsAttention(session, reason, `ineligible termination reason: ${reason}`);
      return { ...base, disposition: "needsAttention-ineligible", reason };
    }

    // Attempt-cap exhaustion → permanent needsAttention (never a third spawn).
    if (session.resumeAttempts >= this.maxResumeAttempts) {
      this.toNeedsAttention(session, reason, `resume attempts exhausted (${session.resumeAttempts})`);
      return { ...base, disposition: "needsAttention-exhausted", reason };
    }

    // Worktree-existence precondition: never spawn into a vanished directory.
    const worktreePath = session.worktreePath;
    if (!worktreePath || !this.worktreeExists(worktreePath)) {
      this.toNeedsAttention(session, reason, `recorded worktree missing: ${worktreePath ?? "<none>"}`);
      return { ...base, disposition: "needsAttention-missingWorktree", reason };
    }

    // Adapter must support resume.
    const adapter = (() => {
      try {
        return this.registry.get(session.adapterId);
      } catch {
        return undefined;
      }
    })();
    if (!adapter || !adapter.capabilities.supportsResume || typeof adapter.buildResume !== "function") {
      this.toNeedsAttention(session, reason, `adapter does not support resume: ${session.adapterId}`);
      return { ...base, disposition: "needsAttention-resumeUnsupported", reason };
    }

    // Vendor session store precondition: a captured native id is required.
    if (!session.nativeSessionId) {
      this.toNeedsAttention(session, reason, "missing native session id (no vendor session store)");
      return { ...base, disposition: "needsAttention-spawnError", reason };
    }

    // Dirty-tree detection: log + flag, then PROCEED.
    let dirty = false;
    try {
      dirty = await this.isWorktreeDirty(worktreePath);
    } catch {
      dirty = false;
    }
    if (dirty) {
      this.log(`[cli-resume] session ${session.id}: worktree dirty at resume — flagged, proceeding`);
      this.flagDirty(session);
    }

    // Relaunch via the manager's resume path (adapter buildResume + native id),
    // reusing the existing record so no duplicate session row is created.
    try {
      await this.manager.spawn({
        adapterId: session.adapterId,
        projectId: session.projectId,
        purpose: session.purpose,
        taskId: session.taskId,
        chatSessionId: session.chatSessionId,
        worktreePath,
        posture: session.autonomyPosture,
        resume: { sessionId: session.id, nativeSessionId: session.nativeSessionId },
      });
    } catch (err) {
      // Immediate spawn failure / unsupported resume / missing vendor store →
      // permanent-failure path. Record the attempt and route to needsAttention
      // once the cap is reached; otherwise leave it for the next sweep (backoff).
      const attempts = session.resumeAttempts + 1;
      this.store.updateSession(session.id, { resumeAttempts: attempts });
      const msg = err instanceof Error ? err.message : String(err);
      const isUnsupported = err instanceof CliResumeUnsupportedError;
      const isCeiling = err instanceof CliConcurrencyLimitError;
      if (isCeiling) {
        // Capacity raced away — leave persisted-live for the next sweep, no attempt charge.
        this.store.updateSession(session.id, { resumeAttempts: session.resumeAttempts });
        return { ...base, disposition: "skipped-noCapacity" };
      }
      this.log(`[cli-resume] session ${session.id}: resume spawn failed (${msg})`);
      if (isUnsupported || attempts >= this.maxResumeAttempts) {
        this.toNeedsAttention(session, reason, `resume spawn failed: ${msg}`);
        return {
          ...base,
          disposition: isUnsupported
            ? "needsAttention-resumeUnsupported"
            : "needsAttention-spawnError",
          reason: msg,
        };
      }
      // Under the cap: needsAttention is the permanent floor only at exhaustion;
      // a single immediate failure (missing vendor store / spawn error) is also
      // permanent per the KTD — do NOT loop. Route to needsAttention now.
      this.toNeedsAttention(session, reason, `resume spawn failed: ${msg}`);
      return { ...base, disposition: "needsAttention-spawnError", reason: msg };
    }

    // Re-attach telemetry (fresh hook token + scripts). Best-effort.
    if (this.reattachTelemetry) {
      try {
        const fresh = this.store.getSession(session.id) ?? session;
        await this.reattachTelemetry(fresh);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[cli-resume] session ${session.id}: telemetry re-attach failed (${msg}) — non-fatal`);
      }
    }

    this.log(`[cli-resume] session ${session.id}: resumed (native ${session.nativeSessionId}) in ${worktreePath}`);
    return { ...base, disposition: "resumed", dirtyWorktree: dirty };
  }

  /** Backoff (ms) before the next resume attempt for a given attempt count. */
  backoffForAttempt(attemptsSoFar: number): number {
    return this.resumeBackoffBaseMs * 2 ** attemptsSoFar;
  }

  /** Route a session to needsAttention, preserving the precise termination reason. */
  private toNeedsAttention(session: CliSession, reason: CliTerminationReason, why: string): void {
    this.log(`[cli-resume] session ${session.id} → needsAttention: ${why}`);
    this.store.updateSession(session.id, {
      agentState: "needsAttention",
      terminationReason: reason,
    });
  }

  /** Persist the dirty-worktree flag on the session record (extensible posture). */
  private flagDirty(session: CliSession): void {
    const posture = { ...(session.autonomyPosture ?? {}), resumeDirtyWorktree: true };
    this.store.updateSession(session.id, { autonomyPosture: posture });
  }
}
