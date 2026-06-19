#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), "..");

export const DEFAULT_TIMINGS_PATH = "scripts/test-timings.json";
export const DEFAULT_QUARANTINE_PATH = "scripts/lib/test-quarantine.json";
export const DEFAULT_HISTORY_PATH = "scripts/test-velocity-history.json";
export const DEFAULT_REPORT_PATH = "docs/test-velocity-baseline.md";
export const DEFAULT_MEASURE_TIMEOUT_MS = 10 * 60 * 1000;
export const DELETION_CLOCK_DAYS = 14;

const MEASURE_COMMANDS = [
  { key: "gateMs", label: "Merge gate (`pnpm test:gate`)", command: "pnpm", args: ["test:gate"] },
  { key: "bootSmokeMs", label: "Boot smoke (`pnpm smoke:boot`)", command: "pnpm", args: ["smoke:boot"] },
  { key: "testMs", label: "Changed-only tests (`pnpm test`)", command: "pnpm", args: ["test"] },
];

function readJson(relativePath, fallback = null, rootDir = repoRoot) {
  const absolutePath = path.join(rootDir, relativePath);
  if (!existsSync(absolutePath)) return fallback;
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function writeJson(relativePath, value, rootDir = repoRoot) {
  const absolutePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(relativePath, value, rootDir = repoRoot) {
  const absolutePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, value, "utf8");
}

function normalizeMs(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative millisecond value, got ${value}`);
  }
  return Math.round(parsed);
}

function toDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ageDays(quarantinedAt, now) {
  const quarantinedAtDate = toDate(quarantinedAt);
  if (!quarantinedAtDate) return null;
  return Math.floor((now.getTime() - quarantinedAtDate.getTime()) / 86_400_000);
}

function isoWeek(date) {
  const working = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = working.getUTCDay() || 7;
  working.setUTCDate(working.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(working.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((working - yearStart) / 86_400_000 + 1) / 7);
  return `${working.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function formatDuration(ms) {
  if (ms == null) return "unavailable";
  const rounded = Math.round(ms);
  const sign = rounded < 0 ? "-" : "";
  const absoluteMs = Math.abs(rounded);
  if (absoluteMs < 1000) return `${sign}${absoluteMs}ms`;
  const seconds = absoluteMs / 1000;
  if (seconds < 60) return `${sign}${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds - minutes * 60);
  return `${sign}${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

export function readQuarantineCount(json, { now = new Date() } = {}) {
  const entries = Array.isArray(json?.entries) ? json.entries : [];
  const buckets = {
    "0-6d": 0,
    "7-13d": 0,
    deletionDue: 0,
    unknown: 0,
  };
  const deletionDueEntries = [];

  for (const entry of entries) {
    const age = ageDays(entry?.quarantinedAt, now);
    const normalized = {
      file: entry?.file ?? "unknown",
      quarantinedAt: entry?.quarantinedAt ?? null,
      ageDays: age,
    };
    if (age == null || age < 0) {
      buckets.unknown += 1;
    } else if (age >= DELETION_CLOCK_DAYS) {
      buckets.deletionDue += 1;
      deletionDueEntries.push(normalized);
    } else if (age >= 7) {
      buckets["7-13d"] += 1;
    } else {
      buckets["0-6d"] += 1;
    }
  }

  return {
    total: entries.length,
    byAgeBucket: buckets,
    deletionDueEntries,
    deletionDueCount: deletionDueEntries.length,
  };
}

export function topSlowestFiles(timingsJson, n = 20) {
  const rows = [];
  for (const [packageName, packageTiming] of Object.entries(timingsJson?.packages ?? {})) {
    for (const [file, ms] of Object.entries(packageTiming?.files ?? {})) {
      const parsed = Number(ms);
      rows.push({ file, ms: Number.isFinite(parsed) ? parsed : 0, package: packageName });
    }
  }

  rows.sort((a, b) => b.ms - a.ms || a.package.localeCompare(b.package) || a.file.localeCompare(b.file));
  return rows.slice(0, n);
}

function delta(latest, previous, field) {
  if (!previous || latest?.[field] == null || previous?.[field] == null) return "n/a";
  const diff = latest[field] - previous[field];
  const sign = diff > 0 ? "+" : "";
  return `${sign}${formatDuration(diff)}`;
}

function renderMetricRow(name, latest, previous, field) {
  return `| ${name} | ${formatDuration(latest?.[field])} | ${delta(latest, previous, field)} |`;
}

function trendCell(current, prior) {
  if (current == null || prior == null) return "n/a";
  const diff = current - prior;
  return `${diff > 0 ? "+" : ""}${diff}`;
}

export function renderReport({ gateMs, bootSmokeMs, testMs, slowest = [], quarantine, capturedAt, previous = null, measurementFailures = [], timingSnapshotCapturedAt = null } = {}) {
  const latest = {
    gateMs: normalizeMs(gateMs),
    bootSmokeMs: normalizeMs(bootSmokeMs),
    testMs: normalizeMs(testMs),
    quarantineCount: quarantine?.total ?? quarantine?.quarantineCount ?? 0,
    capturedAt: capturedAt ?? new Date().toISOString(),
  };
  const cycle = isoWeek(new Date(latest.capturedAt));
  const slowRows = slowest
    .map((row, index) => `| ${index + 1} | \`${row.file}\` | ${row.package} | ${formatDuration(row.ms)} |`)
    .join("\n");
  const dueRows = (quarantine?.deletionDueEntries ?? [])
    .map((entry) => `| \`${entry.file}\` | ${entry.quarantinedAt ?? "unknown"} | ${entry.ageDays ?? "unknown"} |`)
    .join("\n");
  const failures = measurementFailures.length > 0
    ? measurementFailures.map((failure) => `- ${failure.label}: ${failure.status}`).join("\n")
    : "- None recorded.";
  const previousRows = previous
    ? `| Previous | ${previous.capturedAt ?? "unknown"} | ${formatDuration(previous.gateMs)} | ${formatDuration(previous.bootSmokeMs)} | ${formatDuration(previous.testMs)} | ${previous.quarantineCount ?? "n/a"} |\n| Latest | ${latest.capturedAt} | ${formatDuration(latest.gateMs)} | ${formatDuration(latest.bootSmokeMs)} | ${formatDuration(latest.testMs)} | ${latest.quarantineCount} |\n| Delta | — | ${delta(latest, previous, "gateMs")} | ${delta(latest, previous, "bootSmokeMs")} | ${delta(latest, previous, "testMs")} | ${trendCell(latest.quarantineCount, previous.quarantineCount)} |`
    : `| Previous | _(seed baseline)_ | — | — | — | — |\n| Latest | ${latest.capturedAt} | ${formatDuration(latest.gateMs)} | ${formatDuration(latest.bootSmokeMs)} | ${formatDuration(latest.testMs)} | ${latest.quarantineCount} |\n| Delta | — | n/a | n/a | n/a | n/a |`;

  return `# Test velocity baseline\n\n> Weekly FN-6612 signal-per-second baseline. Measure and report feedback-loop velocity; do **not** add slow tests or wire this report into blocking PR checks. The merge gate remains the existing thin Lint, Typecheck, Build, and Gate path.\n\n## Latest baseline\n\n- Cycle: **${cycle}**\n- Captured at: **${latest.capturedAt}**\n- Timing snapshot: \`${DEFAULT_TIMINGS_PATH}\`${timingSnapshotCapturedAt ? ` captured at **${timingSnapshotCapturedAt}**` : ""}\n- Quarantine ledger: \`${DEFAULT_QUARANTINE_PATH}\`\n\n## Metrics\n\n| Metric | Current | Delta vs previous |\n|---|---:|---:|\n${renderMetricRow("Merge gate wall-time (`pnpm test:gate`)", latest, previous, "gateMs")}\n${renderMetricRow("Boot smoke wall-time (`pnpm smoke:boot`)", latest, previous, "bootSmokeMs")}\n${renderMetricRow("Changed-only test wall-time (`pnpm test`)", latest, previous, "testMs")}\n| Quarantine / flake count | ${latest.quarantineCount} | ${trendCell(latest.quarantineCount, previous?.quarantineCount)} |\n| Deletion-due quarantines | ${quarantine?.deletionDueCount ?? 0} | n/a |\n\n## Measurement failures\n\n${failures}\n\n## Slowest 20 test files\n\n| Rank | File | Package | Duration |\n|---:|---|---|---:|\n${slowRows || "| — | — | — | — |"}\n\n## Quarantine age buckets\n\n| Age bucket | Count |\n|---|---:|\n| 0-6 days | ${quarantine?.byAgeBucket?.["0-6d"] ?? 0} |\n| 7-13 days | ${quarantine?.byAgeBucket?.["7-13d"] ?? 0} |\n| deletion due (>=14 days) | ${quarantine?.byAgeBucket?.deletionDue ?? 0} |\n| unknown/future | ${quarantine?.byAgeBucket?.unknown ?? 0} |\n\n### Deletion-due entries\n\n| File | Quarantined at | Age (days) |\n|---|---:|---:|\n${dueRows || "| — | — | — |"}\n\n## Before / after trend\n\n| Row | Captured at | Gate | Boot smoke | \`pnpm test\` | Quarantine count |\n|---|---|---:|---:|---:|---:|\n${previousRows}\n\n_Future weekly rows append to \`${DEFAULT_HISTORY_PATH}\`; compare the latest row against the previous row before posting to #leads._\n\n## Post to #leads\n\n\`\`\`text\nFN-6612 weekly test velocity: gate ${formatDuration(latest.gateMs)} (${delta(latest, previous, "gateMs")}), boot smoke ${formatDuration(latest.bootSmokeMs)} (${delta(latest, previous, "bootSmokeMs")}), pnpm test ${formatDuration(latest.testMs)} (${delta(latest, previous, "testMs")}), quarantine ledger ${latest.quarantineCount} (${trendCell(latest.quarantineCount, previous?.quarantineCount)}). Slowest file: ${slowest[0]?.file ?? "none"} at ${formatDuration(slowest[0]?.ms)}. Deletion-due quarantines: ${quarantine?.deletionDueCount ?? 0}.\n\`\`\`\n\n## How to refresh\n\n\`\`\`bash\npnpm test:velocity -- --measure --write-report\n\`\`\`\n\nReport-only regeneration is cheap and does not run any suite:\n\n\`\`\`bash\npnpm test:velocity\n\`\`\`\n`;
}

function historyEntries(history) {
  if (Array.isArray(history)) return history;
  if (Array.isArray(history?.entries)) return history.entries;
  return [];
}

function createEntry({ capturedAt = new Date().toISOString(), gateMs = null, bootSmokeMs = null, testMs = null, quarantine, slowest, measurementFailures = [], timingSnapshotCapturedAt = null }) {
  return {
    capturedAt,
    gateMs: normalizeMs(gateMs),
    bootSmokeMs: normalizeMs(bootSmokeMs),
    testMs: normalizeMs(testMs),
    quarantineCount: quarantine?.total ?? 0,
    slowestTop20: slowest,
    measurementFailures,
    timingSnapshotCapturedAt,
  };
}

function parseArgs(argv) {
  const args = { measure: false, writeReport: false, reportOnly: true, timeoutMs: DEFAULT_MEASURE_TIMEOUT_MS, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    else if (arg === "--measure") args.measure = true;
    else if (arg === "--write-report") args.writeReport = true;
    else if (arg === "--report-only") args.reportOnly = true;
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error(`Expected --timeout-ms to be a positive number, got ${args.timeoutMs}`);
  }
  return args;
}

async function timeCommand({ command, args, label, timeoutMs, cwd, stdout, stderr }) {
  const started = performance.now();
  stderr.write(`[test-velocity] measuring ${label}\n`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const elapsedMs = Math.round(performance.now() - started);
      resolve({ ms: null, failure: { label, status: `timeout after ${formatDuration(timeoutMs)} (${elapsedMs}ms elapsed)` } });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ms: null, failure: { label, status: `spawn error: ${error.message}` } });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedMs = Math.round(performance.now() - started);
      if (code === 0 && !signal) {
        resolve({ ms: elapsedMs, failure: null });
      } else {
        resolve({ ms: null, failure: { label, status: signal ? `signal ${signal} after ${formatDuration(elapsedMs)}` : `exit ${code} after ${formatDuration(elapsedMs)}` } });
      }
    });
  });
}

async function measureCommands({ timeoutMs, cwd, stdout, stderr }) {
  const results = {};
  const failures = [];
  for (const measurement of MEASURE_COMMANDS) {
    const result = await timeCommand({ ...measurement, timeoutMs, cwd, stdout, stderr });
    results[measurement.key] = result.ms;
    if (result.failure) failures.push(result.failure);
  }
  return { ...results, measurementFailures: failures };
}

function renderFromEntry(entry, previous, quarantine) {
  return renderReport({
    gateMs: entry?.gateMs,
    bootSmokeMs: entry?.bootSmokeMs,
    testMs: entry?.testMs,
    slowest: entry?.slowestTop20 ?? [],
    quarantine: quarantine ?? { total: entry?.quarantineCount ?? 0, byAgeBucket: {}, deletionDueEntries: [], deletionDueCount: 0 },
    capturedAt: entry?.capturedAt,
    previous,
    measurementFailures: entry?.measurementFailures ?? [],
    timingSnapshotCapturedAt: entry?.timingSnapshotCapturedAt ?? null,
  });
}

export async function main(argv = process.argv.slice(2), { rootDir = repoRoot, stdout = process.stdout, stderr = process.stderr, now = new Date() } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }

  if (args.help) {
    stdout.write("Usage: node scripts/test-velocity-baseline.mjs [--measure] [--write-report] [--report-only] [--timeout-ms <ms>]\n");
    return 0;
  }

  const history = readJson(DEFAULT_HISTORY_PATH, { entries: [] }, rootDir);
  const entries = historyEntries(history);
  const timings = readJson(DEFAULT_TIMINGS_PATH, { packages: {} }, rootDir);
  const quarantineJson = readJson(DEFAULT_QUARANTINE_PATH, { entries: [] }, rootDir);
  const quarantine = readQuarantineCount(quarantineJson, { now });
  const slowest = topSlowestFiles(timings, 20);

  if (args.measure) {
    const measured = await measureCommands({ timeoutMs: args.timeoutMs, cwd: rootDir, stdout, stderr });
    const entry = createEntry({
      capturedAt: now.toISOString(),
      gateMs: measured.gateMs,
      bootSmokeMs: measured.bootSmokeMs,
      testMs: measured.testMs,
      quarantine,
      slowest,
      measurementFailures: measured.measurementFailures,
      timingSnapshotCapturedAt: timings?.capturedAt ?? null,
    });
    entries.push(entry);
    writeJson(DEFAULT_HISTORY_PATH, { entries }, rootDir);
  }

  const latest = entries.at(-1) ?? createEntry({
    capturedAt: now.toISOString(),
    quarantine,
    slowest,
    timingSnapshotCapturedAt: timings?.capturedAt ?? null,
  });
  const previous = entries.length > 1 ? entries.at(-2) : null;
  const report = renderFromEntry(latest, previous, quarantine);

  if (args.writeReport || args.reportOnly) {
    writeText(DEFAULT_REPORT_PATH, report, rootDir);
    stdout.write(`Updated ${DEFAULT_REPORT_PATH}\n`);
  } else {
    stdout.write(report);
  }

  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  /*
  FNXC:TestVelocityBaseline 2026-06-17-00:00:
  FN-6612 requires a weekly signal-per-second baseline for gate time, boot smoke time, changed-only test time, slowest files, and quarantine age. This script measures and reports those values only; it must stay out of blocking PR checks so the merge gate remains thin.
  */
  const exitCode = await main();
  process.exitCode = exitCode;
}
