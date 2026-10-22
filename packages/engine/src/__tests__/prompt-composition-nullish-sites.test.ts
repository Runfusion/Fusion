/*
FNXC:PromptSectionTotality 2026-10-22-15:33 (RUFU-707):
RUFU-707 was not one crash, it was one idiom in six places. `buildOperatorLanguageDirective` legitimately
returns `string | undefined` (unset / empty / whitespace / `"auto"`, and `"auto"` is the shipped default), and
six prompt-section joins dereferenced `.trim()` straight off the element. Only the first one was reachable
today; the other five were latent and would have lit up the moment a lane gained an optional section — which
is exactly how this class returns.

`tsc` cannot police it: several of those joins read a deps-bag function typed `AnyFn`, so the array literal
widens to `any[]` and `.trim()` on a `string | undefined` element typechecks clean. This guard is therefore
the ratchet — a code-construct scan over production sources that fails if the non-total predicate reappears.

Scope is the EXACT filter literals, deliberately not a loose `part.trim` substring:
`run-verification-tool.ts` filters over guaranteed-`string` params with `part.trim().length > 0`, and
`prompt-layers-backward-compat.test.ts` re-implements the predicate inside a test. Neither is the defect and
neither is claimed here. `__tests__` is excluded — this guards shipped sources, not harness code.
*/
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENGINE_SRC = fileURLToPath(new URL("../", import.meta.url));

/** The two non-total predicates this class shipped with. The fix adds `?.`; absence of these is the invariant. */
const NON_TOTAL_PREDICATES = [
  ".filter((section) => section.trim())",
  ".filter((part) => part.trim())",
] as const;

function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
    if (statSync(full).isDirectory()) found.push(...productionSources(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

describe("prompt-section composition stays total over nullish sections", () => {
  const sources = productionSources(ENGINE_SRC);

  it("walks a non-trivial production source population", () => {
    // A guard over zero files proves nothing; fail loudly if the walk shape ever breaks.
    expect(sources.length).toBeGreaterThan(50);
  });

  it("finds no non-total section predicate at any production site", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const literal of NON_TOTAL_PREDICATES) {
        if (text.includes(literal)) {
          offenders.push(`${relative(ENGINE_SRC, file)}: "${literal}"`);
        }
      }
    }

    expect(
      offenders,
      `Prompt-section joins must drop nullish sections with the optional-chaining predicate ` +
      `(".filter((section) => section?.trim())"). An absent operator-language directive is a valid ` +
      `configuration (RUFU-707), and the deps-bag AnyFn seam means tsc cannot catch this class:\n` +
      offenders.join("\n"),
    ).toEqual([]);
  });

  it("keeps the nullish-tolerant shape present where RUFU-707 fixed it", () => {
    // The guard must not pass by deleting the joins: the fixed predicate has to remain at the step seam.
    const stepSeam = readFileSync(join(ENGINE_SRC, "executor/execute-workflow-step.ts"), "utf8");
    expect(stepSeam).toContain("[stepInstructionParts.configTime, stepOperatorLanguageDirective].filter((section) => section?.trim())");
  });
});
