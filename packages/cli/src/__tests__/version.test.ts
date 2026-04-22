import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname!, "..", "..", "..", "..");

describe("Changeset configuration", () => {
  // Note: .changeset directory was intentionally removed to stop tracking local-only artifacts (FN-LOCAL).
  // These tests are skipped as the changeset files are no longer present.
  it.skip("should have a valid .changeset/config.json", () => {
    const configPath = join(repoRoot, ".changeset", "config.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");
  });

  it.skip("should have baseBranch set to main", () => {
    const configPath = join(repoRoot, ".changeset", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.baseBranch).toBe("main");
  });

  it.skip("should have changeset scripts in root package.json", () => {
    const pkgPath = join(repoRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    expect(pkg.scripts.changeset).toBe("changeset");
    expect(pkg.scripts.version).toBe("changeset version");
    expect(pkg.scripts["release:version"]).toBe("changeset version");
  });

  it("should have .github/workflows/version.yml with expected content", () => {
    const workflowPath = join(
      repoRoot,
      ".github",
      "workflows",
      "version.yml",
    );
    expect(existsSync(workflowPath)).toBe(true);

    const content = readFileSync(workflowPath, "utf-8");
    expect(content).toContain("changesets/action");
    expect(content).toContain("workflow_dispatch");
    expect(content).toContain("Auto-trigger disabled");
  });
});
