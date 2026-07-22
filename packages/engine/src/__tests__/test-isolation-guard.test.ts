import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { getFusionAuthPath } from "../auth/auth-storage.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

describe("test isolation guard", () => {
  it("overrides HOME to a temp fn-test-home directory", () => {
    const home = process.env.HOME;

    expect(home).toBeDefined();
    expect(home).toContain(tmpdir());
    expect(home).toContain("fn-test-home-");
  });

  it("resolves Fusion auth path under temp HOME", () => {
    const home = process.env.HOME;
    const authPath = getFusionAuthPath();

    expect(home).toBeDefined();
    expect(authPath).toContain("fn-test-home-");
    expect(authPath.startsWith(home!)).toBe(true);
    expect(authPath).toContain(".fusion");
  });

  it("creates temp workspaces outside the real repo root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "fusion-test-guard-workspace-"));
    try {
      const repoRoot = process.env.FUSION_TEST_REAL_ROOT;
      expect(repoRoot).toBeDefined();
      expect(resolve(workspace).startsWith(resolve(repoRoot!))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
