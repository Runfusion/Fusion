import { createHash } from "node:crypto";
import type { TaskStore } from "@fusion/core";

/*
FNXC:DiagnosticLogDedupe 2026-10-11-22:51 (RUFU-643):
Several engine lanes re-state an unchanged diagnostic on every pass: a planning failure that keeps
failing the same way, a containment refusal, a merge-confirmed finalization refusal, an overseer
heartbeat observation. Each of those writers already had an in-process first-sighting gate
(`lastLoggedKey`, `shouldLogContainmentRefusal`, `noteFinalizationPass`) and each still produced
10k-24k rows on the live board, for one reason: an in-process gate dies with the process, and this
deployment restarts the supervised dashboard every ~14-27 min (RUFU-642's symptom), so every restart
turns a "first sighting" back into a first sighting.

Measured on the live board 2026-10-11 (read-only SQL over `project.tasks.log`), the repeated
diagnostics that carried in-process guards or none:
  16,025 rows  "Lifecycle recovery retained in 'in-progress' — …"
  14,059 rows  "Merge already confirmed; refreshing row and completing task …"
  13,931 rows  "[goal-injection] no-goals count=0 ids=[] …"
  12,346 rows  "Done-task merge metadata repair skipped: …"
  11,465 rows  "[planner] stage=… signal=progressing: …"
   7,942 rows  "Specification failed: …" (14.0 MB — the fat ones, they carry a JS stack)

The append is not merely noise. `logEntry` reads the full row twice, rewrites the whole
`task.json` mirror, and emits `task:updated`, so one suppressed repeat is also one skipped board
revalidation; and the per-task log holds only its newest 1,000 entries, so a re-stated sentence
scrolls real delivery history off the card — which is how RUFU-431's strike counters that live IN
that log were silently disarmed.

The durable seam is `store.logEntryOnce`: it dedupes on `dedupeKey` inside the same advisory-locked
transaction that appends, so the sighting record survives restarts and is shared by every process
that writes the card. This helper is the ONE engine-side wrapper over it for diagnostic lines, so a
lane cannot invent its own in-process memory again. It is deliberately not a lifecycle primitive:
it never moves a card, never burns a retry budget, and on a store without the once-seam (a test
double) falls back to the historical single-message `logEntry` shape.

FNXC:DiagnosticLogDedupe 2026-10-11-22:51 (RUFU-643) — inventory boundary made explicit:
routing an append through a helper moves the call out of the module the FN-8923 durable-write
inventory scans, so a converted lane is no longer listed as a per-call-site write. Two things keep
that honest rather than silent: the sink type below names ONLY `logEntry`/`logEntryOnce`, so this
seam cannot be pointed at merge, landing, or status state even by accident, and both methods remain
classified durable writers in `__tests__/_merge-durable-write-callsites.ts`, so the write itself is
still counted. A new lane that needs a bounded diagnostic adds a key here; it does not add a map.
*/

/**
 * Default sighting window for a diagnostic episode.
 *
 * Six hours is one operator shift: a card that is still failing the same way after that long is
 * news again, and the card shows one line per window instead of one per pass or one per restart.
 */
export const DIAGNOSTIC_LOG_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Short stable fingerprint of the variable part of a diagnostic sentence.
 *
 * The dedupe key is stored ON the log entry, so it must stay short and must not carry the sentence:
 * a key built from the raw message would re-introduce the bytes this helper exists to stop, and a
 * message can embed a counter or timestamp that changes every pass.
 */
export function diagnosticSignature(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Exact 4th-parameter type of `TaskStore.logEntry`, so a caller's run attribution is forwarded without
 * re-declaring (and drifting from) core's shape.
 */
type DiagnosticRunContext = NonNullable<Parameters<TaskStore["logEntry"]>[3]>;

/*
FNXC:DiagnosticLogDedupe 2026-10-11-22:51 (RUFU-643):
The sink is declared structurally rather than as `Partial<TaskStore>` because several callers hold a
narrower seam on purpose — the planner overseer takes `{ logEntry? }`, not a store — and a full store
method returns `Promise<Task>` where those seams return `Promise<unknown>`. Widening the return type is
sound here: this helper never reads the returned task.
*/
export interface DiagnosticLogSink {
  logEntry?(id: string, action: string, outcome?: string, runContext?: DiagnosticRunContext): Promise<unknown>;
  logEntryOnce?(id: string, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }): Promise<boolean>;
}

export interface DiagnosticLogOnceInput {
  /** Operator-visible sentence. Written verbatim on the first sighting inside the window. */
  action: string;
  /** Optional detail (stack, gate reason). Stored only with the entry that was actually appended. */
  outcome?: string;
  /** Episode identity, e.g. `specification-failure:<fingerprint>`. Same key within window = silent. */
  dedupeKey: string;
  /** Overrides {@link DIAGNOSTIC_LOG_WINDOW_MS} for a lane whose episode is longer-lived. */
  windowMs?: number;
  /**
   * Run attribution carried on the fallback `logEntry` arm only.
   *
   * `logEntryOnce` has no runContext arm (it writes no `task:log` audit row), so on a store that has
   * the once-seam this is unused; on a store that does not, it preserves the caller's historical
   * write shape exactly instead of silently downgrading it.
   */
  runContext?: DiagnosticRunContext;
  /** Non-throwing sink for the suppressed failure channel; the append never gates its caller. */
  onWarn?: (message: string) => void;
}

/**
 * Append one operator-visible diagnostic at most once per (card, episode) per window.
 *
 * FNXC:DiagnosticLogDedupe 2026-10-11-22:51 (RUFU-643) — the suppressed repeat writes NOTHING, and that
 * is the point, so the coupling has to be named. `logEntry` bumped `updated_at` on every append, and
 * several sweeps read that shared clock: the stalled-card watchdog's idle floor, the stale-merge-active
 * check, the surfacing sweeps' "written this cycle" guard, the 30-minute auto-merge retry cooldown, and
 * the merge sweep's quiescence admission. A chatty diagnostic therefore kept those clocks permanently
 * open — a card whose only activity was its own refusal line could never look idle, never cool down, and
 * never be quiescent enough to merge. Suppressing the repeat removes that false liveness: every affected
 * reader either reports without moving the card (watchdog, surfacing, stale-task reporter) or proceeds on
 * authority that lives elsewhere (live-session proof, merge gates, retry counters). Do not "restore" the
 * bump: the noise was the bug, and a card that looks busy because it keeps saying it is stuck is the
 * failure mode RUFU-291 and RUFU-642 were filed about.
 *
 * @returns `true` when an entry was appended. `false` means the card already carries this exact
 * diagnostic inside the window, or the write failed — both outcomes are silent by design, and the
 * failure is reported to `onWarn` rather than thrown, because a diagnostic that cannot be written
 * must not change what the caller does next.
 */
export async function logDiagnosticOnce(
  store: DiagnosticLogSink,
  taskId: string,
  input: DiagnosticLogOnceInput,
): Promise<boolean> {
  const windowMs = input.windowMs ?? DIAGNOSTIC_LOG_WINDOW_MS;
  const warn = (err: unknown): false => {
    input.onWarn?.(err instanceof Error ? err.message : String(err));
    return false;
  };
  try {
    if (typeof store.logEntryOnce === "function") {
      return await store.logEntryOnce.call(store, taskId, {
        action: input.action,
        outcome: input.outcome,
        dedupeKey: input.dedupeKey,
        windowMs,
      });
    }
    /*
    FNXC:DiagnosticLogDedupe 2026-10-11-22:51 (RUFU-643):
    The fallback keeps the caller's EXACT historical argument list rather than passing `undefined`
    placeholders: existing writer tests assert `toHaveBeenCalledWith(id, action)` with vitest's
    strict arity, and a widened call would fail those guards for a reason no operator can observe.
    */
    if (input.runContext) {
      await store.logEntry?.call(store, taskId, input.action, input.outcome, input.runContext);
    } else if (input.outcome !== undefined) {
      await store.logEntry?.call(store, taskId, input.action, input.outcome);
    } else {
      await store.logEntry?.call(store, taskId, input.action);
    }
    return true;
  } catch (err) {
    return warn(err);
  }
}
