#!/usr/bin/env node
/**
 * Run the engine-slow tier (plan U2 / R8) and assert it executed a non-empty
 * set of tests. The engine-slow vitest project (src/**-/*.slow.test.ts globs)
 * previously ran in NO automated gate — only via the root `test:full` locally.
 * If a config/glob drift ever silently empties the project, a plain
 * `vitest run` exits 0 ("no tests" is not a failure by default), so the gate
 * would pass while running nothing. This wrapper makes zero-execution a hard
 * failure.
 *
 * stdlib only. Runs vitest with the json reporter, parses numTotalTests.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineDir = resolve(__dirname, "..", "packages", "engine");
const outputFile = join(engineDir, ".engine-slow-results.json");

if (existsSync(outputFile)) rmSync(outputFile, { force: true });

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--project=engine-slow",
    "--silent=passed-only",
    "--reporter=dot",
    "--reporter=json",
    `--outputFile=${outputFile}`,
  ],
  { cwd: engineDir, stdio: "inherit", env: { ...process.env } },
);

if (result.error) {
  console.error(`✗ failed to run engine-slow: ${result.error.message}`);
  process.exit(1);
}

if (!existsSync(outputFile)) {
  console.error("✗ engine-slow produced no JSON results file; cannot assert execution");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(outputFile, "utf8"));
} catch (err) {
  console.error(`✗ could not parse engine-slow results: ${err.message}`);
  process.exit(1);
}
rmSync(outputFile, { force: true });

const numTotal =
  typeof report.numTotalTests === "number"
    ? report.numTotalTests
    : (report.testResults || []).reduce(
        (sum, file) => sum + (file.assertionResults?.length || 0),
        0,
      );

if (numTotal === 0) {
  console.error(
    "✗ engine-slow executed 0 tests — the slow tier is silently empty (glob/config drift?). Failing the gate.",
  );
  process.exit(1);
}

// Vitest's own exit code already reflects pass/fail; mirror it.
if (result.status !== 0) {
  console.error(`✗ engine-slow ran ${numTotal} test(s) but reported failures (exit ${result.status}).`);
  process.exit(result.status);
}

console.log(`✓ engine-slow executed ${numTotal} test(s) and passed.`);
