#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/*
FNXC:PgClusterHygiene 2026-08-19-20:14:
FN-9152 R3 needs machine-recorded PostgreSQL leftover counts: a bare `psql -qAt`
zero-row result is an empty file, so it cannot prove a clean host instead of a
failed capture. G1 therefore requires a complete provenance envelope. A supplied malformed marker
or liveness companion fails the entire report closed: ignoring it could call a cluster
clean without reading its marker table. The parser accepts harness-form `t`/`f`, so
capture queries must normalize PostgreSQL booleans. G2 keeps technical reclaimability
default-closed on recorded liveness, and this advisory parser never authorizes a drop:
G6 approval is human-authored outside this script. It never opens PostgreSQL, runs
tests, or spawns a child process.
*/

const BANNER = "# fusion-hygiene-capture v1";
const KINDS = new Set(["databases", "markers", "liveness"]);
const QUERY_BY_KIND = new Map([
  ["databases", "leftover-v1"],
  ["markers", "markers-v1"],
  ["liveness", "liveness-v1"],
]);

/** Parse a self-evidencing capture; absent or incomplete input is never a measured zero. */
export function parseCaptureEnvelope(text, { expectedKind } = {}) {
  if (text == null) return insufficient("missing");
  const source = String(text);
  if (source.length === 0) return insufficient("empty");
  const lines = source.split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines[0] !== BANNER) return insufficient("no-banner");

  const headers = new Map();
  let cursor = 1;
  while (cursor < lines.length && /^# [a-z_]+:/.test(lines[cursor])) {
    const match = /^# ([a-z_]+):\s*(.*)$/.exec(lines[cursor]);
    if (!match || headers.has(match[1])) return insufficient("bad-header");
    headers.set(match[1], match[2]);
    cursor += 1;
  }
  const kind = headers.get("kind");
  const cluster = headers.get("cluster");
  const capturedAt = headers.get("captured_at");
  const query = headers.get("query");
  const rowsValue = headers.get("rows");
  const declaredRowCount = rowsValue != null && /^\d+$/.test(rowsValue) ? Number(rowsValue) : null;
  if (!KINDS.has(kind) || !isCluster(cluster) || !isTimestamp(capturedAt) || !query || declaredRowCount == null) return insufficient("bad-header");
  if (expectedKind && kind !== expectedKind) return insufficient("kind-mismatch", { kind, cluster, capturedAt, query, declaredRowCount });
  if (query !== QUERY_BY_KIND.get(kind)) return insufficient("bad-header", { kind, cluster, capturedAt, query, declaredRowCount });
  if (lines.at(-1) !== "# end") return insufficient("truncated", { kind, cluster, capturedAt, query, declaredRowCount });
  const bodyLines = lines.slice(cursor, -1).filter((line) => line !== "");
  if (declaredRowCount !== bodyLines.length) return insufficient("count-mismatch", { kind, cluster, capturedAt, query, declaredRowCount, bodyLines });
  return { status: "measured", kind, cluster, capturedAt, query, declaredRowCount, bodyLines, malformedLines: [], insufficientReason: null };
}

function insufficient(insufficientReason, details = {}) {
  return { status: "insufficient-data", kind: details.kind ?? null, cluster: details.cluster ?? null, capturedAt: details.capturedAt ?? null, query: details.query ?? null, declaredRowCount: details.declaredRowCount ?? null, bodyLines: details.bodyLines ?? [], malformedLines: [], insufficientReason };
}

function isCluster(value) {
  return typeof value === "string" && value.split("|").length === 3 && value.split("|").every(Boolean);
}

function isTimestamp(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function parseDatabaseRows(bodyLines = []) {
  const rows = [];
  const malformedLines = [];
  for (const line of bodyLines) {
    const [datname, owner, datistemplate, conns, ...extra] = String(line).split("|");
    const sessions = /^\d+$/.test(conns ?? "") ? Number(conns) : null;
    if (extra.length || !datname || !owner || !["t", "f"].includes(datistemplate) || sessions == null) {
      malformedLines.push(line);
    } else {
      rows.push({ datname, owner, datistemplate: datistemplate === "t", conns: sessions });
    }
  }
  return { rows, malformedLines };
}

export function classifyDatabase(datname) {
  if (/^fusion_schema_template_\d+_golden[a-z0-9]*$/.test(datname)) return "golden-template";
  if (datname.startsWith("fusion_schema_template")) return "schema-template";
  if (datname.startsWith("fusion_test_")) return "test";
  if (datname.startsWith("fusion_pool_")) return "pool";
  return "unrelated";
}

/** Mirrors the harness's template pid parser, including its lowercase-alnum suffix rule. */
export function parseTemplateOwnerPid(datname) {
  const match = /^fusion_schema_template_(\d+)(?:_[a-z0-9]+)?$/.exec(datname);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}

export function parseLivenessRows(bodyLines = []) {
  const liveness = new Map();
  const malformedLines = [];
  for (const line of bodyLines) {
    const [pid, verdict, ...extra] = String(line).split("|");
    if (extra.length || !/^\d+$/.test(pid ?? "") || !["alive", "dead"].includes(verdict)) malformedLines.push(line);
    else liveness.set(Number(pid), verdict);
  }
  return { liveness, malformedLines };
}

export function classifyReclaimability(row, { liveness } = {}) {
  if (row?.conns !== 0) return "retain-in-use";
  const pid = parseTemplateOwnerPid(row?.datname ?? "");
  if (pid == null) return "retain-unclassified";
  const verdict = liveness instanceof Map ? liveness.get(pid) : undefined;
  if (verdict === "dead") return "reclaimable-dead-owner";
  if (verdict === "alive") return "retain-live-owner";
  return "retain-unclassified";
}

function parseMarkerRows(bodyLines = []) {
  const rows = [];
  const malformedLines = [];
  for (const line of bodyLines) {
    const [name, createdAt, ...extra] = String(line).split("|");
    if (extra.length || !name || !createdAt) malformedLines.push(line);
    else rows.push({ name, createdAt });
  }
  return { rows, malformedLines };
}

/*
FNXC:PgClusterHygiene 2026-08-20-01:41:
FN-9154 G1 requires all three complete captures from one cluster before the
advisory report can claim clean. Missing companions, cross-cluster envelopes,
and stale marker rows all fail closed so partial reconciliation cannot become
campaign-admission evidence.
*/
export function buildHygieneReport({ databaseCapture, markerCapture, livenessCapture } = {}) {
  const databases = parseCaptureEnvelope(databaseCapture, { expectedKind: "databases" });
  const markers = parseCaptureEnvelope(markerCapture, { expectedKind: "markers" });
  const livenessCaptureParsed = parseCaptureEnvelope(livenessCapture, { expectedKind: "liveness" });
  const captures = [databases, markers, livenessCaptureParsed];
  const incompleteCapture = captures.find((capture) => capture.status !== "measured");
  if (incompleteCapture) {
    return { status: "insufficient-data", counts: emptyCounts(), clean: false, databases: [], staleMarkerRows: [], malformedLines: [], insufficientReason: incompleteCapture.insufficientReason };
  }
  if (new Set(captures.map((capture) => capture.cluster)).size !== 1) {
    return { status: "insufficient-data", counts: emptyCounts(), clean: false, databases: [], staleMarkerRows: [], malformedLines: [], insufficientReason: "cluster-mismatch" };
  }
  const parsedDatabases = parseDatabaseRows(databases.bodyLines);
  const parsedLiveness = parseLivenessRows(livenessCaptureParsed.bodyLines);
  const uniqueRows = [...new Map(parsedDatabases.rows.map((row) => [row.datname, row])).values()];
  const rows = uniqueRows.map((row) => ({ ...row, classification: classifyDatabase(row.datname), technicalEligibility: classifyReclaimability(row, { liveness: parsedLiveness.liveness }) }));
  const counts = emptyCounts();
  for (const row of rows) {
    if (row.classification === "test") counts.test += 1;
    else if (row.classification === "schema-template") counts.schemaTemplate += 1;
    else if (row.classification === "golden-template") counts.goldenTemplate += 1;
    else if (row.classification === "pool") counts.pool += 1;
  }
  const parsedMarkers = parseMarkerRows(markers.bodyLines);
  const names = new Set(rows.map((row) => row.datname));
  const staleMarkerRows = parsedMarkers.rows.filter((row) => !names.has(row.name));
  return {
    status: "measured",
    counts,
    // FNXC:PgClusterHygiene 2026-08-20-00:00: A populated row with an unexpected
    // shape (notably PostgreSQL's un-normalized true/false boolean) cannot become
    // clean evidence merely because it was excluded from the class counters.
    clean: Object.values(counts).every((count) => count === 0)
      && parsedDatabases.malformedLines.length === 0
      && parsedMarkers.malformedLines.length === 0
      && parsedLiveness.malformedLines.length === 0
      && staleMarkerRows.length === 0,
    databases: rows,
    staleMarkerRows,
    malformedLines: [...parsedDatabases.malformedLines, ...parsedMarkers.malformedLines, ...parsedLiveness.malformedLines],
    insufficientReason: null,
  };
}

function emptyCounts() {
  return { test: 0, schemaTemplate: 0, goldenTemplate: 0, pool: 0 };
}

function parseArgs(args) {
  const result = { databases: undefined, markers: undefined, liveness: undefined, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--databases") result.databases = args[++index];
    else if (argument === "--markers") result.markers = args[++index];
    else if (argument === "--liveness") result.liveness = args[++index];
    else if (argument === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.databases) throw new Error("Supply --databases <capture>");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const report = buildHygieneReport({
    databaseCapture: readFileSync(args.databases, "utf8"),
    markerCapture: args.markers ? readFileSync(args.markers, "utf8") : undefined,
    livenessCapture: args.liveness ? readFileSync(args.liveness, "utf8") : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.clean) process.exitCode = 1;
}
