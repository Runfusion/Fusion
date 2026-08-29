import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  __resetSuggestionState,
  __setCreateAiSessionFactory,
  generateMilestoneSuggestions,
  ServiceUnavailableError,
} from "../roadmap-suggestions.js";

describe("roadmap suggestion service", () => {
  beforeEach(() => {
    __resetSuggestionState();
  });

  it("throws when AI factory is unavailable", async () => {
    await expect(generateMilestoneSuggestions("goal", 1, "/tmp/project")).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("uses PluginContext createAiSession-compatible factory", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    __setCreateAiSessionFactory(async () => ({
      session: {
        prompt,
        state: { messages: [{ role: "assistant", content: '[{"title":"A"}]' }] },
      },
    }));

    const result = await generateMilestoneSuggestions("goal", 1, "/tmp/project");
    expect(prompt).toHaveBeenCalled();
    expect(result[0]?.title).toBe("A");
  });
});
