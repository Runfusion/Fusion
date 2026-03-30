import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe.skip("typecheck", () => {
  it("passes tsc --noEmit --skipLibCheck false", () => {
    const cwd = resolve(__dirname, "../..");
    expect(() =>
      execFileSync("npx", ["tsc", "--noEmit", "--skipLibCheck", "false"], {
        cwd,
        stdio: "pipe",
        timeout: 60_000,
      }),
    ).not.toThrow();
  });
});
