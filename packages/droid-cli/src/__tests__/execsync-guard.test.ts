import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("process-manager execSync guard", () => {
  it("keeps Droid CLI probing non-blocking", () => {
    const sourcePath = path.resolve(
      import.meta.dirname,
      "../../../../plugins/fusion-plugin-droid-runtime/src/process-manager.ts",
    );

    expect(existsSync(sourcePath)).toBe(true);
    const src = readFileSync(sourcePath, "utf-8");

    expect(/\bexecSync\b/.test(src)).toBe(false);
  });
});
