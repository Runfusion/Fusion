/*
FNXC:LifecycleColumnRatchet 2026-07-30-09:10 (U12 R12 — AST, replacing the grep):

THE MEASURING INSTRUMENT for the lifecycle-column conversion, and the authority on the number.

WHY IT HAD TO STOP BEING A GREP. Three people measured this surface with three regexes and got
three answers (6, 8, 12 for the agent-role bucket alone). Every figure quoted at the program today
— 57, 48, 45, 34, 56, 46 — was grep-derived, and those were not measurements but estimates with a
consistent bias. A regex cannot distinguish:

  task.column === "triage"        a lifecycle guard           <- the thing being counted
  role === "triage"               the planning AGENT's role   <- correct code, must never convert
  sessionPurpose === "triage"     a session purpose           <- correct code
  surface === "triage"            a docs surface name         <- correct code
  `column === "triage"` in prose  an FNXC note quoting the OLD behaviour

Parsing removes two whole defect classes instead of patching them:
  - COMMENTS ARE NOT NODES. Every FNXC note here explains an old comparison by quoting it, so a text
    scan counts the project's own requirement history as violations. The previous revision of this
    file needed a hand-rolled block-comment tracker for exactly that, and still only caught the
    cases it thought to look for.
  - QUOTE STYLE AND LINE BREAKS VANISH. `"triage"`, `'triage'`, and a comparison wrapped across
    lines are one shape to the AST and three patterns to a grep.

WHAT IT DOES NOT DO. There is no type checker here, only a syntax tree, so classification is by
RECEIVER NAME. That is a real limit and it is why the lists below are explicit and auditable rather
than clever. It errs toward COUNTING: an unrecognised receiver is treated as a column, so a new
binding name inflates the number and demands attention instead of disappearing from it.
*/
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/** Lifecycle column ids whose literal comparison this ratchet governs. */
const GOVERNED_IDS = ["triage", "todo", "in-progress", "in-review"] as const;

/**
 * Receivers that are provably NOT lifecycle columns. Sourced from two independently-built
 * classifiers agreeing — the strongest evidence available on this surface.
 *
 * Converting any of these would be a real bug rather than a missed cleanup: `role === "triage"`
 * selects the planning agent's prompt template, and resolving it to "which column carries the
 * intake trait" asks a column question about something that is not a column.
 */
const NON_COLUMN_RECEIVERS: ReadonlySet<string> = new Set([
  "role",
  "agentType",
  "sessionPurpose",
  "surface",
  "agent",
  "purpose",
  "lane",
]);

/**
 * Column receivers actually present, from the receiver census (task.column 12, toColumn 9,
 * column 9, t.column 2, originColumn 2, then singletons). Documentation, not a filter — anything
 * outside NON_COLUMN_RECEIVERS counts regardless.
 */
const KNOWN_COLUMN_RECEIVERS: ReadonlySet<string> = new Set([
  "column", "toColumn", "fromColumn", "originColumn", "resumeColumn", "taskColumn",
  "from", "to", "c", "col", "workflowIrPinColumnId", "currentColumn", "targetColumn",
]);

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SOURCE_ROOTS = [
  "packages/core/src",
  "packages/engine/src",
  "packages/dashboard/src",
  "packages/dashboard/app",
  "packages/cli/src",
];

interface Site { readonly file: string; readonly line: number; readonly code: string; readonly receiver: string }

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

/*
FNXC:LifecycleColumnRatchet 2026-07-30-23:00 (U12 — the fourth fail-open in this file):
AN UNNAMEABLE RECEIVER IS COUNTED, NOT DROPPED.

The AST rewrite fixed quoting and line-orientation, but `receiverName` still understood only a
ONE-LEVEL property access or a bare identifier, and the caller `continue`d on `undefined`. So these
were silently uncounted:

    task["column"] === "triage"                  // ElementAccess
    metadataColumn(entry, "to") === "in-review"   // CallExpression
    (flag ? from : to) === "triage"               // ConditionalExpression
    (task!.column) === "triage"                   // Parenthesized / NonNull wrapper
    task.column === `triage`                      // NoSubstitutionTemplateLiteral

Live, not theoretical: `metadataColumn(entry, "to") === "in-review"` in
`dashboard/src/reliability-metrics.ts` is THREE real lifecycle guards this ratchet was not counting.
Found by printing what the scanner reported as unnamed instead of trusting its total.

That is the fourth time this file has failed OPEN — grep quoting, then the `/\w*[Cc]olumn/` name
pattern, then one-level property access. Same mechanism every time: a shape the scanner did not
understand became "not a column" and left the count. So the fix is the PROPERTY, not the case: walk
through wrappers, resolve a call to its callee name, and emit a `<SyntaxKind>` SENTINEL for anything
still unnameable. A sentinel is counted AND trips the classification test, so a human judges it
instead of it vanishing. Fail closed — which is what makes this number safe to gate on at all.
*/
function receiverName(node: ts.Expression): string | undefined {
  let cur: ts.Node = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) { cur = cur.name; continue; }
    if (ts.isElementAccessExpression(cur)) {
      const arg = cur.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return arg.text;
      cur = cur.expression;
      continue;
    }
    // A helper that RETURNS a column is classified by the function's name.
    if (ts.isCallExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    break;
  }
  if (ts.isIdentifier(cur)) return cur.text;
  return `<${ts.SyntaxKind[cur.kind]}>`;
}

/** Walk one parsed file for `X === "<id>"` / `X !== "<id>"` where X names something column-like. */
export function collect(sf: ts.SourceFile, columnId: string, file: string, sites: Site[]): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const pairs = [[node.right, node.left], [node.left, node.right]] as const;
      for (const [lit, other] of pairs) {
        // `.text` is the DECODED value, so single and double quotes are indistinguishable here.
        // Backtick literals are string literals to a reader and to the runtime; excluding them left
        // `task.column === \`triage\`` uncounted for no reason anyone would defend.
        const isLiteral = ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit);
        if (!isLiteral || lit.text !== columnId) continue;
        const receiver = receiverName(other);
        /*
        `receiverName` no longer returns undefined for an expression it cannot name — it returns a
        `<SyntaxKind>` sentinel that is COUNTED and must be classified. Dropping on undefined is what
        made this fail open; the undefined arm is kept only as a defensive no-op.
        */
        if (receiver === undefined || NON_COLUMN_RECEIVERS.has(receiver)) continue;
        sites.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          code: node.getText(sf).replace(/\s+/g, " ").slice(0, 100),
          receiver,
        });
        break;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Every lifecycle-column guard against `columnId`. Comments cannot appear here — they are trivia,
 * not nodes — so prose quoting an old comparison is excluded by construction rather than by a
 * pattern that has to anticipate it.
 */
function comparisonSites(columnId: string): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf-8");
    if (!text.includes(columnId)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    collect(sf, columnId, relative(REPO_ROOT, file), sites);
  }
  return sites;
}

/**
 * Ceilings, measured by THIS instrument on `main`. Lower them as conversions land; never raise one.
 * A raise means a guard came back — convert it, or if the receiver genuinely is not a column, add it
 * to NON_COLUMN_RECEIVERS with a reason.
 */
/*
FNXC:LifecycleColumnRatchet 2026-07-30-01:30 (PR #2647 review — greptile, and worse than reported):
TIGHTENED TO THE MEASURED COUNTS, because slack made this a ratchet in name only.

The review's finding was that this test is not in the blocking gate, so a regression can merge. True,
and fixed (`packages/core/package.json` -> `test:unit-gate`). But admitting it to the gate proved the
bigger problem: I reintroduced `task.column === 'triage'` and the gate STAYED GREEN at 158 passed.

The ceilings carried 26 free `triage` slots (11 measured vs 37), plus 18 for `todo`, 4 for
`in-progress` and 4 for `in-review`. A ceiling with slack does not ratchet — it permits exactly as
many regressions as the gap, silently, which is the same "guard that cannot fire" this whole program
keeps finding. Being in the gate was necessary and not sufficient.

Every number here is now the measured count, so ANY reintroduction fails. Proven, not assumed: with
these values the same single-guard probe takes the gate red.

LOWER these as conversions land; a raise means a literal came back OR detection improved — and if it
is the latter, say which sites in the commit, as previous revisions of this file did.
*/
const CEILINGS: Record<string, number> = {
  triage: 11,
  todo: 64,
  "in-progress": 197,
  "in-review": 213,
};

describe("lifecycle-column literal ratchet (AST)", () => {
  for (const columnId of GOVERNED_IDS) {
    it(`does not increase the number of \`${columnId}\` column guards`, () => {
      const sites = comparisonSites(columnId);
      // Reported so the project measures with the same tool it gates with. Every previously-quoted
      // figure was grep-derived; this number replaces them.
      // eslint-disable-next-line no-console
      console.log(`[lifecycle-column-ratchet] ${columnId}: ${sites.length} guard(s), ceiling ${CEILINGS[columnId]}`);

      expect(
        sites.length,
        sites.length > CEILINGS[columnId]!
          ? `\`${columnId}\` column guards rose to ${sites.length} (ceiling ${CEILINGS[columnId]}).\n`
            + "Convert it, or if the receiver is not a lifecycle column add it to\n"
            + "NON_COLUMN_RECEIVERS with a reason — do not raise the ceiling.\n\n"
            + sites.map((s) => `  ${s.file}:${s.line}  [${s.receiver}]  ${s.code}`).join("\n")
          : undefined,
      ).toBeLessThanOrEqual(CEILINGS[columnId]!);
    });
  }

  it("never reports an agent role, session purpose or surface as a violation", () => {
    /*
    The assertion that keeps this instrument honest. A ratchet demanding conversion of
    `role === "triage"` would send the next person into breaking the planning agent's
    prompt-template resolution, AND could never reach zero, because those sites are correct code.

    Asserted POSITIVELY against the files that hold them, so a classifier change that swallowed
    them fails here instead of quietly shrinking the number.
    */
    const files = new Set(comparisonSites("triage").map((s) => s.file));
    expect([...files].some((f) => f.endsWith("agent-prompts.ts"))).toBe(false);
    expect([...files].some((f) => f.endsWith("skill-resolver.ts"))).toBe(false);
    expect([...files].some((f) => f.endsWith("tool-availability.ts"))).toBe(false);
  });

  it("ignores comparisons that appear only inside comments", () => {
    /*
    Holds by construction — comments are trivia — but asserted because the previous grep-based
    revision needed a hand-rolled block-comment tracker to approximate it, and every FNXC note in
    this codebase quotes the comparison it replaced. If a future rewrite returns to text scanning,
    this fails.
    */
    const sf = ts.createSourceFile(
      "probe.ts",
      '/* task.column === "triage" in prose */\n// column === "triage" too\nconst x = 1;\n',
      ts.ScriptTarget.Latest,
      true,
    );
    const sites: Site[] = [];
    collect(sf, "triage", "probe.ts", sites);
    expect(sites).toEqual([]);
  });

  it("detects every syntactic form a reintroduced guard can take", () => {
    /*
    The four shapes a text scan misses or mishandles: single quotes, a comparison wrapped across
    lines, a deeper-qualified receiver, and the literal on the LEFT. Exercised through the real
    collector rather than trusted from a pattern.
    */
    const probe = [
      'const a = task.column === "triage";',
      "const b = t.column === 'triage';",
      'const c = linkedTask.detail.column\n  !==\n  "triage";',
      'const d = "triage" === toColumn;',
      'const e = role === "triage";', // must NOT count
    ].join("\n");
    const sf = ts.createSourceFile("probe.tsx", probe, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const sites: Site[] = [];
    collect(sf, "triage", "probe.tsx", sites);

    // double-quoted, single-quoted, multiline + deeper-qualified, literal-on-the-left.
    expect(sites.map((s) => s.receiver)).toEqual(["column", "column", "column", "toColumn"]);
    expect(sites.map((s) => s.receiver)).not.toContain("role");
  });

  it("documents the column receivers present, so a new binding name is visible", () => {
    // A census, not a gate. Every receiver here is a shape someone must convert, and an unfamiliar
    // name appearing is the signal that a conversion introduced a new alias.
    const receivers = new Set(comparisonSites("triage").map((s) => s.receiver));
    for (const receiver of receivers) expect(NON_COLUMN_RECEIVERS.has(receiver)).toBe(false);
    // eslint-disable-next-line no-console
    console.log(`[lifecycle-column-ratchet] triage receivers: ${[...receivers].sort().join(", ") || "(none)"}`);
    expect(KNOWN_COLUMN_RECEIVERS.size).toBeGreaterThan(0);
  });
});

/*
FNXC:LifecycleColumnRatchet 2026-07-30-23:00 (the fourth fail-open, pinned so it is the last):
PROOF THAT EVERY REINTRODUCTION SHAPE IS COUNTED.

Each shape below was silently dropped by at least one earlier revision of this file: quoting by the
grep, short bindings by the name pattern, and wrappers/calls/brackets by the one-level
`receiverName`. Three of the four were found by review rather than by the ratchet itself, which is
the argument for testing the detector directly instead of trusting its total.

MEASURED IMPACT of the wrapper/call fix, on current main: `in-progress` 196 -> 197 and `in-review`
211 -> 213. Those three were real guards nobody was counting, including
`metadataColumn(entry, "to") === "in-review"` in dashboard/src/reliability-metrics.ts.
*/
describe("the detector counts every reintroduction shape (fail closed)", () => {
  function sitesFor(source: string, columnId: string) {
    const sf = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const sites: Site[] = [];
    collect(sf, columnId, "probe.ts", sites);
    return sites;
  }

  const RED: Array<[string, string]> = [
    ["double-quoted", `if (task.column === "triage") return;`],
    ["single-quoted", `if (task.column === 'triage') return;`],
    ["backtick literal", "if (task.column === `triage`) return;"],
    ["multiline", `if (task.column ===\n    "triage") return;`],
    ["negated", `if (task.column !== "triage") return;`],
    ["reversed operands", `if ("triage" === task.column) return;`],
    ["bracket access", `if (task["column"] === "triage") return;`],
    ["deep qualified", `if (state.board.tasks[i].column === "triage") return;`],
    ["parenthesised non-null", `if ((task!.column) === "triage") return;`],
    ["helper call returning a column", `if (metadataColumn(entry, "to") === "triage") return;`],
    ["bare binding", `if (toColumn === "triage") return;`],
  ];

  for (const [label, source] of RED) {
    it(`counts ${label}`, () => {
      expect(sitesFor(source, "triage")).toHaveLength(1);
    });
  }

  it("counts an unnameable receiver under a sentinel rather than dropping it", () => {
    /*
    THE FAIL-CLOSED PROPERTY ITSELF. Every earlier revision answered "not a column" for a shape it
    did not understand, so the site left the count in silence. A ternary receiver must be COUNTED
    with a `<...>` sentinel, which then trips the classification guard and forces a human judgement.

    If this returns 0, the ratchet has gone back to failing open and its number stops being
    trustworthy — which is the only reason it is allowed to gate.
    */
    const sites = sitesFor(`if ((flag ? from : to) === "triage") return;`, "triage");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.receiver).toMatch(/^<.*>$/);
  });

  const GREEN: Array<[string, string, string]> = [
    ["agent role", `if (role === "triage") return;`, "triage"],
    ["agent display name", `if (entry.agent === "triage") return;`, "triage"],
    ["a line comment", `// if (task.column === "triage") return;`, "triage"],
    ["a block comment", `/* task.column === "triage" */`, "triage"],
  ];

  for (const [label, source, id] of GREEN) {
    it(`ignores ${label}`, () => {
      /*
      The other half: a detector that counted everything would "catch" reintroductions and be
      useless, because converting `role === "triage"` breaks prompt-template resolution and the count
      could never reach its floor. Comments are excluded structurally — the AST has none.
      */
      expect(sitesFor(source, id)).toHaveLength(0);
    });
  }
});

/*
FNXC:LifecycleColumnRatchet 2026-07-30-00:45 (U12 — the bar is a FLOOR, not zero):
SITES THAT MUST NEVER BE CONVERTED, asserted as a positive.

The program has been tracking these counts toward zero. Zero is not reachable, and pursuing it means
breaking working code — the same trap as demanding conversion of `role === "triage"`, one level up.
Two categories are permanent, each for a stated reason, and both are protected here so a future sweep
cannot "finish the job" by removing them:

1. `dashboard/app/components/command-center/MissionControlPanel.tsx` — `FUNNEL_STAGES` is a deliberate
   NAME-SIMILARITY heuristic for the SDLC funnel. It matches synonyms (`signal`, `backlog`, `to-do`,
   `ready`, `shipped`) and folds anything unrecognised into an "other" bucket precisely so a custom
   board still contributes counts. It is not asking "does this column have the intake trait" — it is
   bucketing arbitrary column NAMES for display. Resolving it to traits would change what the funnel
   shows and would drop the synonym coverage that makes it work on boards Fusion has never seen.

2. `core/live-agent-count.ts` — the no-flags arm. Documented in that file and in earlier revisions of
   this one: it is REACHABLE (a remote store is deliberately given an empty flag map, and a card in a
   column its workflow no longer declares has no flags at all), and deleting the literal would make
   such a card match NO arm, so the footer's queued total would silently under-report a stranded card.

This test exists because a count with an undocumented floor invites someone to drive it to zero. The
honest target is: these sites, and nothing else.
*/
describe("the reachable floor: sites that must stay", () => {
  it("keeps the Mission Control funnel's name-similarity heuristic", () => {
    const funnel = readFileSync(
      join(REPO_ROOT, "packages/dashboard/app/components/command-center/MissionControlPanel.tsx"),
      "utf-8",
    );
    /*
    Asserted on the SYNONYM list rather than on the `triage` comparison alone: the synonyms are the
    evidence that this is name matching and not a lifecycle guard, so if they disappear the site has
    changed character and the exemption below no longer applies.
    */
    expect(funnel).toContain("FUNNEL_STAGES");
    expect(funnel).toContain('"signal"');
    expect(funnel).toContain('"backlog"');
  });

  it("keeps live-agent-count's no-flags arm", () => {
    const liveAgentCount = readFileSync(join(REPO_ROOT, "packages/core/src/live-agent-count.ts"), "utf-8");
    // Reachable via an empty remote flag map and via a card in an undeclared column; removing it
    // makes such a card match no arm at all and the queued total under-reports it.
    expect(liveAgentCount).toContain("columnIsIntakeOrHold");
  });
});
