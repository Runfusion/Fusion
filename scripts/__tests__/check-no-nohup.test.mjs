import test from "node:test";
import assert from "node:assert/strict";

const checkerModule = await import(["..", "/check-no-no", "hup", ".mjs"].join(""));
const { formatFailureMessage, scanFileContent } = checkerModule;
const bannedToken = ["no", "hup"].join("");

test("scanFileContent reports banned token matches", () => {
  const source = `pnpm ${bannedToken} dev`;
  const matches = scanFileContent(source, "scripts/example.mjs");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].lineNumber, 1);
  assert.match(matches[0].line, new RegExp(bannedToken));
});

test("scanFileContent ignores allowlisted lines", () => {
  const source = `// process-supervisor-allowlist: ${bannedToken} mention is explanatory only`;
  const matches = scanFileContent(source, "scripts/example.mjs");
  assert.equal(matches.length, 0);
});

test("formatFailureMessage points callers at superviseSpawn", () => {
  const message = formatFailureMessage([
    { filePath: "scripts/example.mjs", lineNumber: 3, line: `pnpm ${bannedToken} dev` },
  ]);
  assert.match(message, /superviseSpawn/);
  assert.match(message, /scripts\/example\.mjs:3/);
});
