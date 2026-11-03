/**
 * The store's run-audit sink host: the one place that joins the drain writer to the durable backend.
 *
 * FNXC:RunAuditSink 2026-09-30 (RUFU-453):
 * Nothing above this module knows the queue exists. `emitBoundedRunAudit` asks the store for
 * `recordRunAuditEventBuffered` and gets an answer about whether the row was taken; `recordRunAuditEvent`
 * keeps awaiting its own commit exactly as FN-9178 characterized it; the transaction-paired
 * `recordRunAuditEventWithinTransaction` keeps sharing its caller's transaction, because a deferred
 * write cannot be atomic with a mutation — that split is the contract this module must not blur.
 *
 * The writer is built per store, lazily, and only over a durable async backend. A file-backed or
 * double-backed host has no pool to protect, so it keeps the plain bounded write and stays testable
 * with an object literal.
 */
import type { RunAuditEventInput } from "../types.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { insertRunAuditEventsBatched } from "../postgres/data-layer.js";
import { createLogger } from "../process/logger.js";
import {
  createRunAuditSinkWriter,
  RUN_AUDIT_SINK_SHUTDOWN_DRAIN_MS,
  type RunAuditSinkRow,
  type RunAuditSinkStats,
  type RunAuditSinkWriter,
} from "./audit-sink-writer.js";
import {
  createRunAuditDeadLetterSink,
  readRunAuditDeadLetter,
  replayRunAuditDeadLetter,
  type RunAuditDeadLetterReplayResult,
} from "./run-audit-dead-letter.js";
import type { RunAuditBufferedSubmitResult } from "./emit-bounded-run-audit.js";

const log = createLogger("run-audit");

/** Kept off the TaskStore instance on purpose: a sink is telemetry, not lifecycle state to persist. */
const writers = new WeakMap<object, RunAuditSinkWriter>();
const constructionFailed = new WeakSet<object>();

type StoreHost = {
  readonly asyncLayer: AsyncDataLayer | null;
  getRootDir(): string;
};

/**
 * `FUSION_RUN_AUDIT_BUFFERED=0` is the kill switch: with it set, no writer is built, the store exposes
 * no buffered submit for the seam to find, and every best-effort emit takes the direct bounded write it
 * took before this module existed.
 */
export function runAuditBufferedWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FUSION_RUN_AUDIT_BUFFERED !== "0";
}

function buildWriter(store: StoreHost, env: NodeJS.ProcessEnv): RunAuditSinkWriter {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("run-audit sink requires a durable async backend");
  const rootDir = store.getRootDir();
  const deadLetter = createRunAuditDeadLetterSink({ rootDir, env, log });
  const writer = createRunAuditSinkWriter({
    write: (rows: RunAuditSinkRow[]) => insertRunAuditEventsBatched(layer, rows),
    deadLetter,
    env,
    log,
  });

  /*
  One bounded replay pass, fire-and-forget, and only at construction: rows spilled by an earlier run are
  evidence that the last database refused, and the `(project_id, id)` key makes replaying them after the
  database came back free. It is never on the emit path — a replay inside an emit would reintroduce the
  extra write against a struggling server that this whole design exists to stop.
  */
  void replayRunAuditDeadLetter({
    rootDir,
    env,
    insert: (rows) => insertRunAuditEventsBatched(layer, rows as RunAuditSinkRow[]),
    log,
  }).catch(() => undefined);

  return writer;
}

function resolveWriter(store: StoreHost, env: NodeJS.ProcessEnv): RunAuditSinkWriter | null {
  if (!runAuditBufferedWriteEnabled(env)) return null;
  if (!store.asyncLayer) return null;
  if (constructionFailed.has(store)) return null;
  const existing = writers.get(store);
  if (existing) return existing;
  try {
    const writer = buildWriter(store, env);
    writers.set(store, writer);
    return writer;
  } catch {
    // A sink that cannot be built must not become a lifecycle failure: remember it and stay direct.
    constructionFailed.add(store);
    return null;
  }
}

/** What the seam finds when it looks for a drain writer. Absent means "write it directly". */
export function recordRunAuditEventBuffered(
  store: StoreHost,
  input: RunAuditEventInput,
  env: NodeJS.ProcessEnv = process.env,
): RunAuditBufferedSubmitResult {
  const writer = resolveWriter(store, env);
  if (!writer) return { accepted: false, queued: false, spilled: false, queueDepth: 0 };
  return writer.submit(input);
}

export function getRunAuditSinkStats(store: StoreHost, env: NodeJS.ProcessEnv = process.env): RunAuditSinkStats | null {
  const writer = runAuditBufferedWriteEnabled(env) ? writers.get(store) : undefined;
  return writer?.stats() ?? null;
}

/**
 * Cheap spill-file accounting for the diagnostics surface — in-memory counters plus the size measured at
 * first append, never a re-read of the file. `readRunAuditSinkDeadLetter` is the deliberate act that
 * actually parses the rows.
 */
export function getRunAuditSinkDeadLetterStats(
  store: StoreHost,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<RunAuditSinkWriter["deadLetterStats"]> {
  const writer = runAuditBufferedWriteEnabled(env) ? writers.get(store) : undefined;
  return writer?.deadLetterStats() ?? null;
}

/** Bounded drain used by tests, by the diagnostics surface, and by shutdown. Never a promise that hangs. */
export async function flushRunAuditSink(
  store: StoreHost,
  options: { timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!runAuditBufferedWriteEnabled(env)) return;
  const writer = writers.get(store);
  if (!writer) return;
  await writer.flush(options);
}

/** Reads the spill file, so an operator can answer "what did the sink lose?" without a database. */
export async function readRunAuditSinkDeadLetter(store: StoreHost, env: NodeJS.ProcessEnv = process.env) {
  return readRunAuditDeadLetter({ rootDir: store.getRootDir(), env });
}

/** Explicit operator-driven replay (the diagnostics surface exposes it; the automatic pass does not). */
export async function replayRunAuditSinkDeadLetter(
  store: StoreHost,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunAuditDeadLetterReplayResult | null> {
  const layer = store.asyncLayer;
  if (!layer) return null;
  return replayRunAuditDeadLetter({
    rootDir: store.getRootDir(),
    env,
    insert: (rows) => insertRunAuditEventsBatched(layer, rows as RunAuditSinkRow[]),
    log,
  });
}

/**
 * Shutdown hook: drain a bounded amount, then spill whatever is left.
 *
 * The bound is owned here rather than trusted to the writer so a wedged database cannot extend process
 * shutdown at all — the drain is raced against its own deadline and the result is discarded either way.
 */
export async function drainRunAuditSinkForClose(
  store: StoreHost,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const writer = runAuditBufferedWriteEnabled(env) ? writers.get(store) : undefined;
  if (!writer) return;
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, RUN_AUDIT_SINK_SHUTDOWN_DRAIN_MS + 500);
    timer.unref?.();
  });
  try {
    await Promise.race([writer.stop({ timeoutMs: RUN_AUDIT_SINK_SHUTDOWN_DRAIN_MS }), deadline]);
  } catch {
    // Shutdown never fails because telemetry could not be flushed.
  }
}
