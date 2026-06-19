import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const docsReadmePath = resolve(workspaceRoot, "docs", "README.md");

const requiredDocs = [
  "docs/dev-server-modules.md",
  "docs/workflow-editor.md",
  "docs/plugins/external-proof-point-runbook.md",
  "docs/research/pi-autoresearch-analysis.md",
  "docs/research/research-hardening-preflight.md",
  "docs/upstream/claude-code-cli-acp-mcp-permission-forwarding.md",
] as const;

/*
FNXC:DocsIndex 2026-06-15-01:35:
FN-6479 keeps CLI Printing Press design and research entries indexed only as Audit Reports, not duplicated in Plugins.
This test guards the documentation-index dedup invariant while requiredDocs guards committed upstream artifacts that must remain discoverable.
*/

describe("docs README index", () => {
  it("includes links for required docs and those files exist", () => {
    expect(existsSync(docsReadmePath)).toBe(true);
    const docsReadme = readFileSync(docsReadmePath, "utf8");

    for (const relativePath of requiredDocs) {
      const readmeLinkPath = `./${relativePath.replace(/^docs\//, "")}`;
      expect(docsReadme).toContain(`(${readmeLinkPath})`);
      expect(existsSync(resolve(workspaceRoot, relativePath))).toBe(true);
    }
  });

  it("keeps CLI Printing Press entries in Audit Reports only", () => {
    const docsReadme = readFileSync(docsReadmePath, "utf8");
    const pluginsHeadingIndex = docsReadme.indexOf("### Plugins");
    expect(pluginsHeadingIndex).toBeGreaterThanOrEqual(0);

    const nextHeadingIndex = docsReadme.indexOf("\n### ", pluginsHeadingIndex + 1);
    expect(nextHeadingIndex).toBeGreaterThan(pluginsHeadingIndex);

    const pluginsSection = docsReadme.slice(pluginsHeadingIndex, nextHeadingIndex);
    expect(pluginsSection).not.toContain("cli-printing-press");
    expect(docsReadme).toContain("./design/cli-printing-press-plugin.md");
    expect(docsReadme).toContain("./research/cli-printing-press.md");
  });
});
