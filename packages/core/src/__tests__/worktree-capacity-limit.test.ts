import { describe, expect, it } from "vitest";
import { resolveWorktreeCapacityLimit } from "../workflow-capacity.js";
import { DEFAULT_SETTINGS } from "../settings-schema.js";

/*
FNXC:CapacityModel 2026-07-28-12:40:
`resolveWorktreeCapacityLimit` is THE single expression of "are worktrees a
capacity dimension for this project?". These cases pin the distinction the whole
worktrees-off design rests on: OFF returns `null` (absence — callers build no gate)
and never a large number, because "very high" is a limiter that can start binding
again while absence cannot.
*/
describe("resolveWorktreeCapacityLimit", () => {
  it("returns the configured limit when worktrees are enabled", () => {
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 7, worktreeLimitEnabled: true })).toBe(7);
  });

  it("treats an omitted worktreeLimitEnabled as ON (back-compat for every existing project)", () => {
    // Existing rows have no `worktreeLimitEnabled` key. They must keep gating exactly
    // as before — an upgrade must not silently remove a limiter operators rely on.
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 3 } as never)).toBe(3);
  });

  it("returns null — not Infinity, not a large number — when worktrees are off", () => {
    const resolved = resolveWorktreeCapacityLimit({ maxWorktrees: 4, worktreeLimitEnabled: false });
    expect(resolved).toBeNull();
    // Explicitly NOT a number: a numeric "disabled" value is a sentinel, and a
    // sentinel is what silently stopped binding in the capacity-pool-id defect.
    expect(typeof resolved).not.toBe("number");
  });

  it("ignores maxWorktrees entirely when off, including values that would deadlock", () => {
    // 0 deadlocks the ON path (`used >= 0` holds on an empty board). Off must not
    // care what the number is.
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 0, worktreeLimitEnabled: false })).toBeNull();
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 999, worktreeLimitEnabled: false })).toBeNull();
    expect(resolveWorktreeCapacityLimit({ worktreeLimitEnabled: false } as never)).toBeNull();
  });

  it("falls back to the shipped default when the limit is missing or non-finite", () => {
    expect(resolveWorktreeCapacityLimit({ worktreeLimitEnabled: true } as never)).toBe(DEFAULT_SETTINGS.maxWorktrees);
    expect(resolveWorktreeCapacityLimit(undefined)).toBe(DEFAULT_SETTINGS.maxWorktrees);
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: Number.NaN } as never)).toBe(DEFAULT_SETTINGS.maxWorktrees);
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: Infinity } as never)).toBe(DEFAULT_SETTINGS.maxWorktrees);
  });

  it("ships with worktrees enabled by default", () => {
    // The supported shape is everything-in-a-worktree, planning included.
    expect(DEFAULT_SETTINGS.worktreeLimitEnabled).toBe(true);
  });
});

/*
FNXC:CapacityModel 2026-07-29-22:55:
"Worktrees off" must make `maxWorktrees` genuinely INERT for admission, not merely skipped by
convention. `resolveWorktreeCapacityLimit` is the only expression of that, so the invariant is not
"the resolver is correct" (asserted above) but "nothing bounds admission WITHOUT going through it".

A unit test on the resolver cannot see a second reader. This one enumerates every non-test source
file that uses `maxWorktrees` in a BOUNDING expression — a comparison, a multiplier, a min/max — and
requires each to be named with a reason. A new raw bound fails here rather than quietly re-limiting a
project that turned worktrees off.

MEASURED at the time of writing: exactly two, and only one of them bounds admission.
*/
describe("worktrees-off is structural: no unaudited maxWorktrees bound", () => {
  /** file → why a raw `maxWorktrees` bound is legitimate there. */
  const AUDITED_BOUNDS: Record<string, string> = {
    "packages/engine/src/scheduler.ts":
      "THE admission gate. Reads the limit only via resolveWorktreeCapacityLimit (single call site), "
      + "and its gate snapshot is optional so OFF mode constructs no gate at all.",
    "packages/engine/src/self-healing.ts":
      "enforceWorktreeCap: on-disk hygiene, not admission. Caps worktree DIRECTORIES at 2x and only "
      + "removes idle ones. Must keep applying in OFF mode or idle worktrees accumulate unbounded.",
  };

  it("every file bounding on maxWorktrees is audited", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = resolve(__dirname, "../../../..");

    const files = execFileSync("git", ["ls-files", "--", "packages"], { cwd: root, encoding: "utf-8" })
      .split("\n")
      .filter((f) => f && /\/src\//.test(f) && /\.tsx?$/.test(f) && !f.includes("__tests__"));

    /*
    A bounding use: `maxWorktrees` on a line that also compares or does arithmetic with it.
    TypeScript generic spans are removed first — `Pick<Settings, "maxWorktrees" | ...>` ends in `">`,
    which reads as a comparison and made this ratchet flag its own resolver's signature.
    */
    const stripGenerics = (line: string): string => {
      let previous;
      let current = line;
      do { previous = current; current = current.replace(/<[^<>]*>/g, " "); } while (current !== previous);
      return current;
    };
    const BOUNDING = /(>=|<=|[^=!<>]>[^=>]|[^=!<>]<[^=<]|\*|Math\.(min|max))/;

    const offenders: string[] = [];
    for (const file of files) {
      const src = await stripComments(readFileSync(resolve(root, file), "utf-8"));
      if (!src.includes("maxWorktrees")) continue;
      for (const line of src.split("\n")) {
        if (!line.includes("maxWorktrees")) continue;
        const bare = stripGenerics(line);
        if (!bare.includes("maxWorktrees")) continue;
        if (BOUNDING.test(bare) && !(file in AUDITED_BOUNDS)) {
          offenders.push(`${file}: ${line.trim()}`);
          break;
        }
      }
    }

    expect(
      offenders,
      "a new raw maxWorktrees bound appeared. Admission must resolve through "
      + "resolveWorktreeCapacityLimit (null = worktrees are not a capacity dimension). If the bound is "
      + "genuinely not about admission, add it to AUDITED_BOUNDS with the reason.",
    ).toEqual([]);

    // The allowlist must not rot into a list of files that no longer bound anything: a stale entry
    // would let a real new bound hide behind an audited name.
    for (const file of Object.keys(AUDITED_BOUNDS)) {
      const src = await stripComments(readFileSync(resolve(root, file), "utf-8"));
      expect(src, `${file} no longer bounds on maxWorktrees — drop its AUDITED_BOUNDS entry`).toContain("maxWorktrees");
    }
  });

  it("admission has exactly one worktree-limit reader", async () => {
    const { execFileSync } = await import("node:child_process");
    const { resolve } = await import("node:path");
    const root = resolve(__dirname, "../../../..");
    // Call sites only (exclude the definition, the barrel re-exports, and prose).
    const hits = execFileSync(
      "git",
      ["grep", "-n", "resolveWorktreeCapacityLimit({", "--", "packages"],
      { cwd: root, encoding: "utf-8" },
    ).split("\n").filter((l) => l && !l.includes("__tests__"));

    expect(hits.length, `expected one admission reader, got:\n${hits.join("\n")}`).toBe(1);
    expect(hits[0]).toContain("packages/engine/src/scheduler.ts");
  });
});

/*
FNXC:CapacityModel 2026-07-30-15:10 (one shared stripper — #2633 owns it now):
Imports the comment stripper from the PROGRAM'S census lib rather than carrying one here. This test
briefly had its own, `replace(/^\s*\/\/.*$/gm, " ")`, which only matched a comment occupying a WHOLE
line — a trailing `foo(); // maxWorktrees * 2` survived, so its prose could trip the unaudited-bound
check as a false positive on a file with no raw bounding code at all. A ratchet that fires on prose is
a ratchet someone mutes.

I then had a second copy in my own census script; #2633 merged the canonical one, so both of mine are
gone and this points at the survivor. Three implementations of "strip comments" was the exact drift
shape this program keeps paying for.
*/
async function stripComments(src: string): Promise<string> {
  const mod = await import("../../../../scripts/lib/lifecycle-column-census.mjs");
  return (mod as { stripComments: (s: string) => string }).stripComments(src);
}
