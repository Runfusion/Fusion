import test from "node:test";
import assert from "node:assert/strict";
import {
  CANARY_FILES,
  assertRootGateOutput,
  assertRootGateTopology,
  parseBoundaryRecords,
  rootGateCommand,
} from "../test-pg-gate-root-topology.mjs";

function terminal({ testFile, boundary, phase }) {
  return {
    timestamp: "2026-10-18T00:00:00.000Z",
    kind: "terminal",
    outcome: "resolved",
    boundary,
    phase,
    ...(testFile ? { testFile } : {}),
  };
}

function healthyRecords() {
  return [
    terminal({ boundary: "setup", phase: "template.ensure-golden" }),
    ...CANARY_FILES.flatMap((testFile) => [
      terminal({ testFile, boundary: "setup", phase: "template.ensure-golden" }),
      terminal({ testFile, boundary: "body", phase: "shared.body" }),
    ]),
  ];
}

test("root PostgreSQL topology driver runs the production merge-gate composition", () => {
  assert.deepEqual(rootGateCommand(), { command: "pnpm", args: ["test:gate"] });
});

test("root PostgreSQL topology driver requires successful preflight and real canary output", () => {
  assert.doesNotThrow(() => assertRootGateTopology(healthyRecords()));
  assert.doesNotThrow(() => assertRootGateOutput("Test Files 2 passed (2)\nTests 10 passed"));
  assert.throws(() => assertRootGateOutput("Test Files 2 passed (2)\nTests 9 passed"), /ten transactional examples/);
});

test("root PostgreSQL topology driver fails closed on timeout evidence", () => {
  const breached = [
    ...healthyRecords(),
    { kind: "breach", boundary: "setup", phase: "database.clone" },
  ];
  assert.throws(() => assertRootGateTopology(breached), /boundary breach/);
});

test("root PostgreSQL topology driver requires both canaries to consume readiness and execute bodies", () => {
  const missingSetup = healthyRecords().filter((record) => record.testFile !== CANARY_FILES[0] || record.phase !== "template.ensure-golden");
  assert.throws(() => assertRootGateTopology(missingSetup), /did not consume golden-template readiness/);

  const missingBody = healthyRecords().filter((record) => record.testFile !== CANARY_FILES[1] || record.phase !== "shared.body");
  assert.throws(() => assertRootGateTopology(missingBody), /did not record a transactional canary body/);
});

test("root PostgreSQL topology driver rejects malformed observer JSONL", () => {
  const records = healthyRecords();
  assert.deepEqual(parseBoundaryRecords(records.map((record) => JSON.stringify(record)).join("\n")), records);
  assert.throws(() => parseBoundaryRecords('{"kind":"terminal"}\nnot-json'), /line 2/);
});
