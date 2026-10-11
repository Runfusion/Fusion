import { describe, expect, it } from "vitest";
import { extractEffectiveWriteScopeFromPrompt } from "@fusion/core";
import {
  canonicalizeDeclaredFileScope,
  normalizeScopePath,
} from "../self-healing-git-evidence.js";

/*
FNXC:AlreadyMergedFalsePositive 2026-10-11-10:21: RUFU-396.
The never-delivered proof compares a card's DECLARED File Scope against the paths of the base commits
stamped with its id. That comparison is only as trustworthy as the scope read, so this file records the
parser truth the proof is built on rather than assuming it:
  - the store's effective write scope (`extractEffectiveWriteScopeFromPrompt`, what
    `store.parseFileScopeFromPrompt` returns) reads only backticked tokens and only the FIRST
    `## File Scope` section;
  - a card whose scope is written as bare bullet paths therefore has an EMPTY effective set, which is
    exactly RUFU-391's shape — so the proof must fall back to the raw prompt list, and must never read
    an empty parse as "nothing was in scope".
*/

/** RUFU-391's real shape: two `## File Scope` headings, section 2 documenting the parse itself. */
const TWO_SECTION_PROMPT = [
  "# Card",
  "",
  "## File Scope",
  "- `packages/cli/src/commands/settings.ts`",
  "- `packages/core/src/config/settings-export.ts`",
  "",
  "## File Scope",
  "- `packages/engine/src/self-healing.ts`",
  "",
  "## Steps",
  "1. do the thing",
].join("\n");

describe("declared File Scope read for the never-delivered proof", () => {
  it("the store's effective set reads the FIRST File Scope section only (which section wins)", () => {
    const effective = extractEffectiveWriteScopeFromPrompt(TWO_SECTION_PROMPT);
    expect(effective).toContain("packages/cli/src/commands/settings.ts");
    expect(effective).toContain("packages/core/src/config/settings-export.ts");
    // The second section's file must NOT be in the effective set: the store parser stops at the
    // first section's end, so a prompt with two sections delivers section 1 and nothing else.
    expect(effective).not.toContain("packages/engine/src/self-healing.ts");
  });

  it("carries a bare-bullet scope through the canonical read when the store parser returns nothing", () => {
    // Proven premise: RUFU-391's declared scope is bare bullet paths.
    const bareBulletPrompt = [
      "## File Scope",
      "- packages/cli/src/commands/settings.ts",
      "- docs/cli-reference.md",
    ].join("\n");
    expect(extractEffectiveWriteScopeFromPrompt(bareBulletPrompt)).toEqual([]);

    // The proof's own read must still see them, otherwise an empty parse would read as
    // "this card declared no files" and every never-delivered verdict would be unreachable.
    const canonical = canonicalizeDeclaredFileScope({ promptContent: bareBulletPrompt });
    expect(canonical).toContain("packages/cli/src/commands/settings.ts");
    expect(canonical).toContain("docs/cli-reference.md");
  });

  it("unions every declared-scope source: prompt list, effective set, and sourceMetadata", () => {
    const canonical = canonicalizeDeclaredFileScope({
      promptContent: TWO_SECTION_PROMPT,
      sourceMetadataFileScope: ["packages/engine/src/self-healing.ts", "- `docs/run-audit.md`"],
    });
    expect(canonical).toContain("packages/cli/src/commands/settings.ts");
    expect(canonical).toContain("packages/engine/src/self-healing.ts");
    expect(canonical).toContain("docs/run-audit.md");
  });

  it("reports no declared scope when no source carries one, so the proof stays unknown", () => {
    expect(canonicalizeDeclaredFileScope({ promptContent: "# Card\n\n## Steps\n1. x\n" })).toEqual([]);
    expect(canonicalizeDeclaredFileScope({ promptContent: null, sourceMetadataFileScope: [] })).toEqual([]);
    // Prose-only bullets are not paths; a prompt whose scope section is pure prose declares nothing.
    expect(canonicalizeDeclaredFileScope({ promptContent: "## File Scope\n- the files named above\n" })).toEqual([]);
  });

  it("normalizes rootDir prefixes, backticked globs and trailing annotations to one path form", () => {
    expect(normalizeScopePath("<rootDir>/packages/engine/src/self-healing.ts")).toBe("packages/engine/src/self-healing.ts");
    expect(normalizeScopePath("./docs/run-audit.md")).toBe("docs/run-audit.md");
    expect(normalizeScopePath("  `packages/dashboard/app/**/*.css`  ")).toBe("packages/dashboard/app/**/*.css");
    expect(normalizeScopePath("packages/engine/src/self-healing.ts (the reclaim arm)")).toBe("packages/engine/src/self-healing.ts");
  });
});
