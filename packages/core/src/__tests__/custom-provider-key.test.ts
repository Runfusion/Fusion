import { describe, expect, it } from "vitest";
import type { CustomProvider } from "../types.js";
import { customProviderRegistryKey } from "../ai/custom-provider-key.js";

function provider(id: string, name: string): CustomProvider {
  return {
    id,
    name,
    apiType: "openai-compatible",
    baseUrl: "https://example.test",
  };
}

describe("customProviderRegistryKey", () => {
  it("slugifies provider names", () => {
    const providers = [provider("1", "My AI Provider")];
    expect(customProviderRegistryKey(providers[0]!, providers)).toBe("my-ai-provider");
  });

  it("handles punctuation and non-ascii", () => {
    const providers = [provider("1", "  Héllø!!! Provider ###  ")];
    expect(customProviderRegistryKey(providers[0]!, providers)).toBe("h-ll-provider");
  });

  it("falls back to id when name slug is empty", () => {
    const providers = [provider("550e8400-e29b-41d4-a716-446655440000", "!!!")];
    expect(customProviderRegistryKey(providers[0]!, providers)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("adds deterministic suffixes for two-way collisions", () => {
    const providers = [provider("1", "A"), provider("2", "A")];
    expect(customProviderRegistryKey(providers[0]!, providers)).toBe("a");
    expect(customProviderRegistryKey(providers[1]!, providers)).toBe("a-2");
  });

  it("adds deterministic suffixes for three-way collisions", () => {
    const providers = [provider("1", "A"), provider("2", "A"), provider("3", "A")];
    expect(customProviderRegistryKey(providers[0]!, providers)).toBe("a");
    expect(customProviderRegistryKey(providers[1]!, providers)).toBe("a-2");
    expect(customProviderRegistryKey(providers[2]!, providers)).toBe("a-3");
  });

  it("is stable for the same ordered list", () => {
    const providers = [provider("1", "A"), provider("2", "A")];
    const first = customProviderRegistryKey(providers[1]!, providers);
    const second = customProviderRegistryKey(providers[1]!, providers);
    expect(first).toBe("a-2");
    expect(second).toBe("a-2");
  });
});
