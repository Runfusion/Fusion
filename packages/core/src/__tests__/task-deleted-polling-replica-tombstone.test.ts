import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

const SOURCES = {
  lifecycle: "packages/core/src/task-store/lifecycle-ops.ts",
  store: "packages/core/src/store.ts",
} as const;

/** The old replica is documented in comments; executable source must not restore it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function source(key: keyof typeof SOURCES): string {
  return stripComments(readFileSync(join(REPO_ROOT, SOURCES[key]), "utf8"));
}

/*
FNXC:TaskDeletedObservation 2026-08-01-09:59:
The SQLite polling replica could never run for the supported PostgreSQL AsyncDataLayer: its first
`store.db` read always threw. FN-8683 deliberately removes every replica-only TaskStore symbol,
rather than leaving a fake cross-process lifecycle capability. The documented transactional-outbox
replacement is owned by FN-8684/FN-8685; comments may name this history, so assertions strip them.
*/
const REMOVED_SYMBOLS: ReadonlyArray<{ symbol: string; source: keyof typeof SOURCES; why: string }> = [
  { symbol: "checkForChangesImpl", source: "lifecycle", why: "the SQLite polling implementation cannot access PostgreSQL through store.db" },
  { symbol: "checkForChanges", source: "store", why: "the public façade exposed only the unreachable TaskStore polling path" },
  { symbol: "pollInterval", source: "store", why: "TaskStore no longer schedules a polling replica" },
  { symbol: "pollingInProgress", source: "store", why: "the re-entrancy guard belonged only to the removed replica" },
  { symbol: "lastKnownModified", source: "store", why: "the SQLite modified-stamp cursor belonged only to the removed replica" },
  { symbol: "lastPollTime", source: "store", why: "the SQLite changed-row cursor belonged only to the removed replica" },
  { symbol: "suppressActivityLogForPollingEmit", source: "store", why: "only replica re-emits needed to suppress duplicate activity rows" },
];

describe("task:deleted SQLite polling replica tombstone", () => {
  it("keeps every classified replica-only symbol out of executable source", () => {
    const violations = REMOVED_SYMBOLS
      .filter(({ symbol, source: sourceKey }) => new RegExp(`\\b${symbol}\\b`).test(source(sourceKey)))
      .map(({ symbol, why }) => `${symbol} was restored — ${why}`);

    expect(violations).toEqual([]);
  });

  it("does not reintroduce synchronous SQLite access into the watch path", () => {
    const lifecycle = source("lifecycle");
    const start = lifecycle.indexOf("export async function watchImpl(");
    const watchBody = lifecycle.slice(start, lifecycle.indexOf("export async function migrateAgentLogEntriesImpl(", start));

    expect(start).toBeGreaterThan(-1);
    expect(watchBody).not.toContain("store.db.");
  });
});
