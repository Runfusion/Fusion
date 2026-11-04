/*
FNXC:HeapCeilingObservability 2026-10-01-11:24 (RUFU-462):
The operator-facing half of the heap-ceiling observation. On the host that motivated this module the
dashboard died 28 times under the supervisor at 3.90–4.03 GB heap (`Ineffective mark-compacts near heap
limit`) while `/api/health` answered `ok` every time, because the process had been started without
`NODE_OPTIONS` and V8 therefore used its ~4.09 GB platform default. Nothing on any surface said which
ceiling the process was running under, so the condition could only be learned from a body count.

This module is what the observation DOES when the answer is "nobody chose this number": one warning line in
the log and one Mailbox notice per day. `lib/heap-ceiling.ts` resolves and classifies the ceiling; this file
only communicates it.

CHANNEL — reuse, never invent. Both sinks are the ones the retention-pressure notice already uses, so an
operator finds this notice in the same places they already read:
  1. the dashboard runtime log (`runtime-logger.ts`);
  2. the operator mailbox via `MessageStore.sendMessageOnce` — the same one-shot system-notice seam as the
     retention notice and `core/task-delete-notice.ts`. There is deliberately no new channel, no new SSE
     event type, and no dashboard-app rendering change: the dashboard cannot import `@fusion/engine`
     (circularity rule), so the message store is reached structurally through `engine.getMessageStore()`.

RATE LIMITING: the Mailbox write is idempotent per UTC day (`heap-ceiling:v8-default:<day-bucket>`), so a
host that lives on the default ceiling hears about it once a day and no louder, while every boot still gets
its log line. The log lane is NOT deduped — the ceiling is a per-process fact, and a supervisor that respawns
every ten minutes should leave that trail.

A DEFAULT CEILING IS NOT A DEFECT. Small boards run comfortably inside 4 GiB, and the value is a per-host
operator decision recorded in `docs/solutions/performance/dashboard-heap-growth-runbook.md`. This notice
states which provenance the number has and where to change it; it never implies the number is wrong, and
this module never sets, raises, defaults, or injects a ceiling — the runbook's standing rule is that the
product must not raise the ceiling as a fix for a leak, and observability is what lets that rule and the
operator's host decision coexist.

PAYLOAD HONESTY: log context and Mailbox metadata carry the byte count, the fixed three-value source enum,
and one boolean — never the raw `NODE_OPTIONS` string or any other launch-environment text (the health
route that also reports this is auth-exempt, and the mailbox row persists). Prose lives in `content` only,
following the retention/delete-notice convention.

BEST-EFFORT: a notice about the process's memory must never itself become a lifecycle dependency. Every
function here is `void`-safe: a missing, throwing, or rejecting mailbox resolves false, and a failing log
sink is swallowed, exactly like `notifyRetentionPressure`.

FNXC:HeapCeilingObservability 2026-10-01-11:34 (RUFU-462 Step 4):
`reportHeapCeilingAtBoot` is the single composition point for the three lanes, so a boot cannot report
half a fact: the log line fires on EVERY boot (a supervisor respawn trail costs one line), while the
warning, the Mailbox notice, and the `runtime:heap-ceiling` run-audit row are gated on `isV8Default`. That
asymmetry is the rate limit — the ceiling is a standing property of the host's launch environment, not an
episode, so nothing may escalate it: a host permanently on the default hears by Mailbox once per UTC day,
while the countable forensic record is one audit row per boot (`runId` carries the pid, which identifies
the process without putting a path or launch-environment text in metadata). The once-per-process latch
exists because `createServer()` can legitimately run twice in one process (tests, the embedded desktop
host) and a second identical row would make the count lie.
*/

import {
  DASHBOARD_USER_ID,
  emitBoundedRunAudit,
  type MessageCreateInput,
} from "@fusion/core";
import {
  formatHeapCeilingBytes,
  formatHeapCeilingLine,
  getBootHeapCeiling,
  MAX_OLD_SPACE_FLAG,
  type HeapCeiling,
} from "./lib/heap-ceiling.js";
import type { RuntimeLogger } from "./runtime-logger.js";

/**
 * The one mailbox method this notice needs. `MessageStore` structurally satisfies it; the same narrowing
 * `retention-pressure-notice.ts` applies, so a single system notice does not depend on the whole store.
 */
export interface HeapCeilingMailbox {
  sendMessageOnce(
    input: MessageCreateInput,
    idempotencyKey: string,
  ): Promise<{ inserted?: boolean } | unknown>;
}

/** Idempotency bucket for the Mailbox notice: one default-ceiling notice per UTC day. */
export const HEAP_CEILING_NOTICE_BUCKET_MS = 24 * 60 * 60 * 1000;

/** Where the host can declare the ceiling, in the order Node applies them. Names only, never values. */
const CEILING_PLACES = `\`${MAX_OLD_SPACE_FLAG}\` as a Node argv flag (execArgv) or in \`NODE_OPTIONS\``;

/** The runbook that records the per-host intent and the never-raise-as-a-leak-fix rule. */
const RUNBOOK_PATH = "docs/solutions/performance/dashboard-heap-growth-runbook.md";

/**
 * The warning line for a process whose ceiling nobody chose. It says what the ceiling IS, that no launch
 * site declared it, and where to look — the two facts that were missing during the 28-restart crash loop.
 * Non-default ceilings get the plain report line instead, so the warning text is never noise on a host that
 * deliberately declared a value.
 */
export function buildHeapCeilingLogMessage(ceiling: HeapCeiling): string {
  if (!ceiling.isV8Default) {
    return `${MAX_OLD_SPACE_FLAG} not defaulted — heap ceiling ${formatHeapCeilingBytes(ceiling)} declared by this process's launch site.`;
  }
  return `heap ceiling is the V8 default: ${formatHeapCeilingBytes(ceiling)}, with no ${MAX_OLD_SPACE_FLAG} in execArgv or NODE_OPTIONS. If this host expects a different ceiling, the launch environment lost it. Verify and record the per-host value in ${RUNBOOK_PATH}. Observation only: this process never sets its own ceiling.`;
}

/**
 * Numeric context for the log line: the byte count, the fixed source enum, and one boolean. Named
 * separately so a test can pin the field set without parsing prose (the retention notice's convention).
 */
export function buildHeapCeilingLogContext(
  ceiling: HeapCeiling,
): Record<string, number | string | boolean> {
  return {
    heapLimitBytes: ceiling.heapLimitBytes,
    source: ceiling.source,
    isV8Default: ceiling.isV8Default,
  };
}

/**
 * Operator-facing Mailbox prose: the number, the two places it can live, the runbook pointer, and an
 * explicit statement that nothing was changed. Mailbox `content` only — never run-audit, never the log.
 */
export function buildHeapCeilingNoticeContent(ceiling: HeapCeiling): string {
  return [
    `**Dashboard heap ceiling is the V8 default** — ${formatHeapCeilingBytes(ceiling)}.`,
    "",
    `No launch site declared a ceiling for this process, so V8 chose one for this machine. That is a fine`,
    `answer for a small board and the wrong answer for a large one — the point is that you can now tell`,
    `which without dying to find out. A dashboard that dies at its ceiling comes back through the`,
    `supervisor every few minutes while \`/api/health\` keeps answering \`ok\`, so the ceiling, not the`,
    `restart count, is the fact worth checking.`,
    "",
    `Where the ceiling can be set: ${CEILING_PLACES}. Whichever carries it, the resolved number this`,
    `process reports is the only truthful reading of it — a flag in a shell profile that never reached the`,
    `launch does not count. The per-host intended value and how to verify it are recorded in`,
    `\`${RUNBOOK_PATH}\`, along with how to tell a ceiling that is simply too small apart from a heap that`,
    `is leaking.`,
    "",
    "This is a warning, not an intervention: the product never sets, raises, or defaults this ceiling, and",
    "nothing was restarted, resized, or reconfigured to produce this notice.",
  ].join("\n");
}

/**
 * Deterministic idempotency key: one Mailbox notice per UTC day. A default ceiling is a standing property
 * of the host's launch environment, not an episode with an end, so the bucket — not a state transition —
 * is what bounds the repeat. The log line is untouched by this, so a crash loop still leaves its trail.
 */
export function buildHeapCeilingNoticeIdempotencyKey(
  nowMs: number = Date.now(),
  bucketMs: number = HEAP_CEILING_NOTICE_BUCKET_MS,
): string {
  const bucket = Math.floor(nowMs / Math.max(1, bucketMs));
  return `heap-ceiling:v8-default:${bucket}`;
}

/** The run-audit row one boot of a default-ceiling process leaves behind. Declared in `@fusion/core`. */
export const HEAP_CEILING_MUTATION_TYPE = "runtime:heap-ceiling";

/**
 * What a boot report needs, and nothing more:
 * - `logger` — the dashboard runtime logger (or a child of it). The only mandatory dep, because the log
 *   lane is the one that survives every other absence, including a headless `--no-engine` boot.
 * - `resolveMailbox` — called lazily so a store/engine that is not up yet at the moment of the call does
 *   not silently disable the notice; mirrors the retention notifier's `() => engine.getMessageStore()`.
 * - `auditHost` — anything holding `recordRunAuditEvent` (a `TaskStore`), fed straight to the bounded seam.
 * - `ceiling` — test/host seam; defaults to the process's one memoized snapshot.
 */
export interface HeapCeilingReportDeps {
  logger: Pick<RuntimeLogger, "info" | "warn">;
  resolveMailbox?: () => HeapCeilingMailbox | null | undefined;
  auditHost?: Parameters<typeof emitBoundedRunAudit>[0];
  nowMs?: number;
  noticeBucketMs?: number;
  ceiling?: HeapCeiling;
}

/** The result of one boot report — the observed fact plus which lanes actually ran. */
export interface HeapCeilingBootReport {
  /** The ceiling every other surface must agree with (the memoized snapshot unless injected). */
  ceiling: HeapCeiling;
  /** False when an earlier call in this process already reported: one boot, one report. */
  emitted: boolean;
  /** True when the ceiling is the V8 default, i.e. the warning + notice + audit lanes ran. */
  warned: boolean;
  /** True when the Mailbox write was accepted (a same-day duplicate collapses inside the store). */
  noticeWritten: boolean;
}

let bootReportEmitted = false;

/** Test-only seam: forget the once-per-process latch so a suite can re-report. */
export function resetHeapCeilingBootReportForTesting(): void {
  bootReportEmitted = false;
}

/**
 * Report the ceiling this process booted under. Called once per boot by `createServer()`.
 *
 * Three lanes with three different rates, on purpose:
 *   1. **log** — every boot, one line, naming the number and the site that carries it;
 *   2. **warning + Mailbox notice** — only when no launch site declared a ceiling (`v8-default`), with the
 *      Mailbox write bounded to one per UTC day so a host that lives on the default is not nagged, while a
 *      supervisor that respawns every ten minutes still leaves a log trail;
 *   3. **run-audit** — `runtime:heap-ceiling`, default case only, so the condition is countable after the
 *      fact instead of being quoted from a log file (`runId` carries the pid, which identifies the process
 *      without putting a path or the launch environment in metadata).
 *
 * Never throws, never rejects, and does not block the boot it reports: both external lanes go through sinks
 * that are already bounded or swallowed, and the log lane is wrapped so a broken log sink cannot fail boot
 * either. The awaited part is the Mailbox write only, and callers fire-and-forget that (`void`).
 */
export async function reportHeapCeilingAtBoot(
  deps: HeapCeilingReportDeps,
): Promise<HeapCeilingBootReport> {
  const ceiling = deps.ceiling ?? getBootHeapCeiling();
  if (bootReportEmitted) {
    // A second createServer() in one process (tests, the embedded desktop host) must not write a second
    // audit row or a second log line for a fact that cannot have changed since the first report.
    return { ceiling, emitted: false, warned: false, noticeWritten: false };
  }
  bootReportEmitted = true;

  const context = buildHeapCeilingLogContext(ceiling);
  try {
    deps.logger.info(formatHeapCeilingLine(ceiling), context);
    if (ceiling.isV8Default) deps.logger.warn(buildHeapCeilingLogMessage(ceiling), context);
  } catch {
    // Swallowed on purpose: reporting a memory ceiling must never become the reason a boot fails.
  }

  if (!ceiling.isV8Default) {
    return { ceiling, emitted: true, warned: false, noticeWritten: false };
  }

  // Audit first: the sink is invoked synchronously inside the bounded seam, so the row is in flight before
  // anything awaits the mailbox — relevant on a process whose next allocation could be its last.
  void emitBoundedRunAudit(
    deps.auditHost,
    {
      agentId: "dashboard-boot",
      runId: `${HEAP_CEILING_MUTATION_TYPE}:boot:${process.pid}`,
      domain: "database",
      mutationType: HEAP_CEILING_MUTATION_TYPE,
      target: "dashboard",
      // Numbers + fixed enum + one boolean only — never the raw NODE_OPTIONS string.
      metadata: context,
    },
    { log: { warn: (message: string) => deps.logger.warn(message) } },
  );

  let mailbox: HeapCeilingMailbox | null | undefined;
  try {
    mailbox = deps.resolveMailbox?.();
  } catch {
    mailbox = null;
  }
  const noticeWritten = await notifyDefaultHeapCeiling(ceiling, {
    mailbox,
    nowMs: deps.nowMs ?? Date.now(),
    noticeBucketMs: deps.noticeBucketMs,
  });

  return { ceiling, emitted: true, warned: true, noticeWritten };
}

/**
 * Write the default-ceiling notice. NEVER throws and NEVER rejects: it resolves to whether a Mailbox row
 * was actually written, purely so callers and tests can assert it. A headless dashboard (no engine message
 * store) resolves false — the log line still fired.
 */
export async function notifyDefaultHeapCeiling(
  ceiling: HeapCeiling,
  deps: { mailbox?: HeapCeilingMailbox | null; nowMs?: number; noticeBucketMs?: number },
): Promise<boolean> {
  try {
    if (!deps.mailbox) return false;
    await deps.mailbox.sendMessageOnce(
      {
        fromId: "system",
        fromType: "system",
        toId: DASHBOARD_USER_ID,
        toType: "user",
        type: "system",
        content: buildHeapCeilingNoticeContent(ceiling),
        // Numbers + fixed enum only — the prose is the `content` field, never the metadata.
        metadata: {
          kind: "heap-ceiling-default-notice",
          heapLimitBytes: ceiling.heapLimitBytes,
          source: ceiling.source,
          isV8Default: ceiling.isV8Default,
        },
      },
      buildHeapCeilingNoticeIdempotencyKey(deps.nowMs ?? Date.now(), deps.noticeBucketMs),
    );
    return true;
  } catch {
    // Swallowed on purpose: a notice about a memory ceiling must not itself degrade the process.
    return false;
  }
}
