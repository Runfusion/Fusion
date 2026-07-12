import { describe, expect, it } from "vitest";
import { inferProviderIconKey } from "../providerIconKey";

describe("inferProviderIconKey", () => {
  it.each([
    ["claude-sonnet-4-5", "anthropic"],
    ["Anthropic Claude", "anthropic"],
    ["gpt-4o", "openai"],
    ["openai-codex", "openai"],
    ["gemini-2.5-pro", "google"],
    ["google-antigravity", "google"],
    ["cursor", "cursor-cli"],
    ["Cursor", "cursor-cli"],
    ["cursor-agent", "cursor-cli"],
    ["cursor/gpt-5", "cursor-cli"],
    ["ollama/llama3", "ollama"],
    ["minimax-text-01", "minimax"],
    ["zhipu-glm-4", "zai"],
    ["zai/glm-4.5", "zai"],
    ["glm-5.1", "zai"],
    ["glm-4.5-air", "zai"],
    ["glm-5v-turbo", "zai"],
    ["kimi-k2", "kimi"],
    ["moonshot-v1", "kimi"],
    ["amazon-bedrock-claude", "anthropic"],
    ["bedrock-titan", "bedrock"],
    ["xai-grok-4", "xai"],
    ["opencode", "opencode"],
    ["github copilot", "github-copilot"],
    ["copilot-gpt-4", "openai"],
  ])("maps %s to %s", (input, expected) => {
    expect(inferProviderIconKey(input)).toBe(expected);
  });

  it("returns unknown ids unchanged so ProviderIcon can render its fallback", () => {
    expect(inferProviderIconKey("custom-model-v1")).toBe("custom-model-v1");
    expect(inferProviderIconKey("not-a-glmish-model")).toBe("not-a-glmish-model");
    expect(inferProviderIconKey("")).toBe("");
  });
});
