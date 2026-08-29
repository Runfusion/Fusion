import { describe, expect, it } from "vitest";
import { isEvalsExperimentalEnabled, resolveEvalSettings } from "../eval/eval-settings.js";

describe("isEvalsExperimentalEnabled", () => {
  it("returns false when settings are undefined", () => {
    expect(isEvalsExperimentalEnabled(undefined)).toBe(false);
  });

  it("returns false when experimentalFeatures are missing", () => {
    expect(isEvalsExperimentalEnabled({})).toBe(false);
  });

  it("returns false when evalsView is false", () => {
    expect(
      isEvalsExperimentalEnabled({
        experimentalFeatures: { evalsView: false },
      }),
    ).toBe(false);
  });

  it("returns true when evalsView is true", () => {
    expect(
      isEvalsExperimentalEnabled({
        experimentalFeatures: { evalsView: true },
      }),
    ).toBe(true);
  });
});

describe("resolveEvalSettings", () => {
  it("returns deterministic defaults when eval settings are unset", () => {
    expect(resolveEvalSettings({})).toEqual({
      enabled: false,
      intervalMs: 86_400_000,
      evaluatorProvider: undefined,
      evaluatorModelId: undefined,
      followUpPolicy: "suggest-only",
      retentionDays: 30,
    });
  });

  it("falls back to validator lane model when evaluator model is unset", () => {
    expect(
      resolveEvalSettings({
        validatorProvider: "anthropic",
        validatorModelId: "claude-sonnet-4-5",
      }),
    ).toEqual({
      enabled: false,
      intervalMs: 86_400_000,
      evaluatorProvider: "anthropic",
      evaluatorModelId: "claude-sonnet-4-5",
      followUpPolicy: "suggest-only",
      retentionDays: 30,
    });
  });

  it("prefers explicit evalSettings model overrides over validator lane", () => {
    expect(
      resolveEvalSettings({
        validatorProvider: "anthropic",
        validatorModelId: "claude-sonnet-4-5",
        evalSettings: {
          evaluatorProvider: "openai",
          evaluatorModelId: "gpt-5",
        },
      }),
    ).toEqual({
      enabled: false,
      intervalMs: 86_400_000,
      evaluatorProvider: "openai",
      evaluatorModelId: "gpt-5",
      followUpPolicy: "suggest-only",
      retentionDays: 30,
    });
  });

  it("ignores incomplete evaluator pair and keeps partial override + validator fallback", () => {
    expect(
      resolveEvalSettings({
        validatorProvider: "anthropic",
        validatorModelId: "claude-sonnet-4-5",
        evalSettings: {
          evaluatorProvider: "openai",
          intervalMs: 120_000,
          enabled: true,
          followUpPolicy: "auto-create",
          retentionDays: 14,
        },
      }),
    ).toEqual({
      enabled: true,
      intervalMs: 120_000,
      evaluatorProvider: "openai",
      evaluatorModelId: "claude-sonnet-4-5",
      followUpPolicy: "auto-create",
      retentionDays: 14,
    });
  });
});
