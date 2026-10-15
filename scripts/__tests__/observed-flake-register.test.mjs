/*
FNXC:TestFlakeRegister 2026-08-01-07:00:
Issue #2862 observed suite-only PostgreSQL-adjacent flakes in files with substantial remaining coverage, so the AGENTS.md first-sighting exception authorizes a record instead of a file-level quarantine. This test prevents dangling paths, suite-title drift, and silent removal of that narrow policy or its evidence requirements.
*/
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");
const registerRelativePath = "docs/solutions/test-failures/suite-only-flakes-observed-register.md";
const registerPath = resolve(rootDir, registerRelativePath);
const agentsPath = resolve(rootDir, "AGENTS.md");
const testingPath = resolve(rootDir, "docs/testing.md");

/*
FNXC:TestFlakeRegister 2026-09-08-11:38:
RUFU-197. The register is append-only history, so records accumulate in two document orders — some write
`Status` above `File`, some below — and an earlier parser that required `File` then `Exact test` on adjacent
lines silently skipped every record that deviated. Parsing is now per heading, so a record is read wherever its
lines sit. `status` stays null when a record has none: an undispositioned record is treated as live.

FNXC:MergeRebuild0919 2026-09-19-21:45:
Canonical rewrote the sibling reader to scope the `File`/`Exact test` scan to the `## Active observation records`
sections, so an archived record may keep citing a deleted ratchet file. This line solves the same problem per record
instead of per section: `evaluateRegisterRecords` below exempts `Closed`-status records from the exists/drift check and
requires an evidence pointer, while still drift-checking a closed record whose file survived. Two readers cannot
share one name with different return shapes, and the merged body has no call site for canonical's variant, so this
parser is the single entry reader; canonical's archived-path concern stays covered by the closed-record branch.
*/
function readRegisterRecords(register) {
  const records = [];
  let heading = null;
  let current = null;
  let pendingStatus = null;

  for (const line of register.split("\n")) {
    const headingMatch = line.match(/^#{2,3} (.+)$/);
    if (headingMatch) {
      heading = headingMatch[1];
      current = null;
      pendingStatus = null;
      continue;
    }
    const status = line.match(/^- \*\*Status:\*\* (.+)$/);
    if (status) {
      if (current && current.status === null) current.status = status[1];
      else pendingStatus = status[1];
      continue;
    }
    const file = line.match(/^- \*\*File:\*\* `([^`]+)`/);
    if (file) {
      current = { heading, file: file[1], status: pendingStatus, fullName: null };
      pendingStatus = null;
      records.push(current);
      continue;
    }
    if (!current) continue;
    const exact = line.match(/^- \*\*Exact test:\*\* `([^`]+)`/);
    if (exact && current.fullName === null) current.fullName = exact[1];
  }

  assert.ok(records.length > 0, "Expected the observed-flake register to name at least one test");
  return records;
}

/*
FNXC:TestFlakeRegister 2026-09-08-11:38:
RUFU-197. The same `^Closed` predicate the active-count assertion already used is now the single classifier for
whether a record still owns a live file. Deletion-ratchet commit 82c635384d retired two quarantined tests and
removed their files, ledger rows, and config excludes in one legitimate sweep, and this guard — the one AGENTS.md says must never be left red — went red for two weeks solely because it demanded that closed records'
subjects still exist. A closed record is historical evidence: it must retain an evidence pointer, not a live file.
*/
const CLOSED_RECORD = /^Closed\b/;
const isClosedRecord = (status) => CLOSED_RECORD.test(status ?? "");
const EVIDENCE_POINTER = /(?:\b(?:FN|RUFU)-\d+\b)|(?:\bPR #\d+\b)|(?:\b[0-9a-f]{7,40}\b)/;

/** Real-tree subject reader; the classifier fixtures inject an in-memory equivalent instead of touching disk. */
const realSubjectFs = {
  fileExists: (path) => existsSync(path),
  readSubject: (path) => readFileSync(path, "utf8"),
};

/**
 * Resolve every register record against `rootDir`. A live record must still name a real file whose documented
 * suite hierarchy is still present; a closed record is exempt from both, but must still point at the decision.
 * Subject reads go through `subjectFs` so the classifier's branches are assertable without a temp directory.
 */
function evaluateRegisterRecords(records, rootDir, subjectFs = realSubjectFs) {
  const violations = [];
  const live = [];
  const closed = [];

  for (const record of records) {
    const subjectPath = resolve(rootDir, record.file);

    if (isClosedRecord(record.status)) {
      closed.push(record);
      if (!EVIDENCE_POINTER.test(record.status)) {
        violations.push({ kind: "closed-record-without-evidence-pointer", heading: record.heading, file: record.file });
      }
      // A closed record whose subject survived is still worth checking, so retirement does not become a
      // blanket exemption that hides pointer drift in files that are very much still there.
      if (!subjectFs.fileExists(subjectPath) || !record.fullName) continue;
    } else {
      live.push(record);
      if (!subjectFs.fileExists(subjectPath)) {
        violations.push({ kind: "registered-file-missing", heading: record.heading, file: record.file });
        continue;
      }
      if (!record.fullName) continue;
    }

    const subject = subjectFs.readSubject(subjectPath);
    for (const segment of record.fullName.split(">").map((part) => part.trim())) {
      if (!segment) violations.push({ kind: "empty-hierarchy-segment", heading: record.heading, file: record.file });
      else if (!subject.includes(segment)) {
        violations.push({ kind: "missing-hierarchy-segment", heading: record.heading, file: record.file, segment });
      }
    }
  }

  return { violations, live, closed };
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
  const { violations, live, closed } = evaluateRegisterRecords(readRegisterRecords(register), rootDir);

  assert.deepEqual(violations, [], "Register records drifted from the tree they document");
  // Non-vacuous on both sides: a parser that classified everything closed would report zero work done.
  assert.ok(live.length >= 6, `Register resolved only ${live.length} live records; the parser is matching too little`);
  assert.ok(closed.length > 0, "Expected the register's closed-record classifier to match the archive sections");
});

/*
FNXC:TestFlakeRegister 2026-09-08-12:38:
RUFU-197. The live document proves the guard is currently green, which cannot show the two directions still
BITE. These fixtures point the same parser and classifier at an injected in-memory tree (no temp directory, no
disk writes): a missing file reddens a live record and must not redden the identical record once closed; a
drifted suite title still reddens a closed record whose file survived; and a closed record with no evidence
pointer reddens on its own. Every accepted citation format is asserted zero-violation, because an unproven
branch of the evidence-pointer alternation can be deleted without reddening anything else.
*/
test("register classifier reddens a missing live subject and exempts the same record once closed", () => {
  const fixtureRoot = "/register-fixture";
  const survivor = "src/survivor.test.ts";
  const survivorTitle = "keeps its documented title";
  const tree = new Map([[resolve(fixtureRoot, survivor), `test('${survivorTitle}', () => {});\n`]]);
  const injectedFs = {
    fileExists: (path) => tree.has(path),
    readSubject: (path) => tree.get(path),
  };

  const record = (statusLine, file, title) =>
    [`### Record for ${file}`, statusLine, `- **File:** \`${file}\``, `- **Exact test:** \`${title}\``].join("\n");

  const build = (records) =>
    evaluateRegisterRecords(readRegisterRecords(records.join("\n")), fixtureRoot, injectedFs).violations;

  const liveMissing = build([record("- **Status:** Active first sighting — unattributed.", "src/gone.test.ts", "a suite > a case")]);
  assert.deepEqual(liveMissing.map((v) => v.kind), ["registered-file-missing"]);

  const closedMissing = build([record("- **Status:** Closed 2026-09-06 — retired by `82c635384d`.", "src/gone.test.ts", "a suite > a case")]);
  assert.deepEqual(closedMissing, [], "a retired record must survive the deletion of its subject");

  const closedDrift = build([record("- **Status:** Closed 2026-08-17 by FN-9141 — rescued.", survivor, "renamed suite > renamed case")]);
  assert.ok(
    closedDrift.some((v) => v.kind === "missing-hierarchy-segment"),
    "a closed record whose subject still exists must still be checked for pointer drift",
  );

  const closedUnpointed = build([record("- **Status:** Closed — no source recorded.", "src/gone.test.ts", "a suite > a case")]);
  assert.deepEqual(closedUnpointed.map((v) => v.kind), ["closed-record-without-evidence-pointer"]);

  const liveDrift = build([record("- **Status:** Active first sighting — unattributed.", survivor, "renamed suite > renamed case")]);
  assert.ok(liveDrift.some((v) => v.kind === "missing-hierarchy-segment"));

  for (const citation of ["`82c635384d`", "PR #3034", "FN-9141", "RUFU-197"]) {
    const pointed = build([record(`- **Status:** Closed 2026-09-06 — retired by ${citation}.`, survivor, survivorTitle)]);
    assert.deepEqual(pointed, [], `a closed record citing ${citation} must satisfy the evidence pointer`);
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

FNXC:TestFlakeRegister 2026-09-03-23:58:
RUFU-181 added active record 15 (the notification-service whole-file OOM first sighting), so the pinned list gains its fifth element. The list is order-sensitive and mirrors document order, so a new active record must be appended last in the same commit that adds it — the count assertion alone would not catch a heading or status-text edit, which is exactly why the deepEqual exists.
*/
/*
FNXC:TestFlakeRegister 2026-09-03-22:23:
The register now records that evidence owner FN-9146 was archived on 2026-09-03 without a named
successor, so active records 1 and 2 are unowned pending their next sighting. The pinned status
texts below track that archived-owner annotation; do not strip it without re-homing the records.

FNXC:TestFlakeRegister 2026-09-09-13:51:
FN-9283 closed entry 14 by deleting stale FN-6735 coverage that asserted FN-217-removed automatic
review-to-WIP recovery. The active inventory must exclude the archived record, so a future quarantine
is never mistaken for an unresolved deletion-ratchet obligation.

FNXC:WorkflowResultsTabMocks 2026-09-20-09:58:
FN-9336 closed entry 15 after request-aware selector fixtures proved the whole file and its exact
preserved-column reproduction green. The record stays physically in the active section for first-sighting
evidence, while this active inventory must include only entries 2 and 13.

FNXC:TestFlakeRegister 2026-09-10-19:28:
Entry 14 closed 2026-09-09 when the deletion ratchet executed via commit 55912bd665, which
removed the test file, the quarantine ledger entry, and the engine-reliability exclude in one
commit. The register record now keeps its historical identity on relabeled File/Exact-test
lines that no longer match the dangling-path scan (the file no longer exists to drift-check),
and identifies the required successor without making the archived path active.

FNXC:TestFlakeRegister 2026-09-13-10:38:
FN-9297 replaces the ghost FN-9287 hand-off and delivers deterministic FN-6735 unit coverage in
merge-pause-abort-recovery.test.ts. The archived entry remains outside active-record validation,
while its successor reference makes the deletion-ratchet closure auditable.

FNXC:TestFlakeRegister 2026-09-12-04:32:
Entry 1 closed 2026-09-12: FN-9131's structural harness connection-budget fix (ae507afc37,
merged 2026-08-16) resolved its reproduced project-identity timeout with loaded re-measurement
green, and no sighting has occurred since. The status line now starts with "Closed", so the
active list drops to entries 2 and 13 and the stated count drops to 2. Entry 1's record and
its FN-9146 campaign table stay physically in the active section (readActiveRecordSections
does not filter by status), so the campaign-evidence assertion below still reads entry 1 in
place — keep it in expectedSubjectResults exactly like the closed-in-place entry 7.

FNXC:TestFlakeRegister 2026-09-24-19:55:
FN-9389 adds entry 17 after a one-time Full Suite terminal graph-gate mismatch. Its source and
outbox trace establishes no product race, so pin the active inventory and require its next
sighting to follow the file-level quarantine policy without weakening the durable contract.

FNXC:TestFlakeRegister 2026-09-29-07:58:
FN-9419 records a second sighting of entry 17, so the deletion ratchet moves it from the active
first-sighting inventory to the archive. Preserve both run identifiers, the exact test identity,
and the quarantined status as behavioral evidence without weakening the outbox assertion.

FNXC:TestFlakeRegister 2026-09-24-22:49:
FN-9390 records the triage retry warning as a high-value first sighting after source tracing
showed a fake-timer observation race rather than a production retry defect. Keep its active
status pinned so a repeat executes the file-level quarantine rule without weakening the warning.

FNXC:SkillsGetFlakeRegister 2026-09-29-14:00:
FN-9423 records one built CLI completion timeout only after the real built-entry file test passed.
The active inventory and evidence check keep the second-sighting quarantine decision tied to the
exact global-flag child lifecycle without widening its existing test budget.

FNXC:TriagePlanningRetry 2026-10-05-04:34:
FN-9498 closed entry 18 after the shard logs proved an abandoned fake-timer test was consuming
its successor's mocks. Keep the active inventory and retained evidence separate: the closed record
must preserve both test identities and the synchronization repair without authorizing quarantine.

FNXC:AgentSkillDetailOrdering 2026-10-05-08:54:
FN-9506 records the shard-three Agent Detail badge observation after a controlled pending-discovery
repair. Keep the first-sighting record active so a second appearance follows the file-level
quarantine rule rather than silently treating a deterministic test repair as a policy exemption.
*/
/*
FNXC:TestFlakeRegister 2026-09-04-16:36:
RUFU-186 closed active record 15 on the fix-landed branch (AGENTS.md record-authority): the harness's
real `fetch` to `https://ntfy.sh` was named as the trigger of Node 26.7.0's native HTTP/2 allocation
storm, and the suite is now network-dead behind a connect-tripwire guard. A `Closed`-prefixed status
is excluded from the active count, and entry 15 is dropped from the pinned list below in the same
commit as the register close. Entry 15 stays PHYSICALLY in the active section as closed
cross-reference (entry 7 precedent); no quarantine entry was created, so `scripts/lib/test-quarantine.json`
is unchanged (lockstep count 0 → 0).
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
      heading: "2. Schema applier retains registered dependents",
      status: "Active first sighting — evidence owner FN-9146 (archived 2026-09-03; record unowned pending next sighting).",
    },
    {
      heading: "13. Handoff-to-review atomicity PostgreSQL setup hook",
      status: "Active first sighting — recorded 2026-08-23, unattributed.",
    },
    {
      heading: "20. ProjectEngine research recall composition ordering",
      status: "Active first sighting — recorded 2026-10-04, unattributed.",
    },
    {
      heading: "21. Agent Detail legacy skill discovery ordering",
      status: "Active first sighting — recorded 2026-10-05 by FN-9506; deterministic test repair landed, with a second sighting requiring file-level quarantine.",
    },
    /*
    FNXC:TestFlakeRegister 2026-10-08-05:27:
    RUFU-323 recorded active record 22 (a first-sighting process-sweep observation inside the RUFU-076
    pause-gate git-silence case), so the order-sensitive pinned list gains its sixth element in the same
    change that appended the record. The list mirrors document order; a new active record must be appended
    last here or this guard reddens on the mismatch rather than on the drift it exists to catch.
    */
    {
      heading: "22. RUFU-076 pause-gate git-silence observes a maintenance process sweep",
      status: "Active first sighting — recorded 2026-10-08 by RUFU-323, attributed only as far as the recorded shellout names it.",
    },
    {
      heading: "23. Pipeline smoke Coding S17 post-merge restart",
      status: "Active first sighting — recorded 2026-10-15 by FN-9551; no quarantine.",
    },
  ]);
});

test("closed triage retry record retains both shard diagnoses and structural repair evidence", () => {
  const register = readFileSync(registerPath, "utf8");
  const sections = readActiveRecordSections(register).filter(
    ({ heading }) => heading === "18. Triage rate-limit retry log warning timer ordering",
  );
  assert.equal(sections.length, 1, "Expected exactly one retained closed triage retry record");

  const [{ body }] = sections;
  for (const evidence of [
    "Closed 2026-10-05 — structurally resolved by FN-9498; no quarantine.",
    "packages/engine/src/__tests__/triage.test.ts",
    "logs warning when logEntry fails during rate-limit retry",
    "logs warning when transient-error retry status update fails",
    "d486a4c275",
    "9f06d4fe16404f72c5d25ad97ebcfa93d4843b8c",
    "36053028228",
    "37260134709",
    "111605429056",
    "--shard=2/2",
    "30000 ms",
    "rejected `logEntry`",
    "recoveryRetryCount: 1",
    "no terminal state",
  ]) {
    assert.ok(body.includes(evidence), `Closed triage retry record is missing ${evidence}`);
  }
});

test("archived skills-get quarantine retains both-sighting and sibling-coverage evidence", () => {
  const register = readFileSync(registerPath, "utf8");
  const archive = register.match(/## Archive — closed records\n([\s\S]*)$/)?.[1];
  assert.ok(archive, "Expected an Archive — closed records section");
  const entry = archive.match(/^### 19\. Built skills-get global flag completion\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1];
  assert.ok(entry, "Expected archived skills-get quarantine entry");

  for (const evidence of [
    "Closed — quarantined 2026-09-29 by FN-9425",
    "deletion deadline 2026-10-13",
    "packages/cli/src/commands/__tests__/skills-get.test.ts",
    "fn skills get > preserves global flag precedence and validation for built guide requests",
    "36562243319",
    "36580840868",
    "5228.5 ms",
    "5914.7 ms",
    "0 newly failed / 0 fixed / 188 still failing",
    "six sibling cases",
    "No engine-core merge-gate allow-list changed",
  ]) {
    assert.ok(entry.includes(evidence), `Archived skills-get record is missing ${evidence}`);
  }
});

test("archived terminal graph-gate quarantine retains both-sighting evidence", () => {
  const register = readFileSync(registerPath, "utf8");
  const archive = register.match(/## Archive — closed records\n([\s\S]*)$/)?.[1];
  assert.ok(archive, "Expected an Archive — closed records section");
  const entry = archive.match(/^### 17\. Terminal graph-gate activity outbox contract\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1];
  assert.ok(entry, "Expected archived terminal graph-gate quarantine entry");

  for (const evidence of [
    "packages/engine/src/__tests__/agent-activity-writers.test.ts",
    "engine agent activity durable writer > persists a terminal graph gate through the production TaskStore outbox facade",
    "36034454035",
    "36533908544",
    "quarantined 2026-09-29",
  ]) {
    assert.ok(entry.includes(evidence), `Archived terminal graph-gate entry is missing ${evidence}`);
  }
  assert.match(entry, /^- \*\*Status:\*\* Closed — quarantined/m);
});

test("archived native updater quarantine retains repeat-failure evidence", () => {
  const register = readFileSync(registerPath, "utf8");
  const archive = register.match(/## Archive — closed records\n([\s\S]*)$/)?.[1];
  assert.ok(archive, "Expected an Archive — closed records section");
  const entry = archive.match(/^### 16\. Native updater setup mock lifecycle\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1];
  assert.ok(entry, "Expected archived native updater quarantine entry");

  for (const evidence of [
    "native integrations > setupAutoUpdater > registers updater listeners and checks for updates",
    "native integrations > setupAutoUpdater > sets updater download and install flags",
    "35959852349",
    "35965109937",
    "35965648898",
    'expected "vi.fn()" to be called 1 times, but got 2 times',
    "STACK_TRACE_ERROR",
    "quarantined 2026-09-24",
    "2026-10-08",
  ]) {
    assert.ok(entry.includes(evidence), `Archived native updater entry is missing ${evidence}`);
  }
  assert.match(entry, /^- \*\*Status:\*\* Closed — quarantined/m);
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
