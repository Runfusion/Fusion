import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  evaluatePromptCondition,
  evaluatePromptConditionDetailed,
  resolveEffectivePluginSettings,
} from "../plugin-prompt-condition.js";

const settings = {
  "api-style": "minimal-apis",
  mode: "strict",
  count: 3,
  enabled: true,
};

describe("evaluatePromptCondition", () => {
  it("includes absent and empty conditions", () => {
    expect(evaluatePromptCondition(undefined, settings)).toBe(true);
    expect(evaluatePromptCondition("   ", settings)).toBe(true);
  });

  it("evaluates passing and failing equality comparisons", () => {
    expect(evaluatePromptCondition('settings["api-style"] === "minimal-apis"', settings)).toBe(true);
    expect(evaluatePromptCondition('settings["api-style"] === "controllers"', settings)).toBe(false);
  });

  it("evaluates passing and failing inequality comparisons", () => {
    expect(evaluatePromptCondition('settings["api-style"] !== "controllers"', settings)).toBe(true);
    expect(evaluatePromptCondition('settings["api-style"] !== "minimal-apis"', settings)).toBe(false);
  });

  it("accepts single quotes, double quotes, and whitespace variance", () => {
    expect(evaluatePromptCondition("settings['api-style'] === 'minimal-apis'", settings)).toBe(true);
    expect(evaluatePromptCondition(" settings [ \"api-style\" ]===  'minimal-apis' ", settings)).toBe(true);
    expect(evaluatePromptCondition("settings['api-style'] !== \"controllers\"", settings)).toBe(true);
  });

  it("fails closed on malformed or unsupported grammar", () => {
    expect(evaluatePromptConditionDetailed('settings["api-style"] == "minimal-apis"', settings)).toEqual({
      included: false,
      reason: "unsupported prompt contribution condition grammar",
    });
    expect(evaluatePromptCondition('settings["api-style"] === "minimal-apis" || true', settings)).toBe(false);
    expect(evaluatePromptCondition('process.env.SECRET === "x"', settings)).toBe(false);
  });

  it("compares absent and non-string settings deterministically", () => {
    expect(evaluatePromptCondition('settings["missing"] === "value"', settings)).toBe(false);
    expect(evaluatePromptCondition('settings["missing"] !== "value"', settings)).toBe(true);
    expect(evaluatePromptCondition('settings["count"] === "3"', settings)).toBe(false);
    expect(evaluatePromptCondition('settings["count"] !== "3"', settings)).toBe(true);
    expect(evaluatePromptCondition('settings["enabled"] === "true"', settings)).toBe(false);
  });

  it("is implemented without dynamic code execution", () => {
    const source = readFileSync(new URL("../plugin-prompt-condition.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/new\s+Function\b/);
    expect(source).not.toMatch(/from\s+["']node:vm["']|require\(["']node:vm["']\)|\bvm\s*\./);
  });
});

describe("resolveEffectivePluginSettings", () => {
  it("overlays stored values over schema defaults", () => {
    expect(resolveEffectivePluginSettings(
      { "api-style": "minimal-apis", extra: "kept" },
      {
        "api-style": { type: "enum", defaultValue: "controllers" },
        language: { type: "string", defaultValue: "csharp" },
      },
    )).toEqual({
      "api-style": "minimal-apis",
      language: "csharp",
      extra: "kept",
    });
  });

  it("uses default values when stored values are absent and leaves unset settings undefined", () => {
    const effective = resolveEffectivePluginSettings({}, {
      "api-style": { type: "enum", defaultValue: "controllers" },
      optional: { type: "string" },
    });

    expect(effective).toEqual({ "api-style": "controllers" });
    expect(evaluatePromptCondition('settings["api-style"] === "controllers"', effective)).toBe(true);
    expect(evaluatePromptCondition('settings["optional"] === "value"', effective)).toBe(false);
    expect(evaluatePromptCondition('settings["optional"] !== "value"', effective)).toBe(true);
  });
});
