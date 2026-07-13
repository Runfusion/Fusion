#!/usr/bin/env node
/*
FNXC:TestQuarantine 2026-07-12-00:00:
The flaky-test deletion ratchet had no visibility tool for entries approaching the `quarantinedAt + 14d` deletion deadline.
This report surfaces near-deadline quarantines so maintainers can make deliberate rescue-or-expire decisions while preserving the policy's report-only default; `--strict` is the opt-in enforcement path.
*/

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_QUARANTINE_PATH, DELETION_CLOCK_DAYS } from "./test-velocity-baseline.mjs";

const MS_PER_DAY = 86_400_000;
const DEFAULT_WARN_WITHIN_DAYS = 5;
const REASON_MAX_LENGTH = 140;

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), "..");

function toDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ageDays(quarantinedAt, now) {
  const quarantinedAtDate = toDate(quarantinedAt);
  if (!quarantinedAtDate) return null;
  return Math.floor((now.getTime() - quarantinedAtDate.getTime()) / MS_PER_DAY);
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeWarnWithinDays(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--warn-within must be a non-negative integer, got ${value}`);
  }
  return parsed;
}

function truncateReason(reason) {
  const normalized = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= REASON_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, REASON_MAX_LENGTH - 1)}…`;
}

function summarizeRows(rows) {
  return rows.reduce(
    (summary, row) => {
      summary[row.status] += 1;
      summary.total += 1;
      return summary;
    },
    { total: 0, expired: 0, near: 0, healthy: 0, unknown: 0 },
  );
}

export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) {
    return { entries: [] };
  }

  const json = JSON.parse(readFileSync(ledgerPath, "utf8"));
  if (json?.entries != null && !Array.isArray(json.entries)) {
    throw new Error(`quarantine ledger ${ledgerPath} must have an "entries" array`);
  }
  return json ?? { entries: [] };
}

export function computeDeadlines(json, { now = new Date(), warnWithinDays = DEFAULT_WARN_WITHIN_DAYS } = {}) {
  const entries = Array.isArray(json?.entries) ? json.entries : [];
  const rows = entries.map((entry, index) => {
    const quarantinedAtDate = toDate(entry?.quarantinedAt);
    const age = ageDays(entry?.quarantinedAt, now);
    const daysRemaining = age == null ? null : DELETION_CLOCK_DAYS - age;
    const deadlineDate = quarantinedAtDate == null
      ? null
      : new Date(quarantinedAtDate.getTime() + DELETION_CLOCK_DAYS * MS_PER_DAY);
    let status = "unknown";
    if (daysRemaining != null) {
      if (daysRemaining <= 0) {
        status = "expired";
      } else if (daysRemaining <= warnWithinDays) {
        status = "near";
      } else {
        status = "healthy";
      }
    }

    return {
      index,
      file: entry?.file ?? "unknown",
      reason: entry?.reason ?? "",
      quarantinedAt: entry?.quarantinedAt ?? null,
      ageDays: age,
      daysRemaining,
      deadline: deadlineDate == null ? null : formatIsoDate(deadlineDate),
      status,
    };
  });

  return rows.sort((a, b) => {
    if (a.deadline == null && b.deadline == null) return a.index - b.index;
    if (a.deadline == null) return 1;
    if (b.deadline == null) return -1;
    return a.deadline.localeCompare(b.deadline) || a.file.localeCompare(b.file) || a.index - b.index;
  });
}

export function renderReport(rows, { warnWithinDays = DEFAULT_WARN_WITHIN_DAYS } = {}) {
  const summary = summarizeRows(rows);
  const lines = [
    "Quarantine ledger deadline report",
    `Deletion clock: quarantinedAt + ${DELETION_CLOCK_DAYS} days; near-deadline window: ${warnWithinDays} days`,
    `Summary: total=${summary.total} expired=${summary.expired} near=${summary.near} healthy=${summary.healthy} unknown=${summary.unknown}`,
  ];

  if (rows.length === 0) {
    lines.push("Ledger is empty; nothing quarantined.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("Entries (soonest deadline first):");
  for (const row of rows) {
    const timing = row.status === "expired"
      ? `EXPIRED (${Math.abs(row.daysRemaining)} day${Math.abs(row.daysRemaining) === 1 ? "" : "s"} overdue)`
      : row.daysRemaining == null
        ? "deadline unknown"
        : `${row.daysRemaining} day${row.daysRemaining === 1 ? "" : "s"} remaining`;
    const deadline = row.deadline == null ? "unknown" : row.deadline;
    const reason = truncateReason(row.reason) || "no reason recorded";
    lines.push(`- [${row.status}] ${row.file} — ${timing}; deadline=${deadline}; reason=${reason}`);
  }

  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = {
    warnWithinDays: DEFAULT_WARN_WITHIN_DAYS,
    json: false,
    strict: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--strict") {
      args.strict = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("--warn-within=")) {
      args.warnWithinDays = normalizeWarnWithinDays(arg.slice("--warn-within=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

export function main(argv = process.argv.slice(2), { rootDir = repoRoot, stdout = process.stdout, stderr = process.stderr, now = new Date(), ledgerPath = path.join(rootDir, DEFAULT_QUARANTINE_PATH) } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }

  if (args.help) {
    stdout.write("Usage: node scripts/check-quarantine-ledger.mjs [--warn-within=<days>] [--json] [--strict]\n");
    return 0;
  }

  let ledger;
  try {
    ledger = readLedger(ledgerPath);
  } catch (error) {
    stderr.write(`Failed to read quarantine ledger: ${error.message}\n`);
    return 1;
  }

  const rows = computeDeadlines(ledger, { now, warnWithinDays: args.warnWithinDays });
  const summary = summarizeRows(rows);
  if (args.json) {
    stdout.write(`${JSON.stringify({ summary, rows }, null, 2)}\n`);
  } else {
    stdout.write(renderReport(rows, { warnWithinDays: args.warnWithinDays }));
  }

  return args.strict && (summary.expired > 0 || summary.near > 0) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
