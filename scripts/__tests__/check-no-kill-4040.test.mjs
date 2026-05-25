// port-4040-allowlist: test fixtures intentionally include the rule itself
import test from "node:test";
import assert from "node:assert/strict";
import { formatFailureMessage, scanFileContent } from "../check-no-kill-4040.mjs";

test("scanFileContent flags `kill ... 4040`", () => {
  const matches = scanFileContent("lsof -ti:4040 | xargs kill -9\n", "x.sh");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].lineNumber, 1);
});

test("scanFileContent flags pkill targeting 4040", () => {
  const matches = scanFileContent("pkill -f 'port 4040'\n", "x.sh");
  assert.equal(matches.length, 1);
});

test("scanFileContent flags fuser -k :4040", () => {
  const matches = scanFileContent("fuser -k 4040/tcp\n", "x.sh");
  assert.equal(matches.length, 1);
});

test("scanFileContent flags `.listen(4040)` bindings", () => {
  const matches = scanFileContent("app.listen(4040)\n", "x.test.ts");
  assert.equal(matches.length, 1);
});

test("scanFileContent ignores files containing the allowlist marker", () => {
  const src = "// port-4040-allowlist\nlsof -ti:4040 | xargs kill\n";
  const matches = scanFileContent(src, "docs.md");
  assert.equal(matches.length, 0);
});

test("scanFileContent ignores benign 4040 mentions (URLs, configs)", () => {
  const src = [
    "const url = 'http://localhost:4040';",
    "port: 4040,",
    "expect(node.port).toBe(4040);",
  ].join("\n");
  const matches = scanFileContent(src, "x.test.ts");
  assert.equal(matches.length, 0);
});

test("formatFailureMessage cites file and line and points at remediation", () => {
  const msg = formatFailureMessage([
    { filePath: "tests/x.sh", lineNumber: 3, line: "kill $(lsof -ti:4040)" },
  ]);
  assert.match(msg, /tests\/x\.sh:3/);
  assert.match(msg, /--port 0/);
});
