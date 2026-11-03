/**
 * RUFU-453 — the dead letter is the answer to "what did the sink lose?", so it has to be readable
 * without a database, capped, and replayable exactly once over a row that may already be durable.
 *
 * Every case writes under a temp root: the shared vitest setup forbids touching a real `.fusion/`, and
 * the whole point of the file is that it lives outside the database failure domain.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  RUN_AUDIT_DEAD_LETTER_FILENAME,
  createRunAuditDeadLetterSink,
  readRunAuditDeadLetter,
  replayRunAuditDeadLetter,
  runAuditDeadLetterPath,
} from "../run-audit/run-audit-dead-letter.js";
import type { RunAuditSinkRow } from "../run-audit/audit-sink-writer.js";

let rootDir = "";
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "fusion-run-audit-dead-letter-"));
});

function row(overrides: Partial<RunAuditSinkRow> = {}): RunAuditSinkRow {
  return {
    id: "row-id-1",
    timestamp: "2026-09-30T21:35:00.000Z",
    taskId: "RUFU-453",
    agentId: "self-healing",
    runId: "synthetic:reconcile-stranded-continuation:wi-1",
    domain: "database",
    mutationType: "workflowWorkItem:reconcile-stranded-no-action",
    target: "wi-1",
    metadata: { workItemId: "wi-1", reason: "lease-expired" },
    ...overrides,
  };
}

describe("run-audit dead letter", () => {
  it("spills one parseable JSONL line per row outside the database, naming the pid and the reason", async () => {
    const sink = createRunAuditDeadLetterSink({ rootDir });

    const first = await sink.append(row(), "batch-refused:Error");
    expect(first).toEqual({ written: true, suppressed: false });
    await sink.append(row({ id: "row-id-2", mutationType: "task:updated", target: "FN-2" }), "queue-overflow");

    const path = runAuditDeadLetterPath(rootDir);
    expect(path).toBe(join(rootDir, ".fusion", "logs", RUN_AUDIT_DEAD_LETTER_FILENAME));
    const raw = await readFile(path, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    // One row per line, always: the file is shared by every `fn` process on the host.
    expect(lines.every((line) => line.startsWith("{") && line.endsWith("}"))).toBe(true);

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({
      id: "row-id-1",
      mutationType: "workflowWorkItem:reconcile-stranded-no-action",
      reason: "batch-refused:Error",
      pid: process.pid,
    });
    expect(sink.stats()).toMatchObject({ path, rows: 2, suppressed: 0, writeFailures: 0 });
    expect(sink.stats().bytes).toBe(await stat(path).then((s) => s.size));
  });

  it("stops accepting at its byte cap and counts what the cap refused", async () => {
    // Measure one real spilled line first, so the cap sits between one row and two rather than at a
    // guessed constant that a metadata change would silently invalidate.
    const probe = createRunAuditDeadLetterSink({ rootDir });
    await probe.append(row(), "queue-overflow");
    const oneRowBytes = (await stat(runAuditDeadLetterPath(rootDir))).size;
    await rm(runAuditDeadLetterPath(rootDir), { force: true });

    const sink = createRunAuditDeadLetterSink({ rootDir, maxBytes: Math.ceil(oneRowBytes * 1.5) });
    expect((await sink.append(row(), "batch-refused:Error")).written).toBe(true);
    const refused = await sink.append(row({ id: "row-id-2" }), "batch-refused:Error");
    expect(refused).toEqual({ written: false, suppressed: true });

    expect(sink.stats().suppressed).toBe(1);
    expect(sink.stats().rows).toBe(1);
    // The cap is a ceiling on the file, not a suggestion.
    expect((await stat(runAuditDeadLetterPath(rootDir))).size).toBeLessThanOrEqual(Math.ceil(oneRowBytes * 1.5));
  });

  it("counts an unwritable spill instead of surfacing it to the caller", async () => {
    // A directory where the logs path can never be created: rootDir itself is a file.
    const blockedRoot = join(rootDir, "not-a-directory");
    await writeFile(blockedRoot, "x", "utf8");
    const warnings: string[] = [];
    const sink = createRunAuditDeadLetterSink({ rootDir: blockedRoot, log: { warn: (m) => { warnings.push(m); } } });

    const result = await sink.append(row(), "batch-refused:Error");
    expect(result).toEqual({ written: false, suppressed: true });
    expect(sink.stats().writeFailures).toBe(1);
    expect(warnings.join("\n")).toContain("dead letter unwritable");
  });

  it("counts malformed lines on the way back in without losing the rows around them", async () => {
    const sink = createRunAuditDeadLetterSink({ rootDir });
    await sink.append(row(), "queue-overflow");
    const path = runAuditDeadLetterPath(rootDir);
    await writeFile(path, `${(await readFile(path, "utf8")).trimEnd()}\n{not json at all\n\n`, "utf8");

    const read = await readRunAuditDeadLetter({ rootDir });
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]!.mutationType).toBe("workflowWorkItem:reconcile-stranded-no-action");
    expect(read.malformed).toBe(1);
    expect(read.bytes).toBeGreaterThan(0);
  });

  it("replays the spill through the real insert and never offers the same row twice", async () => {
    const sink = createRunAuditDeadLetterSink({ rootDir });
    await sink.append(row(), "batch-refused:Error");
    await sink.append(row({ id: "row-id-2", target: "wi-2" }), "batch-refused:Error");

    const inserted: string[][] = [];
    const known = new Set(["row-id-2"]); // simulates a row that landed anyway and only LOOKED lost
    const replayOnce = () =>
      replayRunAuditDeadLetter({
        rootDir,
        insert: async (rows) => {
          inserted.push(rows.map((candidate) => candidate.id));
          return rows.filter((candidate) => !known.has(candidate.id)).length;
        },
      });

    const first = await replayOnce();
    expect(first.considered).toBe(2);
    expect(first.replayed).toBe(1); // the already-durable row is a no-op, not a duplicate and not an error
    expect(inserted[0]).toEqual(["row-id-1", "row-id-2"]);
    // The spilled envelope never reaches the durable insert.
    expect(inserted[0]).toHaveLength(2);

    // A fully recovered file moves aside rather than being rewritten, so an appending sibling cannot
    // lose a line mid-pass — and the next pass therefore has nothing left to consider.
    const second = await replayOnce();
    expect(second.considered).toBe(0);
    expect(first.archivedTo).toBeTruthy();
    const archived = await readFile(first.archivedTo!, "utf8");
    expect(archived.trimEnd().split("\n")).toHaveLength(2);
  });

  it("leaves the file in place when the insert refuses the whole pass", async () => {
    const sink = createRunAuditDeadLetterSink({ rootDir });
    await sink.append(row(), "batch-refused:Error");

    const result = await replayRunAuditDeadLetter({
      rootDir,
      insert: async () => {
        throw new Error("database still refusing writes");
      },
    });

    expect(result.replayed).toBe(0);
    expect(result.retained).toBe(1);
    expect(result.archivedTo).toBeUndefined();
    // Evidence for a database that is still sick stays on disk for the next pass.
    expect((await readRunAuditDeadLetter({ rootDir })).rows).toHaveLength(1);
  });

  it("honours the byte cap through the environment", async () => {
    const probe = createRunAuditDeadLetterSink({ rootDir });
    await probe.append(row(), "queue-overflow");
    const oneRowBytes = (await stat(runAuditDeadLetterPath(rootDir))).size;
    await rm(runAuditDeadLetterPath(rootDir), { force: true });

    const sink = createRunAuditDeadLetterSink({
      rootDir,
      env: { FUSION_RUN_AUDIT_DEAD_LETTER_MAX_BYTES: String(Math.ceil(oneRowBytes * 1.5)) },
    });
    await sink.append(row(), "queue-overflow");
    expect((await sink.append(row({ id: "row-id-2" }), "queue-overflow")).suppressed).toBe(true);
  });

  it("measures an existing file before writing, so a shared cap is a shared cap", async () => {
    // A sibling process already filled the file; a fresh sink must not assume it starts at zero bytes.
    const path = runAuditDeadLetterPath(rootDir);
    await createRunAuditDeadLetterSink({ rootDir }).append(row(), "queue-overflow");
    const sizeBefore = (await stat(path)).size;
    const later = createRunAuditDeadLetterSink({ rootDir, maxBytes: sizeBefore + 1 });

    expect((await later.append(row({ id: "row-id-2" }), "queue-overflow")).suppressed).toBe(true);
    expect(later.stats().bytes).toBe(sizeBefore);
  });
});
