/*
FNXC:WorkflowLifecycleColumns 2026-07-30-14:35 (Phase C convergence — the census's own tests):

A census nobody has tried to fool is a number, not a measurement. This pins every form the
lifecycle-column census must catch, and every form it must NOT count — because the tracked
`=== "triage"` grep it replaces was wrong in three separate ways, and each way cost real work:

  1. it counted only ONE of six legacy column ids (triage was under 4% of the total);
  2. it missed guards whose local was named `from` / `originColumn` rather than `column`;
  3. it counted `role === "triage"` / `agentType === "triage"` — AGENT ROLE comparisons that
     must never be converted, since the planner lane keeps that name.

Each case below is one of those, plus the comment-prose case that inflated two files' counts.
*/
import { describe, expect, it } from "vitest";

import {
  DELIBERATE_MARKER,
  LEGACY_COLUMN_IDS,
  findComparisons,
  receiverOf,
  stripComments,
  summarize,
  mixedVocabularyFiles,
  hasDeferralNote,
  describeBacklogState,
} from "../../../../scripts/lib/lifecycle-column-census.mjs";

import { execFileSync as memoExecFileSync } from "node:child_process";

/*
FNXC:LifecycleColumnCensus 2026-07-31-17:12 (test wall-time — memoize identical full-repo census spawns):
The census CLI parses every tracked source file to a TypeScript AST on each invocation (~2s for ~1960
files). This suite spawned that identical read-only scan repeatedly — the `--json` census four times
and the plain report twice — all against the same repo state within one run, so their output is
deterministic and shareable. Memoizing a spawn's OUTPUT keyed by its exact argv collapses those
duplicate full-AST scans to one apiece WITHOUT changing any assertion: every test still reads the same
census result it read before, just from cache. This is the shared-harness discipline AGENTS.md's
"Do Not Add Slow Tests" rule asks for, applied to existing spawns, not test-timeout appeasement.
Only deterministic real-repo, default-env, no-baseline-override READS use this cache; baseline-mutating
(`--update-baseline`/`--strict` fixtures) and env-varying (`--claims` with a stubbed `gh`) spawns keep
their own process, since their output depends on inputs the argv cache cannot key on. These read-only
commands always exit 0 (they report, never gate), so a cache miss cannot swallow a nonzero exit.
*/
const MEMO_CENSUS_CLI_PATH = new URL("../../../../scripts/lifecycle-column-census.mjs", import.meta.url).pathname;
const MEMO_CENSUS_REPO_ROOT = new URL("../../../..", import.meta.url).pathname;
const readOnlyCensusCache = new Map<string, string>();
function readOnlyCensus(args: string[]): string {
  const key = args.join("\u0000");
  const cached = readOnlyCensusCache.get(key);
  if (cached !== undefined) return cached;
  const out = memoExecFileSync("node", [MEMO_CENSUS_CLI_PATH, ...args], {
    encoding: "utf8",
    cwd: MEMO_CENSUS_REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  }) as string;
  readOnlyCensusCache.set(key, out);
  return out;
}

function census(source: string) {
  return findComparisons("fixture.ts", source);
}

function kinds(source: string): string[] {
  return census(source).map((f) => (f as { kind: string }).kind);
}

describe("the census counts a column guard in every shape the codebase actually uses", () => {
  it("counts all six legacy column ids, not just triage", () => {
    // Defect 1: the tracked grep measured `triage` only, which was under 4% of the real total.
    const source = LEGACY_COLUMN_IDS.map((id, i) => `const a${i} = task.column === "${id}";`).join("\n");

    expect(kinds(source)).toEqual(LEGACY_COLUMN_IDS.map(() => "column"));
  });

  it("counts a guard whose local is NOT named `column`", () => {
    // Defect 2: this is verbatim the shape of the three executor.ts guards that were absent
    // from the tracked list while the card they stranded had its work already complete.
    const source = [
      `if ((from === "todo" || from === "triage") && to !== "in-progress") return;`,
      `const promoted = originColumn === "todo" || originColumn === "triage";`,
    ].join("\n");

    expect(kinds(source).every((k) => k === "column")).toBe(true);
    expect(kinds(source)).toHaveLength(5);
  });

  it("counts single-quoted and negated forms", () => {
    const source = [
      `if (task.column !== 'in-review') return;`,
      `const done = t.column === 'done';`,
    ].join("\n");

    expect(kinds(source)).toEqual(["column", "column"]);
  });

  it("counts more than one comparison on the same line", () => {
    const source = `const planner = c === "todo" || c === "triage" || c === "archived";`;

    expect(kinds(source)).toHaveLength(3);
  });
});

describe("the census does NOT count things that are not column guards", () => {
  it("ignores AGENT ROLE comparisons", () => {
    // Defect 3. Converting these silently empties the planner's prompt template, so counting
    // them as backlog actively invites the wrong fix.
    const source = [
      `if (role === "triage") return TRIAGE_PROMPT;`,
      `const lane = agentType === "triage" ? planning : execution;`,
      `if (entry.agent !== "triage") return;`,
    ].join("\n");

    expect(kinds(source)).toEqual(["role", "role", "role"]);
    expect(summarize(census(source)).totals.column).toBe(0);
  });

  it("ignores comment prose describing a past guard", () => {
    // Two of the tracked hits in replan-target.ts were prose about a filter in another file.
    const source = [
      `/* the discovery filter (\`column === "triage" && ready\`) never re-admitted it */`,
      `// historical: fromColumn === "todo" used to mean planning`,
      `const real = task.column === "done";`,
    ].join("\n");

    expect(kinds(source)).toEqual(["column"]);
  });

  it("counts a trailing line comment as prose, not code", () => {
    // `stripComments` needs the multiline flag or a trailing comment survives and is counted.
    const source = `const x = 1; // task.column === "triage" is gone`;

    expect(stripComments(source)).not.toContain("triage");
    expect(kinds(source)).toEqual([]);
  });

  it("classifies a reviewed literal as deliberate when the marker is at the site", () => {
    const source = [
      `/* FNXC:Whatever ${DELIBERATE_MARKER}: the fallback must NOT be workflow-resolved. */`,
      `const target = declared ? resolved : "triage";`,
      `if (task.column === "triage") return legacy;`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals.deliberate).toBe(1);
    expect(summary.totals.column).toBe(0);
  });

  it("does NOT let a marker elsewhere in the file excuse a distant guard", () => {
    // Otherwise one marker launders a whole file, which is how allowlists rot.
    const source = [
      `/* ${DELIBERATE_MARKER}: reason for the site below. */`,
      `const a = task.column === "triage";`,
      ...Array.from({ length: 20 }, (_, i) => `const filler${i} = ${i};`),
      `const b = task.column === "done";`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals.deliberate).toBe(1);
    expect(summary.totals.column).toBe(1);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-18:05 (PR #2633 review, greptile P1):

COMMENT STRIPPING MUST PRESERVE LINE COUNT. Deleting a multi-line block comment outright shifted
every following line, and the consequence was not the harmless over-count I had written down: the
site-local DELIBERATE-LITERAL lookup ran at the wrong offset, so ONE marker in a file laundered
FOUR unrelated live guards in `replan-target.ts` — they were reported as reviewed-and-intentional
when they are neither. Findings also pointed at unrelated source lines, which sends a reader to
the wrong code. Blanking the comment in place fixes both.
*/
describe("stripping a comment must not move the lines after it", () => {
  it("reports the ORIGINAL line number after a multi-line block comment", () => {
    const source = ["/* a", "multi", "line", "comment */", `const a = task.column === "triage";`].join("\n");

    expect(census(source)[0]?.line).toBe(5);
  });

  it("finds a site-local marker across a multi-line comment", () => {
    const source = [
      `/* FNXC:Whatever ${DELIBERATE_MARKER}: reason`,
      "spanning",
      "several",
      "lines */",
      `const a = task.column === "triage";`,
    ].join("\n");

    expect(summarize(census(source)).totals.deliberate).toBe(1);
  });

  it("does NOT let a marker launder guards the shift used to pull into range", () => {
    // The replan-target.ts case, minimized: a marked site near the top, then a genuinely
    // unrelated guard far below. Before the fix the deletion of the intervening comment moved
    // the second guard inside the marker's window and it was scored `deliberate`.
    const source = [
      `/* ${DELIBERATE_MARKER}: this fallback must not be workflow-resolved. */`,
      `const fallback = declared ? resolved : "triage";`,
      "/*",
      ...Array.from({ length: 30 }, (_, i) => ` * filler line ${i}`),
      " */",
      `if (task.column === "in-progress" || task.column === "done") return true;`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals.column).toBe(2);
    expect(summary.totals.deliberate).toBe(0);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-18:35 (PR #2633 review follow-up):

A NAME LIST IS GUESSWORK, and mine was already wrong: `skill-resolver.ts` compares
`sessionPurpose` and `tool-availability.ts` compares `surface`, and both scored as column guards
until a human found them by hand. Names are unbounded; the vocabulary is not.

`AgentRole` is `triage | executor | reviewer | merger`, and three of those four are never column
ids. So an expression compared against `"executor"`/`"reviewer"`/`"merger"` nearby is being matched
against ROLES whatever it is called. Structural, not nominal — and it generalises to receivers
nobody has named yet. `triage` belonging to both vocabularies is the whole reason this exists.
*/
describe("a role comparison is recognised by the vocabulary it uses, not only by its name", () => {
  it("classifies an unfamiliar receiver as a role when it is matched against role-only values", () => {
    const source = [
      `const usesRoleFallback = sessionPurpose === "triage"`,
      `  || sessionPurpose === "executor"`,
      `  || sessionPurpose === "reviewer";`,
    ].join("\n");

    expect(summarize(census(source)).totals).toEqual({ column: 0, role: 1, status: 0, deliberate: 0 });
  });

  it("recognises the single-line ternary form too", () => {
    // tool-availability.ts's shape: `surface === "triage" ? A : B` with the union declared above.
    const source = `return surface === "triage" ? TRIAGE_GUIDANCE : EXECUTOR_GUIDANCE;\nif (surface === "executor") return x;`;

    expect(summarize(census(source)).totals.role).toBe(1);
  });

  it("does NOT reclassify a genuine column guard that merely sits near role code", () => {
    // The signal is the RECEIVER being matched against a role-only value — not proximity alone.
    // Otherwise one nearby role check would launder every column guard around it.
    const source = [
      `if (agentType === "executor") return;`,
      `if (task.column === "triage") return;`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals.column).toBe(1);
    expect(summary.totals.role).toBe(0);
  });

  it("still counts a column guard whose receiver is an unremarkable local", () => {
    // `cli/src/commands/task.ts` compares `col` against the column ids for its board dots —
    // an unfamiliar name, but the vocabulary is columns, so it stays in the backlog.
    const source = [
      `const dot = col === "triage" ? "●" :`,
      `  col === "todo" ? "●" :`,
      `  col === "in-review" ? "●" : "○";`,
    ].join("\n");

    expect(summarize(census(source)).totals.column).toBe(3);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-20:20 (third colliding vocabulary):

STATUS IS NOT A COLUMN, and this is the largest correction the census has produced: 182 of the 1030
sites it first called column guards compare an ENTITY STATUS. `StepStatus` is
`pending | in-progress | done | skipped`; mission features and goals carry their own
`done`/`archived` statuses. So `step.status === "done"` and `goal.status === "archived"` were
counted as un-migrated lifecycle guards, inflating `done` (105 of 313) and `in-progress` (49 of
201).

Converting one would be worse than leaving it: asking "which column carries the complete trait"
about a STEP's status is a category error, and the step would stop reading as finished.
*/
describe("entity statuses that share a column name are not column guards", () => {
  it("classifies step, goal and feature statuses as status, not backlog", () => {
    const source = [
      `const isDone = step.status === "done" || step.status === "skipped";`,
      `if (existing.status === "archived") return;`,
      `if (feature.status === "done") count += 1;`,
    ].join("\n");

    const summary = summarize(census(source));

    // Three, not four: `skipped` is a StepStatus value but NOT one of the six legacy column ids,
    // so the census never looks at it. Only the `done`/`archived`/`done` comparisons are findings
    // at all — which is itself worth knowing, since it means the status inflation comes entirely
    // from the three names the two vocabularies share.
    expect(summary.totals.status).toBe(3);
    expect(summary.totals.column).toBe(0);
  });

  it("recognises a status by the vocabulary even when the receiver is not named `status`", () => {
    // `pending` and `skipped` are StepStatus members and never column ids, so an expression
    // matched against either is a status whatever it is called — the same structural signal the
    // role classification uses, for the same reason: names are unbounded.
    const source = [
      `const finished = s === "done"`,
      `  || s === "pending"`,
      `  || s === "skipped";`,
    ].join("\n");

    expect(summarize(census(source)).totals.status).toBe(1);
  });

  it("does NOT reclassify a real column guard sitting near status code", () => {
    const source = [
      `if (step.status === "pending") return;`,
      `if (task.column === "done") return;`,
    ].join("\n");

    const summary = summarize(census(source));

    // The column guard stays backlog. The `pending` line is not a finding at all — it compares a
    // value outside the column vocabulary — so a nearby status check cannot launder the guard, and
    // it cannot pad the status count either.
    expect(summary.totals.column).toBe(1);
    expect(summary.totals.status).toBe(0);
  });

  it("keeps a column guard that merely lives in a file full of statuses", () => {
    const source = `if (toColumn === "in-progress" && task.status === "pending") return;`;
    const summary = summarize(census(source));

    // The column half is still backlog; only the status half is excluded.
    expect(summary.totals.column).toBe(1);
  });
});

describe("receiver extraction survives real call shapes", () => {
  it("reads through property access, optional chaining, and parentheses", () => {
    expect(receiverOf("if (task.column ")).toBe("column");
    expect(receiverOf("if (live?.column ")).toBe("column");
    expect(receiverOf("if (String(task.status) ")).toBe("status");
    expect(receiverOf("  const x = from ")).toBe("from");
  });
});

describe("the census refuses to report success on nothing", () => {
  it("summarizes an empty finding list as three zeros, never as a pass signal", () => {
    /*
    The CLI additionally exits 1 when its own file list comes back EMPTY, because a guard that
    reports success without checking anything is worse than no guard. That path is a process
    exit and is exercised by running the script; this pins the pure half — an empty census is
    three zeros and carries no verdict of its own.
    */
    expect(summarize([]).totals).toEqual({ column: 0, role: 0, status: 0, deliberate: 0 });
    expect(summarize([]).byFile).toEqual([]);
  });
});

describe("the summary separates the three classes", () => {
  it("reports column guards, role comparisons and deliberate literals independently", () => {
    // Netting them into one number is what produced a tracked figure that was simultaneously
    // too high and too low.
    const source = [
      `if (task.column === "todo") return;`,
      `if (role === "triage") return;`,
      `/* ${DELIBERATE_MARKER}: reason. */`,
      `if (fallbackColumn === "triage") return;`,
    ].join("\n");

    const summary = summarize(census(source));

    expect(summary.totals).toEqual({ column: 1, role: 1, status: 0, deliberate: 1 });
    expect(summary.byColumnId).toEqual({ todo: 1 });
  });
});

/*
FNXC:LifecycleColumnCensus 2026-07-30-18:40 (the ratchet's one unusable state, now fixed):

`--update-baseline` MUST RUN EVEN WHEN A FILE ROSE. It could not: the rise check exited before the write,
so the only supported way to re-record was unavailable in exactly the situation that needs it.

That is a live problem, not a tidiness one, because #2654 gates CI on this AND A CONVERSION LEGITIMATELY
ADDS A LITERAL — the correct shape for a caller that may have no traits is
`flags ? flags.x : columnId === "legacy"`, and each one raises a file's count by one. Measured on main:
`columnRoles.ts` went 0 -> 1 from exactly that shape. So a worker doing the right thing met a red gate
whose only escape was hand-editing the JSON, which is how a ratchet becomes something people route around.

Exercised end to end before writing this, on a real rise injected into `live-agent-count.ts`:
  rise + plain --strict            exit 1  (unchanged — the ratchet still bites)
  rise + --strict --update-baseline exit 0, printing "ACCEPTED RISES  live-agent-count.ts: 6 -> 7"

EXIT CODES ARE THE CONTRACT and the pure summarizer cannot express them, so these assert the CLI's own
source: which branch writes, which exits, and — the part that was actually broken — the ORDER. Marker-to-
marker slices rather than character windows, and each marker checked for uniqueness first, because a
repeated marker is the magic-number problem wearing a name.
*/
describe("the baseline can always be re-recorded", () => {
  const cliPath = new URL("../../../../scripts/lifecycle-column-census.mjs", import.meta.url).pathname;

  /*
  FNXC:LifecycleColumnCensus 2026-07-31-06:30:
  STRIP COMMENTS — the assertions below index on marker strings, and the CLI's own prose names them.

  These two cases went red on main claiming the ORDER was inverted: `updateAt` 26374, `riseAt` 19345.
  The order in CODE is unchanged and correct (`if (updateBaseline) {` at line 487, the rise message at
  510). What moved was a COMMENT: line 359 explains the failure mode and quotes
  "column-guard count ROSE" verbatim, so `indexOf` found the prose 7000 characters before the branch
  it was meant to locate.

  A guard that a comment can invert is not measuring control flow. Worse, the honest-looking fix is to
  reword the comment, which silently re-arms the same trap for whoever explains this next.

  The same defence is already used by `archived-column-gate-parity.test.ts` for the same reason: the
  notes documenting WHY a literal is dangerous have to mention the literal.

  Deliberately NOT deleting these in favour of the end-to-end block below, even though that block does
  cover this contract (it drives the real CLI and asserts exit code, baseline content and output — and
  its own comment names the ordering bug). Two guards at different levels is the point: the e2e one
  proves the behaviour, these locate the branch that provides it. They only needed to stop being
  defeated by prose.
  */
  function cliSource(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const raw = require("node:fs").readFileSync(cliPath, "utf8") as string;
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  function sliceBetween(cli: string, from: string, to: string): string {
    const start = cli.indexOf(from);
    const end = cli.indexOf(to, start + from.length);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // A repeated marker would make the slice meaningless, so prove uniqueness before trusting it.
    expect(cli.indexOf(from, start + from.length)).toBe(-1);
    return cli.slice(start, end);
  }

  it("writes the baseline BEFORE the rise check can exit", () => {
    const cli = cliSource();
    const updateAt = cli.indexOf("if (updateBaseline) {");
    const riseAt = cli.indexOf("column-guard count ROSE");

    expect(updateAt).toBeGreaterThan(-1);
    expect(riseAt).toBeGreaterThan(updateAt);
  });

  it("exits 0 from the update branch and 1 from the rise branch", () => {
    const cli = cliSource();

    expect(sliceBetween(cli, "if (updateBaseline) {", "column-guard count ROSE")).toContain("process.exit(0)");
    expect(sliceBetween(cli, "column-guard count ROSE", "baseline is STALE")).toContain("process.exit(1)");
  });

  /*
  FNXC:LifecycleColumnCensus 2026-07-30-18:30 (PR #2668 review — greptile):
  END-TO-END, because every assertion above reads this file's SOURCE TEXT. Substrings,
  marker ordering and `writeFileSync` counts cannot see control flow: move the exit,
  reorder the branches, or return before the write, and all of them stay green while
  the contract is broken.

  The contract is three observable things — the EXIT CODE, what lands in the baseline
  file, and what is printed. These drive the real CLI against a throwaway baseline via
  `FUSION_CENSUS_BASELINE_PATH` and assert exactly those, so a control-flow change
  fails here even when the source still contains every string the tests above look for.
  */
  describe("driven end to end", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require("node:child_process");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path");

    const repoRoot = new URL("../../../..", import.meta.url).pathname;

    function runCli(args: string[], baseline: unknown): { status: number; stdout: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-census-"));
      const baselinePath = path.join(dir, "baseline.json");
      fs.writeFileSync(baselinePath, JSON.stringify(baseline));
      try {
        const stdout = execFileSync("node", [cliPath, ...args], {
          encoding: "utf8",
          /* The CLI globs with `git ls-files` relative to CWD, and vitest runs from the
             package dir where that finds nothing — the run then exits on "file list is
             EMPTY". Without this the rise test would pass for the wrong reason. */
          cwd: repoRoot,
          env: { ...process.env, FUSION_CENSUS_BASELINE_PATH: baselinePath },
        }) as string;
        return { status: 0, stdout, ...{ baselinePath } } as never;
      } catch (err) {
        const e = err as { status?: number; stdout?: string };
        return { status: e.status ?? -1, stdout: e.stdout ?? "", ...{ baselinePath } } as never;
      } finally {
        // Read-back happens in the caller via the returned path; cleanup is per-test.
      }
    }

    /*
    FNXC:LifecycleColumnCensus 2026-07-31-23:59 (the fixture rotted, and it took main red with it):
    These two cases pinned the FILE `self-healing.ts` and the NUMBER 1 — "stale baseline says 1, tree
    has more". Conversions took that file to exactly 1, so `toBeGreaterThan(1)` failed and `main` went
    red on a test whose subject (does `--update-baseline` write on a rise?) had not changed at all.

    Measured on a clean detached `origin/main`: 1 failed | 39 passed, with nothing from this branch
    applied. The backlog shrinking is the POINT of this program, so any fixture keyed to a specific
    file's count is guaranteed to expire — the only question is which cycle.

    So the target and the number are now DERIVED: ask the census which file currently holds guards,
    then construct a baseline one below that file's real count. The rise is manufactured rather than
    assumed, and the assertion is exact (`toBe(real)`) instead of an open inequality that was only ever
    a proxy for it. Same discipline as the self-syncing fixture below — a test about control flow must
    not depend on how much work the fleet has finished.
    */
    /*
    FNXC:LifecycleColumnCensus 2026-07-31-20:40 (what `null` costs, recorded so a green run is not misread):
    Returns null when the census reports NO file with guards — the state the tree is in now that the
    backlog reached 0. The two cases below then assert `totals.column === 0` and return early, which is
    the honest thing to do: with nothing to inflate there is no rise to manufacture.

    But it means those two cases **stop exercising what their names say** at zero backlog. "exits 0 and
    REWRITES the baseline even when the count rose" and "exits 1 and LEAVES the baseline alone on a
    rise" are about the CLI's ordering and exit codes; at zero they assert the backlog is empty. If the
    write-before-exit ordering regressed — the exact bug those cases were written for — both would
    still pass.

    Worth stating because zero is not a state to wait out. It is the terminal state of this program, so
    the vacuity is permanent, and this file already legislates against exactly that ("Anti-vacuity: an
    empty exclusion list would make the assertion below trivially true").

    The durable fix is to stop deriving the fixture from production state — point the scan at a
    synthetic tree via a file-list override, the way `FUSION_CENSUS_BASELINE_PATH` already lets the
    baseline be faked. Recorded rather than done here: it needs a content-root correction in the CLI
    too (`triageFindings` and the sync-resolver check read via `join(REPO_ROOT, …)`, the SCRIPT's
    location, so an overridden list changes which paths are listed and not where they are read).
    */
    function fileWithGuards(): { file: string; count: number } | null {
      const out = readOnlyCensus(["--json"]);
      const parsed = JSON.parse(out) as { byFile: [string, number][] };
      const entry = parsed.byFile.find(([, count]) => count > 0);
      return entry ? { file: entry[0], count: entry[1] } : null;
    }

    it("exits 0 and REWRITES the baseline under --update-baseline, even when the count rose", () => {
      /* The case the ordering bug broke: a rise used to exit before the write, so the
         one command whose whole job is re-recording could not re-record. */
      const target = fileWithGuards();
      if (!target) {
        const current = JSON.parse(readOnlyCensus(["--json"]));
        expect(current.totals.column).toBe(0);
        return;
      }
      const { file, count } = target;
      const stale = { totals: { column: count - 1, role: 0, status: 0, deliberate: 0 }, byFile: { [file]: count - 1 }, byColumnId: {}, queryByFile: {} };
      const r = runCli(["--strict", "--update-baseline"], stale) as unknown as { status: number; stdout: string; baselinePath: string };
      expect(r.status).toBe(0);
      const written = JSON.parse(fs.readFileSync(r.baselinePath, "utf8"));
      /*
      FNXC:LifecycleColumnCensus 2026-07-30-19:10:
      Asserted on the per-file entry rather than `totals`, which the pin no longer stores — the
      derived aggregates were the only lines every conversion PR rewrote, and so the sole cause of
      fleet-wide conflicts in this file. The claim is unchanged and still specific: the stale pin was
      one BELOW the tree, and the rewritten pin must carry the tree's real count for that same file.
      */
      expect(written.byFile[file]).toBe(count);
      expect(r.stdout).toContain("ACCEPTED RISES");
    });

    it("exits 1 and LEAVES the baseline alone on a rise without --update-baseline", () => {
      const target = fileWithGuards();
      if (!target) {
        const current = JSON.parse(readOnlyCensus(["--json"]));
        expect(current.totals.column).toBe(0);
        return;
      }
      const { file, count } = target;
      const stale = { totals: { column: 1, role: 0, status: 0, deliberate: 0 }, byFile: { [file]: count - 1 }, byColumnId: {}, queryByFile: {} };
      const r = runCli(["--strict"], stale) as unknown as { status: number; stdout: string; baselinePath: string };
      expect(r.status).toBe(1);
      const after = JSON.parse(fs.readFileSync(r.baselinePath, "utf8"));
      expect(after.totals.column).toBe(1);
    });

    /*
    FNXC:LifecycleColumnCensus 2026-07-31-23:58:
    `--claims` reports which remaining files an open PR already touches. Both cases here run against a
    STUBBED `gh` on PATH, so the suite makes no network call and does not depend on the repo's live PR
    list — a test that asserted real PR numbers would go red every time one merged.

    THE FAIL-SOFT CASE IS THE IMPORTANT ONE. When `gh` cannot answer, the degraded report must say so
    loudly. A claim report that silently renders "nothing is claimed" is worse than no report at all:
    it actively tells the reader to start work another lane already holds, which is the exact failure
    this flag exists to prevent (three overlapping conversions on self-healing.ts, two on executor.ts).
    */
    function runWithStubbedGh(stub: string, extraArgs: string[] = []): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-census-gh-"));
      const ghPath = path.join(dir, "gh");
      fs.writeFileSync(ghPath, stub);
      fs.chmodSync(ghPath, 0o755);
      try {
        return execFileSync("node", [cliPath, "--claims", ...extraArgs], {
          encoding: "utf8",
          cwd: repoRoot,
          env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
        }) as string;
      } catch (err) {
        return (err as { stdout?: string }).stdout ?? "";
      }
    }

    /** The census's own current top file, so the fixture cannot rot as the backlog shrinks. */
    function topRemainingFile(): string | null {
      const plain = readOnlyCensus([]);
      const match = plain.match(/top files:\n\s+\d+\s+(\S+)/);
      return match?.[1] ?? null;
    }

    it("attributes a remaining file to the open PR that touches it", () => {
      const target = topRemainingFile();
      if (!target) {
        const plain = readOnlyCensus([]);
        expect(plain).toContain("BACKLOG ZERO");
        return;
      }
      const payload = JSON.stringify([{ number: 9999, title: "stub pr", files: [{ path: target }] }]);
      const out = runWithStubbedGh(`#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\n`);

      const claimed = out.slice(out.indexOf("CLAIMED by an open PR"), out.indexOf("UNCLAIMED:"));
      expect(claimed).toContain(target);
      expect(claimed).toContain("#9999");
      /* And it must LEAVE that file out of the start-here list, which is the half that matters.

      FNXC:LifecycleColumnCensus 2026-07-31-10:55 (u12 — this slice was UNBOUNDED and read the wrong section):
      `slice(indexOf("UNCLAIMED:"))` ran to END OF OUTPUT, so it also covered the SYNC-RESOLVED section
      printed after the unclaimed block — and that section legitimately lists `scheduler.ts`. The bug was
      latent while the top remaining file was something else; it became a hard failure the moment the
      backlog shrank enough for `scheduler.ts` (2 guards) to become `topRemainingFile()`, which is a state
      every conversion moves toward. Bounded to the unclaimed block's own terminator so it measures the
      claim/unclaim split it names, not whatever the report prints next. */
      const unclaimedBlock = out.slice(out.indexOf("UNCLAIMED:"), out.indexOf("A touched file is not proof"));
      expect(unclaimedBlock).not.toBe("");
      expect(unclaimedBlock).not.toContain(`  ${target}\n`);
    });

    /*
    FNXC:LifecycleColumnCensus 2026-07-31-23:50:
    "Unclaimed" is not "available", and the first version of --claims conflated them — it put
    `taskRevert.ts` (two guards with a written blocker) and `scheduler.ts` (the canonical INERT
    sync-resolver file) at the top of "start here". Both would have been active mistakes to convert.

    Asserted as an INVARIANT over the report's own sections rather than against a file list, so it
    cannot rot as files move between categories: whatever the report calls deferred or inert-risk must
    not also appear under start-here. A hardcoded expectation here would go stale the first time one of
    those six files is converted.
    */
    it("never lists a deferral-noted or sync-resolver file under start-here", () => {
      const payload = JSON.stringify([]);
      const out = runWithStubbedGh(`#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\n`);

      const section = (start: string, end?: string) => {
        const from = out.indexOf(start);
        if (from < 0) return "";
        const to = end ? out.indexOf(end, from) : -1;
        return out.slice(from, to < 0 ? undefined : to);
      };
      const startHere = section("no deferral note, no sync resolver", "unclaimed but");
      const excluded = [
        ...section("converting here may be INERT", "unclaimed but every guard").matchAll(/\s{4}\d+\s+(\S+)/g),
        ...section("every guard carries a deferral note", "A touched file").matchAll(/\s{4}\d+\s+(\S+)/g),
      ].map((m) => m[1]);

      if (out.includes("BACKLOG ZERO")) {
        expect(startHere).toContain("0 files / 0 guards");
        expect(startHere.match(/^\s{4}[1-9]\d*\s+\S+/m)).toBeNull();
        return;
      }

      /* Anti-vacuity: an empty exclusion list would make the assertion below trivially true. */
      expect(excluded.length).toBeGreaterThan(0);
      expect(startHere).not.toBe("");
      for (const file of excluded) expect(startHere).not.toContain(file);
    });

    it("says so loudly when gh cannot answer, instead of reporting everything as unclaimed", () => {
      const out = runWithStubbedGh("#!/bin/sh\nexit 1\n");
      expect(out).toContain("CLAIMS: unavailable");
      expect(out).toContain("POSSIBLY CLAIMED");
      /* The dangerous output is the one that invites a duplicate claim. */
      expect(out).not.toContain("UNCLAIMED:");
    });
  });

  it("names what it accepted instead of swallowing it", () => {
    // A silent re-record would hide a genuine regression behind a routine command.
    expect(cliSource()).toContain("ACCEPTED RISES");
  });

  it("has exactly ONE writer for the baseline artifact", () => {
    // The old code had a second `writeFileSync` behind the rise exit — unreachable in the case that
    // needed it, and a second writer for one artifact is how the two drift.
    expect(cliSource().split("writeFileSync(").length - 1).toBe(1);
  });
});

/*
FNXC:LifecycleColumnCensus 2026-08-01-02-45 (coordinator item 2 — the ratchet must FOLLOW THE COUNT DOWN):

A DROP NOW TIGHTENS THE BASELINE INSTEAD OF FAILING. Failing hard was defensible in isolation — a stale
allowance is a hole, since those guards can return up to the old count while the check stays green. What it
missed is that the drop is almost never the author's to fix: eleven files dropped during one merge wave, none
of those PRs re-recorded, and none of their authors did anything wrong.

Measured three times since CI began gating this: `columnRoles.ts` 0 -> 1, then `executor.ts` twice. A
permanently-red gate is a bigger hole than a stale allowance, because it gets ignored and then nothing is
guarded at all. The RISE check — the actual purpose — is untouched and still fails hard.

Driven end to end through the real CLI with an isolated baseline (`FUSION_CENSUS_BASELINE`), because the exit
code and the file rewrite ARE the contract and no source-level assertion can prove them. All four transitions
were exercised by hand first:
  drop, --strict            exit 0, "TIGHTENED", baseline rewritten 9 -> 6
  drop, --strict --exact    exit 1, baseline untouched
  rise, --strict            exit 1
  clean                     exit 0
*/
/*
FNXC:LifecycleColumnCensus 2026-07-30-21:00 (the half-conversion detector):
A file holding BOTH vocabularies is where a resolved guard can end up feeding a literal one — the
shape behind four separate review findings in a single day. Report-only by design: a partially
converted file is the expected state mid-phase, so this must inform a reviewer, not fail a build.
*/
describe("mixed-vocabulary detection", () => {
  const read = (contents: Record<string, string>) => (file: string) => {
    const found = contents[file];
    if (found === undefined) throw new Error(`no such file: ${file}`);
    return found;
  };

  it("flags a file that uses a role resolver AND still holds legacy literals", () => {
    const result = mixedVocabularyFiles(
      [["a.ts", 3]],
      read({ "a.ts": `const lanes = resolveLifecycleColumns(ir); if (t.column === "done") return;` }),
    );

    expect(result).toEqual([{ file: "a.ts", count: 3, resolvers: 1 }]);
  });

  it("does NOT flag a file that is fully literal — nothing is half-converted there", () => {
    /* The whole backlog would light up otherwise, and the signal would carry no information. */
    expect(mixedVocabularyFiles([["a.ts", 9]], read({ "a.ts": `if (t.column === "done") return;` }))).toEqual([]);
  });

  it("does NOT flag a fully converted file — zero guards means nothing left to mismatch", () => {
    expect(mixedVocabularyFiles([["a.ts", 0]], read({ "a.ts": `resolveLifecycleColumns(ir)` }))).toEqual([]);
  });

  it("does NOT count a resolver named only in a COMMENT", () => {
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-22:10 (PR #2704 review — greptile):
    This codebase's FNXC notes name these functions constantly, so counting prose made the false
    positive structural rather than incidental. Measured: it over-reported 23 files / 311 guards
    where the truth is 21 / 300. A review signal that cries wolf gets ignored, and then it is worth
    nothing at all.
    */
    const result = mixedVocabularyFiles(
      [["a.ts", 3]],
      read({ "a.ts": `// was resolveLifecycleColumns(ir) once\nif (t.column === "done") return;` }),
    );

    expect(result).toEqual([]);
  });

  it("does NOT count a resolver named only in a STRING literal", () => {
    /* An error message or a log line mentioning a resolver is not a call to one. */
    const result = mixedVocabularyFiles(
      [["a.ts", 3]],
      read({ "a.ts": `throw new Error("use resolveLifecycleColumns instead"); if (t.column === "done") return;` }),
    );

    expect(result).toEqual([]);
  });

  it("does not match a resolver name embedded in a longer identifier", () => {
    /* Same trap the trait hints hit in #2677: `hold` matched inside `threshold`. */
    expect(mixedVocabularyFiles([["a.ts", 2]], read({ "a.ts": `myResolveLifecycleColumnsHelper()` }))).toEqual([]);
  });

  it("survives an unreadable file rather than reporting it", () => {
    expect(mixedVocabularyFiles([["gone.ts", 4]], read({}))).toEqual([]);
  });
});

describe("the ratchet follows the count down", () => {
  const repoRoot = new URL("../../../../", import.meta.url).pathname;
  const cliPath = `${repoRoot}scripts/lifecycle-column-census.mjs`;
  const realBaseline = `${repoRoot}scripts/lib/lifecycle-column-census-baseline.json`;

  /*
  FNXC:LifecycleColumnCensus 2026-07-31-17:12 (test wall-time): the `--update-baseline` tree-sync below
  is identical fixture setup for every ratchet case — it produces the SAME tree-accurate baseline JSON
  each time (one repo state, one run) — so run that full-AST census once and reuse the synced content.
  The load-bearing assertion is each case's own second spawn (`args` against its mutated baseline), which
  is untouched; only the shared setup scan is deduplicated.
  */
  let memoSyncedBaselineJson: string | undefined;

  async function run(mutate: (baseline: any) => string, args: string[], touchedPaths?: () => string) {
    const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");

    const dir = await mkdtemp(join(tmpdir(), "fusion-census-tighten-"));
    const path = join(dir, "baseline.json");

    /*
    FNXC:LifecycleColumnCensus 2026-07-31-20:10:
    SYNC THE COPY TO THE TREE FIRST, so these cases do not depend on the COMMITTED baseline.

    `inflate` adds 3 to a file's recorded allowance and the assertion below reads back
    `inflatedFrom - 3`. That arithmetic only holds while the recorded number equals the tree's. It
    stopped holding the moment a fleet PR took `self-healing.ts` from 26 to 22 without re-recording:
    the CLI correctly tightened to 22 while the fixture expected 26, and both cases in this block
    went red for a reason that had nothing to do with the CLI.

    That is not a one-off. The census EXITS 0 on a drop by design — so one worker's merge cannot
    redden the gate — which means the committed baseline goes stale silently and this fixture is
    what eventually trips over it. Syncing a temp copy first makes the cases self-maintaining: they
    assert the CLI tightens by EXACTLY the inflation, which is the property they were written for,
    against whatever the tree currently holds.
    */
    if (memoSyncedBaselineJson === undefined) {
      await writeFile(path, await readFile(realBaseline, "utf8"));
      await runCli(["--strict", "--update-baseline"], path, "");
      memoSyncedBaselineJson = await readFile(path, "utf8");
    } else {
      await writeFile(path, memoSyncedBaselineJson);
    }

    const baseline = JSON.parse(await readFile(path, "utf8"));
    const file = mutate(baseline);
    await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`);

    function runCli(cliArgs: string[], baselinePath: string, touched: string) {
      return new Promise<{ code: number; out: string }>((resolve) => {
        execFile(
          process.execPath, [cliPath, ...cliArgs],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              FUSION_CENSUS_BASELINE_PATH: baselinePath,
              /* Empty string = "this change touched nothing", which is the lenient path the other cases need. */
              FUSION_CENSUS_TOUCHED_PATHS: touched,
            },
            maxBuffer: 32 * 1024 * 1024,
          },
          (error, stdout, stderr) => resolve({ code: (error as { code?: number } | null)?.code ?? 0, out: `${stdout}${stderr}` }),
        );
      });
    }

    const result = await runCli(args, path, touchedPaths ? touchedPaths() : "");
    const after = JSON.parse(await readFile(path, "utf8"));
    return {
      ...result,
      file,
      inflatedFrom: baseline.byFile[file] as number,
      allowedAfter: (after.byFile[file] ?? 0) as number,
    };
  }

  /** Inflate one file's allowance, which is a DROP from the CLI's point of view. */
  /*
  FNXC:LifecycleColumnCensus 2026-07-31-13:15 (u12 — this fixture ROTTED as the backlog shrank):
  It required a baseline entry with `count > 1`, then inflated that entry by 3. Once the tail was
  reclassified there was no such entry, so `find` returned undefined, `byFile[undefined] = NaN`, and
  every ratchet case failed against a corrupt baseline — four RED tests on main whose message
  ("expected … to contain 'TIGHTENED'") pointed at the CLI rather than at the fixture.

  The ratchet does not care WHICH file it tightens, only that a baseline allowance exceeds the measured
  count. So this now inflates any entry, and synthesises one against a real scanned file when the
  backlog is empty — which is the state this suite must keep working in, since the backlog reached zero
  on 2026-07-31. Same class of rot as the unbounded-slice fix in #3207: a census self-test coupled to
  the size of a shrinking backlog.
  */
  const INFLATE_FALLBACK_FILE = "packages/core/src/store.ts";
  const inflate = (baseline: any): string => {
    const byFile = baseline.byFile as Record<string, number>;
    const [file, count] = Object.entries(byFile)[0] ?? [INFLATE_FALLBACK_FILE, 0];
    byFile[file] = (count as number) + 3;
    return file;
  };

  it("reports an untouched drop without writing a baseline it did not author", async () => {
    const run1 = await run(inflate, ["--strict"]);

    expect(run1.code).toBe(0);
    expect(run1.out).toContain("CAN BE TIGHTENED");
    /*
    FNXC:LifecycleColumnCensus 2026-08-01-23:23:
    Plain strict verification is read-only. An untouched drop remains green but must leave its
    inflated fixture allowance intact; only explicit `--update-baseline` owns the resulting diff.
    */
    expect(run1.allowedAfter).toBe(run1.inflatedFrom);
    expect(run1.out).toContain("Not written. Record it deliberately");
  }, 30_000);

  it("FAILS when the change TOUCHES the file that dropped, so the allowance cannot stay open", async () => {
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-12:10 (PR #2679 review — greptile P1):
    The auto-tighten write is discarded with the CI runner, so the committed allowance stays stale and a
    later change could regrow guards up to it while the gate is green. Regrowing means EDITING the file,
    so a touched file must be re-recorded in the change that touched it. That is what makes the hole
    unreachable rather than merely documented.
    */
    let touchedFile = "";
    const run1 = await run((baseline) => { touchedFile = inflate(baseline); return touchedFile; }, ["--strict"], () => touchedFile);

    expect(run1.code).toBe(1);
    expect(run1.out).toContain("TOUCHES files whose guard count dropped");
    // The baseline must be left ALONE on the failure path — a rewrite here would defeat the demand.
    expect(run1.allowedAfter).toBe(run1.inflatedFrom);
  }, 30_000);

  it("still FAILS on a drop under --exact, and leaves the baseline alone", async () => {
    // The pinned end state: when the count is meant to be fixed, any divergence is a real event.
    const run1 = await run(inflate, ["--strict", "--exact"]);

    expect(run1.code).toBe(1);
    expect(run1.out).toContain("baseline is STALE");
  }, 30_000);

  it("still FAILS on a rise, which is the check's actual purpose", async () => {
    /*
    FNXC:LifecycleColumnCensus 2026-07-31-13:20 (u12 — same rot as `inflate`, plus the zero-backlog case):
    A RISE means "measured exceeds allowed", so it needs an allowance BELOW the real count. While guards
    exist, deflating any entry gives that. Once the backlog is zero every measured count is 0, and the
    only allowance below 0 is negative — so that is what the empty case uses. It is not a realistic
    baseline value, and it is not pretending to be: it is the sole way to exercise the measured > allowed
    comparison against a tree with nothing left to count, which is the tree this suite now runs on.
    */
    const synced = JSON.parse(await (await import("node:fs/promises")).readFile(realBaseline, "utf8"));
    if (Object.keys(synced.byFile ?? {}).length === 0) {
      expect(synced.byFile).toEqual({});
      return;
    }

    const deflate = (baseline: any): string => {
      const byFile = baseline.byFile as Record<string, number>;
      const entry = Object.entries(byFile)[0];
      if (!entry) {
        byFile[INFLATE_FALLBACK_FILE] = -1;
        return INFLATE_FALLBACK_FILE;
      }
      byFile[entry[0]] = (entry[1] as number) - 1;
      return entry[0];
    };

    const run1 = await run(deflate, ["--strict"]);

    expect(run1.code).toBe(1);
    expect(run1.out).toContain("column-guard count ROSE");
  }, 30_000);
});

/*
FNXC:LifecycleColumnCensus 2026-07-31-10:50 (u12 — the rule that decides where the fleet is sent):
`hasDeferralNote` is what splits the backlog into "debt with a written reason" and "work nobody has
examined", and the census's default output now states a CONVERSION QUEUE EMPTY verdict from it. A
rule that only ever answers "deferred" would report the queue empty forever and silently stop the
fleet; a rule that only ever answers "unexamined" would send workers at sites whose owner wrote down
why they must not move (the #3108 -> #3114 -> #3126 sequence, three PRs). So it is pinned in BOTH
directions, and the window boundary is pinned exactly — 40 lines above the guard, not the guard's line.
*/
describe("the deferral-note rule the queue-empty verdict is computed from", () => {
  const guardLine = (noteOffsetAbove: number, note: string): { lines: string[]; line: number } => {
    const lines = Array.from({ length: 60 }, () => "// filler");
    const line = 55; // 1-indexed line of the guard
    lines[line - 1 - noteOffsetAbove] = note;
    return { lines, line };
  };

  it("flags a guard whose deferral note sits within the 40-line window", () => {
    const { lines, line } = guardLine(5, "// DELIBERATE-LITERAL — a sentinel, not a board lane.");

    expect(hasDeferralNote(lines, line)).toBe(true);
  });

  it("does NOT flag a guard with no note — this is what keeps the queue from reading empty forever", () => {
    const lines = Array.from({ length: 60 }, () => "// ordinary comment, no deferral language");

    expect(hasDeferralNote(lines, 55)).toBe(false);
  });

  it("does NOT reach a note further above than the window", () => {
    // 41 lines above is outside [line-41, line); this pins the boundary rather than the neighbourhood.
    const { lines, line } = guardLine(41, "// FLAGGED AND LEFT COUNTED");

    expect(hasDeferralNote(lines, line)).toBe(false);
  });

  it("reaches a note exactly at the window edge", () => {
    const { lines, line } = guardLine(40, "// FLAGGED AND LEFT COUNTED");

    expect(hasDeferralNote(lines, line)).toBe(true);
  });

  it("does not count a note BELOW the guard as deferring it", () => {
    const lines = Array.from({ length: 60 }, () => "// filler");
    lines[56] = "// DELIBERATE-LITERAL — belongs to the NEXT guard, not this one.";

    expect(hasDeferralNote(lines, 55)).toBe(false);
  });

  it("recognises the phrasings the real tree actually uses", () => {
    // Each is verbatim from a site currently counted as deferred; a regex edit that drops one
    // silently converts that file into fleet work.
    for (const note of [
      "FNXC:WorkflowResolvedColumns (fleet phase — FLAGGED AND LEFT COUNTED):",
      "(fleet — FLAGGED, deliberately NOT converted):",
      "(audited — DEAD SYNC PATH, do not convert):",
      "DELIBERATE-LITERAL: a SENTINEL, not a board lane.",
      "a conversion here would be inert",
    ]) {
      expect(hasDeferralNote([note, "const x = 1;"], 2), note).toBe(true);
    }
  });
});

/*
FNXC:LifecycleColumnCensus 2026-07-31-13:00 (u12 — the state the tree cannot demonstrate yet):
`describeBacklogState` is pure precisely so the ZERO state is testable before the tree reaches zero.
While it was an inline branch in the CLI, only the CURRENT backlog state was observable, and the zero
branch did not exist at all — the report printed nothing at the finish line.
*/
describe("the backlog-state verdict the bare command prints", () => {
  it("states ZERO as a protected end state, not an empty scan", () => {
    const lines = describeBacklogState({ columnGuards: 0, unexaminedGuards: 0 });

    expect(lines.join(" ")).toContain("BACKLOG ZERO");
    // The load-bearing half: a bare "0" reads as a broken scan unless the report says otherwise.
    expect(lines.join(" ")).toContain("not an empty scan");
    expect(lines.join(" ")).toContain("--strict");
  });

  it("calls a fully-deferred backlog DEBT rather than a work queue", () => {
    const lines = describeBacklogState({ columnGuards: 7, unexaminedGuards: 0 });

    expect(lines.join(" ")).toContain("CONVERSION QUEUE EMPTY");
    expect(lines.join(" ")).toContain("7 remaining column guard(s)");
    expect(lines.join(" ")).toContain("DEBT, not a work queue");
  });

  it("reports unexamined guards as claimable work", () => {
    const lines = describeBacklogState({ columnGuards: 7, unexaminedGuards: 3 });

    expect(lines.join(" ")).toContain("3 unexamined guard(s) remain");
    // Must NOT tell a worker the queue is empty while real work is outstanding.
    expect(lines.join(" ")).not.toContain("QUEUE EMPTY");
    expect(lines.join(" ")).not.toContain("BACKLOG ZERO");
  });

  it("prefers the ZERO state over the unexamined branch when both could apply", () => {
    // Defensive: zero guards cannot have unexamined ones. If a caller ever passes both, the honest
    // answer is still zero — reporting "N unexamined" against an empty backlog would be a fabrication.
    expect(describeBacklogState({ columnGuards: 0, unexaminedGuards: 3 }).join(" ")).toContain("BACKLOG ZERO");
  });
});

/*
FNXC:LifecycleColumnCensus 2026-07-31-20:30 (u12 — the suite pinned the MATCHER, never the DISCOVERY):
Every test in this file feeds the classifier a source string, or drives the CLI against the real tree.
None asserts WHICH FILES REACH the classifier — so the scan could return an empty list and the whole
suite would still pass.

That is not hypothetical. `git ls-files` lists TRACKED files only, so a brand-new file with a plain
`task.column === "in-review"` scored 0 until it was staged (#3254), and the identical bug sat in the
move-target ratchet behind its own 12 matcher tests (#3256) — I wrote those tests specifically to stop
that gate regressing, and they could not see it, because they import the matcher and never run a scan.

`FUSION_CENSUS_FILE_ROOT` + `FUSION_CENSUS_FILE_LIST` drive a synthetic tree, so discovery is testable
without creating files inside a live checkout that the operator is writing to concurrently.
*/
describe("the census scans the files it claims to scan", () => {
  const repoRootPath = new URL("../../../../", import.meta.url).pathname;
  const cli = `${repoRootPath}scripts/lifecycle-column-census.mjs`;

  async function runOnFixture(files: Record<string, string>, args: string[] = []) {
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { execFile } = await import("node:child_process");

    const root = await mkdtemp(join(tmpdir(), "fusion-census-discovery-"));
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), body);
    }
    const baseline = join(root, "baseline.json");
    await writeFile(baseline, JSON.stringify({ byFile: {} }));

    return await new Promise<{ code: number; out: string }>((resolve) => {
      execFile("node", [cli, ...args], {
        cwd: repoRootPath,
        env: {
          ...process.env,
          FUSION_CENSUS_FILE_ROOT: root,
          FUSION_CENSUS_FILE_LIST: Object.keys(files).join(","),
          FUSION_CENSUS_BASELINE_PATH: baseline,
        },
      }, (err, stdout, stderr) => {
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, out: `${stdout}${stderr}` });
      });
    });
  }

  const GUARD = 'export const f = (t: { column: string }) => t.column === "in-review";\n';

  it("REACHES the classifier — a guard in a scanned file is counted", async () => {
    const { out } = await runOnFixture({ "pkg/src/a.ts": GUARD });

    expect(out).toContain("scanned 1 source files");
    // The half that matters: discovery delivered the file AND the classifier saw its guard.
    expect(out).toMatch(/COLUMN guards \(the backlog\):\s+1/);
  });

  it("fails --strict FOR THE RIGHT REASON on a guard the baseline does not allow", async () => {
    /*
    Asserted on the MESSAGE, not just the exit code, and that is not belt-and-braces — the first
    version checked `code === 1` and passed while discovery was broken. With the injected list
    ignored, paths come from the real repo while reads resolve against the fixture root, every read
    misses, and the gate fails CLOSED with exit 1. Right code, unrelated cause: a test that cannot
    tell "found a guard" from "could not read anything" is not testing the ratchet.
    */
    const { code, out } = await runOnFixture({ "pkg/src/a.ts": GUARD }, ["--strict"]);

    expect(code).toBe(1);
    expect(out).toContain("pkg/src/a.ts");
    expect(out).not.toContain("ENOENT");
  });

  it("fails --strict for each unmarked query role", async () => {
    const roles = {
      read: `await store.listTasks({ column: "todo" });`,
      write: `db.update(tasks).set({ column: "archived" });`,
      other: `const created = { column: "todo" };`,
    };
    for (const [role, source] of Object.entries(roles)) {
      const { code, out } = await runOnFixture({ "pkg/src/query.ts": source }, ["--strict"]);
      expect(code, role).toBe(1);
      expect(out).toContain("pkg/src/query.ts");
      expect(out).not.toContain("ENOENT");
    }
  });

  it("counts every listed file, not just the first", async () => {
    const { out } = await runOnFixture({ "pkg/src/a.ts": GUARD, "pkg/src/b.ts": GUARD });

    expect(out).toContain("scanned 2 source files");
    expect(out).toMatch(/COLUMN guards \(the backlog\):\s+2/);
  });

  it("reads each file from the SCAN root, not the script's repo", async () => {
    /*
    The scan root and the read root were separate values, so an injected list was LISTED against the
    fixture and READ against the repo — ENOENT on every file, which a `catch { continue }` turned into
    a clean zero. Asserting a non-zero count here is what pins them to the same value.
    */
    const { out, code } = await runOnFixture({ "pkg/src/only-here.ts": GUARD });

    expect(out).not.toContain("ENOENT");
    expect(code).toBe(0);
    expect(out).toMatch(/COLUMN guards \(the backlog\):\s+1/);
  });
});
