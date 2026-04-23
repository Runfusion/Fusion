import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname!, "..", "..", "..", "..");

describe("Changeset configuration", () => {
  // Release guardrail: These tests protect the @runfusion/fusion release pipeline
  // by ensuring changeset configuration required for npm publishing remains intact.
  // If these tests fail, the automated release workflow will break.
  it("should have a valid .changeset/config.json", () => {
    const configPath = join(repoRoot, ".changeset", "config.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");
  });

  it("should have baseBranch set to 'main' for the default branch", () => {
    const configPath = join(repoRoot, ".changeset", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.baseBranch).toBe("main");
  });

  it("should have changeset scripts in root package.json", () => {
    // These scripts drive the changesets CLI workflow: changeset (add), version (bump), release:version (apply)
    const pkgPath = join(repoRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    expect(pkg.scripts.changeset).toBe("changeset");
    expect(pkg.scripts.version).toBe("changeset version");
    expect(pkg.scripts["release:version"]).toBe("changeset version");
  });

  it("should have .github/workflows/version.yml configured for manual releases", () => {
    const workflowPath = join(
      repoRoot,
      ".github",
      "workflows",
      "version.yml",
    );
    expect(existsSync(workflowPath)).toBe(true);

    const content = readFileSync(workflowPath, "utf-8");
    // Guardrail: workflow must use changesets/action for npm publishing
    expect(content).toContain("changesets/action");
    // Guardrail: workflow must be manually triggered (auto-trigger disabled for safety)
    expect(content).toContain("workflow_dispatch");
    expect(content).toContain("Auto-trigger disabled");
  });
});
