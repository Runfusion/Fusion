import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:EngineTests 2026-07-31-05:20:
Ratchet for the recurring incomplete-logger-mock failure class.

THE CLASS. `createLogger` returns four methods — `log`, `debug`, `warn`, `error` (logger.ts:20-27).
A test that mocks `../logger.js` with only three throws "<log>.debug is not a function" on the FIRST
demoted call, which fails EVERY case in that file for a reason unrelated to what any of them assert.
It has now happened 31 times: 27 files in one sweep, then notification-service (26 cases) and
child-process-worker (12) missed by that sweep, then ipc-host and ipc-worker found latent.

WHY A SOURCE SCAN RATHER THAN A RUNTIME CHECK. The gap only bites when a demoted line is actually
reached, so a mock can sit incomplete and green for months — ipc-host and ipc-worker were exactly
that: 56 passing tests with a three-method mock. Nothing at runtime can fail on a call that does not
happen yet, so the guard has to read the source.

DELIBERATELY NARROW. Only object literals that already look like a logger (`log: vi.fn()` plus
`warn:` and `error:`) are checked, so an unrelated `{ log: ... }` shape is not dragged in. A file that
mocks the logger some other way is not policed here — this pins the copy-paste shape that actually
recurred, not every conceivable mock.
*/

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const REQUIRED_METHODS = ["log", "debug", "warn", "error"] as const;

/** Engine test files that mock the logger module, via git so untracked scratch files are ignored. */
function loggerMockingTestFiles(): string[] {
  const out = execFileSync(
    "git",
    ["grep", "-lE", String.raw`vi\.mock\("\.\.?(/\.\.)*/logger\.js"`, "--", "packages/engine/src"],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  );
  return out.split("\n").filter((line) => line.endsWith(".test.ts"));
}

/** Object literals shaped like a logger mock, extracted from one file's source. */
function loggerShapedLiterals(source: string): string[] {
  return [...source.matchAll(/\{[^{}]*\blog:\s*vi\.fn\(\)[^{}]*\}/g)]
    .map((match) => match[0])
    .filter((body) => body.includes("warn:") && body.includes("error:"));
}

describe("engine logger mocks are complete", () => {
  it("finds the logger-mocking test files at all (the scan itself must not silently match nothing)", () => {
    // Without this, deleting the pattern or moving the files turns the ratchet below into a no-op
    // that reports success while checking nothing.
    expect(loggerMockingTestFiles().length).toBeGreaterThan(20);
  });

  it("every logger-shaped mock declares all four methods of the real logger surface", () => {
    const gaps: string[] = [];

    for (const file of loggerMockingTestFiles()) {
      const source = readFileSync(join(REPO_ROOT, file), "utf-8");
      for (const body of loggerShapedLiterals(source)) {
        const missing = REQUIRED_METHODS.filter((method) => !new RegExp(String.raw`\b${method}\s*:`).test(body));
        if (missing.length > 0) {
          gaps.push(`${relative("packages/engine", file)}: logger mock missing ${missing.join(", ")}`);
        }
      }
    }

    expect(
      gaps,
      `Incomplete logger mocks — each throws "<log>.<method> is not a function" on the first call to `
      + `the missing channel, failing every case in the file:\n${gaps.join("\n")}`,
    ).toEqual([]);
  });
});
