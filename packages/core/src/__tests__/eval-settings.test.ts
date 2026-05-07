import { describe, expect, it } from "vitest";
import { resolveEvalSettings } from "../eval-settings.js";

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
