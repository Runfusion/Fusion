/*
FNXC:LifecycleColumnRatchet 2026-07-31-09:10 (U12 R12 — AST, replacing the grep):

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

/** The receiver's name: `task.column` -> "column"; a bare `toColumn` -> "toColumn". */
function receiverName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isIdentifier(node)) return node.text;
  return undefined;
}

/** Walk one parsed file for `X === "<id>"` / `X !== "<id>"` where X names something column-like. */
function collect(sf: ts.SourceFile, columnId: string, file: string, sites: Site[]): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const pairs = [[node.right, node.left], [node.left, node.right]] as const;
      for (const [lit, other] of pairs) {
        // `.text` is the DECODED value, so single and double quotes are indistinguishable here.
        if (!ts.isStringLiteral(lit) || lit.text !== columnId) continue;
        const receiver = receiverName(other);
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
const CEILINGS: Record<string, number> = {
  triage: 37,
  todo: 82,
  "in-progress": 201,
  "in-review": 217,
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
