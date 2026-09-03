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

function githubSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function readActiveRecordSections(register) {
  const activeSection = register.match(/^## Active observation records\n([\s\S]*?)(?=^## (?!#)|(?![\s\S]))/m);
  assert.ok(activeSection, "Expected an Active observation records section");
  return [...activeSection[1].matchAll(/^### (\d+\. .+)\n([\s\S]*?)(?=^### |(?![\s\S]))/gm)].map(
    ([, heading, body]) => ({ heading, body }),
  );
}

function readActiveEntries(register) {
  return readActiveRecordSections(register).map(({ heading, body }) => {
    const status = body.match(/^- \*\*Status:\*\* (.+)$/m)?.[1];
    assert.ok(status, `Expected active record ${heading} to have a status line`);
    return { heading, status };
  });
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

/*
FNXC:TestFlakeRegister 2026-08-19-12:04:
FN-9146 requires the register's active statuses to name the current evidence owner after a completed campaign. Enforce the stated count, retained observation state, ownership, and inbound testing-guide anchors so that decision surface cannot silently drift.

FNXC:TestFlakeRegister 2026-08-30-04:25:
A closed record may stay PHYSICALLY inside the active section when later evidence still cross-references it: entry 7 was closed on 2026-08-23 after its file was quarantined, but the FN-9146 campaign-evidence assertion below reads its per-run table in place, so relocating it to the archive would destroy that coverage. The stated introduction count describes ACTIVE records only, so closed-status entries are excluded here rather than moved. Counting raw sections instead made the two disagree the moment entry 7 closed and left main red. Drift protection is unchanged: the pinned list below still fixes every active heading and its exact status text.
*/
/*
FNXC:TestFlakeRegister 2026-09-03-22:23:
The register now records that evidence owner FN-9146 was archived on 2026-09-03 without a named
successor, so active records 1 and 2 are unowned pending their next sighting. The pinned status
texts below track that archived-owner annotation; do not strip it without re-homing the records.
*/
test("observed-flake register active count, escalation state, and owners stay synchronized", () => {
  const register = readFileSync(registerPath, "utf8");
  const statedCount = register.match(/\*\*(\d+) active observation records\*\*/);
  assert.ok(statedCount, "Expected the register introduction to state the active observation count");

  const activeEntries = readActiveEntries(register).filter(({ status }) => !/^Closed\b/.test(status));
  assert.equal(
    activeEntries.length,
    Number(statedCount[1]),
    `Register states ${statedCount[1]} active observation records but contains ${activeEntries.length}`,
  );

  assert.deepEqual(activeEntries, [
    {
      heading: "1. Project identity returns no stored identity",
      status: "Active reproduced-but-unattributed observation — evidence owner FN-9146 (archived 2026-09-03; record unowned pending next sighting).",
    },
    {
      heading: "2. Schema applier retains registered dependents",
      status: "Active first sighting — evidence owner FN-9146 (archived 2026-09-03; record unowned pending next sighting).",
    },
    {
      heading: "13. Handoff-to-review atomicity PostgreSQL setup hook",
      status: "Active first sighting — recorded 2026-08-23, unattributed.",
    },
    {
      heading: "14. Merge-node paused-abort retry sequence",
      status: "Quarantined 2026-08-29 after a second sequence-only sighting.",
    },
  ]);
});

/*
FNXC:TestFlakeRegister 2026-08-19-12:25:
FN-9146's three records require independent, in-place campaign evidence. Subject-containing runs must retain measured backend peaks; configured lanes that do not select a subject may explicitly report no sample.
*/
test("FN-9146 campaign evidence remains complete within every owned active record", () => {
  const register = readFileSync(registerPath, "utf8");
  const records = new Map(readActiveRecordSections(register).map(({ heading, body }) => [heading, body]));
  const runIds = ["A01", "A02", "A03", "A04", "B01", "B02", "B03", "C01", "C02", "C03", "D01", "D02"];
  const passedSelectedRuns = new Map(runIds.map((runId) => [runId, runId.startsWith("D") ? "not selected" : "pass"]));
  const expectedSubjectResults = new Map([
    [
      "1. Project identity returns no stored identity",
      new Map([...passedSelectedRuns, ["A02", "**captured: 15s timeout**"], ["A03", "**captured: 15s timeout**"], ["A04", "**captured: 15s timeout**"]]),
    ],
    ["2. Schema applier retains registered dependents", passedSelectedRuns],
    [
      "7. Mission store PostgreSQL teardown hook",
      new Map([...passedSelectedRuns, ["A02", "not reached: `beforeAll` timeout (not registered `afterAll`)"]]),
    ],
  ]);

  for (const [heading, specialResults] of expectedSubjectResults) {
    const body = records.get(heading);
    assert.ok(body, `Missing FN-9146 active record: ${heading}`);
    assert.match(body, /\*\*Campaign outcome 2026-08-19 \(FN-9146\):\*\*/);
    assert.match(
      body,
      /\| run \| shape \/ workers \| wall \| subject result \| whole-lane result \| cluster capacity \(`max`\/ordinary; peak\) \|/,
      `${heading} must retain the per-run FN-9146 evidence columns`,
    );

    for (const runId of runIds) {
      const replacementSuffix = runId.startsWith("C") ? ` / ${runId}R` : "";
      assert.match(
        body,
        new RegExp(`^\\| ${runId}${replacementSuffix} \\|`, "m"),
        `${heading} is missing run ${runId}`,
      );
    }
    assert.equal(
      [...body.matchAll(/^\| (?:A0[1-4]|B0[1-3]|C0[1-3] \/ C0[1-3]R|D0[1-2]) \|/gm)].length,
      runIds.length,
      `${heading} must retain exactly one FN-9146 row for every pre-registered run`,
    );
    assert.match(body, /\| A01 \| directory \/ 27 \| 235\.8s \|/);
    assert.match(body, /\| D02 \| configured pg gate \/ 4 forks \| 3\.7s \|/);
    assert.match(body, /\| A01 \|[^\n]*\| 100\/97; 73 \|/);
    assert.match(body, /\| C01 \/ C01R \|[^\n]*\| 100\/97; 28 \(583 samples\) \|/);
    assert.match(body, /\| C02 \/ C02R \|[^\n]*\| 100\/97; 31 \(491 samples\) \|/);
    assert.match(body, /\| C03 \/ C03R \|[^\n]*\| 100\/97; 30 \(508 samples\) \|/);
    assert.doesNotMatch(body, /\| C0[1-3][^\n]*\| 100\/97; not sampled \|/);
    for (const [runId, result] of specialResults) {
      const replacementSuffix = runId.startsWith("C") ? `(?: / ${runId}R)?` : "";
      assert.match(
        body,
        new RegExp(`^\\| ${runId}${replacementSuffix} \\|[^\\n]*\\| ${result.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`, "m"),
      );
    }
  }
});

test("testing-guide observed-flake anchors resolve to register headings", () => {
  const register = readFileSync(registerPath, "utf8");
  const testing = readFileSync(testingPath, "utf8");
  const registerAnchors = new Set(
    [...register.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) => githubSlug(heading)),
  );
  const inboundAnchors = [
    ...testing.matchAll(/suite-only-flakes-observed-register\.md#([^\s)]+)/g),
  ].map(([, anchor]) => anchor);

  assert.ok(inboundAnchors.length > 0, "Expected docs/testing.md to link a register anchor");
  for (const anchor of inboundAnchors) {
    assert.ok(registerAnchors.has(anchor), `Unresolvable observed-flake register anchor: ${anchor}`);
  }
});
