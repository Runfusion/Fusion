#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/*
FNXC:PgLoadedFailureCensus 2026-08-19-12:41:
FN-9148 requires a report-only census because earlier PostgreSQL loaded-lane
owners had to reason from runner-log impressions. Peaks of 62–73 below 97
ordinary slots already contradict ordinary connection exhaustion, while a
non-reproducing run is evidence only when it remains distinguishable from a
missing or truncated capture. This parser never opens PostgreSQL, runs tests,
or changes harness behavior.
*/

export function stripAnsi(text) {
  return String(text).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

export function parseDiagnosticsJsonl(text) {
  const rows = [];
  let malformedLines = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
      else malformedLines += 1;
    } catch {
      malformedLines += 1;
    }
  }
  return { rows, malformedLines };
}

export function normalizeFile(value) {
  const normalized = String(value).replaceAll("\\", "/");
  // Vitest diagnostics use absolute paths while runner failures use repo paths.
  // Canonicalize at the test-root segment before any key-based observer join.
  const testRoot = normalized.indexOf("src/__tests__/");
  if (testRoot >= 0) return normalized.slice(testRoot);
  const match = normalized.match(/(?:[\w@.-]+\/)*[\w@.-]+(?:\.pg)?\.test\.[cm]?[jt]sx?/i);
  return match?.[0] ?? null;
}

export function classifyLifecyclePosition(text) {
  const value = String(text).toLowerCase();
  if (/\bglobal (?:setup|teardown)\b|\bglobalSetup\b|\bglobalTeardown\b/i.test(text)) return "global setup-teardown";
  if (/\bafterall\b|\bafter all\b/i.test(text)) return "afterAll hook";
  if (/\baftereach\b|\bafter each\b/i.test(text)) return "afterEach";
  if (/\bbeforeall\b|\bbefore all\b/i.test(text)) return "beforeAll hook";
  if (/\bbeforeeach\b|\bbefore each\b|\bin-test setup\b|\btest setup\b/i.test(text)) return "in-test setup";
  return "test body";
}

export function classifyFailureShape(text) {
  const value = String(text).toLowerCase();
  if (/\b(?:hook|beforeall|beforeeach|afterall|aftereach|global setup|global teardown)\b[\s\S]{0,120}\btimed out\b|\btimed out\b[\s\S]{0,120}\b(?:hook|beforeall|beforeeach|afterall|aftereach)\b/.test(value)) return "hook timeout";
  if (/\btest timed out\b|\btimed out\b/.test(value)) return "test timeout";
  if (/assertionerror|\bexpected\b[\s\S]{0,80}\b(?:to be|to equal|to deeply equal|received)\b/i.test(text)) return "assertion";
  return "error";
}

export function extractFailingFiles(log) {
  const clean = stripAnsi(log);
  const headings = [...clean.matchAll(/^\s*(?:FAIL|❯)\s+(.+?\.test\.[cm]?[jt]sx?)(?:\s|$)/gim)];
  const failures = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const file = normalizeFile(headings[index][1]);
    if (!file) continue;
    const start = headings[index].index ?? 0;
    const end = headings[index + 1]?.index ?? clean.length;
    const detail = clean.slice(start, end);
    const prior = failures.get(file);
    if (!prior || detail.length > prior.detail.length) {
      failures.set(file, { file, lifecyclePosition: classifyLifecyclePosition(detail), failureShape: classifyFailureShape(detail), detail });
    }
  }
  return [...failures.values()].map(({ detail: _detail, ...failure }) => failure);
}

function parseCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseFileSummary(log) {
  const line = stripAnsi(log).split(/\r?\n/).find((candidate) => /^\s*Test Files\s+/i.test(candidate));
  if (!line) return { complete: false, totalFiles: null, reportedFailedFiles: null };
  const count = (word) => {
    const match = line.match(new RegExp(`(\\d+)\\s+${word}\\b`, "i"));
    return match ? parseCount(match[1]) : 0;
  };
  const failed = count("failed");
  const passed = count("passed");
  const skipped = count("skipped");
  if ([failed, passed, skipped].some((value) => value == null)) return { complete: false, totalFiles: null, reportedFailedFiles: null };
  return { complete: true, totalFiles: failed + passed + skipped, reportedFailedFiles: failed };
}

export function parseBoundaryObserverJsonl(text) {
  return parseDiagnosticsJsonl(text);
}

/** Vitest JSON exposes test durations; hook duration is not available in v4 output. */
export function parseVitestJson(text) {
  try {
    const report = JSON.parse(String(text));
    const rows = Array.isArray(report?.testResults) ? report.testResults : [];
    return {
      rows: rows.flatMap((file) => (Array.isArray(file?.assertionResults) ? file.assertionResults : []).map((test) => ({
        testFile: normalizeFile(file?.name),
        position: classifyLifecyclePosition([test?.fullName, ...(test?.failureMessages ?? [])].join("\n")),
        durationMs: Number.isFinite(test?.duration) ? test.duration : null,
        status: test?.status ?? null,
      }))),
      malformed: false,
    };
  } catch {
    return { rows: [], malformed: true };
  }
}

function boundaryForLifecycle(lifecyclePosition) {
  if (lifecyclePosition === "beforeAll hook" || lifecyclePosition === "in-test setup") return "setup";
  if (lifecyclePosition === "afterEach" || lifecyclePosition === "afterAll hook" || lifecyclePosition === "global setup-teardown") return "teardown";
  return "body";
}

function observerFile(record) {
  return normalizeFile(record?.testFile);
}

/**
 * FNXC:PgTimeoutBoundaryObserver 2026-08-19-13:51:
 * Watchdog payloads win because they are the only records carrying a cluster
 * snapshot. Completion-only and suppressed records may support host evidence,
 * but must never be promoted to cluster causation by inference.
 */
export function classifyBoundaryAttribution(failure, observerRecords, bodyUnobservableFiles = [], fullyUnobservableFiles = []) {
  const boundary = boundaryForLifecycle(failure.lifecyclePosition);
  const sameFile = observerRecords.filter((record) => observerFile(record) === failure.file && record.boundary === boundary);
  if (fullyUnobservableFiles.includes(failure.file)) {
    // These files never enter a harness-owned boundary, so their missing join
    // is an explicit coverage limit rather than a failed observer correlation.
    return { classification: "unjoined", boundary, record: null, hostOnly: false, fullyUnobservable: true };
  }
  if (boundary === "body" && bodyUnobservableFiles.includes(failure.file)) {
    return { classification: "body-unobservable", boundary, record: null, hostOnly: false, fullyUnobservable: false };
  }
  // Shared-harness afterEach only closes the body bracket; consumer afterEach
  // hooks are outside it, so an absent record is an explicit position limit.
  if (failure.lifecyclePosition === "afterEach") {
    return { classification: "position-unobservable", boundary, record: null, hostOnly: false, fullyUnobservable: false };
  }
  // A settled boundary can legitimately have earlier checkpoints. Only a key
  // with progress and no terminal record is an abandoned-boundary lower bound.
  const terminalKeys = new Set(sameFile.filter((record) => record.kind === "terminal" && typeof record.joinKey === "string").map((record) => record.joinKey));
  const abandonedProgress = sameFile.filter((record) => record.kind === "progress" && typeof record.joinKey === "string" && !terminalKeys.has(record.joinKey));
  if (abandonedProgress.length > 0) {
    const withElapsed = abandonedProgress.map((record) => ({ record, elapsedMs: Number(record.elapsedMs) })).filter(({ elapsedMs }) => Number.isFinite(elapsedMs));
    const latestBound = withElapsed.length > 0 ? withElapsed.reduce((latest, candidate) => candidate.elapsedMs > latest.elapsedMs ? candidate : latest) : null;
    return { classification: "attributed-by-ladder", boundary, record: latestBound?.record ?? abandonedProgress[0], hostOnly: true, elapsedLowerBoundMs: latestBound?.elapsedMs ?? null };
  }
  const watchdog = sameFile.filter((record) => record.trigger === "boundary-watchdog");
  const record = watchdog.find((candidate) => !candidate.probeSuppressed && candidate.cluster && candidate.template)
    ?? watchdog.find((candidate) => candidate.kind === "watchdog")
    ?? watchdog[0]
    ?? sameFile[0]
    ?? null;
  if (!record) return { classification: "unjoined", boundary, record: null, hostOnly: false };
  const hostOnly = record.trigger !== "boundary-watchdog" || Boolean(record.probeSuppressed) || !record.cluster;
  if (hostOnly) {
    const load = Number(record?.host?.loadavg1);
    const cpus = Number(record?.host?.cpuCount);
    const lag = Number(record?.host?.eventLoopLagMs);
    if ((Number.isFinite(load) && Number.isFinite(cpus) && load >= cpus) || lag >= 100) {
      return { classification: "host-implicated", boundary, record, hostOnly: true };
    }
    // A two-phase breach is a real boundary join even when it has no cluster
    // payload. Keep it visible as coverage rather than misreporting no record.
    if (record?.kind === "breach" && record?.payloadFree === true) {
      return { classification: "joined", boundary, record, hostOnly: true };
    }
    return { classification: "unjoined", boundary, record, hostOnly: true };
  }
  const template = record.template ?? {};
  // A holder alone is not a convoy: only a non-owner waiter proves the
  // timed-out boundary was queued behind the golden template advisory lock.
  if (Array.isArray(template.advisoryWaiters) && template.advisoryWaiters.length > 0 && template.isOwner === false) {
    return { classification: "template-convoy", boundary, record, hostOnly: false, fullyUnobservable: false };
  }
  const cluster = record.cluster ?? {};
  const active = Array.isArray(cluster.activity) && cluster.activity.some((row) => row?.state === "active" || row?.wait_event || row?.blockingPids?.length);
  const blocked = Array.isArray(cluster.locks) && cluster.locks.some((lock) => lock?.granted === false || lock?.blockingPids?.length);
  if (active || blocked) return { classification: "cluster-implicated", boundary, record, hostOnly: false };
  const load = Number(record?.host?.loadavg1);
  const cpus = Number(record?.host?.cpuCount);
  const lag = Number(record?.host?.eventLoopLagMs);
  if ((Number.isFinite(load) && Number.isFinite(cpus) && load >= cpus) || lag >= 100) return { classification: "host-implicated", boundary, record, hostOnly: false };
  return { classification: "unjoined", boundary, record, hostOnly: false };
}

export function summarizeBoundaryObserver(records, failures, bodyUnobservableFiles = [], fullyUnobservableFiles = []) {
  const rows = Array.isArray(records) ? records : [];
  const attributions = failures.map((failure) => ({ ...failure, boundaryAttribution: classifyBoundaryAttribution(failure, rows, bodyUnobservableFiles, fullyUnobservableFiles) }));
  const suppression = {};
  for (const row of rows) {
    const reason = row?.probeSuppressed === "single-flight" ? "concurrency" : row?.probeSuppressed;
    if (reason) suppression[reason] = (suppression[reason] ?? 0) + 1;
  }
  const attributionCounts = Object.fromEntries(Object.entries(Object.groupBy(attributions, (row) => row.boundaryAttribution.classification)).map(([key, values]) => [key, values.length]));
  return {
    boundaryObserver: rows.length ? "present" : "absent",
    boundaryAttributionHistogram: attributionCounts,
    joinedCoverageYield: {
      joined: (attributionCounts.joined ?? 0) + (attributionCounts["cluster-implicated"] ?? 0) + (attributionCounts["host-implicated"] ?? 0) + (attributionCounts["template-convoy"] ?? 0),
      attributedByLadder: attributionCounts["attributed-by-ladder"] ?? 0,
      bodyUnobservable: attributionCounts["body-unobservable"] ?? 0,
      positionUnobservable: attributionCounts["position-unobservable"] ?? 0,
      unjoined: attributionCounts.unjoined ?? 0,
    },
    observerProbeSuppression: suppression,
    settledDuringProbeCount: rows.filter((row) => row?.settledDuringProbe === true).length,
    fullyUnobservableFailingFiles: attributions.filter((row) => row.boundaryAttribution.fullyUnobservable).map((row) => row.file),
    fullyUnobservableFailingFileCount: attributions.filter((row) => row.boundaryAttribution.fullyUnobservable).length,
    attributions,
  };
}

export function summarizeDiagnostics(diagnostics) {
  const input = Array.isArray(diagnostics) ? diagnostics : [];
  const waits = new Map();
  const peaks = [];
  const phaseDurations = new Map();
  let watchdogCount = 0;
  let probeDegradationCount = 0;
  for (const row of input) {
    if (row?.trigger === "phase-watchdog" || row?.trigger === "teardown-watchdog") watchdogCount += 1;
    if (row?.probeSuppressed || (row?.trigger?.includes("watchdog") && row?.probeRan === false)) probeDegradationCount += 1;
    for (const duration of Object.values(row?.phaseDurationsMs ?? {})) {
      if (Number.isFinite(duration)) phaseDurations.set("all", [...(phaseDurations.get("all") ?? []), duration]);
    }
    for (const activity of row?.snapshotRows ?? []) {
      if (Number.isFinite(activity?.total_backends)) peaks.push(activity.total_backends);
      const type = activity?.wait_event_type ?? "none";
      const event = activity?.wait_event ?? "none";
      const key = `${type}/${event}`;
      waits.set(key, (waits.get(key) ?? 0) + 1);
    }
  }
  const values = phaseDurations.get("all") ?? [];
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (fraction) => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    peakBackends: peaks.length ? Math.max(...peaks) : null,
    waitEventHistogram: Object.fromEntries([...waits.entries()].sort(([a], [b]) => a.localeCompare(b))),
    phaseDurationMs: { count: sorted.length, median: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null },
    watchdogCount,
    probeDegradationCount,
  };
}

export function buildCensus({ log, diagnostics = [], boundaryObserver = [], vitestJson = [], bodyUnobservableFiles = [], fullyUnobservableFiles = [], ordinarySlotCeiling = null, subjects = [] }) {
  const summary = parseFileSummary(log);
  if (!summary.complete) {
    return { status: "insufficient-data", reason: "missing Test Files summary", totalFiles: null, failingFiles: [], failingFileCount: null };
  }
  const failingFiles = extractFailingFiles(log).map((failure) => ({ ...failure, campaignSubject: subjects.includes(failure.file) }));
  if (summary.reportedFailedFiles !== failingFiles.length) {
    return { status: "insufficient-data", reason: `summary reports ${summary.reportedFailedFiles} failed files but ${failingFiles.length} failure blocks were parsed`, totalFiles: summary.totalFiles, failingFiles, failingFileCount: null };
  }
  const diagnosticSummary = summarizeDiagnostics(diagnostics);
  const observerSummary = summarizeBoundaryObserver(boundaryObserver, failingFiles, bodyUnobservableFiles, fullyUnobservableFiles);
  const reporterFiles = new Set(vitestJson.map((row) => row.testFile).filter(Boolean));
  const observerFiles = new Set(boundaryObserver.map(observerFile).filter(Boolean));
  const reporterJoin = {
    observerFilesWithoutReporter: [...observerFiles].filter((file) => !reporterFiles.has(file)),
    reporterFilesWithoutObserver: [...reporterFiles].filter((file) => !observerFiles.has(file)),
  };
  const ceiling = Number.isFinite(ordinarySlotCeiling) && ordinarySlotCeiling >= 0 ? ordinarySlotCeiling : null;
  return {
    status: "measured",
    totalFiles: summary.totalFiles,
    failingFiles,
    failingFileCount: failingFiles.length,
    failingFileBand: failingFiles.length >= 25 ? "high (>=25)" : failingFiles.length === 0 ? "zero" : "low (1-24)",
    lifecyclePositionHistogram: Object.fromEntries(Object.entries(Object.groupBy(failingFiles, (failure) => failure.lifecyclePosition)).map(([key, values]) => [key, values.length])),
    failureShapeHistogram: Object.fromEntries(Object.entries(Object.groupBy(failingFiles, (failure) => failure.failureShape)).map(([key, values]) => [key, values.length])),
    ordinarySlotCeiling: ceiling,
    backendHeadroom: ceiling != null && diagnosticSummary.peakBackends != null ? ceiling - diagnosticSummary.peakBackends : null,
    ...diagnosticSummary,
    ...observerSummary,
    reporterJoin,
  };
}

function parseArgs(args) {
  const result = { log: undefined, diagnostics: undefined, boundaryObserver: undefined, vitestJson: undefined, bodyUnobservableFiles: undefined, fullyUnobservableFiles: undefined, ordinarySlotCeiling: null, subjects: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--log") result.log = args[++index];
    else if (argument === "--diagnostics") result.diagnostics = args[++index];
    else if (argument === "--boundary-observer") result.boundaryObserver = args[++index];
    else if (argument === "--vitest-json") result.vitestJson = args[++index];
    else if (argument === "--body-unobservable-files") result.bodyUnobservableFiles = args[++index];
    else if (argument === "--fully-unobservable-files") result.fullyUnobservableFiles = args[++index];
    else if (argument === "--ordinary-slot-ceiling") result.ordinarySlotCeiling = Number(args[++index]);
    else if (argument === "--subject") result.subjects.push(args[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.log) throw new Error("Supply --log <runner.log>");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const parsed = args.diagnostics ? parseDiagnosticsJsonl(readFileSync(args.diagnostics, "utf8")) : { rows: [], malformedLines: 0 };
  const observer = args.boundaryObserver ? parseBoundaryObserverJsonl(readFileSync(args.boundaryObserver, "utf8")) : { rows: [], malformedLines: 0 };
  const reporter = args.vitestJson ? parseVitestJson(readFileSync(args.vitestJson, "utf8")) : { rows: [], malformed: false };
  const bodyUnobservableFiles = args.bodyUnobservableFiles ? readFileSync(args.bodyUnobservableFiles, "utf8").split(/\\r?\\n/).map(normalizeFile).filter(Boolean) : [];
  const fullyUnobservableFiles = args.fullyUnobservableFiles ? readFileSync(args.fullyUnobservableFiles, "utf8").split(/\\r?\\n/).map(normalizeFile).filter(Boolean) : [];
  console.log(JSON.stringify({ ...buildCensus({ log: readFileSync(args.log, "utf8"), diagnostics: parsed.rows, boundaryObserver: observer.rows, vitestJson: reporter.rows, bodyUnobservableFiles, fullyUnobservableFiles, ordinarySlotCeiling: args.ordinarySlotCeiling, subjects: args.subjects }), malformedDiagnosticLines: parsed.malformedLines, malformedBoundaryObserverLines: observer.malformedLines, malformedVitestJson: reporter.malformed }, null, 2));
}
