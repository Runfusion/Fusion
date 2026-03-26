import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateWorktreeName } from "./worktree-names.js";

describe("generateWorktreeName", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hai-wt-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns a name matching adjective-noun pattern", () => {
    const name = generateWorktreeName(tempDir);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("returns different names on subsequent calls (not deterministic)", () => {
    // Generate several names — at least some should differ
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateWorktreeName(tempDir));
    }
    // With 2500 combinations and 20 draws, we'd expect multiple unique names
    expect(names.size).toBeGreaterThan(1);
  });

  it("avoids collision with existing .worktrees/ directories", () => {
    // Create .worktrees dir with a known name
    const worktreesDir = join(tempDir, ".worktrees");
    mkdirSync(worktreesDir, { recursive: true });

    // We need to force a collision — mock Math.random to always pick the same words
    const originalRandom = Math.random;
    Math.random = () => 0; // Will always pick first adjective and first noun
    try {
      // First call: should get the base name (e.g., "amber-badger")
      const firstName = generateWorktreeName(tempDir);
      expect(firstName).toMatch(/^[a-z]+-[a-z]+$/);
      expect(firstName).not.toMatch(/-\d+$/); // no suffix

      // Create that directory to simulate collision
      mkdirSync(join(worktreesDir, firstName));

      // Second call: should get a suffixed name
      const secondName = generateWorktreeName(tempDir);
      expect(secondName).toBe(`${firstName}-2`);

      // Create that too
      mkdirSync(join(worktreesDir, secondName));

      // Third call: should get -3
      const thirdName = generateWorktreeName(tempDir);
      expect(thirdName).toBe(`${firstName}-3`);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("works when .worktrees/ directory does not exist", () => {
    // tempDir has no .worktrees/ subdirectory
    const name = generateWorktreeName(tempDir);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });
});
