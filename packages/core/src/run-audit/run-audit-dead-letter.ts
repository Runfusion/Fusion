/**
 * Run-audit dead letter — the file that exists so a lost audit row is a `cat` away.
 *
 * FNXC:RunAudit 2026-09-30 (RUFU-453):
 * When the run-audit sink loses a row today it leaves only a warn line naming the mutation type. The
 * row's payload — the ids and counts that make an incident readable — is gone, which is why
 * RUFU-451's proof row could never be recovered after the engine said it emitted one. The spill target
 * therefore lives OUTSIDE the PostgreSQL failure domain entirely: appending to a file is the one write
 * that stays available when the database that lost the row is the thing that is sick.
 *
 * Append-only JSONL, one line per row, one line per row ALWAYS — a multi-process host (`fn` desktop +
 * `fn serve` + engine workers) shares this file, so `O_APPEND` plus a single write per line is what
 * keeps lines whole. The pid is recorded INSIDE each row, not in the filename, because the file is
 * shared deliberately.
 *
 * The file is capped so a wedged database cannot grow it without bound, and the cap counts bytes
 * rather than rows because the rows that spill are exactly the ones carrying the largest metadata.
 * `deadLetterSuppressed` then names what the cap refused, so loss stays accounted for even here.
 */
import { appendFile, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RunAuditSinkRow } from "./audit-sink-writer.js";
import { createLogger } from "../process/logger.js";

export const RUN_AUDIT_DEAD_LETTER_FILENAME = "run-audit-dead-letter.jsonl";
export const RUN_AUDIT_DEAD_LETTER_MAX_BYTES = 8 * 1024 * 1024;
/** Rows per replay INSERT round-trip. Matches the sink's own batch so replay is no heavier than a drain. */
export const RUN_AUDIT_DEAD_LETTER_REPLAY_BATCH_MAX = 50;
/** Archives kept after successful replays, newest first, so recovery is auditable but bounded. */
export const RUN_AUDIT_DEAD_LETTER_ARCHIVE_KEEP = 3;

const defaultLog = createLogger("run-audit");

/** A spilled row plus why it spilled. The whole point is that this stays readable without a database. */
export type RunAuditDeadLetterRow = RunAuditSinkRow & {
  spilledAt: string;
  reason: string;
  pid: number;
};

export type RunAuditDeadLetterReadResult = {
  path: string;
  bytes: number;
  rows: RunAuditDeadLetterRow[];
  /** Lines that parsed as nothing — counted, never thrown away silently. */
  malformed: number;
  /** True when the read stopped at the byte cap and later lines were not examined. */
  truncated: boolean;
};

export type RunAuditDeadLetterReplayResult = {
  path: string;
  considered: number;
  /** Rows the insert reported as newly landed. An already-present row replays as 0, not as an error. */
  replayed: number;
  malformed: number;
  /** Rows left un-recovered by a refused insert; they stay in the file for the next pass. */
  retained: number;
  /** Present when a pass archived the file, so the operator can see where the evidence went. */
  archivedTo?: string;
};

/** The spill handle the sink writer uses. Mirrors `RunAuditSinkDeadLetter` plus failure accounting. */
export type RunAuditDeadLetterSink = {
  append(row: RunAuditSinkRow, reason: string): Promise<{ written: boolean; suppressed: boolean }>;
  stats(): { path: string; bytes: number; rows: number; suppressed: number; writeFailures: number };
  close(): Promise<void>;
};

export function runAuditDeadLetterPath(rootDir: string): string {
  return join(rootDir, ".fusion", "logs", RUN_AUDIT_DEAD_LETTER_FILENAME);
}

function bytesFrom(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * One shared, capped, append-only spill file under `<rootDir>/.fusion/logs/`.
 *
 * Every failure mode here — a read-only filesystem, a full disk, a cap already reached — returns
 * "suppressed" instead of throwing, because the caller is a telemetry writer whose own contract is
 * that it cannot alter the lifecycle that emitted the row.
 */
export function createRunAuditDeadLetterSink(deps: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  log?: { warn: (message: string) => void };
}): RunAuditDeadLetterSink {
  const env = deps.env ?? process.env;
  const log = deps.log ?? defaultLog;
  const path = runAuditDeadLetterPath(deps.rootDir);
  const maxBytes = deps.maxBytes ?? bytesFrom(env.FUSION_RUN_AUDIT_DEAD_LETTER_MAX_BYTES, RUN_AUDIT_DEAD_LETTER_MAX_BYTES);

  let bytes = 0;
  let bytesMeasured = false;
  let rows = 0;
  let suppressed = 0;
  let writeFailures = 0;
  let warnedCap = false;
  let warnedIo = false;
  let closing: Promise<void> | null = null;

  async function measureOnce(): Promise<void> {
    if (bytesMeasured) return;
    bytesMeasured = true;
    try {
      // Measured, not assumed: sibling `fn` processes may already have filled part of the cap.
      bytes = (await stat(path)).size;
    } catch {
      bytes = 0;
    }
  }

  return {
    async append(row, reason) {
      await measureOnce();
      const entry: RunAuditDeadLetterRow = {
        ...row,
        spilledAt: new Date().toISOString(),
        reason,
        pid: process.pid,
      };
      // One line, terminated, never two writes: an interleave can split a line but never merge one.
      const line = `${JSON.stringify(entry)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");

      if (bytes + lineBytes > maxBytes) {
        suppressed += 1;
        if (!warnedCap) {
          warnedCap = true;
          log.warn(`[run-audit] dead letter at its ${maxBytes} byte cap — further rows suppressed: ${path}`);
        }
        return { written: false, suppressed: true };
      }

      try {
        await mkdir(dirname(path), { recursive: true });
        // O_APPEND semantics with a single write per line is the whole multi-process contract.
        await appendFile(path, line, "utf8");
        bytes += lineBytes;
        rows += 1;
        return { written: true, suppressed: false };
      } catch (error) {
        writeFailures += 1;
        if (!warnedIo) {
          warnedIo = true;
          log.warn(`[run-audit] dead letter unwritable (${error instanceof Error ? error.name : "error"}) — rows lost here are counted only: ${path}`);
        }
        return { written: false, suppressed: true };
      }
    },

    stats() {
      return { path, bytes, rows, suppressed, writeFailures };
    },

    async close() {
      // Nothing is buffered — every append is its own O_APPEND write — so close only has to be safe
      // to call twice from a shutdown path that may already be draining.
      closing ??= Promise.resolve();
      await closing;
    },
  };
}

/** Reads the spill file for the diagnostics surface and for replay. Malformed lines count, never throw. */
export async function readRunAuditDeadLetter(deps: {
  rootDir: string;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<RunAuditDeadLetterReadResult> {
  const env = deps.env ?? process.env;
  const path = runAuditDeadLetterPath(deps.rootDir);
  const cap = deps.maxBytes ?? bytesFrom(env.FUSION_RUN_AUDIT_DEAD_LETTER_MAX_BYTES, RUN_AUDIT_DEAD_LETTER_MAX_BYTES);
  const empty: RunAuditDeadLetterReadResult = { path, bytes: 0, rows: [], malformed: 0, truncated: false };

  let handle = null;
  try {
    handle = await open(path, "r");
  } catch {
    return empty;
  }
  try {
    const size = (await handle.stat()).size;
    const readBytes = Math.min(size, cap);
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, 0);
    const lines = buffer.toString("utf8").split("\n");
    if (readBytes < size) lines.pop(); // a truncated tail is an unread line, not a malformed one
    const rows: RunAuditDeadLetterRow[] = [];
    let malformed = 0;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as RunAuditDeadLetterRow;
        if (typeof parsed?.id === "string" && typeof parsed?.mutationType === "string") rows.push(parsed);
        else malformed += 1;
      } catch {
        malformed += 1;
      }
    }
    return { path, bytes: size, rows, malformed, truncated: readBytes < size };
  } catch {
    return empty;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Newest-first archive names, so a bounded prune keeps the most recent recoveries. */
async function listArchives(path: string): Promise<string[]> {
  const dir = dirname(path);
  const base = path.slice(path.lastIndexOf("/") + 1);
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.startsWith(`${base}.replayed-`))
      .sort()
      .reverse()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Replays the spill through the caller's real durable insert, at most one bounded pass.
 *
 * Idempotency is structural, not hoped for: the row id was assigned when the row was FIRST accepted,
 * so a row that actually landed and only appeared lost replays onto the `(project_id, id)` primary key
 * and the insert's `ON CONFLICT DO NOTHING` turns it into a no-op. A pass that recovers anything then
 * moves the file aside rather than rewriting it — an appending sibling holds an O_APPEND handle, and
 * renaming is the one operation that cannot lose a line that another process wrote mid-pass.
 */
export async function replayRunAuditDeadLetter(deps: {
  rootDir: string;
  insert: (rows: RunAuditSinkRow[]) => Promise<number>;
  maxRows?: number;
  env?: NodeJS.ProcessEnv;
  log?: { warn: (message: string) => void };
}): Promise<RunAuditDeadLetterReplayResult> {
  const log = deps.log ?? defaultLog;
  const read = await readRunAuditDeadLetter(deps);
  const considered = deps.maxRows ? read.rows.slice(0, deps.maxRows) : read.rows;
  const result: RunAuditDeadLetterReplayResult = {
    path: read.path,
    considered: considered.length,
    replayed: 0,
    malformed: read.malformed,
    retained: 0,
  };
  if (considered.length === 0) return result;

  for (let offset = 0; offset < considered.length; offset += RUN_AUDIT_DEAD_LETTER_REPLAY_BATCH_MAX) {
    const batch = considered.slice(offset, offset + RUN_AUDIT_DEAD_LETTER_REPLAY_BATCH_MAX);
    try {
      // Strip the spill envelope: the durable insert takes the row exactly as the emitters shaped it.
      result.replayed += await deps.insert(batch.map(({ spilledAt: _s, reason: _r, pid: _p, ...row }) => row));
    } catch {
      // A refused batch stays on disk for the next pass rather than being consumed by the failure.
      result.retained += batch.length;
    }
  }

  if (result.retained === considered.length) {
    log.warn(`[run-audit] dead-letter replay recovered nothing — leaving ${result.considered} row(s) in place: ${read.path}`);
    return result;
  }

  if (result.retained === 0 && result.malformed === 0) {
    const archive = `${read.path}.replayed-${new Date().toISOString().replace(/[:.]/g, "")}`;
    try {
      await rename(read.path, archive);
      result.archivedTo = archive;
    } catch {
      // Failing to archive only means the next pass re-reads rows that are already durable.
      return result;
    }
    for (const stale of (await listArchives(read.path)).slice(RUN_AUDIT_DEAD_LETTER_ARCHIVE_KEEP)) {
      await rm(stale, { force: true }).catch(() => undefined);
    }
  }
  return result;
}

/** Writes a replayed file back out — used by the archive prune test and by nothing in the hot path. */
export async function writeRunAuditDeadLetterLines(rootDir: string, lines: string[]): Promise<string> {
  const path = runAuditDeadLetterPath(rootDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
}
