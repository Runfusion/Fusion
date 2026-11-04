#!/usr/bin/env node
/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
The Workflow Merger lane used to hand-write a board census on almost every wake (~50 ticks/day, nearly
all of them record-only). Four extractor defects in one week each had the power to grant or revoke
merge authority for the wrong card, so this file is the ONE census surface for that lane and every
tick that follows:

  §1c (twice) — a derived value (`col`, later `wn` + `srows`) bound only inside a collection loop, so
                two `in-review` rows printed as `column=done` with a false `APPROVE_WITH_NOTES`.
  §2c         — `sourceAgentId` read from `sourceMetadata` returned null on 38/38 rows, so the
                anti-duplicate check reported "cards filed by me: []".
  §1b         — `--grep=RUFU-225` matched a commit that merely MENTIONS the id (that commit is RUFU-283).
  §1d         — a `$`-anchored grep over `for-each-ref --format=… %(objectname)` reported nothing
                while 46 refs lived.

PRINT DISCIPLINE (§1c) is therefore a structural rule, not a style preference: every reported field
is read from the row's own dict inside that row's own print block. No derived name may bind only in a
collection loop, because a carried-over binding makes the output a function of CORPUS ORDER — and the
fixture suite asserts order-swap invariance to prove it.

FIELD ADAPTER (§2c) reads each field from every path it legitimately lives on and prints WHICH path
hit, so "cards filed by me: []" is a measured fact rather than a wrong-path null.

PATH DEVIATION (deliberate, contract-preserving): the operator's card names
`.fusion/scripts/merge_census.py`. `.gitignore` line 42 ignores `.fusion/` ("local board state — don't
commit"), so a script there can never be committed, never run in CI, cannot satisfy the squash-merge
File-Scope invariant, and AGENTS.md forbids force-adding `.fusion/`. There is also no Python test
runner in this repo while `scripts/*.mjs` census tooling is the established tested pattern
(`scripts/lifecycle-column-census.mjs` via `pnpm test:scripts`). The canonical tool is therefore this
tracked Node ESM file, preserving every observable the card demanded.

READ-ONLY CONTRACT: the only filesystem write anywhere in this file is the digest stamp under
`.fusion/state/` (gitignored runtime state, `--no-stamp` disables it). No task store, no database, no
network. Git is invoked as fixed argv through execFileSync — task ids are never shell-interpolated.
*/

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const USAGE = `merge-census.mjs — the Workflow Merger lane's only board census (read-only)

Usage: node scripts/merge-census.mjs [--repo <path>] [--tasks-dir <path>] [--lane <columnId>]
                                      [--task <ID>] [--agent <id>] [--state-file <path>]
                                      [--no-stamp] [--full] [--help]

  --repo <path>        Repository whose git plumbing is consulted (default: .).
  --tasks-dir <path>   Mirrors directory (default: <repo>/.fusion/tasks).
  --lane <columnId>    Lane to census (default: in-review).
  --task <ID>          Narrow single-card cross-check — the mandated second, differently-written read.
                       Never reads nor writes the lane stamp (a single card must not corrupt the
                       lane's "unchanged" memory).
  --agent <id>         Own-filed-cards filter (top-level sourceAgentId, sourceMetadata fallback).
  --state-file <path>  Digest stamp path (default: <repo>/.fusion/state/merge-census-stamp.json).
  --no-stamp           Do not read or write any stamp file.
  --full               Add the worktree inventory, own-filed-cards section, and per-row evidence.

Output contract: first stdout line "SENTINEL-START"; "mirrors: N" before the report; exactly one
"disposition laneRows=N authorityVerdict=<v> actionTaken=<a>" line; "laneDigest=<16hex>"; final line
"SENTINEL-END" printed ONLY on a complete run.

Default output is the compact authority-only mode, sized so that one tick's output plus the lane's
standing instructions fits the code-owned long-term \`MEMORY.md\` budget — the constant
\`MEMORY_LONG_TERM_BYTE_BUDGET\` in packages/engine/src/memory/memory-budget.ts, a working-set bound
because that file is injected into agent context. Its value is asserted against the constant in
packages/core/src/__tests__/workflow-role-agent-defaults-merger.test.mjs, so no number is remembered
here. Never paste the full census (--full) into long-term memory.

Exit codes: 0 complete · 1 INCOMPLETE (unparseable mirrors or failed git probes — negative
conclusions are forbidden) · 2 usage.`;

/** Usage failure — the CLI maps this to exit 2 and prints no sentinels. */
class UsageError extends Error {}

/**
 * Parse argv. Unknown flags are a usage failure rather than a silently ignored word: a typo'd
 * `--nostamp` would otherwise run a stamp-writing lane tick that the operator believed was inert.
 */
export function parseArgs(argv) {
  const opts = {
    repo: ".",
    tasksDir: null,
    lane: "in-review",
    task: null,
    agent: null,
    stateFile: null,
    stamp: true,
    full: false,
    help: false,
  };
  const needsValue = new Set(["--repo", "--tasks-dir", "--lane", "--task", "--agent", "--state-file"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (arg === "--no-stamp") { opts.stamp = false; continue; }
    if (arg === "--full") { opts.full = true; continue; }
    if (!needsValue.has(arg)) throw new UsageError(`unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} requires a value`);
    i += 1;
    switch (arg) {
      case "--repo": opts.repo = value; break;
      case "--tasks-dir": opts.tasksDir = value; break;
      case "--lane": opts.lane = value; break;
      case "--task": opts.task = value; break;
      case "--agent": opts.agent = value; break;
      case "--state-file": opts.stateFile = value; break;
      default: throw new UsageError(`unhandled flag ${arg}`);
    }
  }
  return opts;
}

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
Canonical JSON = recursively key-sorted. The digest is the lane's "nothing changed" key, so its
serialization must not depend on the insertion order a JSON.parse happened to produce in a mirror.
*/
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** First 16 hex of SHA-256 over canonical JSON — enough to key a lane tick, short enough to paste. */
export function digestOf(shape) {
  return createHash("sha256").update(canonicalJson(shape)).digest("hex").slice(0, 16);
}

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
`workflowStepResults` reaches a mirror in two shapes — the array the engine writes and a dict keyed
by step id seen on older/imported rows (the OD demands both be handled identically). Normalize to an
array, and for the dict form keep the key as the step id when the value omits one, so a dict row
never loses its identity to `undefined`.
*/
export function normalizeStepResults(value) {
  if (Array.isArray(value)) {
    return value.filter((row) => row && typeof row === "object").map((row) => ({ ...row }));
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, entry]) => entry && typeof entry === "object")
      .map(([key, entry]) => ({ ...entry, id: entry.id ?? key }));
  }
  return [];
}

/** Parse only full ISO stamps; a garbage stamp must never outrank a real one. */
function stampOf(row) {
  for (const key of ["completedAt", "startedAt", "createdAt"]) {
    const raw = row?.[key];
    if (typeof raw === "string" && raw.trim()) {
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return null;
}

/**
 * An AUTHORITATIVE row is one that can carry a merge decision. `output` alone is never one: an
 * interrupted prompt leaves output bytes with no verdict behind, which is the "(no feedback
 * captured)" shape that has already misled this lane.
 */
export function isAuthoritativeRow(row) {
  if (typeof row?.verdict === "string" && row.verdict.trim()) return true;
  if (row?.status === "passed" || row?.status === "failed") return true;
  return hasBypass(row);
}

/** Operator waiver evidence requires BOTH keys; one alone is a partial write, not a waiver. */
export function hasBypass(row) {
  return Boolean(row?.bypassedBy) && Boolean(row?.bypassedAt);
}

/** Classify one authoritative row into the lane's verdict vocabulary. */
export function classifyRow(row) {
  if (row?.status === "skipped" && hasBypass(row)) {
    return { kind: "covered-approval", note: "bypassed", stepId: stepIdOf(row) };
  }
  const verdict = typeof row?.verdict === "string" ? row.verdict.trim().toUpperCase() : "";
  if (verdict) {
    if (verdict.startsWith("APPROVE")) return { kind: "covered-approval", note: null, stepId: stepIdOf(row) };
    if (verdict === "REVISE" || verdict === "RETHINK" || verdict === "BLOCK" || verdict === "BLOCKING") {
      return { kind: "revise-blocked", note: null, stepId: stepIdOf(row) };
    }
  }
  if (row?.status === "passed") return { kind: "covered-approval", note: null, stepId: stepIdOf(row) };
  if (row?.status === "failed") return { kind: "revise-blocked", note: null, stepId: stepIdOf(row) };
  return { kind: "none", note: null, stepId: stepIdOf(row) };
}

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
`authorityVerdict` follows the card's verdict exactly as the card specifies (latest authoritative row
across current + prior attempts). `actionTaken` is the lane's own conservative mapping, and this is
the one place the two must differ. A card whose latest approval came from `plan-review` while its
`code-review` row is `skipped` with no verdict and four failed priors (measured on RUFU-343) is
`covered-approval` by the verdict rule — and printing `merge-ready` for it would be exactly the false
authority grant this card exists to make structurally impossible. So an action requires the CONTENT
gate to actually hold an approving row, unless that card's own workflow never enabled a code-review
step (`enabledWorkflowSteps` from the mirror — then the gate is `n-a`, not missing).
*/
export function codeReviewStateOf(rows, enabledWorkflowSteps) {
  const gateRows = rows.filter((row) => (stepIdOf(row) ?? "").includes("code-review"));
  let approval = false;
  let blocked = false;
  for (const row of gateRows) {
    if (!isAuthoritativeRow(row)) continue;
    const kind = classifyRow(row).kind;
    if (kind === "covered-approval") approval = true;
    if (kind === "revise-blocked") blocked = true;
  }
  if (!gateRows.length) {
    const gateEnabled = Array.isArray(enabledWorkflowSteps)
      ? enabledWorkflowSteps.some((id) => typeof id === "string" && id.includes("code-review"))
      : true;
    return { state: gateEnabled ? "absent" : "n-a", attempts: 0 };
  }
  const attempts = Math.max(...gateRows.map((row) => attemptsOf(row)));
  // No approval among existing gate rows is never a pass; `blocked` and `no-verdict` differ only in
  // what the operator sees, both refuse an action.
  if (approval) return { state: "pass", attempts };
  if (blocked) return { state: "blocked", attempts };
  return { state: "no-verdict", attempts };
}

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
A prior attempt can arrive in three shapes, and only ONE of them appears in production mirrors, so
reading just the obvious one is how stale authority silently stops counting:
1. TASK-level `priorAttempts` — measured absent on all 834 live mirrors, still honoured (each entry is
   either a whole prior task snapshot, so its results sit under `workflowStepResults`, or a
   step-result-shaped row itself).
2. STEP-RESULT-level `priorAttempts` — the shape the engine ACTUALLY writes: every gate row carries its
   own earlier attempts (measured: RUFU-343's `code-review` row is `skipped` with 4 failed priors, and
   prior #0 nests its own `priorAttempts` on top of that).
3. The dict form of `workflowStepResults` (older/imported rows), handled by normalizeStepResults.
So expansion is RECURSIVE, and because attempt N typically re-embeds attempts 1..N-1 the walk dedupes
on stamp+identity — otherwise the same failure would be counted several times and the digest would
grow without the lane changing.
*/
const MAX_ATTEMPT_DEPTH = 8;

/** Row identity, across every key the mirrors use for it. */
export function stepIdOf(row) {
  for (const key of ["workflowStepId", "stepId", "id"]) {
    if (typeof row?.[key] === "string" && row[key]) return row[key];
  }
  return null;
}

function attemptIdentity(row) {
  // Source-INDEPENDENT on purpose: a nested prior re-embedding its own earlier attempts reaches the
  // same content through a different source path, and identity that carries the path would report
  // one attempt several times (which would then move the laneDigest without the lane changing).
  return `${stepIdOf(row) ?? "-"}|${row?.status ?? "-"}|${row?.verdict ?? "-"}|${row?.completedAt ?? row?.startedAt ?? "-"}`;
}

function expandAttempts(row, source, depth, seen, out) {
  if (!row || typeof row !== "object") return;
  const key = attemptIdentity(row);
  if (!seen.has(key)) {
    seen.add(key);
    out.push({ ...row, _attemptSource: source });
  }
  if (depth >= MAX_ATTEMPT_DEPTH) return;
  const priors = Array.isArray(row.priorAttempts) ? row.priorAttempts : [];
  priors.forEach((entry, index) => {
    expandAttempts(entry, `${source}#${stepIdOf(row) ?? "gate"}~prior${index + 1}`, depth + 1, seen, out);
  });
}

export function collectEvidenceRows(task) {
  const seen = new Set();
  const out = [];
  for (const row of normalizeStepResults(task?.workflowStepResults)) {
    expandAttempts(row, "current", 0, seen, out);
  }
  const priors = Array.isArray(task?.priorAttempts) ? task.priorAttempts : [];
  priors.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const nested = normalizeStepResults(entry.workflowStepResults);
    if (nested.length > 0) {
      for (const row of nested) expandAttempts(row, `taskPrior${index + 1}`, 0, seen, out);
    } else {
      expandAttempts(entry, `taskPrior${index + 1}`, 0, seen, out);
    }
  });
  return out;
}

/** Attempts = 1 + len(priorAttempts): the current attempt is an attempt too. */
export function attemptsOf(container) {
  return 1 + (Array.isArray(container?.priorAttempts) ? container.priorAttempts.length : 0);
}

/** Latest authoritative verdict across the current row AND every prior attempt, ranked by full-ISO stamp. */
export function pickAuthoritative(rows) {
  let best = null;
  let bestStamp = null;
  for (const row of rows) {
    if (!isAuthoritativeRow(row)) continue;
    const stamp = stampOf(row);
    const effective = stamp ?? -1;
    if (best === null || effective >= bestStamp) {
      best = row;
      bestStamp = effective;
    }
  }
  if (!best) return { kind: "none", note: null, stepId: null, source: null, completedAt: null, attempts: null };
  const classified = classifyRow(best);
  return {
    ...classified,
    source: best._attemptSource ?? "current",
    completedAt: best.completedAt ?? null,
    attempts: attemptsOf(best),
  };
}

/** Bypass evidence anywhere (current row or any prior attempt) is enough to be operator-covered. */
export function bypassSeen(rows) {
  return rows.some((row) => hasBypass(row));
}

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
The wedge notification is an OBJECT with reasonKey / episodeId / status / transitionedAt /
lastNotifiedAtByReason. There is deliberately no scalar `lastNotifiedAt` on it — reading one returns
undefined and would print as an empty field, which is the §2c class of bug. Absence is tolerated: a
card with no wedge reads as an empty map, never as a crash and never as a fabricated reason.
*/
export const WEDGE_KEYS = Object.freeze(["reasonKey", "episodeId", "status", "transitionedAt", "lastNotifiedAtByReason"]);

export function wedgeMapOf(task) {
  const wedge = task?.wedgeNotification;
  if (!wedge || typeof wedge !== "object" || Array.isArray(wedge)) return {};
  const perReason = wedge.lastNotifiedAtByReason;
  const map = {};
  if (perReason && typeof perReason === "object" && !Array.isArray(perReason)) {
    for (const [reasonKey, notifiedAt] of Object.entries(perReason)) {
      map[reasonKey] = { status: "notified", notifiedAt: typeof notifiedAt === "string" ? notifiedAt : null };
    }
  }
  if (typeof wedge.reasonKey === "string" && wedge.reasonKey) {
    map[wedge.reasonKey] = {
      status: typeof wedge.status === "string" ? wedge.status : "unknown",
      transitionedAt: typeof wedge.transitionedAt === "string" ? wedge.transitionedAt : null,
    };
  }
  return map;
}

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463) — defect §2c:
`sourceAgentId`/`sourceType` are TOP-LEVEL on the task row (measured: 368 of 834 mirrors), while
`nearDuplicateOf` lives under `sourceMetadata`. The lane's anti-duplicate check read the agent id
from `sourceMetadata`, got null on 38/38 rows, and reported "cards filed by me: []" — a wrong-path
null presented as an empty result. So probe BOTH paths and print WHICH one hit; duplicates are
reported as printed facts, never as a recall rule the next tick has to remember.
*/
export function filedByOf(task) {
  const topLevel = typeof task?.sourceAgentId === "string" && task.sourceAgentId ? task.sourceAgentId : null;
  const meta = task?.sourceMetadata && typeof task.sourceMetadata === "object" ? task.sourceMetadata : null;
  const nearDuplicateOf = meta && typeof meta.nearDuplicateOf === "string" && meta.nearDuplicateOf
    ? meta.nearDuplicateOf
    : null;
  return {
    agentId: topLevel,
    sourceType: typeof task?.sourceType === "string" ? task.sourceType : null,
    path: topLevel ? "top-level" : null,
    nearDuplicateOf,
    nearDuplicatePath: nearDuplicateOf ? "sourceMetadata" : null,
    pausedReason: typeof task?.pausedReason === "string" && task.pausedReason ? task.pausedReason : null,
  };
}

/** One mirror per task directory, single-level only — the board's layout is `.fusion/tasks/<ID>/task.json`. */
export function listMirrorFiles(tasksDir) {
  if (!existsSync(tasksDir)) return { files: [], missingDir: true };
  const files = [];
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(tasksDir, entry.name, "task.json");
    if (existsSync(candidate)) files.push({ taskId: entry.name, path: candidate });
  }
  return { files, missingDir: false };
}

/**
 * Read every mirror. Unparseable mirrors are COUNTED and NAMED — never silently dropped — because a
 * census that quietly loses a card is exactly how a negative conclusion ("no approval anywhere") gets
 * fabricated from an incomplete read.
 */
export function readMirrors(tasksDir) {
  const { files, missingDir } = listMirrorFiles(tasksDir);
  const rows = [];
  const unparseable = [];
  for (const { taskId, path } of files) {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      unparseable.push({ taskId, reason: "json-parse" });
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      unparseable.push({ taskId, reason: "not-an-object" });
      continue;
    }
    rows.push(buildRow(parsed, taskId));
  }
  rows.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return { rows, mirrors: files.length, unparseable, missingDir };
}

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463) — print discipline (§1c):
buildRow precomputes EVERY field a print block will need, into that row's OWN object. The print loop
below then destructures per row. That is the structural fix for the leaked loop variable: there is no
outer `col`/`wn`/`srows` name for a later iteration to overwrite, so output cannot depend on corpus
order. The fixture suite proves it by swapping the corpus order and demanding identical per-row lines.
*/
export function buildRow(task, dirName) {
  const evidenceRows = collectEvidenceRows(task);
  const authoritative = pickAuthoritative(evidenceRows);
  const bypassed = bypassSeen(evidenceRows);
  const verdictKind = authoritative.kind === "none" && bypassed ? "covered-approval" : authoritative.kind;
  const gate = codeReviewStateOf(evidenceRows, task?.enabledWorkflowSteps);
  return {
    taskId: typeof task?.id === "string" && task.id ? task.id : dirName,
    dirName,
    column: typeof task?.column === "string" ? task.column : "",
    // Every print field above came from THIS task dict; nothing is inherited from a previous row.
    attempts: attemptsOf(task),
    gateAttempts: Math.max(gate.attempts, authoritative.attempts ?? 0),
    codeReview: gate.state,
    verdict: verdictKind,
    verdictNote: authoritative.kind === "none" && bypassed ? "bypassed" : authoritative.note,
    verdictStepId: authoritative.stepId,
    verdictSource: authoritative.source,
    verdictCompletedAt: authoritative.completedAt,
    bypassed,
    wedge: wedgeMapOf(task),
    filed: filedByOf(task),
    updatedAt: typeof task?.updatedAt === "string" ? task.updatedAt : null,
    branch: typeof task?.branch === "string" ? task.branch : null,
    status: typeof task?.status === "string" ? task.status : null,
    evidence: evidenceRows
      .filter((row) => isAuthoritativeRow(row))
      .map((row) => ({
        attempt: row._attemptSource ?? "current",
        stepId: stepIdOf(row),
        status: typeof row.status === "string" ? row.status : null,
        verdict: typeof row.verdict === "string" ? row.verdict : null,
        completedAt: typeof row.completedAt === "string" ? row.completedAt : null,
        bypassed: hasBypass(row),
      })),
    // Filled in by the ref probe; unknown until then, and never defaulted to a negative answer.
    refState: "unprobed",
    refTip: null,
    refOwnership: "unprobed",
    landed: false,
  };
}

/** The verdict a tick may act on: proven-landed beats everything, then the recorded gate verdict. */
export function dispositionVerdictOf(row) {
  return row.landed ? "landed" : row.verdict;
}

/** Lane aggregate. Any blocked card dominates; `landed`/approval only aggregate when nothing blocks. */
export function aggregateVerdict(rows) {
  if (rows.length === 0) return "none";
  const verdicts = rows.map(dispositionVerdictOf);
  if (verdicts.some((v) => v === "revise-blocked")) return "revise-blocked";
  if (verdicts.every((v) => v === "landed")) return "landed";
  if (verdicts.every((v) => v === "landed" || v === "covered-approval")) return "covered-approval";
  return "none";
}

/**
 * What the tick is allowed to DO. Deliberately more conservative than `authorityVerdict`: a
 * revise-blocked lane is a hold, and an approval that does not sit on the card's own CONTENT gate is
 * not merge authority — it is a reason to await review. `n-a` is the only state where a card
 * legitimately has no code-review gate (its own workflow never enabled one).
 */
export function actionTakenFor(aggregate, rows = []) {
  if (aggregate === "revise-blocked") return "hold";
  if (aggregate === "covered-approval") {
    const gateHolds = rows.every((row) => row.landed || row.codeReview === "pass" || row.codeReview === "n-a");
    return gateHolds ? "merge-ready" : "await-review";
  }
  return "none";
}

/** git plumbing, fixed argv. Never shell-interpolated, so a task id can never carry an argument. */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463) — defects §1b/§1d:
The unfiltered ref census is taken FIRST and its count gates every negative ref answer. A
`$`-anchored grep over a `--format=%(objectname)` list matched nothing while 46 refs lived, and a
text grep for an id hit a commit that merely mentions that id. So: (1) enumerate `%(refname)` alone;
(2) prove ownership by TRAILER VALUE equality (`Fusion-Task-Id:`/`Task-Id:` value equals the id),
never by a message that contains the id; (3) prove delivery by `merge-base --is-ancestor`. If the
census itself came back with zero refs, every negative answer it could have produced is recorded
`invalid` and non-authoritative — an unenumerable namespace is not an absent branch.
*/
export function refCensus(repo) {
  try {
    const out = git(repo, ["for-each-ref", "refs/heads/fusion/*", "--format=%(refname)"]);
    const names = out.split("\n").map((line) => line.trim()).filter(Boolean);
    return { count: names.length, names: new Set(names), ok: true };
  } catch {
    return { count: 0, names: new Set(), ok: false };
  }
}

/** git's trailer block: the final paragraph, every line a `Token: value` pair. Anything else is prose. */
export function parseTrailers(body) {
  const paragraphs = body.replace(/\r\n/g, "\n").split(/\n{2,}/);
  let last = null;
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const trimmed = paragraphs[i].trim();
    if (trimmed) { last = trimmed; break; }
  }
  if (!last) return {};
  const lines = last.split("\n").map((line) => line.trim()).filter(Boolean);
  const trailers = {};
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) return {};
    const key = match[1].toLowerCase();
    trailers[key] = trailers[key] ? `${trailers[key]};${match[2].trim()}` : match[2].trim();
  }
  return trailers;
}

/** Trailer VALUE equivalence only — a message that merely mentions an id proves nothing (§1b). */
export function refOwnedById(repo, refName, taskId, depth = 20) {
  try {
    const out = git(repo, ["log", `-n${depth}`, refName, "--format=%B%x1e"]);
    const wanted = taskId.toLowerCase();
    for (const record of out.split("\u001e")) {
      if (!record.trim()) continue;
      const trailers = parseTrailers(record);
      for (const key of ["fusion-task-id", "task-id"]) {
        const raw = trailers[key];
        if (!raw) continue;
        for (const value of raw.split(";")) {
          if (value.trim().toLowerCase() === wanted) return true;
        }
      }
    }
    return false;
  } catch {
    return null;
  }
}

export function refIsAncestorOfHead(repo, sha) {
  try {
    git(repo, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Attach ref state to one row. A zero-ref census makes every negative answer `invalid`. */
export function probeRow(repo, row, census) {
  if (!census.ok || census.count === 0) {
    row.refState = "invalid";
    row.refOwnership = "invalid";
    row.refInvalidReason = census.ok ? "zero-ref-census" : "ref-census-failed";
    return row;
  }
  const refName = `refs/heads/fusion/${row.taskId.toLowerCase()}`;
  if (!census.names.has(refName)) {
    row.refState = "absent";
    row.refOwnership = "absent";
    return row;
  }
  let tip = null;
  try {
    tip = git(repo, ["rev-parse", refName]).trim();
  } catch {
    row.refState = "probe-error";
    row.refOwnership = "probe-error";
    return row;
  }
  row.refTip = tip;
  row.refOwnership = refOwnedById(repo, refName, row.taskId) ? "trailer-match" : "no-trailer-match";
  row.landed = refIsAncestorOfHead(repo, tip);
  row.refState = row.landed ? "ancestor" : "present";
  return row;
}

/** Worktree inventory — unabbreviated, plus a single-level look at the rotating merge-scratch room. */
function worktreeInventory(repo) {
  const lines = [];
  try {
    const out = git(repo, ["worktree", "list", "--porcelain"]);
    for (const block of out.split("\n\n")) {
      const head = block.split("\n").find((line) => line.startsWith("worktree "));
      if (head) lines.push(head.slice("worktree ".length));
    }
  } catch {
    lines.push("<worktree-list-failed>");
  }
  const aiMerge = [];
  const room = join(repo, ".fusion", "worktrees", ".ai-merge");
  if (existsSync(room)) {
    // Single-level, non-recursive: AGENTS.md forbids walking a scratch root; rotating suffixes are normal.
    for (const entry of readdirSync(room, { withFileTypes: true })) aiMerge.push(entry.name);
  }
  return { worktrees: lines, aiMerge };
}

function readStamp(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStamp(path, stamp) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
}

/*
FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463) — defect §1c, the print surface itself:
One row, one pure formatter. It takes a row and returns ITS lines and holds no module-level or
closure state, so calling it in one order and then the reverse must yield the same line per card.
Both §1c incidents were a derived value (`col`, later `wn` + `srows`) bound in a collection loop and
read after it, which prints a card with ANOTHER card's column and verdict — and because readMirrors
sorts by taskId, a leaked binding survives as a deterministically-wrong report rather than a flaky
one. Exposing the formatter is what makes "corpus order cannot change a row's own line" assertible.
A mutation check was run against this test: reintroducing a carried-over column binding fails exactly
this case, so the assertion is not vacuous.
*/
export function formatRowLines(entry, { full = false } = {}) {
  // Every value below is read from THIS entry and nothing else.
  const disposition = dispositionVerdictOf(entry);
  const wedgeKeys = Object.keys(entry.wedge).sort().map((reasonKey) => `${reasonKey}=${entry.wedge[reasonKey].status}`).join(",") || "-";
  const lines = [`row taskId=${entry.taskId} column=${entry.column} verdict=${disposition}`
    + (entry.verdictNote ? ` note=${entry.verdictNote}` : "")
    + ` step=${entry.verdictStepId ?? "-"} codeReview=${entry.codeReview} gateAttempts=${entry.gateAttempts} attempts=${entry.attempts}`
    + ` ref=${entry.refState} owner=${entry.refOwnership} wedge=${wedgeKeys} updatedAt=${entry.updatedAt ?? "-"}`
    + (entry.refState === "invalid" ? " refProbe:invalid" : "")];
  if (full) {
    for (const ev of entry.evidence) {
      lines.push(`  evidence attempt=${ev.attempt} step=${ev.stepId ?? "-"} status=${ev.status ?? "-"} verdict=${ev.verdict ?? "-"} completedAt=${ev.completedAt ?? "-"} bypassed=${ev.bypassed}`);
    }
  }
  return lines;
}

/**
 * Run one census. `emit` receives each output line so tests capture the exact contract; the CLI
 * entry point pipes it to stdout, which is what the lane redirects with `2>&1`.
 */
export function runCensus(opts, emit) {
  const repo = resolve(opts.repo);
  const tasksDir = opts.tasksDir ? resolve(opts.tasksDir) : join(repo, ".fusion", "tasks");
  const laneRowsWanted = opts.task ? null : opts.lane;

  emit("SENTINEL-START");
  const { rows, mirrors, unparseable, missingDir } = readMirrors(tasksDir);
  emit(`mirrors: ${mirrors}`);
  if (missingDir) emit(`mirrors-dir-missing: ${tasksDir}`);
  // Unparseable mirrors are named on stdout: the lane reads stdout with 2>&1, and a silent gap is
  // how an incomplete read becomes a fabricated negative conclusion.
  for (const bad of unparseable) emit(`unparseable-mirror: ${bad.taskId} (${bad.reason})`);

  const census = refCensus(repo);
  const probeRows = opts.task
    ? rows.filter((row) => row.taskId.toUpperCase() === opts.task.toUpperCase())
    : rows.filter((row) => row.column === laneRowsWanted);
  for (const row of probeRows) probeRow(repo, row, census);

  const probeErrors = probeRows.filter((row) => row.refState === "probe-error").length;
  /*
  FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463) — defect §1d:
  A census that enumerated ZERO fusion/* refs cannot support a negative ref conclusion, whether the
  enumeration came back empty because it broke or because the namespace really is empty — the two are
  indistinguishable from here, and the §1d incident WAS a broken enumeration read as absence while 46
  refs lived. So an empty census marks every row `refProbe:invalid` and holds the run INCOMPLETE: the
  lane waits or escalates instead of concluding "branch absent". Over-conservative on a genuinely
  branchless repo, which is the correct side for a merge authority to err on.
  */
  const refProbeInvalid = census.ok && census.count === 0;
  const taskMissing = Boolean(opts.task) && probeRows.length === 0;
  const incomplete = unparseable.length > 0 || missingDir || probeErrors > 0 || !census.ok || refProbeInvalid || taskMissing;

  emit(`repo: ${repo}`);
  emit(`refCensus: ${census.count}${census.ok ? "" : " (FAILED)"}`);
  if (refProbeInvalid) emit("refProbe:invalid (zero-ref-census — no negative ref conclusion is authoritative)");
  if (!census.ok) emit("refProbe:invalid (ref census could not run)");
  if (taskMissing) emit(`task-not-found: ${opts.task}`);
  if (!opts.task) emit(`lane: ${opts.lane}`);
  emit(`laneRows: ${probeRows.length}`);

  /*
  FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463) — the print block itself (§1c):
  Each iteration destructures its OWN row and prints only from those bindings. Swapping the corpus
  order therefore cannot change a row's printed column or verdict.
  */
  for (const entry of probeRows) {
    // One row in, that row's lines out; the formatter holds no state (§1c).
    for (const line of formatRowLines(entry, { full: opts.full })) emit(line);
  }

  if (opts.full) {
    const { worktrees, aiMerge } = worktreeInventory(repo);
    emit(`worktrees: ${worktrees.length}`);
    for (const wt of worktrees) emit(`  worktree ${wt}`);
    emit(`aiMergeRooms: ${aiMerge.length}`);
    for (const roomName of aiMerge) emit(`  aiMerge ${roomName}`);
    printOwnFiled(rows, opts.agent, emit);
  }

  const aggregate = aggregateVerdict(probeRows);
  const actionTaken = actionTakenFor(aggregate, probeRows);
  /*
  FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
  The digest keys ONLY authority-relevant state — mirror count plus, per card, the lane column, the
  disposition verdict, every recorded verdict across current AND prior attempts with its stamp, bypass
  presence, the wedge reasonKey→status map, ref ancestry, and updatedAt. Run wall-clock time is
  deliberately absent, so two consecutive unchanged lane reads produce the identical digest.
  */
  const digestShape = {
    mirrors,
    lane: opts.task ? `task:${opts.task}` : laneRowsWanted,
    rows: probeRows.map((row) => ({
      taskId: row.taskId,
      column: row.column,
      verdict: dispositionVerdictOf(row),
      codeReview: row.codeReview,
      verdicts: row.evidence.map((ev) => ({
        attempt: ev.attempt,
        stepId: ev.stepId,
        verdict: ev.verdict,
        status: ev.status,
        completedAt: ev.completedAt,
        bypassed: ev.bypassed,
      })),
      bypassed: row.bypassed,
      wedge: Object.fromEntries(Object.keys(row.wedge).sort().map((k) => [k, row.wedge[k].status])),
      ref: row.refState,
      updatedAt: row.updatedAt,
    })),
  };
  const digest = digestOf(digestShape);
  emit(`laneDigest=${digest}`);

  if (opts.task) {
    /*
    FNXC:MergerLaneCensus 2026-11-04-02:55 (RUFU-463):
    A `--task` cross-check never touches the lane stamp. One card's digest is not the lane's digest,
    and letting the mandated second read overwrite the stamp would make the NEXT tick believe the
    whole lane was unchanged when only one card had just been looked at.
    */
    emit("stamp: not-read (single-card cross-check)");
  } else if (!opts.stamp) {
    emit("stamp: disabled (--no-stamp)");
  } else {
    const stateFile = opts.stateFile ? resolve(opts.stateFile) : join(repo, ".fusion", "state", "merge-census-stamp.json");
    const prior = readStamp(stateFile);
    const unchanged = prior?.digest === digest && prior?.mirrors === mirrors;
    emit(unchanged ? `unchanged: yes (stamped ${prior.writtenAt ?? "unknown"})` : "unchanged: no");
    try {
      writeStamp(stateFile, { digest, mirrors, writtenAt: new Date().toISOString() });
    } catch (error) {
      emit(`stamp-write-failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // EXACTLY one disposition line, always — this is the row the reflection pipeline consumes.
  emit(`disposition laneRows=${probeRows.length} authorityVerdict=${aggregate} actionTaken=${actionTaken}`);

  if (incomplete) {
    emit("incomplete: negative conclusions are FORBIDDEN for this run (unparseable mirrors, missing mirrors dir, or a failed ref probe)");
    return 1;
  }
  emit("SENTINEL-END");
  return 0;
}

/**
 * Own-filed cards, printed as FACTS with the path each hit came from (§2c). Bounded so `--full`
 * output cannot balloon past the long-term memory cap a tick may keep.
 */
function printOwnFiled(rows, agentFilter, emit) {
  const OWN_FILED_CAP = 100;
  const matches = [];
  let topLevelCount = 0;
  let metadataOnlyCount = 0;
  for (const row of rows) {
    const filed = { ...row.filed };
    if (filed.agentId) topLevelCount += 1;
    const matchesFilter = agentFilter ? filed.agentId === agentFilter : Boolean(filed.agentId || filed.nearDuplicateOf);
    if (!matchesFilter) continue;
    if (!filed.agentId && filed.nearDuplicateOf) metadataOnlyCount += 1;
    matches.push({ taskId: row.taskId, ...filed });
  }
  emit(`ownFiled filter=${agentFilter ?? "<any>"} matched=${matches.length} topLevelSourceAgentId=${topLevelCount} nearDuplicateOnly=${metadataOnlyCount}`);
  for (const match of matches.slice(0, OWN_FILED_CAP)) {
    emit(`  ownFiled taskId=${match.taskId} agent=${match.agentId ?? "-"} agentPath=${match.path ?? "none"} sourceType=${match.sourceType ?? "-"} nearDuplicateOf=${match.nearDuplicateOf ?? "-"} nearDuplicatePath=${match.nearDuplicatePath ?? "none"} pausedReason=${match.pausedReason ?? "-"}`);
  }
  if (matches.length > OWN_FILED_CAP) emit(`  ownFiled truncated: ${matches.length - OWN_FILED_CAP} more (raise --full filtering with --agent)`);
}

export function main(argv = [], { emit = (line) => console.log(line) } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      emit(`usage-error: ${error.message}`);
      emit(USAGE);
      return 2;
    }
    throw error;
  }
  if (opts.help) {
    emit(USAGE);
    return 0;
  }
  return runCensus(opts, emit);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
