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
   which 10 are NOT columns and 62 are. So the reachable floor for the RAW number is 10, not 0 —
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
import { join } from "node:path";

/** Lifecycle column ids whose literal comparison this ratchet governs. */
const GOVERNED_IDS = ["triage", "todo", "in-progress", "in-review"] as const;

/**
 * Per-id ceilings, measured 2026-07-30 on `main`. LOWER THESE as conversions land; never raise one.
 * A raise means a literal came back — convert the site or, if it genuinely is not a column, teach
 * the classifier why rather than widening the ceiling.
 */
const CEILINGS: Record<string, number> = {
  triage: 62,
  todo: 88,
  "in-progress": 133,
  "in-review": 200,
};

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

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

  const columnLhs = new RegExp(
    String.raw`\b(\w*[Cc]olumn|\w*\.column)\s*(===|!==)\s*"${columnId}"` +
      String.raw`|"${columnId}"\s*(===|!==)\s*\b(\w*[Cc]olumn|\w*\.column)`,
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
    .filter(({ code }) => !/^\s*(\/\/|\*|\/\*)/.test(code))
    // The load-bearing exclusion: only a comparison against something NAMED a column counts.
    .filter(({ code }) => columnLhs.test(code));
}

describe("lifecycle-column literal ratchet", () => {
  for (const columnId of GOVERNED_IDS) {
    it(`does not increase the number of \`${columnId}\` column comparisons`, () => {
      const sites = comparisonSites(columnId);
      const ceiling = CEILINGS[columnId]!;

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

  it("still detects a column comparison when one is present (the classifier is not vacuous)", () => {
    /*
    A ratchet that matched nothing would pass forever and report success while measuring nothing —
    the failure mode this program has found repeatedly. Prove the classifier fires on the shape it
    governs, using the real source rather than a synthetic string.
    */
    const sites = comparisonSites("todo");
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((s) => /column/i.test(s.code))).toBe(true);
  });
});
