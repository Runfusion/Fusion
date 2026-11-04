import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
The ref-probe contract, against real ephemeral repositories: no network, no polling, deterministic
git plumbing only. These two cases are the defects that made an ad-hoc scan lie about DELIVERY —
`--grep=RUFU-225` matching a commit that merely mentions the id (§1b), and an anchored grep over
`for-each-ref --format=… %(objectname)` reporting nothing while 46 refs lived (§1d).
*/
import { main, parseTrailers } from "../merge-census.mjs";

function git(repo, args) {
  return execFileSync("git", [
    "-C", repo,
    "-c", "user.name=census-fixture",
    "-c", "user.email=census@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "advice.detachedHead=false",
    ...args,
  ], { encoding: "utf8" });
}

function initRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "merge-census-git-"));
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "chore: fixture base"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A commit on its own branch: subject plus an optional trailer paragraph. */
function commitOnBranch(root, branch, { subject, trailer, touch }) {
  git(root, ["checkout", "-q", "-b", branch, "main"]);
  writeFileSync(join(root, touch), `${branch} content\n`);
  git(root, ["add", touch]);
  const args = ["commit", "-q", "-m", subject];
  if (trailer) args.push("-m", trailer);
  git(root, args);
  git(root, ["checkout", "-q", "main"]);
}

function writeMirror(root, card) {
  const dir = join(root, ".fusion", "tasks", card.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify(card, null, 2));
}

function runCli(root, extra = []) {
  const lines = [];
  const code = main(["--repo", root, "--no-stamp", ...extra], { emit: (line) => lines.push(line) });
  return { code, lines, text: lines.join("\n") };
}

function fieldOf(rowLine, key) {
  const match = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(rowLine);
  return match ? match[1] : undefined;
}

function rowLineFor(result, taskId) {
  const line = result.lines.find((candidate) => candidate.startsWith(`row taskId=${taskId} `));
  assert.ok(line, `no row line for ${taskId}: ${result.text}`);
  return line;
}

function approvalRow(stepId, completedAt) {
  return { workflowStepId: stepId, status: "passed", verdict: "APPROVE", completedAt, output: "ok" };
}

test("ownership needs trailer VALUE equality; a message that merely mentions an id proves nothing (§1b)", (t) => {
  const root = initRepo(t);
  // Owned: the trailer VALUE equals the card id (both the canonical and the short key variant).
  commitOnBranch(root, "fusion/rufu-0001", { subject: "feat: add the thing", trailer: "Fusion-Task-Id: RUFU-0001", touch: "a.txt" });
  commitOnBranch(root, "fusion/rufu-0002", { subject: "feat: other thing", trailer: "Task-Id: RUFU-0002", touch: "b.txt" });
  // NOT owned: the message MENTIONS the id — the exact §1b trap where a RUFU-283 commit mentioning
  // RUFU-225 was read as RUFU-225's own work — and a trailer whose value belongs to ANOTHER card.
  commitOnBranch(root, "fusion/rufu-0225", { subject: "fix: follow-up that supersedes RUFU-225 behavior", touch: "c.txt" });
  commitOnBranch(root, "fusion/rufu-0226", { subject: "fix: borrowed work", trailer: "Fusion-Task-Id: RUFU-0999", touch: "d.txt" });
  for (const id of ["RUFU-0001", "RUFU-0002", "RUFU-0225", "RUFU-0226"]) {
    writeMirror(root, { id, column: "in-review", updatedAt: "2026-11-03T10:00:00.000Z", enabledWorkflowSteps: ["code-review"], workflowStepResults: [approvalRow("code-review", "2026-11-03T09:00:00.000Z")] });
  }

  const run = runCli(root);
  assert.equal(run.code, 0, run.text);
  assert.match(run.text, /^refCensus: 4$/m, "the unfiltered census counts every fusion ref, unanchored");
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0001"), "owner"), "trailer-match");
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0002"), "owner"), "trailer-match", "the Task-Id: variant is a real trailer");
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0225"), "owner"), "no-trailer-match", "message text mentioning an id is NOT ownership");
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0226"), "owner"), "no-trailer-match", "another card's trailer value is not this card's ownership");
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0225"), "ref"), "present", "the branch exists; only ownership failed");
});

test("a zero-ref census invalidates every negative ref conclusion and holds the run incomplete (§1d)", (t) => {
  const root = initRepo(t);
  writeMirror(root, { id: "RUFU-0001", column: "in-review", updatedAt: "2026-11-03T10:00:00.000Z", enabledWorkflowSteps: ["code-review"], workflowStepResults: [approvalRow("code-review", "2026-11-03T09:00:00.000Z")] });

  const run = runCli(root);
  assert.match(run.text, /^refCensus: 0$/m);
  assert.match(run.text, /refProbe:invalid/);
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0001"), "ref"), "invalid", "an unenumerable namespace is never read as an absent branch");
  assert.ok(!run.text.includes("ref=absent"), "no row may conclude `absent` while the census is empty");
  assert.ok(!run.text.includes("verdict=landed"), "nothing can be proven landed from an empty ref census");
  assert.equal(run.code, 1, "a run that cannot enumerate refs is incomplete, not successful");
  assert.ok(!run.text.includes("SENTINEL-END"));
  assert.equal(run.lines.filter((line) => line.startsWith("disposition ")).length, 1, "the disposition line is still the one machine-readable record");
});

test("a ref tip proven an ancestor of HEAD reports landed", (t) => {
  const root = initRepo(t);
  // Ref names carry the LOWERCASE id, so the probe must lowercase before matching.
  commitOnBranch(root, "fusion/rufu-0003", { subject: "feat: delivered work", trailer: "Fusion-Task-Id: RUFU-0003", touch: "e.txt" });
  commitOnBranch(root, "fusion/rufu-0004", { subject: "feat: still pending", trailer: "Fusion-Task-Id: RUFU-0004", touch: "f.txt" });
  // Deliver only RUFU-0003: merging its branch makes its tip an ancestor of HEAD, RUFU-0004's stays ahead.
  git(root, ["merge", "-q", "--no-ff", "-m", "chore: land the delivered branch", "fusion/rufu-0003"]);
  for (const id of ["RUFU-0003", "RUFU-0004"]) {
    writeMirror(root, { id, column: "in-review", updatedAt: "2026-11-03T10:00:00.000Z", enabledWorkflowSteps: ["code-review"], workflowStepResults: [approvalRow("code-review", "2026-11-03T09:00:00.000Z")] });
  }

  const run = runCli(root);
  assert.equal(run.code, 0, run.text);
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0003"), "ref"), "ancestor");
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0003"), "verdict"), "landed");
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0004"), "ref"), "present");
  assert.equal(fieldOf(rowLineFor(run, "RUFU-0004"), "verdict"), "covered-approval");

  // A lane where every card is proven landed is `landed`, and a landed card is not an action.
  const onlyDelivered = runCli(root, ["--task", "RUFU-0003"]);
  assert.match(onlyDelivered.text, /^disposition laneRows=1 authorityVerdict=landed actionTaken=none$/m);
});

test("trailer parsing reads git's real trailer block, not any line that mentions a key", () => {
  assert.deepEqual(parseTrailers("feat: subject\n\nbody prose\n\nFusion-Task-Id: RUFU-0001"), { "fusion-task-id": "RUFU-0001" });
  assert.deepEqual(parseTrailers("feat: subject\n\nFusion-Task-Id: RUFU-0001\n\nprose after the trailer block"), {}, "a trailer followed by prose is not a trailer block");
  // A subject line whose token is not one of our keys yields no ownership either way; what matters is
  // that the lookup keys stay absent, which is exactly the §1b trap being closed.
  assert.deepEqual(parseTrailers("fix: follow-up to RUFU-225"), { fix: "follow-up to RUFU-225" });
  assert.equal(parseTrailers("fix: follow-up to RUFU-225")["fusion-task-id"], undefined);
  assert.deepEqual(parseTrailers("see RUFU-0001 for context"), {}, "prose with no trailer shape is no trailer block");
  assert.deepEqual(parseTrailers(""), {});
});
