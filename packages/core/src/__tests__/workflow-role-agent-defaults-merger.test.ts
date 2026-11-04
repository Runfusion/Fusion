import { readFileSync, existsSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:MergerLaneCensus 2026-11-04-02:43 (RUFU-463):
The Workflow Merger lane's per-tick instruction is the durable half of the merge-census contract. It
matters because the lane re-reads its own instructions on every wake (~50 ticks/day, almost all of them
record-only) and each of those ticks re-derived merge authority with a hand-written scan of task
mirrors, ref listings, and gate verdicts. Four extractor defects in one week each produced a value with
exactly the shape that authorizes an unauthorised merge, and the same tick also pasted a >50 KB dump
into a lane whose long-term memory cap is 50 000 bytes — the scan then evicted the lane's own notes.

So this test pins three things that prose alone cannot hold:
1. the original seed sentences survive verbatim (the seed is the lane's whole authority statement, and
   an amendment that rewrites it silently changes merge policy);
2. the census mandate names the canonical tool, its output markers, the second-read requirement, and the
   prohibition on negative conclusions from an incomplete run;
3. the mandate + one 20-line census output + a decision note stays inside the memory cap it must live in.
*/
import { BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULTS } from "../agents/workflow-role-agent-defaults.js";

/*
Repo root MUST be derived from this module's own URL: core's vitest pool sets `process.cwd()` to a
per-test-worker temp directory under the OS temp root, so a cwd-relative read fails with ENOENT
(reported path looked like a sandbox copy of `packages/...`) and would otherwise read as a missing
source file.
*/
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/*
The lane's memory bound is code-owned and lives in the ENGINE package (`packages/core` cannot import
`packages/engine` — circularity), so this test reads the constant's own source instead of importing it
or hard-coding a number. Hard-coding is the failure mode: this task's origin document cited a
`DEFAULT_LONG_TERM_MEMORY_BYTE_BUDGET` of 50 000 bytes that does not exist in this tree, where two
different bounds live — `MEMORY_LONG_TERM_BYTE_BUDGET` = 32 * 1024 (the long-term `MEMORY.md`
working-set bound enforced by the append tool and the consolidation sweep, i.e. the one that evicted
the lane's notes) and `MAX_MEMORY_LENGTH` = 50_000 (an inline injected-memory char budget in
`packages/engine/src/agents/agent-instructions.ts`). The governing cap for a lane writing its census
into long-term memory is the first, so the assertion follows THAT constant wherever it moves.
*/
/** True when git would ignore `relPath` in this checkout (exit 0 from `check-ignore`). */
function isGitIgnored(repoRoot: string, relPath: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", relPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readLongTermMemoryBudget(): number {  const budgetSource = readFileSync(
    join(REPO_ROOT, "packages", "engine", "src", "memory", "memory-budget.ts"),
    "utf8",
  );
  const declaration = /export const MEMORY_LONG_TERM_BYTE_BUDGET = ([0-9]+(?:\s*\*\s*[0-9]+)?);/.exec(budgetSource);
  expect(declaration, "the long-term memory budget must stay a literal arithmetic constant").not.toBeNull();
  // The declaration is a literal product like `32 * 1024`; sum the factors rather than remembering one.
  return declaration![1].split("*").reduce((product, factor) => product * Number(factor.trim()), 1);
}

/** The original seed, sentence by sentence — every one of these must survive the amendment. */
const ORIGINAL_SEED_SENTENCES = [
  "You are the Workflow Merger.",
  "Integrate only work that has met the project’s configured completion and review requirements.",
  "Protect the target branch, inspect merge state and conflicts carefully, and preserve unrelated work.",
  "Do not substitute judgment for missing approval, bypass safeguards, or silently discard changes.",
  "Report the integration result, any conflicts, and the evidence used to make the decision.",
];

const CENSUS_MARKER = "merge-census.mjs";

const merger = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULTS.merger;
const mandate = merger.instructionsText.slice(merger.instructionsText.indexOf("Run `node scripts/"));

describe("built-in Workflow Merger lane instructions carry the merge-census mandate", () => {
  it("retains every sentence of the original seed alongside the mandate", () => {
    for (const sentence of ORIGINAL_SEED_SENTENCES) {
      expect(merger.instructionsText).toContain(sentence);
    }
    // The seed must stay FIRST: the mandate is an addition, not a rewrite of merge policy.
    expect(merger.instructionsText.indexOf(ORIGINAL_SEED_SENTENCES[0])).toBe(0);
    expect(merger.instructionsText.indexOf(CENSUS_MARKER)).toBeGreaterThan(0);
    expect(merger.role).toBe("merger");
    expect(merger.name).toBe("Workflow Merger");
  });

  it("mandates the canonical census tool, its output markers, and the second read", () => {
    expect(merger.instructionsText).toContain("merge-census");
    expect(mandate).toContain("scripts/merge-census.mjs");
    expect(mandate).toContain("--repo .");
    expect(mandate).toContain("2>&1");
    expect(mandate).toContain("`disposition`");
    expect(mandate).toContain("laneDigest");
    // A decision to act needs a second, differently-written read.
    expect(mandate).toMatch(/second, differently-written read/);
    expect(mandate).toContain("--task <ID>");
    // Provenance prohibition: the lane may not re-derive authority itself.
    expect(mandate).toMatch(/never hand-write a per-tick scan/);
    // No negative conclusion from an unproven read.
    expect(mandate).toMatch(/refProbe:invalid/);
    expect(mandate).toMatch(/forbids every negative conclusion/);
    expect(mandate).toMatch(/incomplete:/);
    // The unchanged-lane case must be cheap, which is what makes ~50 record-only ticks/day affordable.
    expect(mandate).toMatch(/record-only/);
  });

  it("mandates a tool that actually exists and is tracked, not a prose promise about a phantom script", () => {
    const toolPath = join(REPO_ROOT, "scripts", "merge-census.mjs");
    expect(existsSync(toolPath)).toBe(true);
    const source = readFileSync(toolPath, "utf8");
    // The markers the mandate tells the lane to trust must be printed by the tool it names.
    for (const marker of ["SENTINEL-START", "SENTINEL-END", "laneDigest", "disposition laneRows=", "refProbe:invalid", "mirrors:"]) {
      expect(source).toContain(marker);
    }
    // The --help surface must cite the budget honestly: the constant's name and location, never a
    // remembered number that can disagree with the code.
    expect(source).toContain("MEMORY_LONG_TERM_BYTE_BUDGET");
    expect(source).toContain("packages/engine/src/memory/memory-budget.ts");
    // The lane instruction must never point at the gitignored scratch path, where an earlier ad-hoc
    // census lived and where the next session would find nothing.
    expect(merger.instructionsText).not.toContain(".fusion/scripts/");
    // And the canonical tool must be VISIBLE to a fresh checkout: `.gitignore` carries `.fusion/`, so
    // anything under it is invisible to the next session — this is the premise of the whole relocation.
    expect(readFileSync(join(REPO_ROOT, ".gitignore"), "utf8")).toMatch(/^\.fusion\//m);
    expect(isGitIgnored(REPO_ROOT, join("scripts", "merge-census.mjs"))).toBe(false);
  });

  it("keeps the mandate inside the memory budget it has to coexist with", () => {
    const byteBudget = readLongTermMemoryBudget();
    // Guard the premise: the constant is a working-set bound, so the lane's tick must fit a FRACTION.
    expect(byteBudget).toBeGreaterThanOrEqual(16 * 1024);

    const mandateBytes = Buffer.byteLength(mandate, "utf8");
    expect(mandateBytes).toBeGreaterThan(0);
    // One fifth of the cap is the mandate's ceiling.
    expect(mandateBytes).toBeLessThanOrEqual(byteBudget / 5);

    // And the whole tick still fits: seed + mandate + a 20-line authority-only census read plus a note.
    // Measured line budget comes from the tool's own row format, not a guess.
    const censusOutputBytes = 20 * 220;
    const decisionNoteBytes = 400;
    const tickBytes = Buffer.byteLength(merger.instructionsText, "utf8") + censusOutputBytes + decisionNoteBytes;
    expect(tickBytes).toBeLessThanOrEqual(byteBudget);
  });

  it("ships no tracked instruction that still tells the merger lane to hand-write its own scan", () => {
    // Drift guard for the tracked instruction surface. Live durable merger rows are a separate,
    // one-time operator-config convergence (fn_agent_set_instructions), asserted when it is applied.
    const tracked = readFileSync(
      join(REPO_ROOT, "packages", "core", "src", "agents", "workflow-role-agent-defaults.ts"),
      "utf8",
    );
    expect(tracked).toMatch(/merge-census\.mjs/);
    // The anti-pattern: instructions telling the lane to enumerate refs/mirrors itself.
    expect(tracked).not.toMatch(/for-each-ref|task\.json|merge_census\.py/);
  });
});
