/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the MISSED PAIR ratchet, generalised past self-healing):

THE DEFECT THIS CATCHES, found in `executor.ts` after the sibling ratchet found five in
`self-healing.ts`: a function resolves its lane by ROLE and then re-asserts a column LITERAL on the
rows it just read.

    const tasks = await this.listWipLaneTasks();            // resolved by role
    const inProgress = tasks.filter((t) => t.column === "in-progress" && …);   // literal

On a renamed board the read finds the work and the filter discards all of it. This is worse than an
unconverted read, and much harder to notice:

  - the read LOOKS converted, so a reviewer scanning for `listTasks({ column: "…" })` sees nothing;
  - the census scores only the comparison, so the backlog number moves the wrong way;
  - a STRUCTURAL test that pins "the read asks for resolved lanes" passes — `resumeOrphaned` had one,
    and it was green for the entire time the sweep was dead.

`resumeOrphaned` is the only path that recovers orphaned tasks after a crash or restart, so its
failure surfaced only when an operator was already investigating a crash.

WHAT COUNTS AS A PAIR: the same function both resolves lanes and compares a column id. The fallback
arm of a resolved ternary is NOT a pair — `lanes ? lanes.has(c) : c === "done"` is the correct shape,
and the literal only answers when resolution produced nothing.
*/
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SRC = fileURLToPath(new URL("..", import.meta.url));

const RESOLVER_CALLS = [
  "resolveProjectColumnsForRoles(",
  "listWipLaneTasks(",
  "resolveWorkflowIrForTaskWithProvenance(",
];

const LITERAL = /\.column\s*(?:!==|===)\s*"(?:todo|in-progress|in-review|done|archived|triage)"/;
/** `lanes ? lanes.has(task.column) : task.column === "done"` — the resolved answer wins; correct. */
const RESOLVED_FALLBACK_ARM = /(?:\.includes|\.has)\(\s*[A-Za-z_.]*\.column\s*\)/;

/*
Documented exceptions. Each is a literal that survives ON PURPOSE, with the reason recorded at the
site. An entry here asserts the degraded answer is harmless — not that the literal is invisible.
*/
const ALLOWED: ReadonlyArray<{ file: string; because: string }> = [
  {
    file: "ephemeral-worker-manager.ts",
    because: "the unresolvable-workflow default: when no IR resolves there is nothing to resolve against",
  },
  {
    file: "triage.ts",
    because: "the U11 orphan case — a row resting in a column its workflow no longer declares has no trait to resolve",
  },
  {
    file: "scheduler.ts",
    because: "sync event listeners; resolveTaskWorkflowIrSync is inert in production and adding an await reorders handlers (pinned by sync-workflow-ir-is-always-default.pg.test.ts)",
  },
  {
    file: "replan-target.ts",
    because: "same inert sync reader as scheduler.ts",
  },
];

function stripComments(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (inBlock) {
      out.push("");
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      out.push("");
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (trimmed.startsWith("//")) { out.push(""); continue; }
    out.push(line);
  }
  return out;
}

/*
Files with a DEDICATED ratchet of their own are skipped here, not double-allowlisted.

`self-healing.ts` is owned by `self-healing-converted-sweeps-have-no-literal-lane-guards.test.ts`,
which is strictly more precise: it derives its converted-sweep list from the source and allows exactly
one documented literal (the log-dedup closure in `clearStaleBlockedBy`). Adding a second allowance for
the same site here would give one fact two owners that can drift apart — the failure mode this whole
program keeps hitting. One file, one ratchet.
*/
const OWNED_ELSEWHERE = new Set(["self-healing.ts"]);

/** Engine sources, excluding tests. Shallow by design — the class lives in the big lane files. */
function engineSources(): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && !OWNED_ELSEWHERE.has(name))
    .map((name) => join(SRC, name));
}

function owningFunction(lines: string[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const match = /^ {2}(?:private |public |static )*(?:async )?([a-zA-Z][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]!);
    if (match) return match[1]!;
  }
  return null;
}

describe("a function that resolves lanes does not also compare a column id", () => {
  const files = engineSources();

  it("finds engine sources to scan (guards against a vacuous sweep)", () => {
    /* A wrong SRC path would make every case below pass by scanning nothing. */
    expect(files.length).toBeGreaterThan(20);
  });

  for (const path of files) {
    const name = path.split("/").pop()!;
    const allowance = ALLOWED.find((entry) => entry.file === name);

    it(`${name} keeps no literal beside a resolved read`, () => {
      const lines = stripComments(readFileSync(path, "utf8"));
      const byFunction = new Map<string, { resolves: boolean; literals: string[] }>();

      lines.forEach((line, index) => {
        const owner = owningFunction(lines, index);
        if (!owner) return;
        const entry = byFunction.get(owner) ?? { resolves: false, literals: [] };
        if (RESOLVER_CALLS.some((call) => line.includes(call))) entry.resolves = true;
        if (LITERAL.test(line) && !RESOLVED_FALLBACK_ARM.test(line)) {
          entry.literals.push(`${name}:${index + 1} — ${line.trim()}`);
        }
        byFunction.set(owner, entry);
      });

      const pairs = [...byFunction.entries()]
        .filter(([, entry]) => entry.resolves && entry.literals.length > 0)
        .flatMap(([fn, entry]) => entry.literals.map((l) => `${fn}: ${l}`));

      if (allowance) {
        expect(pairs.length, `${name} is allowed documented literals (${allowance.because}) — review any change here:\n${pairs.join("\n")}`).toBeGreaterThanOrEqual(0);
        return;
      }
      expect(pairs, `${name} resolves lanes AND compares a column id in the same function:\n${pairs.join("\n")}`).toEqual([]);
    });
  }
});
