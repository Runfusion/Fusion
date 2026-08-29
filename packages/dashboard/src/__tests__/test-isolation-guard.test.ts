import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("test isolation guard", () => {
  it("overrides HOME to a temp fn-test-home directory", () => {
    const home = process.env.HOME;

    expect(home).toBeDefined();
    expect(home).toContain(tmpdir());
    expect(home).toContain("fn-test-home-");
  });

  it("does not run from the real project root cwd", () => {
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = resolve(dirname(thisFile), "../../../../");
    const projectFusionDir = join(projectRoot, ".fusion");

    expect(process.cwd()).not.toBe(projectRoot);
    expect(process.cwd().startsWith(projectFusionDir)).toBe(false);
  });
});
