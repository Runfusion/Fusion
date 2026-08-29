import test from "node:test";
import assert from "node:assert/strict";
import { formatFailureMessage, scanFileContent } from "../check-no-test-timeout-appeasement.mjs";

const emptyAllowlist = { allowlistEntries: [] };

test("scanFileContent reports vi.setConfig testTimeout bumps", () => {
  const source = ["import { vi } from 'vitest';", "vi.setConfig({ testTimeout: 30000 });"].join("\n");
  const matches = scanFileContent(source, "packages/x/src/a.test.ts", emptyAllowlist);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].lineNumber, 2);
  assert.match(matches[0].line, /testTimeout/);
});

test("scanFileContent reports hookTimeout bumps", () => {
  const matches = scanFileContent("vi.setConfig({ hookTimeout: 30000 });", "packages/x/src/a.test.ts", emptyAllowlist);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].lineNumber, 1);
  assert.match(matches[0].line, /hookTimeout/);
});

test("scanFileContent ignores allowlisted files with a rationale", () => {
  const matches = scanFileContent("vi.setConfig({ testTimeout: 30000 });", "packages/x/src/a.test.ts", {
    allowlistEntries: [
      {
        file: "packages/x/src/a.test.ts",
        reason: "legacy timeout pending FN-0000 removal",
      },
    ],
  });
  assert.equal(matches.length, 0);
});

test("scanFileContent ignores global vitest config timeouts and non-test paths", () => {
  const configMatches = scanFileContent("testTimeout: 30_000,", "packages/x/vitest.config.ts", emptyAllowlist);
  const sourceMatches = scanFileContent("testTimeout: 30_000,", "packages/x/src/config.ts", emptyAllowlist);
  assert.equal(configMatches.length, 0);
  assert.equal(sourceMatches.length, 0);
});

test("formatFailureMessage cites file, line, quarantine remediation, and allowlist", () => {
  const message = formatFailureMessage([
    { filePath: "packages/x/src/a.test.ts", lineNumber: 3, line: "vi.setConfig({ testTimeout: 30000 });" },
  ]);
  assert.match(message, /packages\/x\/src\/a\.test\.ts:3/);
  assert.match(message, /scripts\/lib\/test-quarantine\.json/);
  assert.match(message, /Do Not Add Slow Tests/);
  assert.match(message, /scripts\/lib\/test-timeout-appeasement-allowlist\.json/);
});
