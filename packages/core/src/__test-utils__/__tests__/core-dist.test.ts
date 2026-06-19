import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasBuiltCoreDistBarrel, requiredCoreDistFiles, tempWorkspace } from "../workspace.js";

describe("hasBuiltCoreDistBarrel", () => {
  function makeDistDir() {
    const root = tempWorkspace("fusion-core-dist-predicate-");
    const distDir = join(root, "dist");
    mkdirSync(distDir, { recursive: true });
    return distDir;
  }

  function touchDistFile(distDir: string, file: (typeof requiredCoreDistFiles)[number]) {
    writeFileSync(join(distDir, file), "export {};\n");
  }

  it("returns false when the dist barrel is absent", () => {
    const distDir = makeDistDir();

    expect(hasBuiltCoreDistBarrel(distDir)).toBe(false);
  });

  it("returns false when index.js exists without task-list-format.js", () => {
    const distDir = makeDistDir();
    touchDistFile(distDir, "index.js");

    expect(hasBuiltCoreDistBarrel(distDir)).toBe(false);
  });

  it("returns false when task-list-format.js exists without index.js", () => {
    const distDir = makeDistDir();
    touchDistFile(distDir, "task-list-format.js");

    expect(hasBuiltCoreDistBarrel(distDir)).toBe(false);
  });

  it("returns true only when all required core dist files exist", () => {
    const distDir = makeDistDir();
    for (const file of requiredCoreDistFiles) {
      touchDistFile(distDir, file);
    }

    expect(hasBuiltCoreDistBarrel(distDir)).toBe(true);
  });
});
