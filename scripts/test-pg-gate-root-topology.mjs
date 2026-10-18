#!/usr/bin/env node
/*
FNXC:PgGateRootTopology 2026-10-18-00:35:
FN-9563 requires a production-shaped reproducer for the concurrent root merge
 gate, not an isolated PostgreSQL invocation. This driver launches the exact
root `test:gate` command with the bounded observer enabled and refuses success
unless global preflight completes and both real canaries report their transactional bodies.
*/

import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, "..");
export const CANARY_FILES = [
  "src/__tests__/postgres/handoff-to-review-atomicity.pg.test.ts",
  "src/__tests__/postgres/task-lifecycle-e2e.pg.test.ts",
];

/** Parse bounded observer JSONL without accepting malformed evidence rows. */
export function parseBoundaryRecords(content) {
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error("not an object");
      }
      return record;
    } catch (error) {
      throw new Error(`invalid PostgreSQL boundary record at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function isResolvedTerminal(record, boundary, phase) {
  return record.kind === "terminal"
    && record.outcome === "resolved"
    && record.boundary === boundary
    && record.phase === phase;
}

/**
 * Validate the evidence emitted by the real root gate. Record ordering is the
 * append order, so a worker cannot claim it consumed readiness published later.
 */
export function assertRootGateTopology(records) {
  const preflightIndex = records.findIndex((record) =>
    !record.testFile && isResolvedTerminal(record, "setup", "template.ensure-golden"),
  );
  if (preflightIndex < 0) {
    throw new Error("root gate did not publish a successful global PostgreSQL golden-template preflight");
  }

  const breaches = records.filter((record) => record.kind === "breach" || record.kind === "watchdog");
  if (breaches.length > 0) {
    throw new Error(`root gate recorded ${breaches.length} PostgreSQL setup boundary breach${breaches.length === 1 ? "" : "es"}`);
  }

  for (const testFile of CANARY_FILES) {
    const canarySetupIndex = records.findIndex((record, index) =>
      index > preflightIndex
      && record.testFile === testFile
      && isResolvedTerminal(record, "setup", "template.ensure-golden"),
    );
    if (canarySetupIndex < 0) {
      throw new Error(`root gate did not consume golden-template readiness after preflight for ${testFile}`);
    }

    const canaryBodyIndex = records.findIndex((record, index) =>
      index > canarySetupIndex
      && record.testFile === testFile
      && isResolvedTerminal(record, "body", "shared.body"),
    );
    if (canaryBodyIndex < 0) {
      throw new Error(`root gate did not record a transactional canary body after setup for ${testFile}`);
    }
  }
}

/** The real PG reporter must confirm all ten transactional canary examples. */
export function assertRootGateOutput(output) {
  const plainOutput = stripVTControlCharacters(output);
  if (!/Test Files[\s\S]*2[\s\S]*passed/.test(plainOutput) || !/Tests[\s\S]*10[\s\S]*passed/.test(plainOutput)) {
    throw new Error("root gate did not report both real PostgreSQL canaries and their ten transactional examples");
  }
}

export function rootGateCommand() {
  return { command: "pnpm", args: ["test:gate"] };
}

export function runRootGate({ evidencePath, root = repoRoot, spawnImpl = spawn, env = process.env } = {}) {
  if (typeof evidencePath !== "string" || evidencePath.trim().length === 0) {
    return Promise.reject(new Error("an absolute --evidence path is required for root gate boundary records"));
  }
  const resolvedEvidencePath = resolve(root, evidencePath);
  rmSync(resolvedEvidencePath, { force: true });
  const { command, args } = rootGateCommand();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnImpl(command, args, {
      cwd: root,
      env: {
        ...env,
        FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER: "1",
        FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_LOG: resolvedEvidencePath,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const forward = (chunk, destination) => {
      const text = String(chunk);
      output += text;
      destination.write(text);
    };
    child.stdout?.on("data", (chunk) => forward(chunk, process.stdout));
    child.stderr?.on("data", (chunk) => forward(chunk, process.stderr));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal) {
        rejectRun(new Error(`root merge gate failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
        return;
      }
      try {
        const records = parseBoundaryRecords(readFileSync(resolvedEvidencePath, "utf8"));
        assertRootGateTopology(records);
        assertRootGateOutput(output);
        resolveRun(records);
      } catch (error) {
        rejectRun(error);
      }
    });
  });
}

function readEvidenceArgument(args) {
  const position = args.indexOf("--evidence");
  return position >= 0 ? args[position + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const evidencePath = readEvidenceArgument(process.argv.slice(2));
  if (!evidencePath) {
    console.error("Usage: node scripts/test-pg-gate-root-topology.mjs --evidence <absolute-path>");
    process.exitCode = 1;
  } else {
    const records = await runRootGate({ evidencePath });
    console.log(`[pg-gate-root-topology] verified ${records.length} boundary records`);
  }
}
