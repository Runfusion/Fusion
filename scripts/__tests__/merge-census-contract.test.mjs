import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
The fixture contract for the Workflow Merger lane's census. Each case reproduces ONE of the four
extractor defects that lane hit inside a single week, using data shaped like the real mirrors
(measured on 834 live `.fusion/tasks/<ID>/task.json` rows: step identity lives on `workflowStepId`, and
each gate row carries its own nested `priorAttempts` — the task-level array is absent everywhere).
*/
import {
  buildRow,
  collectEvidenceRows,
  formatRowLines,
  main,
  readMirrors,
  wedgeMapOf,
} from "../merge-census.mjs";

const ME = "agent-me";

function git(repo, args) {
  return execFileSync("git", [
    "-C", repo,
    "-c", "user.name=census-fixture",
    "-c", "user.email=census@example.invalid",
    "-c", "commit.gpgsign=false",
    ...args,
  ], { encoding: "utf8" });
}

function seedRepo(root) {
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "chore: census fixture base"]);
  // One unrelated fusion/* ref: the ref census must be non-zero for a run to be COMPLETE, and this
  // name deliberately matches no card id, so per-card ref state stays `absent`.
  git(root, ["branch", "fusion/unrelated-fixture"]);
}

function writeMirror(tasksDir, card) {
  const dir = join(tasksDir, card.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify(card, null, 2));
}

function makeFixture(t, cards) {
  const root = mkdtempSync(join(tmpdir(), "merge-census-"));
  const tasksDir = join(root, ".fusion", "tasks");
  for (const card of cards) writeMirror(tasksDir, card);
  seedRepo(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, tasksDir };
}

/** Run the real CLI, capturing every emitted line — the output contract is line-exact. */
function runCli(root, tasksDir, extra = []) {
  const lines = [];
  const code = main(["--repo", root, "--tasks-dir", tasksDir, ...extra], { emit: (line) => lines.push(line) });
  return { code, lines, text: lines.join("\n") };
}

function rowLineFor(lines, taskId) {
  const line = lines.find((candidate) => candidate.startsWith(`row taskId=${taskId} `));
  assert.ok(line, `no row line printed for ${taskId}: ${lines.join("\n")}`);
  return line;
}

function fieldOf(rowLine, key) {
  const match = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(rowLine);
  return match ? match[1] : undefined;
}

function approvalRow(stepId, completedAt) {
  return { workflowStepId: stepId, status: "passed", verdict: "APPROVE", completedAt, output: "ok" };
}

/*
§1c — the leaked loop variable. Two defects, one shape: a derived value bound only inside a collection
loop and read after it, which printed two `in-review` cards as `column=done` with a false
APPROVE_WITH_NOTES. Because `readMirrors` sorts by taskId before printing, a carried-over binding does
not flake — it reports wrong values with total confidence. So the assertion is per-row CONTENT plus
corpus-order invariance, never output stability alone.
*/
test("every printed field comes from the row's own dict, in any corpus order (§1c)", (t) => {
  const cards = [
    { id: "RUFU-0101", column: "in-review", updatedAt: "2026-11-01T10:00:00.000Z", workflowStepResults: [approvalRow("code-review", "2026-11-01T09:00:00.000Z")] },
    { id: "RUFU-0102", column: "done", updatedAt: "2026-11-01T11:00:00.000Z", workflowStepResults: [{ workflowStepId: "code-review", status: "failed", completedAt: "2026-11-01T09:30:00.000Z", output: "no verdict" }] },
    { id: "RUFU-0103", column: "in-progress", updatedAt: "2026-11-01T12:00:00.000Z", workflowStepResults: [] },
  ];
  const { tasksDir } = makeFixture(t, cards);
  const { rows } = readMirrors(tasksDir);
  assert.equal(rows.length, 3);

  const firstPass = new Map(rows.map((row) => [row.taskId, formatRowLines(row)[0]]));
  // Same rows walked in reverse: a binding that survives from a previous iteration would shift.
  for (const row of [...rows].reverse()) {
    assert.equal(formatRowLines(row)[0], firstPass.get(row.taskId), `order-dependent print for ${row.taskId}`);
  }

  // Content: each line names its OWN card's column and verdict, never a neighbour's.
  assert.equal(fieldOf(firstPass.get("RUFU-0101"), "column"), "in-review");
  assert.equal(fieldOf(firstPass.get("RUFU-0101"), "verdict"), "covered-approval");
  assert.equal(fieldOf(firstPass.get("RUFU-0102"), "column"), "done");
  assert.equal(fieldOf(firstPass.get("RUFU-0102"), "verdict"), "revise-blocked");
  assert.equal(fieldOf(firstPass.get("RUFU-0103"), "column"), "in-progress");
  assert.equal(fieldOf(firstPass.get("RUFU-0103"), "verdict"), "none");
  assert.equal(new Set([...firstPass.values()].map((line) => fieldOf(line, "taskId"))).size, 3);
});

/*
`workflowStepResults` reaches a mirror as an array (what the engine writes) or as a dict keyed by step
id (older/imported rows). Both shapes must yield the SAME verdict, and a dict key must not lose the
step identity when the entry omits `workflowStepId`.
*/
test("list and dict workflowStepResults produce identical verdicts", (t) => {
  const listRow = { workflowStepId: "code-review", status: "passed", verdict: "APPROVE_WITH_NOTES", completedAt: "2026-11-02T08:00:00.000Z", output: "ship it" };
  const listCard = { id: "RUFU-0201", column: "in-review", updatedAt: "2026-11-02T09:00:00.000Z", enabledWorkflowSteps: ["plan-review", "code-review"], workflowStepResults: [listRow] };
  const dictCard = {
    ...listCard,
    id: "RUFU-0202",
    // Dict form with no step id inside the entry: only the key can identify the gate.
    workflowStepResults: { "code-review": { status: "passed", verdict: "APPROVE_WITH_NOTES", completedAt: "2026-11-02T08:00:00.000Z", output: "ship it" } },
  };
  const { root, tasksDir } = makeFixture(t, [listCard, dictCard]);

  const fromList = buildRow(listCard, listCard.id);
  const fromDict = buildRow(dictCard, dictCard.id);
  for (const key of ["verdict", "verdictNote", "verdictStepId", "codeReview", "attempts", "bypassed"]) {
    assert.equal(fromDict[key], fromList[key], `${key} differs between dict and list shape`);
  }
  assert.equal(fromList.verdictStepId, "code-review", "list shape must read workflowStepId");
  assert.equal(fromDict.verdictStepId, "code-review", "dict shape must fall back to the dict key");

  // The CLI sees the two shapes as the same lane row.
  const run = runCli(root, tasksDir, ["--no-stamp"]);
  assert.equal(fieldOf(rowLineFor(run.lines, "RUFU-0201"), "verdict"), fieldOf(rowLineFor(run.lines, "RUFU-0202"), "verdict"));
  assert.equal(fieldOf(rowLineFor(run.lines, "RUFU-0201"), "codeReview"), "pass");

  // Mixed shape: a dict-shaped current row with a nested prior attempt.
  const mixed = { ...listCard, workflowStepResults: { "code-review": { ...listRow, priorAttempts: [{ status: "failed", completedAt: "2026-11-02T07:00:00.000Z" }] } } };
  assert.equal(buildRow(mixed, mixed.id).verdict, "covered-approval");
  assert.equal(buildRow(mixed, mixed.id).gateAttempts, 2, "priorAttempts on the gate row count as attempts");
});

/*
priorAttempts collapse. The live engine nests priorAttempts on each GATE ROW (measured: RUFU-343's
code-review row is `skipped` with 4 failed priors); the OD's attempt rule is `1 + len(priorAttempts)`.
Both shapes must collapse to honest counts, rank by full-ISO completedAt, and an `output`-only row is
never a verdict.
*/
test("priorAttempts collapse to 1 + len, rank by completedAt, and reject output-only rows", (t) => {
  const card = {
    id: "RUFU-0301",
    column: "in-review",
    updatedAt: "2026-11-03T10:00:00.000Z",
    priorAttempts: [{ workflowStepResults: [] }, { status: "failed" }],
    workflowStepResults: [
      approvalRow("plan-review", "2026-10-01T10:00:00.000Z"),
      {
        workflowStepId: "code-review",
        status: "skipped",
        completedAt: "2026-10-05T10:00:00.000Z",
        output: "Code Review failed before producing a verdict: failed",
        priorAttempts: [
          { workflowStepId: "code-review", status: "failed", completedAt: "2026-10-04T10:00:00.000Z", output: "no verdict" },
          { workflowStepId: "code-review", status: "failed", verdict: "REVISE", completedAt: "2026-10-03T10:00:00.000Z" },
        ],
      },
    ],
  };
  makeFixture(t, [card]);
  const row = buildRow(card, card.id);

  assert.equal(row.attempts, 3, "card attempts = 1 + len(task.priorAttempts)");
  // The current code-review row carries no verdict and no waiver, so the newest AUTHORITATIVE row is
  // the 2026-10-04 failure — which makes this card revise-blocked, never approved.
  assert.equal(row.verdict, "revise-blocked");
  assert.match(row.verdictSource, /prior1$/);
  assert.equal(row.codeReview, "blocked");
  assert.equal(row.gateAttempts, 3, "gate attempts = 1 + len(gate row.priorAttempts)");

  const outputOnly = {
    id: "RUFU-0302",
    column: "in-review",
    workflowStepResults: [{ workflowStepId: "code-review", output: "partial bytes" }, { workflowStepId: "plan-review", notes: "thinking" }],
  };
  const parsedOnly = buildRow(outputOnly, outputOnly.id);
  assert.equal(parsedOnly.verdict, "none");
  assert.equal(parsedOnly.codeReview, "no-verdict");
  assert.deepEqual(parsedOnly.evidence, [], "output-only rows are not evidence");

  // Nested duplicates (attempt N re-embedding 1..N-1, as RUFU-343's priors do) must not double-count.
  const nested = {
    id: "RUFU-0303",
    column: "in-review",
    workflowStepResults: [{
      workflowStepId: "code-review",
      status: "passed",
      verdict: "APPROVE",
      completedAt: "2026-10-09T10:00:00.000Z",
      priorAttempts: [{
        workflowStepId: "code-review",
        status: "failed",
        verdict: "REVISE",
        completedAt: "2026-10-08T10:00:00.000Z",
        priorAttempts: [{ workflowStepId: "code-review", status: "failed", verdict: "REVISE", completedAt: "2026-10-08T10:00:00.000Z" }],
      }],
    }],
  };
  const keys = collectEvidenceRows(nested).map((entry) => `${entry.workflowStepId}|${entry.status}|${entry.completedAt}`);
  assert.equal(new Set(keys).size, keys.length, "recursive expansion must not double-count a re-embedded attempt");
  assert.equal(keys.length, 2);
});

/*
Bypass keys are an operator waiver and may sit on the current row OR on any prior attempt. One key
alone is a partial write, not a waiver.
*/
test("bypass keys on the current or any prior row cover the gate as note=bypassed", () => {
  const onPrior = {
    id: "RUFU-0401",
    column: "in-review",
    enabledWorkflowSteps: ["code-review"],
    workflowStepResults: [{ workflowStepId: "code-review", output: "no verdict captured" }],
    priorAttempts: [{ workflowStepResults: { "code-review": { status: "skipped", bypassedBy: "dashboard-operator", bypassedAt: "2026-11-04T00:33:07.528Z" } } }],
  };
  const fromPrior = buildRow(onPrior, onPrior.id);
  assert.equal(fromPrior.verdict, "covered-approval");
  assert.equal(fromPrior.verdictNote, "bypassed");
  assert.equal(fromPrior.codeReview, "pass", "an operator waiver is a passing content gate");

  const onCurrent = {
    id: "RUFU-0402",
    column: "in-review",
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [
      approvalRow("plan-review", "2026-11-02T12:00:00.000Z"),
      { workflowStepId: "code-review", status: "skipped", completedAt: "2026-11-02T21:00:00.000Z", bypassedBy: "dashboard-operator", bypassedAt: "2026-11-04T00:33:07.528Z" },
    ],
  };
  const fromCurrent = buildRow(onCurrent, onCurrent.id);
  assert.equal(fromCurrent.verdict, "covered-approval");
  assert.equal(fromCurrent.verdictNote, "bypassed");
  assert.equal(fromCurrent.verdictStepId, "code-review");

  const halfWaiver = { ...onCurrent, workflowStepResults: [{ workflowStepId: "code-review", status: "skipped", bypassedBy: "dashboard-operator" }] };
  assert.equal(buildRow(halfWaiver, halfWaiver.id).verdict, "none");
});

/*
The wedge notification is an object whose keys are reasonKey / episodeId / status / transitionedAt /
lastNotifiedAtByReason. There is NO scalar `lastNotifiedAt` on it, and reading one is the §2c class of
bug: it returns undefined and prints as a fabricated empty field.
*/
test("wedge reads only the named object keys and tolerates absence and junk", () => {
  const multi = {
    id: "RUFU-0501",
    column: "in-review",
    wedgeNotification: {
      reasonKey: "in-review-stall-deadlock",
      episodeId: "fadd5746",
      status: "active",
      transitionedAt: "2026-11-03T02:59:12.821Z",
      lastNotifiedAtByReason: { "stall:merge-blocker": "2026-11-02T21:27:51.851Z", "in-review-stall-deadlock": "2026-11-03T02:59:12.821Z" },
    },
  };
  const map = wedgeMapOf(multi);
  assert.deepEqual(Object.keys(map).sort(), ["in-review-stall-deadlock", "stall:merge-blocker"]);
  assert.equal(map["in-review-stall-deadlock"].status, "active");
  assert.equal(map["stall:merge-blocker"].status, "notified");
  assert.match(formatRowLines(buildRow(multi, multi.id))[0], /wedge=in-review-stall-deadlock=active,stall:merge-blocker=notified/);

  assert.deepEqual(wedgeMapOf({ id: "RUFU-0502" }), {}, "absence is an empty map, never a crash");
  assert.deepEqual(wedgeMapOf({ wedgeNotification: "stall:merge-blocker" }), {}, "a scalar wedge is junk, not a reason");
  assert.deepEqual(Object.keys(wedgeMapOf({ wedgeNotification: { reasonKey: "x", lastNotifiedAt: "2026-11-03T00:00:00.000Z" } })), ["x"]);
  assert.doesNotMatch(formatRowLines(buildRow({ id: "RUFU-0503", wedgeNotification: { reasonKey: "x", lastNotifiedAt: "y" } }, "RUFU-0503"))[0], /lastNotifiedAt/);
  assert.equal(fieldOf(formatRowLines(buildRow({ id: "RUFU-0504", column: "in-review" }, "RUFU-0504"))[0], "wedge"), "-");
});

/*
§2c — the anti-duplicate check read `sourceAgentId` from `sourceMetadata`, got null on 38/38 rows, and
reported "cards filed by me: []". The field is TOP-LEVEL; `nearDuplicateOf` is what lives under
`sourceMetadata`. Both paths are probed and the printed line names the path that hit, so duplicates
are printed facts rather than a recall rule the next tick must remember.
*/
test("own-filed cards probe both paths, so a top-level agent id is never reported empty (§2c)", (t) => {
  const mine = { id: "RUFU-0601", column: "in-review", sourceAgentId: ME, sourceType: "api", workflowStepResults: [approvalRow("code-review", "2026-11-01T09:00:00.000Z")] };
  const duplicate = { id: "RUFU-0602", column: "todo", sourceMetadata: { nearDuplicateOf: "RUFU-0601" }, pausedReason: "near-duplicate-decision", workflowStepResults: [] };
  const misplaced = { ...mine, id: "RUFU-0603", sourceAgentId: undefined, sourceMetadata: { sourceAgentId: ME }, column: "todo" };
  const { root, tasksDir } = makeFixture(t, [mine, duplicate, misplaced]);

  const asAgent = runCli(root, tasksDir, ["--lane", "in-review", "--full", "--no-stamp", "--agent", ME]);
  const summary = asAgent.lines.find((line) => line.startsWith("ownFiled filter="));
  assert.ok(summary, "the own-filed section must print");
  assert.match(summary, /matched=1 topLevelSourceAgentId=1/, "a top-level sourceAgentId is a card filed by me, not an empty list");
  assert.match(asAgent.lines.find((line) => line.includes("ownFiled taskId=RUFU-0601")), new RegExp(`agent=${ME} agentPath=top-level`));

  const anyAgent = runCli(root, tasksDir, ["--lane", "in-review", "--full", "--no-stamp"]);
  const dupLine = anyAgent.lines.find((line) => line.includes("ownFiled taskId=RUFU-0602"));
  assert.match(dupLine, /agent=- agentPath=none/);
  assert.match(dupLine, /nearDuplicateOf=RUFU-0601 nearDuplicatePath=sourceMetadata/);
  assert.match(dupLine, /pausedReason=near-duplicate-decision/);

  // Writing the agent id under sourceMetadata — the §2c wrong path — files NOTHING: the corpus holds
  // three cards and exactly ONE top-level sourceAgentId, so the census reports one card, and the
  // misplaced card never appears as filed by me.
  assert.match(summary, /matched=1 topLevelSourceAgentId=1/, "an agent id under sourceMetadata is not a filing");
  assert.ok(!asAgent.lines.some((line) => line.includes("ownFiled taskId=RUFU-0603") && line.includes(`agent=${ME}`)),
    "the wrong-path card must not be printed as filed by the agent");
  const anyLines = anyAgent.lines.filter((line) => line.includes("ownFiled taskId=RUFU-0603"));
  assert.equal(anyLines.length, 0, "a card whose only agent id sits under sourceMetadata is not filed by anyone");
});

test("unparseable mirrors are counted AND named, and the run is incomplete", (t) => {
  const root = mkdtempSync(join(tmpdir(), "merge-census-"));
  const tasksDir = join(root, ".fusion", "tasks");
  writeMirror(tasksDir, { id: "RUFU-0701", column: "in-review", workflowStepResults: [] });
  mkdirSync(join(tasksDir, "RUFU-0702"), { recursive: true });
  writeFileSync(join(tasksDir, "RUFU-0702", "task.json"), "{ this is not json");
  seedRepo(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const run = runCli(root, tasksDir, ["--no-stamp"]);
  assert.equal(run.code, 1, "an incomplete census never reports success");
  assert.match(run.text, /^mirrors: 2$/m, "the control count includes the unparseable mirror");
  assert.match(run.text, /unparseable-mirror: RUFU-0702 \(json-parse\)/);
  assert.ok(!run.text.includes("SENTINEL-END"), "no END sentinel while the read is incomplete");
  assert.equal(run.lines.filter((line) => line.startsWith("disposition ")).length, 1);
  assert.match(run.text, /^disposition laneRows=1 authorityVerdict=none actionTaken=none$/m);
});

test("every run prints mirrors, laneDigest and exactly one disposition line; the stamp makes the next tick cheap", (t) => {
  const card = { id: "RUFU-0801", column: "in-review", updatedAt: "2026-11-03T10:00:00.000Z", enabledWorkflowSteps: ["code-review"], workflowStepResults: [approvalRow("code-review", "2026-11-03T09:00:00.000Z")] };
  const { root, tasksDir } = makeFixture(t, [card]);
  const stateFile = join(root, "state", "stamp.json");
  const digestOf = (text) => /laneDigest=([0-9a-f]{16})/.exec(text)[1];

  const first = runCli(root, tasksDir, ["--state-file", stateFile]);
  assert.equal(first.code, 0, first.text);
  assert.equal(first.lines[0], "SENTINEL-START", "the sentinel is the FIRST stdout line");
  assert.match(first.lines[first.lines.length - 1], /^SENTINEL-END$/);
  assert.match(first.text, /^mirrors: 1$/m);
  assert.match(first.text, /laneDigest=[0-9a-f]{16}/);
  assert.match(first.text, /^disposition laneRows=1 authorityVerdict=covered-approval actionTaken=merge-ready$/m);
  assert.equal(first.lines.filter((line) => line.startsWith("disposition ")).length, 1);
  assert.match(first.text, /unchanged: no/);

  const second = runCli(root, tasksDir, ["--state-file", stateFile]);
  assert.equal(digestOf(second.text), digestOf(first.text), "an unchanged lane must produce the identical digest");
  assert.match(second.text, /unchanged: yes \(stamped /, "the stamp is what lets the next tick skip the work");

  // A mirror write moves the digest: the stamp is an "authority unchanged" key, not a file cache.
  writeMirror(tasksDir, { ...card, updatedAt: "2026-11-03T11:00:00.000Z" });
  const third = runCli(root, tasksDir, ["--state-file", stateFile]);
  assert.notEqual(digestOf(third.text), digestOf(first.text));
  assert.match(third.text, /unchanged: no/);

  // --no-stamp neither reads nor writes state.
  const untouched = join(root, "state-disabled");
  const disabled = runCli(root, tasksDir, ["--state-file", untouched, "--no-stamp"]);
  assert.match(disabled.text, /stamp: disabled/);
  assert.ok(!existsSync(untouched), "--no-stamp must not create the state file");
});

/*
The action gate. `authorityVerdict` follows the card's verdict rule; `actionTaken` is what the lane may
do, and an approval that does not sit on the card's own content gate is NOT merge authority. The
measured case is RUFU-343: `code-review` skipped with no verdict and 4 failed priors, which an ad-hoc
scan reported as an approval.
*/
test("an approval that is not on the content gate never yields merge-ready", (t) => {
  const planOnly = { id: "RUFU-0901", column: "in-review", enabledWorkflowSteps: ["plan-review", "code-review"], workflowStepResults: [approvalRow("plan-review", "2026-11-03T08:00:00.000Z")] };
  const noGate = { id: "RUFU-0902", column: "in-review", enabledWorkflowSteps: ["plan-review"], workflowStepResults: [approvalRow("plan-review", "2026-11-03T08:00:00.000Z")] };
  const blockedGate = {
    id: "RUFU-0903",
    column: "in-review",
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [
      approvalRow("plan-review", "2026-11-03T08:00:00.000Z"),
      {
        workflowStepId: "code-review",
        status: "skipped",
        completedAt: "2026-11-03T09:00:00.000Z",
        output: "Code Review failed before producing a verdict: failed",
        priorAttempts: [{ workflowStepId: "code-review", status: "failed", completedAt: "2026-11-03T08:30:00.000Z" }],
      },
    ],
  };
  const { root, tasksDir } = makeFixture(t, [planOnly, noGate, blockedGate]);
  const run = runCli(root, tasksDir, ["--no-stamp"]);

  assert.equal(fieldOf(rowLineFor(run.lines, "RUFU-0901"), "verdict"), "covered-approval");
  assert.equal(fieldOf(rowLineFor(run.lines, "RUFU-0901"), "codeReview"), "absent");
  assert.equal(fieldOf(rowLineFor(run.lines, "RUFU-0902"), "codeReview"), "n-a", "a workflow that never enabled the gate is not missing it");
  assert.match(run.text, /^disposition laneRows=3 authorityVerdict=revise-blocked actionTaken=hold$/m, "one blocked gate holds the whole lane");

  const solo = runCli(root, tasksDir, ["--lane", "in-review", "--no-stamp", "--task", "RUFU-0902"]);
  assert.match(solo.text, /^disposition laneRows=1 authorityVerdict=covered-approval actionTaken=merge-ready$/m);
  assert.match(solo.text, /stamp: not-read/, "a single-card cross-check must not overwrite the lane stamp");
  assert.equal(rowLineFor(solo.lines, "RUFU-0902"), rowLineFor(run.lines, "RUFU-0902"), "the mandated second read must agree with the lane row");

  const missing = runCli(root, tasksDir, ["--no-stamp", "--task", "RUFU-9999"]);
  assert.equal(missing.code, 1, "an unknown --task id is a negative conclusion and must not exit 0");
  assert.match(missing.text, /^task-not-found: RUFU-9999$/m);
});

test("usage errors exit 2 and print no sentinels", () => {
  const lines = [];
  const code = main(["--nope"], { emit: (line) => lines.push(line) });
  assert.equal(code, 2);
  assert.equal(lines[0], "usage-error: unknown argument: --nope");
  assert.ok(!lines.includes("SENTINEL-START"));

  const lines2 = [];
  assert.equal(main(["--lane"], { emit: (line) => lines2.push(line) }), 2);
  assert.match(lines2[0], /--lane requires a value/);

  const lines3 = [];
  assert.equal(main(["--help"], { emit: (line) => lines3.push(line) }), 0);
  assert.match(lines3.join("\n"), /MEMORY_LONG_TERM_BYTE_BUDGET/, "--help must cite the code-owned budget constant");
});
