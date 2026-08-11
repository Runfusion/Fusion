import { describe, expect, it } from "vitest";
import { isGlobalSettingsKey, isProjectSettingsKey } from "../config/settings-schema.js";
import { resolveRequiredCheckNames } from "../config/required-checks.js";

describe("resolveRequiredCheckNames", () => {
  it.each([undefined, null, {}, { requiredChecks: [] }, { requiredChecks: ["", "  "] }, { requiredChecks: "build" }, { requiredChecks: [1, null] }])("returns no names for %j", (settings) => {
    expect(resolveRequiredCheckNames(settings as any)).toEqual([]);
  });
  it("trims and deduplicates names in first-seen order", () => {
    expect(resolveRequiredCheckNames({ requiredChecks: ["build", "build ", " ci", "ci"] })).toEqual(["build", "ci"]);
  });
  it("registers the setting at project scope only", () => {
    expect(isProjectSettingsKey("requiredChecks")).toBe(true);
    expect(isGlobalSettingsKey("requiredChecks")).toBe(false);
  });
});
