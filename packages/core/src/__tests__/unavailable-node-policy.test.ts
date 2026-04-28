import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DEFAULT_PROJECT_SETTINGS,
  PROJECT_SETTINGS_KEYS,
  isGlobalSettingsKey,
  isProjectSettingsKey,
  type UnavailableNodePolicy,
  validateUnavailableNodePolicy,
} from "../index.js";

describe("unavailableNodePolicy settings contract", () => {
  it("accepts both supported UnavailableNodePolicy values", () => {
    expectTypeOf<UnavailableNodePolicy>().toEqualTypeOf<"block" | "fallback-local">();

    const block: UnavailableNodePolicy = "block";
    const fallbackLocal: UnavailableNodePolicy = "fallback-local";

    expect(block).toBe("block");
    expect(fallbackLocal).toBe("fallback-local");
  });

  it("defaults unavailableNodePolicy to block", () => {
    expect(DEFAULT_PROJECT_SETTINGS.unavailableNodePolicy).toBe("block");
  });

  it("classifies unavailableNodePolicy as project-only scope", () => {
    expect(isProjectSettingsKey("unavailableNodePolicy")).toBe(true);
    expect(isGlobalSettingsKey("unavailableNodePolicy")).toBe(false);
  });

  it("includes unavailableNodePolicy in PROJECT_SETTINGS_KEYS", () => {
    expect(PROJECT_SETTINGS_KEYS).toContain("unavailableNodePolicy");
  });

  it("validates supported and unsupported policy values", () => {
    expect(validateUnavailableNodePolicy("block")).toBe("block");
    expect(validateUnavailableNodePolicy("fallback-local")).toBe("fallback-local");
    expect(validateUnavailableNodePolicy(undefined)).toBeUndefined();
    expect(validateUnavailableNodePolicy("fallback-remote")).toBeUndefined();
    expect(validateUnavailableNodePolicy(42)).toBeUndefined();
  });
});
