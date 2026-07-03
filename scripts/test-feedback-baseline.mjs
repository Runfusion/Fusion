#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), "..");

export const DEFAULT_TIMINGS_PATH = "scripts/test-timings.json";
export const DEFAULT_QUARANTINE_PATH = "scripts/lib/test-quarantine.json";
export const DEFAULT_BASELINES_PATH = "docs/test-feedback-loop-baselines.json";
export const DEFAULT_MARKDOWN_PATH = "docs/test-feedback-loop-baseline.md";

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

function formatDuration(ms) {
  if (ms == null) return "pending measurement";
  const sign = ms < 0 ? "-" : "";
  const absoluteMs = Math.abs(ms);
  if (absoluteMs < 1000) return `${sign}${absoluteMs}ms`;
  const seconds = absoluteMs / 1000;
  if (seconds < 60) return `${sign}${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds - minutes * 60);
  return `${sign}${minutes}m ${String(remaining).padStart(2, "0")}s`;
}

function isoWeek(date) {
  const working = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = working.getUTCDay() || 7;
  working.setUTCDate(working.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(working.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((working - yearStart) / 86_400_000 + 1) / 7);
  return `${working.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function collectSlowestFiles(timings, limit = 20) {
  const rows = [];
  for (const [packageName, packageTiming] of Object.entries(timings?.packages ?? {})) {
    for (const [file, durationMs] of Object.entries(packageTiming?.files ?? {})) {
      rows.push({ packageName, file, durationMs: Number(durationMs) || 0 });
    }
  }

  rows.sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file));
  return rows.slice(0, limit);
}

export function collectFlakeSummary(quarantine) {
  const entries = Array.isArray(quarantine?.entries) ? quarantine.entries : [];
  const uniqueFiles = [...new Set(entries.map((entry) => entry.file).filter(Boolean))].sort();
  return {
    flakeCount: entries.length,
    uniqueQuarantinedFileCount: uniqueFiles.length,
    quarantinedFiles: uniqueFiles,
  };
}

export function createBaseline({ now = new Date(), gateWallTimeMs = null, pnpmTestWallTimeMs = null, timings, quarantine, notes = "" } = {}) {
  const slowest20 = collectSlowestFiles(timings, 20);
  const flakeSummary = collectFlakeSummary(quarantine);
  return {
    capturedAt: now.toISOString(),
    cycle: isoWeek(now),
    gateWallTimeMs: normalizeMs(gateWallTimeMs),
    pnpmTestWallTimeMs: normalizeMs(pnpmTestWallTimeMs),
    timingSnapshotCapturedAt: timings?.capturedAt ?? null,
    slowest20,
    ...flakeSummary,
    notes,
  };
}

function trendDelta(latest, previous, field) {
  if (!previous || latest?.[field] == null || previous?.[field] == null) return "n/a";
  const delta = latest[field] - previous[field];
  const sign = delta > 0 ? "+" : "";
  return `${sign}${formatDuration(delta)}`;
}

export function renderMarkdown(baselines) {
  const sorted = [...baselines].sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
  const latest = sorted.at(-1);
  const previous = sorted.at(-2);

  const slowRows = (latest?.slowest20 ?? [])
    .map((row, index) => `| ${index + 1} | \`${row.file}\` | ${row.packageName} | ${formatDuration(row.durationMs)} |`)
    .join("\n");
  const trendRows = sorted
    .map((row) => `| ${row.cycle} | ${row.capturedAt} | ${formatDuration(row.gateWallTimeMs)} | ${formatDuration(row.pnpmTestWallTimeMs)} | ${row.flakeCount ?? 0} | ${row.uniqueQuarantinedFileCount ?? 0} |`)
    .join("\n");
  const latestNotes = latest?.notes ? `\n- Notes: ${latest.notes}` : "";

  return `# Test feedback-loop baseline\n\n> Publish this page's latest-cycle summary in #leads each week. The objective is signal-per-second: keep the merge gate thin, keep \`pnpm test\` flat or faster, and ratchet flaky/low-signal tests toward rescue or deletion.\n\n## Latest #leads summary\n\n- Cycle: **${latest?.cycle ?? "none"}** (${latest?.capturedAt ?? "not captured"})\n- Gate suite wall-time: **${formatDuration(latest?.gateWallTimeMs)}** (trend: ${trendDelta(latest, previous, "gateWallTimeMs")})\n- \`pnpm test\` wall-time: **${formatDuration(latest?.pnpmTestWallTimeMs)}** (trend: ${trendDelta(latest, previous, "pnpmTestWallTimeMs")})\n- Flake/quarantine count: **${latest?.flakeCount ?? 0}** ledger entr${(latest?.flakeCount ?? 0) === 1 ? "y" : "ies"} across **${latest?.uniqueQuarantinedFileCount ?? 0}** file${(latest?.uniqueQuarantinedFileCount ?? 0) === 1 ? "" : "s"}\n- Timing snapshot source: \`${DEFAULT_TIMINGS_PATH}\` captured at **${latest?.timingSnapshotCapturedAt ?? "unknown"}**${latestNotes}\n\n## Slowest 20 test files\n\n| Rank | File | Package | Duration |\n|---:|---|---|---:|\n${slowRows || "| — | — | — | — |"}\n\n## Trend\n\n| Cycle | Captured at | Gate suite | \`pnpm test\` | Quarantine entries | Quarantined files |\n|---|---|---:|---:|---:|---:|\n${trendRows || "| — | — | — | — | — | — |"}\n\n## Operating rules\n\n- Record a new row weekly with \`node scripts/test-feedback-baseline.mjs --record --gate-ms <ms> --test-ms <ms>\` after running \`pnpm test:gate\` and \`pnpm test\`.\n- Use the slowest-file list as the candidate queue for FN-5048 rewrites or deletion-ratchet review; do not add coverage for its own sake.\n- Quarantined tests remain on the 14-day rescue-or-delete clock in \`scripts/lib/test-quarantine.json\`; deleting a low-signal expired test is a valid positive outcome.\n`;
}

function parseArgs(argv) {
  const args = { record: false, printLeads: false, gateMs: null, testMs: null, notes: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--record") args.record = true;
    else if (arg === "--print-leads") args.printLeads = true;
    else if (arg === "--gate-ms") args.gateMs = argv[++index];
    else if (arg === "--test-ms") args.testMs = argv[++index];
    else if (arg === "--notes") args.notes = argv[++index] ?? "";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function renderLeadsSummary(baselines) {
  const latest = [...baselines].sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt))).at(-1);
  if (!latest) return "No test feedback-loop baseline has been recorded yet.";
  const topFive = (latest.slowest20 ?? []).slice(0, 5).map((row, index) => `${index + 1}. ${row.file} (${formatDuration(row.durationMs)})`).join("; ");
  const notes = latest.notes ? ` Notes: ${latest.notes}` : "";
  /*
  FNXC:TestFeedbackVelocity 2026-07-03-01:52:
  Weekly #leads output must carry the same operator notes as the Markdown report so FN-5048 slow-test candidates and quarantine-ledger reconciliation are not trapped in the backing JSON.
  */
  return `Test feedback-loop ${latest.cycle}: gate ${formatDuration(latest.gateWallTimeMs)}, pnpm test ${formatDuration(latest.pnpmTestWallTimeMs)}, quarantine ledger ${latest.flakeCount} entries/${latest.uniqueQuarantinedFileCount} files. Slowest files: ${topFive || "none"}.${notes}`;
}

export async function main(argv = process.argv.slice(2), { rootDir = repoRoot, stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }

  if (args.help) {
    stdout.write("Usage: node scripts/test-feedback-baseline.mjs [--record --gate-ms <ms> --test-ms <ms>] [--print-leads]\n");
    return 0;
  }

  const store = readJson(DEFAULT_BASELINES_PATH, { baselines: [] }, rootDir);
  const baselines = Array.isArray(store?.baselines) ? store.baselines : [];

  if (args.record || baselines.length === 0) {
    const timings = readJson(DEFAULT_TIMINGS_PATH, { packages: {} }, rootDir);
    const quarantine = readJson(DEFAULT_QUARANTINE_PATH, { entries: [] }, rootDir);
    baselines.push(createBaseline({
      gateWallTimeMs: args.gateMs,
      pnpmTestWallTimeMs: args.testMs,
      timings,
      quarantine,
      notes: args.notes,
    }));
    writeJson(DEFAULT_BASELINES_PATH, { baselines }, rootDir);
  }

  const markdown = renderMarkdown(baselines);
  writeText(DEFAULT_MARKDOWN_PATH, markdown, rootDir);

  if (args.printLeads) {
    stdout.write(`${renderLeadsSummary(baselines)}\n`);
  } else {
    stdout.write(`Updated ${DEFAULT_MARKDOWN_PATH}\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  /*
  FNXC:TestFeedbackVelocity 2026-06-17-18:30:
  The CEO mandate requires a weekly #leads-visible baseline for test signal-per-second, not more coverage. Keep this script stdlib-only so any engineer or scheduled job can refresh gate time, pnpm-test time, slowest files, and quarantine count without booting Fusion services.
  */
  const exitCode = await main();
  process.exitCode = exitCode;
}
