import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStylesCss } from "../test/cssFixture";

const componentsDir = resolve(__dirname, "../components");

const migratedRules = [
  { file: "GrokCliProviderCard.css", selector: ".grok-cli-binary-path-label" },
  { file: "OmpCliProviderCard.css", selector: ".omp-cli-binary-path-label" },
  { file: "CursorCliProviderCard.css", selector: ".cursor-cli-binary-path-label" },
  {
    file: "WorkflowNodeEditor.css",
    selector: ".wf-lifecycle-warning-code, .wf-lifecycle-warning-node",
  },
];

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractBlockAt(css: string, startIdx: number): string {
  const openBraceIdx = startIdx + css.slice(startIdx).indexOf("{");
  let depth = 1;

  for (let index = openBraceIdx + 1; index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}") depth--;
    if (depth === 0) return css.slice(startIdx, index + 1);
  }

  throw new Error(`Could not find closing brace for block at ${startIdx}`);
}

function extractRootBlock(css: string): string {
  const rootRegex = /:root\s*\{/g;
  let match: RegExpExecArray | null;
  let rootCount = 0;

  while ((match = rootRegex.exec(css)) !== null) {
    rootCount++;
    if (rootCount === 2) return extractBlockAt(css, match.index);
  }

  throw new Error("Could not find canonical base :root block");
}

function extractLightThemeBlock(css: string): string {
  const match = css.match(/:root\[data-theme="light"\]\s*\{/);
  if (!match) throw new Error("Could not find :root[data-theme=\"light\"] block");
  return extractBlockAt(css, match.index!);
}

function extractTokenDefinition(block: string, token: string): string {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escapedToken}:\\s*([^;]+);`));
  if (!match) throw new Error(`Could not find ${token} definition`);
  return match[1].trim();
}

function extractSelectorBlock(css: string, selector: string): string {
  const selectorPattern = selector
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{`));
  if (!match) throw new Error(`Could not find ${selector} rule`);
  return extractBlockAt(css, match.index!);
}

/*
FNXC:DashboardTextTokens 2026-07-15-00:00:
FN-8043 requires these four secondary-text rules to use canonical --text-muted, never the undefined
--text-secondary alias. Strip CSS comments before scanning so required migration rationale comments
can name the deprecated alias without violating the executable token-use invariant; require the
replacement token in both base and light theme blocks so it resolves on both supported theme paths.
*/
describe("deprecated secondary dashboard text token migration", () => {
  it("keeps the undefined secondary alias out of uncommented migrated CSS", () => {
    const offenders = migratedRules.flatMap(({ file }) => {
      const css = stripCssComments(readFileSync(resolve(componentsDir, file), "utf8"));
      return /--text-secondary\b/.test(css) ? [file] : [];
    });

    expect(offenders, `Unexpected deprecated --text-secondary usage in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("uses the canonical muted token in each migrated secondary-text rule", () => {
    for (const { file, selector } of migratedRules) {
      const css = readFileSync(resolve(componentsDir, file), "utf8");
      const rule = extractSelectorBlock(css, selector);
      expect(rule, `${file} ${selector} must use --text-muted`).toMatch(/color:\s*var\(--text-muted\);/);
    }
  });

  it("defines the muted replacement token in base and light theme blocks", () => {
    const css = loadStylesCss();
    const baseDefinition = extractTokenDefinition(extractRootBlock(css), "--text-muted");
    const lightDefinition = extractTokenDefinition(extractLightThemeBlock(css), "--text-muted");

    expect(baseDefinition, "--text-muted must be defined in the base :root theme").not.toBe("");
    expect(lightDefinition, "--text-muted must be defined in :root[data-theme=\"light\"]").not.toBe("");
  });
});
