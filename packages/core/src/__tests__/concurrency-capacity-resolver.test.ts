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
FN-9189's surface audit requires invalid persisted maxConcurrent values to resolve identically through both exported entry points. Production callers use the effective ceiling, so this shared matrix protects it from leaking an invalid scalar after the fallback resolver sanitizes it.
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
      effectiveLimit: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      bindingKnob: "maxConcurrent",
    });
  });

  it.each(INVALID_MAX_CONCURRENT_CASES)("falls back for invalid maxConcurrent: %s", (_label, value) => {
    expect(resolveMaxConcurrentSetting(invalidMaxConcurrentSettings(value))).toBe(DEFAULT_PROJECT_SETTINGS.maxConcurrent);
  });

  it.each(INVALID_MAX_CONCURRENT_CASES)("returns a finite default effective ceiling for invalid maxConcurrent: %s", (_label, value) => {
    const resolved = resolveEffectiveConcurrency(invalidMaxConcurrentSettings(value));

    expect(resolved).toEqual({
      maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      worktreeLimit: DEFAULT_PROJECT_SETTINGS.maxWorktrees,
      effectiveLimit: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      bindingKnob: "maxConcurrent",
    });
    expect(Number.isFinite(resolved.maxConcurrent)).toBe(true);
    expect(resolved.maxConcurrent).toBeGreaterThan(0);
    expect(Number.isFinite(resolved.effectiveLimit)).toBe(true);
    expect(resolved.effectiveLimit).toBeGreaterThan(0);
  });

  it.each(INVALID_MAX_CONCURRENT_CASES)("keeps a binding worktree ceiling for invalid maxConcurrent: %s", (_label, value) => {
    const resolved = resolveEffectiveConcurrency({
      ...invalidMaxConcurrentSettings(value),
      maxWorktrees: 1,
      worktreeLimitEnabled: true,
    });

    expect(resolved).toEqual({
      maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      worktreeLimit: 1,
      effectiveLimit: 1,
      bindingKnob: "maxWorktrees",
    });
  });

  it.each(INVALID_MAX_CONCURRENT_CASES)("removes the worktree ceiling when disabled for invalid maxConcurrent: %s", (_label, value) => {
    const resolved = resolveEffectiveConcurrency({
      ...invalidMaxConcurrentSettings(value),
      worktreeLimitEnabled: false,
    });

    expect(resolved).toEqual({
      maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      worktreeLimit: null,
      effectiveLimit: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      bindingKnob: "maxConcurrent",
    });
  });

  it("honors configured values and names a binding worktree limit", () => {
    expect(resolveEffectiveConcurrency({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true })).toEqual({
      maxConcurrent: 8,
      worktreeLimit: 4,
      effectiveLimit: 4,
      bindingKnob: "maxWorktrees",
    });
  });

  it("makes the worktree dimension structurally absent when disabled", () => {
    expect(resolveEffectiveConcurrency({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: false })).toEqual({
      maxConcurrent: 8,
      worktreeLimit: null,
      effectiveLimit: 8,
      bindingKnob: "maxConcurrent",
    });
  });

  it("keeps exported capacity defaults aligned with shipped settings", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(DEFAULT_PROJECT_SETTINGS.maxConcurrent);
    expect(DEFAULT_MAX_WORKTREES).toBe(DEFAULT_PROJECT_SETTINGS.maxWorktrees);
  });
});
