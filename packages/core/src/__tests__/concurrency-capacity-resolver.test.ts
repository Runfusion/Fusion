import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../types.js";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_WORKTREES,
  resolveEffectiveConcurrency,
  resolveMaxConcurrentSetting,
} from "../workflows/workflow-capacity.js";

/*
FNXC:CapacityModel 2026-08-22-00:09:
FN-9189's surface audit requires invalid persisted maxConcurrent values to resolve identically through both exported entry points. Production callers use the agent ceiling, so this shared matrix protects it from leaking an invalid scalar after the fallback resolver sanitizes it.
*/
const INVALID_MAX_CONCURRENT_CASES = [
  ["zero", 0],
  ["negative", -3],
  ["NaN", Number.NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["numeric string", "2"],
  ["null", null],
  ["undefined", undefined],
  ["missing key", {}],
] as const;

function invalidMaxConcurrentSettings(value: unknown) {
  return (value !== null && typeof value === "object" ? value : { maxConcurrent: value }) as never;
}

describe("resolveEffectiveConcurrency", () => {
  it("uses shipped defaults for absent values", () => {
    expect(resolveEffectiveConcurrency(undefined)).toEqual({
      maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      worktreeLimit: DEFAULT_PROJECT_SETTINGS.maxWorktrees,
    });
  });

  it.each(INVALID_MAX_CONCURRENT_CASES)("falls back for invalid maxConcurrent: %s", (_label, value) => {
    expect(resolveMaxConcurrentSetting(invalidMaxConcurrentSettings(value))).toBe(DEFAULT_PROJECT_SETTINGS.maxConcurrent);
  });

  it.each(INVALID_MAX_CONCURRENT_CASES)("returns a finite default agent ceiling for invalid maxConcurrent: %s", (_label, value) => {
    const resolved = resolveEffectiveConcurrency(invalidMaxConcurrentSettings(value));

    expect(resolved).toEqual({
      maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      worktreeLimit: DEFAULT_PROJECT_SETTINGS.maxWorktrees,
    });
    expect(Number.isFinite(resolved.maxConcurrent)).toBe(true);
    expect(resolved.maxConcurrent).toBeGreaterThan(0);
  });

  it.each(INVALID_MAX_CONCURRENT_CASES)("keeps the worktree dimension independent for invalid maxConcurrent: %s", (_label, value) => {
    expect(resolveEffectiveConcurrency({
      ...invalidMaxConcurrentSettings(value),
      maxWorktrees: 1,
      worktreeLimitEnabled: true,
    })).toEqual({
      maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      worktreeLimit: 1,
    });
  });

  it.each(INVALID_MAX_CONCURRENT_CASES)("removes the worktree dimension when disabled for invalid maxConcurrent: %s", (_label, value) => {
    expect(resolveEffectiveConcurrency({
      ...invalidMaxConcurrentSettings(value),
      worktreeLimitEnabled: false,
    })).toEqual({
      maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      worktreeLimit: null,
    });
  });

  it("keeps maxConcurrent 30 independent from maxWorktrees 3", () => {
    expect(resolveEffectiveConcurrency({ maxConcurrent: 30, maxWorktrees: 3, worktreeLimitEnabled: true })).toEqual({
      maxConcurrent: 30,
      worktreeLimit: 3,
    });
  });

  it("makes the worktree dimension structurally absent when disabled", () => {
    expect(resolveEffectiveConcurrency({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: false })).toEqual({
      maxConcurrent: 8,
      worktreeLimit: null,
    });
  });

  it("keeps exported capacity defaults aligned with shipped settings", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(DEFAULT_PROJECT_SETTINGS.maxConcurrent);
    expect(DEFAULT_MAX_WORKTREES).toBe(DEFAULT_PROJECT_SETTINGS.maxWorktrees);
  });
});
