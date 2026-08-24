import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";
import {
  buildHygieneReport,
  classifyDatabase,
  classifyReclaimability,
  parseCaptureEnvelope,
  parseTemplateOwnerPid,
} from "../pg-cluster-hygiene-report.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/pg-cluster-hygiene-report/${name}`, import.meta.url), "utf8");
const captureForKind = (capture, kind) => capture
  .replace("# kind: databases", `# kind: ${kind}`)
  .replace("# query: leftover-v1", `# query: ${kind === "markers" ? "markers-v1" : "liveness-v1"}`);
const measuredZero = fixture("post-state.txt");
const zeroMarkers = captureForKind(measuredZero, "markers");
const zeroLiveness = captureForKind(measuredZero, "liveness");
const report = (databaseName, options = {}) => buildHygieneReport({
  databaseCapture: fixture(databaseName),
  markerCapture: zeroMarkers,
  livenessCapture: zeroLiveness,
  ...options,
});

test("reports the named dead-owner golden template as technically reclaimable, never approved", () => {
  const preState = report("pre-state.txt", { livenessCapture: fixture("liveness-dead.txt") });
  assert.equal(preState.status, "measured");
  assert.equal(preState.counts.goldenTemplate, 1);
  assert.equal(preState.clean, false);
  assert.equal(preState.databases[0].technicalEligibility, "reclaimable-dead-owner");
  assert.equal("approval" in preState, false);
  assert.equal("authorization" in preState, false);
  assert.equal("safeToDrop" in preState, false);

  assert.equal(report("pre-state.txt", { livenessCapture: fixture("liveness-alive.txt") }).databases[0].technicalEligibility, "retain-live-owner");
  assert.equal(report("pre-state.txt", { livenessCapture: fixture("liveness-absent.txt") }).databases[0].technicalEligibility, "retain-unclassified");
  assert.equal(report("pre-state.txt").databases[0].technicalEligibility, "retain-unclassified");
});

test("recognizes three same-cluster well-formed zeros as measured clean evidence", () => {
  const postState = report("post-state.txt");
  assert.equal(postState.status, "measured");
  assert.deepEqual(postState.counts, { test: 0, schemaTemplate: 0, goldenTemplate: 0, pool: 0 });
  assert.equal(postState.clean, true);
});

test("rejects every missing or incomplete database capture rather than manufacturing a zero", () => {
  const expected = new Map([
    [undefined, "missing"],
    [fixture("empty.txt"), "empty"],
    [fixture("no-banner.txt"), "no-banner"],
    [fixture("truncated.txt"), "truncated"],
    [fixture("count-mismatch.txt"), "count-mismatch"],
  ]);
  for (const [capture, reason] of expected) {
    const parsed = parseCaptureEnvelope(capture, { expectedKind: "databases" });
    assert.equal(parsed.status, "insufficient-data");
    assert.equal(parsed.insufficientReason, reason);
    const value = buildHygieneReport({ databaseCapture: capture });
    assert.equal(value.status, "insufficient-data");
    assert.equal(value.clean, false);
  }
});

/*
FNXC:PgClusterHygiene 2026-08-20-00:54:
FN-9154 G1 treats every supplied companion as required evidence. A measured-zero
primary capture must fail closed for malformed or wrong-kind marker and liveness
inputs, rather than treating an unread companion as proof of a clean cluster.
*/
test("fails closed when any supplied companion envelope is malformed", () => {
  const failures = [
    [fixture("empty.txt"), "empty"],
    [fixture("no-banner.txt"), "no-banner"],
    [fixture("truncated.txt"), "truncated"],
    [fixture("count-mismatch.txt"), "count-mismatch"],
    [measuredZero, "kind-mismatch"],
  ];

  for (const [capture, reason] of failures) {
    for (const [option, kind] of [["markerCapture", "markers"], ["livenessCapture", "liveness"]]) {
      const companionCapture = reason === "kind-mismatch" ? capture : captureForKind(capture, kind);
      const value = report("post-state.txt", { [option]: companionCapture });
      assert.equal(value.status, "insufficient-data", `${option} ${reason} status`);
      assert.equal(value.clean, false, `${option} ${reason} clean`);
      assert.equal(value.insufficientReason, reason, `${option} ${reason} propagation`);
    }
  }

  const badHeader = captureForKind(measuredZero, "markers").replace("# captured_at: 2026-08-19T18:18:00Z", "# captured_at: not-a-date");
  assert.equal(report("post-state.txt", { markerCapture: badHeader }).insufficientReason, "bad-header");
  const wrongQuery = measuredZero.replace("# query: leftover-v1", "# query: unknown-v1");
  assert.equal(parseCaptureEnvelope(wrongQuery, { expectedKind: "databases" }).insufficientReason, "bad-header");

  const bothBroken = report("post-state.txt", { markerCapture: fixture("empty.txt"), livenessCapture: fixture("truncated.txt") });
  assert.equal(bothBroken.status, "insufficient-data");
  assert.equal(bothBroken.clean, false);
  assert.equal(bothBroken.insufficientReason, "empty");
});

/*
FNXC:PgClusterHygiene 2026-08-20-01:41:
FN-9154 G1 permits a clean Path A/C/D verdict only when database, marker, and
liveness captures all measure the same cluster; omission or mixed provenance is
insufficient evidence even when every supplied body is empty.
*/
test("requires all three measured captures from the same cluster", () => {
  for (const captures of [
    { databaseCapture: measuredZero },
    { databaseCapture: measuredZero, markerCapture: zeroMarkers },
  ]) {
    const value = buildHygieneReport(captures);
    assert.equal(value.status, "insufficient-data");
    assert.equal(value.clean, false);
    assert.equal(value.insufficientReason, "missing");
  }

  for (const option of ["markerCapture", "livenessCapture"]) {
    const value = report("post-state.txt", {
      [option]: (option === "markerCapture" ? zeroMarkers : zeroLiveness)
        .replace("# cluster: 5432|PostgreSQL 16.0|postgres", "# cluster: 6543|PostgreSQL 17.0|postgres"),
    });
    assert.equal(value.status, "insufficient-data");
    assert.equal(value.clean, false);
    assert.equal(value.insufficientReason, "cluster-mismatch");
  }
});

/*
FNXC:PgClusterHygiene 2026-08-19-21:49:
FN-9154's campaign hygiene invariant excludes non-campaign databases even when
an over-matching capture query sees them. Keep representative host families in
the fixture so the advisory report cannot propose them for reclamation.
*/
test("counts distinct campaign names, retains live/in-use rows, and ignores unrelated families", () => {
  const value = report("mixed.txt", { livenessCapture: `# fusion-hygiene-capture v1\n# kind: liveness\n# cluster: 5432|PostgreSQL 16.0|postgres\n# captured_at: 2026-08-19T18:18:00Z\n# query: liveness-v1\n# rows: 1\n22|alive\n# end\n` });
  assert.deepEqual(value.counts, { test: 1, schemaTemplate: 1, goldenTemplate: 0, pool: 1 });
  assert.equal(value.databases.find((row) => row.datname === "fusion_test_one").technicalEligibility, "retain-in-use");
  assert.equal(value.databases.find((row) => row.datname === "fusion_schema_template_22_nonce").technicalEligibility, "retain-live-owner");
  for (const name of ["archive_live_fence_1", "ce_pipeline_pg_1", "fn-extension-1", "custom_prefix_1", "autotrade", "eclipxe"]) {
    assert.equal(value.databases.find((row) => row.datname === name).classification, "unrelated");
  }
  assert.equal(value.databases.filter((row) => row.datname === "fusion_pool_one").length, 1);
});

test("retains malformed body evidence while classifying valid rows and stale markers", () => {
  const malformed = report("malformed.txt");
  assert.equal(malformed.counts.test, 1);
  // `psql -qAt` emits true/false unless the documented query normalizes to t/f.
  assert.equal(malformed.malformedLines.length, 3);
  const unnormalizedOnly = fixture("post-state.txt")
    .replace("# rows: 0", "# rows: 1")
    .replace("# end", "fusion_schema_template_99_goldenrun|eclipxe|false|0\n# end");
  const unnormalizedReport = buildHygieneReport({ databaseCapture: unnormalizedOnly, markerCapture: zeroMarkers, livenessCapture: zeroLiveness });
  assert.equal(unnormalizedReport.counts.goldenTemplate, 0);
  assert.equal(unnormalizedReport.clean, false);
  const markers = report("post-state.txt", { markerCapture: fixture("markers-stale.txt") });
  assert.equal(markers.staleMarkerRows[0].name, "fusion_schema_template_39001_goldenestworkerspnnem8");
  assert.equal(markers.clean, false);
});

test("matches the harness template naming grammar", () => {
  assert.equal(classifyDatabase("fusion_schema_template_39001_goldenestworkerspnnem8"), "golden-template");
  assert.equal(parseTemplateOwnerPid("fusion_schema_template_39001_goldenestworkerspnnem8"), 39001);
  assert.equal(classifyDatabase("fusion_schema_template_22_nonce"), "schema-template");
  assert.equal(parseTemplateOwnerPid("fusion_schema_template_22_nonce"), 22);
  assert.equal(parseTemplateOwnerPid("fusion_schema_template_not-a-pid"), null);
  assert.equal(classifyReclaimability({ datname: "archive_live_fence_1", conns: 0 }, { liveness: new Map() }), "retain-unclassified");
});
