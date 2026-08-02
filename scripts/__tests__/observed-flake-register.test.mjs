/*
FNXC:TestFlakeRegister 2026-08-01-07:00:
Issue #2862 observed suite-only PostgreSQL-adjacent flakes in files with substantial remaining coverage, so the AGENTS.md first-sighting exception authorizes a record instead of a file-level quarantine. This test prevents dangling paths, suite-title drift, and silent removal of that narrow policy or its evidence requirements.
*/
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");
const registerRelativePath = "docs/solutions/test-failures/suite-only-flakes-observed-register.md";
const registerPath = resolve(rootDir, registerRelativePath);
const agentsPath = resolve(rootDir, "AGENTS.md");
const testingPath = resolve(rootDir, "docs/testing.md");

function readRegisterEntries(register) {
  const entries = [...register.matchAll(/- \*\*File:\*\* `([^`]+)`\n- \*\*Exact test:\*\* `([^`]+)`/g)].map(
    ([, file, fullName]) => ({ file, fullName }),
  );

  assert.ok(entries.length > 0, "Expected the observed-flake register to name at least one test");
  return entries;
}

test("observed-flake register frontmatter identifies test failures", () => {
  assert.ok(existsSync(registerPath), `Missing register: ${registerRelativePath}`);
  const register = readFileSync(registerPath, "utf8");
  const frontmatter = register.match(/^---\n([\s\S]*?)\n---/);

  assert.ok(frontmatter, "Expected YAML frontmatter in the observed-flake register");
  assert.match(frontmatter[1], /^category:\s*test-failures\s*$/m);
});

test("observed-flake register paths and every documented hierarchy segment remain valid", () => {
  const register = readFileSync(registerPath, "utf8");

  for (const { file, fullName } of readRegisterEntries(register)) {
    const subjectPath = resolve(rootDir, file);
    assert.ok(existsSync(subjectPath), `Registered test file no longer exists: ${file}`);

    const subject = readFileSync(subjectPath, "utf8");
    for (const segment of fullName.split(">").map((part) => part.trim())) {
      assert.ok(segment, `Empty suite hierarchy segment in ${fullName}`);
      assert.ok(subject.includes(segment), `Missing hierarchy segment "${segment}" in ${file}`);
    }
  }
});

test("testing guidance and the AGENTS.md exception retain record escalation evidence", () => {
  const testing = readFileSync(testingPath, "utf8");
  const agents = readFileSync(agentsPath, "utf8");
  const register = readFileSync(registerPath, "utf8");

  assert.ok(testing.includes(registerRelativePath), "docs/testing.md must link the observed-flake register");
  assert.ok(agents.includes("On a **first** sighting only"), "AGENTS.md must retain the first-sighting exception");
  assert.ok(agents.includes("A **second** sighting of the same test"), "AGENTS.md must retain second-sighting escalation");
  assert.ok(register.includes("A **second sighting**"), "Register must retain second-sighting escalation");
  assert.ok(register.includes("Capture **full runner output**"), "Register must retain full-output capture guidance");
});
