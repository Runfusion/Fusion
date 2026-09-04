import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_MODEL_MIN_CLAUDE_CODE_VERSION,
  buildAnthropicClaudeCodeIdentityHeaders,
  CLAUDE_CODE_CLIENT_VERSION_ENV,
  CLAUDE_CODE_IMPERSONATED_VERSION,
  compareClaudeCodeVersions,
  resolveClaudeCodeClientVersion,
} from "../ai/claude-code-identity.js";
import { SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION } from "../ai/anthropic-models.js";

describe("Claude Code identity headers", () => {
  it("emits a lowercase user-agent only for Anthropic OAuth credentials", () => {
    expect(buildAnthropicClaudeCodeIdentityHeaders({ providerId: "anthropic", apiKey: "sk-ant-oat-test" })).toEqual({
      "user-agent": "claude-cli/2.1.251",
    });
    expect(buildAnthropicClaudeCodeIdentityHeaders({ providerId: "anthropic-subscription", apiKey: "sk-ant-oat-test" })).toEqual({
      "user-agent": "claude-cli/2.1.251",
    });
    expect(buildAnthropicClaudeCodeIdentityHeaders({ providerId: "anthropic-api-key", apiKey: "sk-ant-api-test" })).toEqual({});
    expect(buildAnthropicClaudeCodeIdentityHeaders({ providerId: "openrouter", apiKey: "sk-ant-oat-test" })).toEqual({});
    expect(buildAnthropicClaudeCodeIdentityHeaders({ providerId: "anthropic" })).toEqual({});
    expect(buildAnthropicClaudeCodeIdentityHeaders({ apiKey: "sk-ant-oat-test" })).toEqual({});
  });

  it("uses a valid environment override and rejects malformed values", () => {
    expect(resolveClaudeCodeClientVersion({ [CLAUDE_CODE_CLIENT_VERSION_ENV]: "2.9.0" })).toBe("2.9.0");
    for (const value of ["", "latest", "2.1", " 2.1.300 "]) {
      const onWarn = vi.fn();
      expect(resolveClaudeCodeClientVersion({ [CLAUDE_CODE_CLIENT_VERSION_ENV]: value }, onWarn)).toBe(CLAUDE_CODE_IMPERSONATED_VERSION);
      expect(onWarn).toHaveBeenCalledOnce();
    }
  });

  it("compares versions numerically", () => {
    expect(compareClaudeCodeVersions("2.1.75", "2.1.251")).toBeLessThan(0);
    expect(compareClaudeCodeVersions("2.1.251", "2.2.0")).toBeLessThan(0);
    expect(compareClaudeCodeVersions("2.2.0", "10.0.0")).toBeLessThan(0);
  });

  it("keeps the impersonated version at every registered model minimum", () => {
    const registeredModelIds = new Set(SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models.map((model) => model.id));
    for (const [modelId, minimum] of Object.entries(ANTHROPIC_MODEL_MIN_CLAUDE_CODE_VERSION)) {
      expect(registeredModelIds).toContain(modelId);
      expect(compareClaudeCodeVersions(CLAUDE_CODE_IMPERSONATED_VERSION, minimum)).toBeGreaterThanOrEqual(0);
    }
  });
});
