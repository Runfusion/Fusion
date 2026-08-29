import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ceBrainstormRoot = fileURLToPath(new URL("../skills/ce-brainstorm/", import.meta.url));
const visualProbesPath = join(ceBrainstormRoot, "references/visual-probes.md");
const skillPath = join(ceBrainstormRoot, "SKILL.md");
const brainstormSectionsPath = join(ceBrainstormRoot, "references/brainstorm-sections.md");

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

function listMarkdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return listMarkdownFiles(path);
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      return [path];
    }
    return [];
  });
}

function lineNumberForOffset(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

/*
FNXC:CompoundEngineering 2026-06-27-01:15:
CE brainstorm and plan share a unified durable artifact under docs/plans/, while docs/brainstorms/ remains only a legacy input. This content guard protects the prompt-executed bundled skill text from regressing to a new-output or durable-artifact claim for docs/brainstorms/ during future upstream refreshes.
*/
describe("bundled ce-brainstorm docs/plans alias content", () => {
  it("does not name docs/brainstorms as the durable or new brainstorm output", () => {
    const forbiddenDurableOutputClaims = [
      /docs\/brainstorms\/[^\n.]*\b(?:is|are)\b[^\n.]*\bdurable artifact\b/gi,
      /(?:durable artifact|durable document|durable output|final requirements doc)[^\n.]*docs\/brainstorms\//gi,
      /new\s+`?ce-brainstorm`?\s+outputs?\s+(?:write|go|land|belong)[^\n.]*docs\/brainstorms\//gi,
    ];

    const failures = listMarkdownFiles(ceBrainstormRoot).flatMap((path) => {
      const content = readUtf8(path);
      return forbiddenDurableOutputClaims.flatMap((pattern) => {
        pattern.lastIndex = 0;
        return Array.from(content.matchAll(pattern), (match) => {
          const line = lineNumberForOffset(content, match.index ?? 0);
          return `${relative(ceBrainstormRoot, path)}:${line}: ${match[0]}`;
        });
      });
    });

    expect(failures).toEqual([]);
  });

  it("keeps visual probes pointing at docs/plans for the durable artifact", () => {
    const visualProbes = readUtf8(visualProbesPath);

    expect(visualProbes).toContain(
      "The requirements-only unified plan in `docs/plans/` is the durable artifact.",
    );
    expect(visualProbes).not.toContain(
      "The final requirements doc in `docs/brainstorms/` is the durable artifact.",
    );
  });

  it("keeps docs/brainstorms labeled as legacy input rather than new output", () => {
    const skill = readUtf8(skillPath);
    const brainstormSections = readUtf8(brainstormSectionsPath);

    expect(skill).toContain(
      "Historical `docs/brainstorms/*-requirements.{md,html}` files remain legacy inputs for `ce-plan`, but new `ce-brainstorm` outputs do not write there.",
    );
    expect(brainstormSections).toContain(
      "Historical `docs/brainstorms/*-requirements.*` files remain valid legacy\ninputs. Do not migrate or rewrite them when creating new artifacts.",
    );
  });

  it("keeps the ce-brainstorm skill directory present for recursive content checks", () => {
    expect(statSync(ceBrainstormRoot).isDirectory()).toBe(true);
    expect(listMarkdownFiles(ceBrainstormRoot).length).toBeGreaterThan(0);
  });
});
