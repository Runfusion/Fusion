import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("worktree-backend static shellout guard", () => {
  it("does not use execSync and always sets timeout for exec/execFile calls", () => {
    const source = readFileSync(resolve(process.cwd(), "src/worktree/worktree-backend.ts"), "utf-8");

    expect(source).not.toContain("execSync(");
    expect(source).not.toMatch(/\bexecSync\b/);

    const callPattern = /exec(?:File)?Async\([\s\S]{0,400}?\{[\s\S]{0,400}?timeout\s*:/g;
    const callMatches = source.match(/exec(?:File)?Async\(/g) ?? [];
    const timeoutMatches = source.match(callPattern) ?? [];
    expect(timeoutMatches.length).toBeGreaterThanOrEqual(callMatches.length);
  });
});
