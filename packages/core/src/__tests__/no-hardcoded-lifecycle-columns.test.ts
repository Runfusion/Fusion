/*
FNXC:LifecycleColumnRatchet 2026-07-30-12:10 (U12 R12 — the anti-regression ratchet):

Counts lifecycle-column LITERAL COMPARISONS in production source and fails when the count rises.
Two jobs, and the second is why a plain grep is not enough:

1. RATCHET. A converted guard cannot silently come back as a literal. The number only goes down.

2. HONEST DENOMINATOR. `triage` is overloaded in this codebase — it is a column id, an AGENT ROLE,
   a SESSION PURPOSE, a PROMPT-TEMPLATE family, and a CLI glyph key. A raw grep counts all of them
   together, which makes the convergence target unreachable by construction: converting
   `role === "triage"` in agent-prompts.ts would break the planning agent's prompt-template
   resolution, and the resulting failure would look nothing like a column bug.

   Measured at the time of writing, `triage` alone: 72 raw matches across the five source roots, of
   which 10 are NOT columns and 62 are. A further 2 of the 62 ARE columns but are documented
   permanent fallbacks (see the live-agent-count case below), so the reachable floor for the RAW
   number is 12, not 0 —
   anyone tracking the raw grep toward zero is chasing a target that would require breaking working
   code to hit.

   The scope also matters and is why this lives in code rather than in a shell one-liner. A grep over
   `packages/<pkg>/src` MISSES `packages/dashboard/app` entirely, where the board components live — that
   omission undercounted `triage` as 43 when it is 62. Writing the ratchet is what caught it; the
   roots are listed explicitly below so the number cannot drift with someone's glob.

The classifier keys on the LEFT-HAND SIDE naming a column (`task.column`, `fromColumn`,
`currentColumn`, ...). That is deliberately syntactic and therefore auditable: a reader can check it
against the source without running anything. It is also conservative — an unrecognised shape counts
as a column comparison, so the ratchet errs toward demanding conversion rather than excusing it.
*/
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Lifecycle column ids whose literal comparison this ratchet governs. */
const GOVERNED_IDS = ["triage", "todo", "in-progress", "in-review"] as const;

/**
 * Per-id ceilings, re-measured against `main` with the INVERTED classifier (2026-07-30).
 *
 * These numbers went UP from the previous set (triage 48 -> 57, in-progress 133 -> 205). No literals
 * were added: the classifier got honest. It used to require the receiver to LOOK like a column and
 * therefore could not see `col`, `c`, or `from`/`to`. Treat the jump as a correction to the
 * measurement, not a regression in the code. LOWER THESE as conversions land; never raise one.
 * A raise means a literal came back — convert the site or, if it genuinely is not a column, teach
 * the classifier why rather than widening the ceiling.
 */
const CEILINGS: Record<string, number> = {
  triage: 40,
  todo: 82,
  "in-progress": 200,
  "in-review": 214,
};

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/**
 * Is this 1-indexed line inside a `/* … *\/` block? Cheap state scan rather than a parser: the
 * ratchet must not need a TypeScript AST to tell documentation from a guard, and every FNXC note in
 * this codebase explaining an OLD comparison would otherwise be counted as the comparison itself.
 */
const blockCommentLinesByFile = new Map<string, ReadonlySet<number>>();

function isInsideBlockComment(file: string, lineNo: number): boolean {
  let cached = blockCommentLinesByFile.get(file);
  if (!cached) {
    const inside = new Set<number>();
    let open = false;
    const lines = readFileSync(join(REPO_ROOT, file), "utf-8").split("\n");
    lines.forEach((text, index) => {
      const opensHere = text.includes("/*");
      const closesHere = text.includes("*/");
      if (open) inside.add(index + 1);
      if (opensHere && !closesHere) {
        open = true;
        inside.add(index + 1);
      } else if (closesHere) {
        if (opensHere) inside.add(index + 1);
        open = false;
      }
    });
    cached = inside;
    blockCommentLinesByFile.set(file, cached);
  }
  return cached.has(lineNo);
}



function comparisonSites(columnId: string): { file: string; line: string; code: string }[] {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      [
        "-rnE",
        `(===|!==)[[:space:]]*"${columnId}"|"${columnId}"[[:space:]]*(===|!==)`,
        "--include=*.ts",
        "--include=*.tsx",
        "packages/core/src",
        "packages/engine/src",
        "packages/dashboard/src",
        "packages/dashboard/app",
        "packages/cli/src",
      ],
      { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    // grep exits 1 on no matches, which is a legitimate zero rather than a failure.
    const status = (err as { status?: number }).status;
    if (status !== 1) throw err;
    return [];
  }

  /*
  FNXC:LifecycleColumnRatchet 2026-07-30-21:10 (classifier INVERTED after a measured miss):
  This used to require the left-hand side to LOOK like a column (`\w*[Cc]olumn`), which silently
  under-counted: `col`, `c`, and `from`/`to` are column receivers that pattern cannot match. Measured
  against a full comparison sweep it missed 2 genuine guards — `executor.ts`'s
  `from === "todo" || from === "triage"` and MissionControlPanel's `(c) => c === "triage"` — while
  the program tracked the smaller number as ground truth.

  So it now counts EVERY comparison and subtracts an explicit allowlist of receivers that are
  provably not columns. Conservative in the correct direction: an unrecognised receiver COUNTS, so a
  new binding name inflates the number and demands attention rather than vanishing from it.

  The allowlist is receivers, not files, so it cannot excuse a real guard that happens to live in an
  allowlisted file.
  */
  const NON_COLUMN_RECEIVERS = [
    "role",            // agent-prompts, TaskChatTab — the planning AGENT's role
    "agentType",       // usage-limit-detector — which lane hit the limit
    "sessionPurpose",  // skill-resolver
    "surface",         // tool-availability
    "agent",           // AgentLogViewer, effective-model-resolution, useTasks (entry.agent)
  ];
  const nonColumnLhs = new RegExp(
    String.raw`(^|[^\w.])(` + NON_COLUMN_RECEIVERS.join("|") + String.raw`)\s*(===|!==)\s*"` + columnId + `"`,
  );

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [file, no, ...rest] = line.split(":");
      return { file, line: no, code: rest.join(":").trim() };
    })
    .filter(({ file }) => !file.includes("__tests__") && !file.includes(".test."))
    // Comments describe the old behavior on purpose; they are documentation, not guards.
    // Line-leading markers only catch the FIRST line of a block comment — a `/* ... */` body wraps
    // onto continuation lines with no marker at all, and four such lines were being counted as
    // guards. `isInsideBlockComment` re-reads the file and tracks state, which is the only way to
    // tell prose from code without parsing.
    .filter(({ file, line, code }) => !/^\s*(\/\/|\*|\/\*)/.test(code) && !isInsideBlockComment(file, Number(line)))
    .filter(({ code }) => !nonColumnLhs.test(code));
}

describe("lifecycle-column literal ratchet", () => {
  for (const columnId of GOVERNED_IDS) {
    it(`does not increase the number of \`${columnId}\` column comparisons`, () => {
      const sites = comparisonSites(columnId);
      const ceiling = CEILINGS[columnId]!;
      /*
      The ratchet REPORTS the number it enforces, so the program measures with the same tool it
      gates with. A grep cannot tell a lifecycle guard from a legitimate declaration — the legacy
      workflow still declares `triage`, the Task enum still includes it — so a separately-maintained
      count drifts from the gate, which is exactly how 34 was tracked while 56 were live.
      */
      // eslint-disable-next-line no-console
      console.log(`[lifecycle-column-ratchet] ${columnId}: ${sites.length} comparison(s), ceiling ${ceiling}`);

      expect(
        sites.length,
        sites.length > ceiling
          ? `\`column === "${columnId}"\` comparisons rose to ${sites.length} (ceiling ${ceiling}).\n` +
            `A literal came back. Convert it, or if it is genuinely not a lifecycle column, teach the\n` +
            `classifier rather than raising the ceiling.\n\n` +
            sites.map((s) => `  ${s.file}:${s.line}  ${s.code.slice(0, 100)}`).join("\n")
          : undefined,
      ).toBeLessThanOrEqual(ceiling);
    });
  }

  it("excludes non-column `triage` comparisons, which must NEVER be converted", () => {
    /*
    The reachable floor is not zero. `role === "triage"` (agent-prompts), `agentType === "triage"`
    (usage-limit-detector), `sessionPurpose === "triage"` (skill-resolver) and
    `surface === "triage"` (tool-availability) name the planning AGENT, not the planning column.
    Converting them would break prompt-template resolution and produce a failure that looks nothing
    like a column bug.

    Asserted as a POSITIVE so the classifier itself is under test: if a future edit made it treat
    these as columns, this fails and the ratchet's number stops meaning anything.
    */
    const columnSites = comparisonSites("triage");
    const files = new Set(columnSites.map((s) => s.file));

    expect([...files].some((f) => f.endsWith("agent-prompts.ts"))).toBe(false);
    expect([...files].some((f) => f.endsWith("skill-resolver.ts"))).toBe(false);
    expect([...files].some((f) => f.endsWith("tool-availability.ts"))).toBe(false);
  });

  /*
  FNXC:LifecycleColumnRatchet 2026-07-30-14:20 (audited, not converted):
  PERMANENT FALLBACKS. Two sites in `live-agent-count.ts` compare a column literal and must STAY
  that way, which lowers the honest floor further — to 12 raw matches, not 10.

  `enrichRunningAgentTaskShapeFromFlags` derives intake/hold/wip/review membership from board
  trait flags, with `task.column === "triage" || task.column === "todo"` as the no-flags arm. That
  arm is REACHABLE in two documented ways, and the second is the one U11 creates:

    - remote tasks: `App.tsx` deliberately supplies an EMPTY flag map for a remote store, because
      local board-workflow metadata must not be applied to another store's ids;
    - a card whose column its workflow does not declare: the flag lookup finds nothing, so the card
      has no flags at all. Post-U11 that is precisely a row left in `triage`.

  Removing the literal would make such a card match NO arm — counted as neither running nor
  waiting, so the footer's queued total silently under-reports a stranded card. The file's own
  comment reaches the same conclusion and names the correct fix: supply flags, do not delete the
  fallback. That is caller-side work in the dashboard, not a conversion here.

  Asserted so the exclusion is a recorded decision rather than an oversight, and so a future edit
  that DOES delete the fallback fails here and has to argue with this reasoning.
  */
  it("keeps the live-agent-count no-flags fallbacks, which U11 makes load-bearing", () => {
    const sites = comparisonSites("triage").filter((s) => s.file.endsWith("live-agent-count.ts"));
    expect(sites.length).toBe(2);
    // Both are the `?:` / `??` no-flags arm, never the primary decision.
    expect(sites.every((s) => /flags|\?\?/.test(s.code))).toBe(true);
  });

  it("still detects a column comparison when one is present (the classifier is not vacuous)", () => {
    /*
    A ratchet that matched nothing would pass forever and report success while measuring nothing —
    the failure mode this program has found repeatedly. Prove the classifier fires on the shape it
    governs, using the real source rather than a synthetic string.
    */
    const sites = comparisonSites("todo");
    expect(sites.length).toBeGreaterThan(0);
    /*
    Deliberately NOT "every site mentions the word column". That assertion belonged to the previous
    classifier, which required the receiver to look like a column — and it is precisely the
    assumption that made the ratchet blind to `col`, `c` and `from`/`to`. Asserting it again would
    re-impose the blind spot on the very test meant to prove the classifier works.

    Instead: it finds real sites, AND it still excludes a receiver on the non-column allowlist.
    */
    expect(sites.some((site) => /\.column|\bcolumn\b/i.test(site.code))).toBe(true);
    expect(sites.some((site) => /\brole\s*===/.test(site.code))).toBe(false);
  });
});
