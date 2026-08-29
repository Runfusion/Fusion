import { describe, expect, it } from "vitest";
import { ResearchProviderRegistry } from "../provider-registry.js";

describe("ResearchProviderRegistry", () => {
  it("instantiates providers with defaults", () => {
    const registry = new ResearchProviderRegistry({}, process.cwd());
    expect(registry.getProvider("web-search")).toBeDefined();
    expect(registry.getProvider("page-fetch")).toBeDefined();
    expect(registry.isProviderAvailable("web-search")).toBe(true);
    expect(registry.isProviderAvailable("local-docs")).toBe(true);
    expect(registry.isProviderAvailable("github")).toBe(false);
  });

  it("requires credentials for explicit external providers", () => {
    const registry = new ResearchProviderRegistry({ researchGlobalWebSearchProvider: "tavily" }, process.cwd());
    expect(registry.isProviderAvailable("web-search")).toBe(false);
  });

  it("returns only configured providers in available list", () => {
    const registry = new ResearchProviderRegistry(
      {
        researchGlobalWebSearchProvider: "brave",
        researchGlobalBraveApiKey: "token",
        researchGlobalGitHubEnabled: true,
      },
      process.cwd(),
    );

    const available = registry.getAvailableProviders();
    expect(available).toContain("web-search");
    expect(available).toContain("local-docs");
  });

  it("refreshes providers after settings changes", () => {
    const registry = new ResearchProviderRegistry({ researchGlobalWebSearchProvider: "tavily" }, process.cwd());
    expect(registry.isProviderAvailable("web-search")).toBe(false);

    registry.refreshSettings({ researchGlobalWebSearchProvider: "tavily", researchGlobalTavilyApiKey: "key" });
    expect(registry.isProviderAvailable("web-search")).toBe(true);
  });
});
