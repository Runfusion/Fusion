import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const docsReadmePath = resolve(workspaceRoot, "docs", "README.md");

const requiredDocs = [
  "docs/beads-dolt-sync-evaluation.md",
  "docs/dev-server-modules.md",
  "docs/research/pi-autoresearch-analysis.md",
  "docs/research/research-hardening-preflight.md",
] as const;

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
});
