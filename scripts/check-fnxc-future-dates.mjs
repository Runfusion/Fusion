/*
FNXC:FnxcStampHygiene 2026-08-01-01:17:
The baseline ratchet answers whether the future-dated population grew, not whether an individual
stamp is plausible. That lets a 79-day-out stamp remain tolerated indefinitely. This advisory makes
that distinction visible without failing: 111 existing stamps belong to other authors, and a bulk
rewrite would create the churn this gate is meant to avoid.
*/
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOTS = ["packages", "scripts", "docs"];
const BASELINE = join(REPO, "scripts", "lib", "fnxc-future-dates-baseline.json");
/* Build output and vendored bundles are generated; their stamps are copies of the source ones. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".gate-bundle", "coverage", "build", ".next"]);

/*
FNXC:FnxcStampHygiene 2026-08-01-01:17:
Hyphens are part of the required `FNXC:Area-of-product` form, so this one shared matcher remains the
source of both ratchet and advisory records. A second pattern would let the two reports disagree.
*/
export const STAMP = /FNXC:([A-Za-z0-9_-]+)\s+(\d{4}-\d{2}-\d{2})/g;
export const STAMP_TIME = /FNXC:[A-Za-z0-9_-]+\s+\d{4}-\d{2}-\d{2}-(\d{2}):(\d{2})/g;

/*
FNXC:FnxcStampHygiene 2026-08-01-01:17:
26 hours is wider than the UTC+14 maximum offset, so a stamp inside a day-and-a-bit can be an
author-local date and needs no action.
*/
export const TIMEZONE_PLAUSIBLE_HOURS = 26;

/*
FNXC:FnxcStampHygiene 2026-08-01-01:17:
48 hours is the deliberately conservative headline threshold: nothing inside two days is called out
loudly. The 26–48 hour suspect band still counts the source measurement's >26h population rather
than silently dropping it.
*/
export const IMPLAUSIBLE_HOURS = 48;

/** Returns a valid UTC-midnight date for a YYYY-MM-DD value, or null without throwing. */
function parseStampDate(stampDate) {
  if (typeof stampDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stampDate)) return null;
  const parsed = new Date(`${stampDate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== stampDate ? null : parsed;
}

/** Returns the UTC hours a date-only stamp is ahead of the reference, or null when it is invalid. */
export function hoursAhead(stampDate, referenceDate) {
  const stamp = parseStampDate(stampDate);
  const reference = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (!stamp || Number.isNaN(reference.getTime())) return null;
  return (stamp.getTime() - reference.getTime()) / (60 * 60 * 1000);
}

/** Classifies every parseable stamp; invalid dates are non-anomalies rather than scanner failures. */
export function classifyFutureStamp(stampDate, referenceDate) {
  const hours = hoursAhead(stampDate, referenceDate);
  if (hours === null || hours <= 0) return "past-or-today";
  if (hours <= TIMEZONE_PLAUSIBLE_HOURS) return "timezone-plausible";
  if (hours <= IMPLAUSIBLE_HOURS) return "suspect";
  return "implausible";
}

/** The stamp an author should paste, in the project's `yyyy-MM-dd-HH:mm` form, in UTC. */
export function nowStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}-${p(now.getUTCHours())}:${p(now.getUTCMinutes())}`;
}

export function impossibleClockTimes(source) {
  let bad = 0;
  STAMP_TIME.lastIndex = 0;
  for (const match of source.matchAll(STAMP_TIME)) {
    if (Number(match[1]) > 23 || Number(match[2]) > 59) bad += 1;
  }
  return bad;
}

export function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(tsx?|m?js|cjs|md|sql|css|html|ya?ml|json|sh)$/.test(full)) yield full;
  }
}

/** Preserves the existing later-of-local-and-UTC calendar bound for an injectable clock. */
export function todayFor(now = new Date()) {
  const localToday = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const utcToday = now.toISOString().slice(0, 10);
  return { localToday, utcToday, today: localToday > utcToday ? localToday : utcToday };
}

/**
 * Scans exactly the historical roots. `root` is a repository root, not a directory to broaden.
 */
export function scan({ root = REPO, referenceDate = new Date(`${todayFor().today}T00:00:00.000Z`) } = {}) {
  const counts = {};
  const records = [];
  const impossibleRecords = [];
  const scannedFiles = [];
  for (const scanRoot of ROOTS) {
    const directory = join(root, scanRoot);
    try { if (!statSync(directory).isDirectory()) continue; } catch { continue; }
    for (const file of walk(directory)) {
      const fileKey = relative(root, file).split("\\").join("/");
      scannedFiles.push(fileKey);
      const source = readFileSync(file, "utf8");
      let hits = 0;
      STAMP.lastIndex = 0;
      for (const match of source.matchAll(STAMP)) {
        const [area, stamp] = [match[1], match[2]];
        const hours = hoursAhead(stamp, referenceDate);
        const band = classifyFutureStamp(stamp, referenceDate);
        if (hours !== null && hours > 0) {
          hits += 1;
          records.push({ file: fileKey, area, stamp, hoursAhead: hours, daysAhead: hours / 24, band });
        }
      }
      STAMP_TIME.lastIndex = 0;
      for (const match of source.matchAll(STAMP_TIME)) {
        if (Number(match[1]) > 23 || Number(match[2]) > 59) {
          hits += 1;
          impossibleRecords.push({ file: fileKey, stamp: match[0] });
        }
      }
      if (hits > 0) counts[fileKey] = hits;
    }
  }
  scannedFiles.sort();
  return { counts, records, impossibleRecords, scannedFiles };
}

function byBand(records) {
  return {
    timezonePlausible: records.filter((record) => record.band === "timezone-plausible").length,
    suspect: records.filter((record) => record.band === "suspect").length,
    implausible: records.filter((record) => record.band === "implausible").length,
  };
}

function advisoryLines(records, bands) {
  if (bands.suspect + bands.implausible === 0) return [];
  const lines = [
    "[check-fnxc-future-dates] advisory (informational only; does not fail the build):",
    `  future-dated total: ${records.length}`,
    `  timezone-plausible (<=26h; explainable by author timezone — no action needed): ${bands.timezonePlausible}`,
    `  suspect (>26h, <=48h): ${bands.suspect}`,
    `  implausible (>48h): ${bands.implausible}`,
  ];
  const offenders = records.filter((record) => record.band === "implausible")
    .sort((a, b) => b.daysAhead - a.daysAhead || a.file.localeCompare(b.file)).slice(0, 10);
  if (offenders.length > 0) {
    lines.push("  worst implausible offenders:");
    for (const record of offenders) {
      lines.push(`    ${record.file} — FNXC:${record.area} ${record.stamp} (${record.daysAhead.toFixed(1)} days ahead)`);
    }
  }
  return lines;
}

function reportLines(records, impossibleRecords, bands) {
  const lines = ["[check-fnxc-future-dates] anomaly census (read-only; informational only):"];
  const anomalies = records.filter((record) => record.band === "suspect" || record.band === "implausible")
    .sort((a, b) => a.file.localeCompare(b.file) || b.daysAhead - a.daysAhead);
  let currentFile;
  for (const record of anomalies) {
    if (record.file !== currentFile) {
      currentFile = record.file;
      lines.push(`  ${currentFile}`);
    }
    lines.push(`    FNXC:${record.area} ${record.stamp} — ${record.band} (${record.daysAhead.toFixed(1)} days ahead)`);
  }
  if (anomalies.length === 0) lines.push("  no suspect or implausible stamps");
  if (impossibleRecords.length > 0) {
    lines.push("  impossible clock times (informational):");
    for (const record of impossibleRecords) lines.push(`    ${record.file} — ${record.stamp}`);
  }
  const areas = new Map();
  for (const record of anomalies) areas.set(record.area, (areas.get(record.area) ?? 0) + 1);
  lines.push("  anomaly counts by FNXC area:");
  for (const [area, count] of [...areas].sort(([a], [b]) => a.localeCompare(b))) lines.push(`    FNXC:${area}: ${count}`);
  lines.push(`  band totals: timezone-plausible=${bands.timezonePlausible}, suspect=${bands.suspect}, implausible=${bands.implausible}`);
  return lines;
}

function readBaseline(baselinePath) {
  let baseline;
  try { baseline = JSON.parse(readFileSync(baselinePath, "utf8")); } catch {
    return { error: "[check-fnxc-future-dates] missing or malformed baseline; run with --update-baseline" };
  }
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
    return { error: "[check-fnxc-future-dates] baseline must be a JSON object of file -> count" };
  }
  for (const [file, count] of Object.entries(baseline)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      return { error: `[check-fnxc-future-dates] baseline entry "${file}" must be a non-negative safe integer, got ${JSON.stringify(count)}` };
    }
  }
  return { baseline };
}

function writeBaseline(baselinePath, baseline) {
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

/**
 * Runs the historical ratchet plus its non-blocking plausibility advisory.
 *
 * FNXC:FnxcStampHygiene 2026-08-01-01:17:
 * The injected root, baseline, and clock make the real gate testable without changing discovery or
 * the later-of-local-and-UTC bound. Report mode is intentionally read-only so operators can census a
 * tolerated population without banking, tightening, or failing it.
 */
export function runGate({ root = REPO, baselinePath = join(root, "scripts", "lib", "fnxc-future-dates-baseline.json"), now = new Date(), mode = "check" } = {}) {
  const { today } = todayFor(now);
  const referenceDate = new Date(`${today}T00:00:00.000Z`);
  const { counts: found, records, impossibleRecords, scannedFiles } = scan({ root, referenceDate });
  const bands = byBand(records);
  const result = {
    exitCode: 0,
    futureTotal: records.length,
    byBand: bands,
    records,
    scannedFiles,
    baselineWritten: false,
    lines: [],
  };

  if (mode === "report") {
    if (readBaseline(baselinePath).error) result.lines.push("[check-fnxc-future-dates] baseline unavailable — census only");
    result.lines.push(...reportLines(records, impossibleRecords, bands));
    return result;
  }

  if (mode === "update") {
    writeBaseline(baselinePath, found);
    result.baselineWritten = true;
    const total = Object.values(found).reduce((a, b) => a + b, 0);
    result.lines.push(`[check-fnxc-future-dates] baseline written: ${total} stamp(s) in ${Object.keys(found).length} file(s)`);
    return result;
  }

  const loaded = readBaseline(baselinePath);
  if (loaded.error) {
    result.exitCode = 1;
    result.lines.push(loaded.error);
    return result;
  }
  const baseline = loaded.baseline;
  const problems = [];
  const offendingFiles = [];
  for (const [file, count] of Object.entries(found)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      offendingFiles.push(file);
      problems.push(`  ${file}: ${count} future-dated FNXC stamp(s), baseline allows ${allowed}`);
    }
  }
  const tightened = [];
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = found[file] ?? 0;
    if (count < allowed) tightened.push(`  ${file}: ${allowed} -> ${count}`);
  }
  /*
  FNXC:FnxcStampHygiene 2026-08-01-01:17:
  Check mode must remain read-only: an aging stamp can lower the census without an author action.
  Report the available tightening, but require the explicit update mode to record it.
  */
  if (tightened.length > 0) {
    result.lines.push(
      `[check-fnxc-future-dates] baseline CAN BE TIGHTENED for ${tightened.length} file(s):`,
      ...tightened.sort(),
      "  run `pnpm check:fnxc-future-dates --update-baseline` to record it (one commit, one author).",
    );
  }
  if (problems.length > 0) {
    result.exitCode = 1;
    result.lines.push("", "[check-fnxc-future-dates] FNXC stamp population changed:", "", ...problems.sort());
    for (const file of offendingFiles) {
      const source = readFileSync(join(root, file), "utf8");
      const bad = [];
      STAMP.lastIndex = 0;
      for (const match of source.matchAll(STAMP)) if (classifyFutureStamp(match[2], referenceDate) !== "past-or-today") bad.push(`${match[0]}  (dated after today)`);
      STAMP_TIME.lastIndex = 0;
      for (const match of source.matchAll(STAMP_TIME)) if (Number(match[1]) > 23 || Number(match[2]) > 59) bad.push(`${match[0]}  (impossible clock time)`);
      if (bad.length > 0) result.lines.push("", `  ${file}`, ...[...new Set(bad)].map((line) => `    ${line}`));
    }
    result.lines.push(
      `\nA stamp dated after today (${today}) records the change as happening in the future, which makes`,
      "the FNXC record — the project's why-does-this-exist trail — read out of order. An hour above 23",
      "or a minute above 59 is not a real time at all.",
      "Use the current date and a real clock time. If a count went DOWN, re-record the baseline in the",
      `same commit.\nCurrent UTC stamp to use: ${nowStamp(now)}\n`,
    );
    return result;
  }
  const total = Object.values(found).reduce((a, b) => a + b, 0);
  result.lines.push(`[check-fnxc-future-dates] ${total} known future-dated stamp(s), none added.`);
  result.lines.push(...advisoryLines(records, bands));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes("--report-anomalies") ? "report" : process.argv.includes("--update-baseline") ? "update" : "check";
  const result = runGate({ mode });
  for (const line of result.lines) console.log(line);
  process.exit(result.exitCode);
}
