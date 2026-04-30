import { describe, expect, it } from "vitest";
import { ResearchProviderRegistry } from "../provider-registry.js";

describe("ResearchProviderRegistry", () => {
  it("instantiates providers with defaults", () => {
    const registry = new ResearchProviderRegistry({}, process.cwd());
    expect(registry.getProvider("web-search")).toBeDefined();
    expect(registry.getProvider("page-fetch")).toBeDefined();
    expect(registry.isProviderAvailable("local-docs")).toBe(true);
    expect(registry.isProviderAvailable("github")).toBe(false);
  });

  it("detects search backend from credentials", () => {
    const tavily = new ResearchProviderRegistry({ researchTavilyApiKey: "key" }, process.cwd());
    expect(tavily.isProviderAvailable("web-search")).toBe(true);

    const searx = new ResearchProviderRegistry({ researchSearxngUrl: "https://sx.local" }, process.cwd());
    expect(searx.isProviderAvailable("web-search")).toBe(true);
  });

  it("returns only configured providers in available list", () => {
    const registry = new ResearchProviderRegistry(
      {
        researchWebSearchProvider: "brave",
        researchBraveApiKey: "token",
        researchGitHubEnabled: true,
      },
      process.cwd(),
    );

    const available = registry.getAvailableProviders();
    expect(available).toContain("web-search");
    expect(available).toContain("local-docs");
  });

  it("refreshes providers after settings changes", () => {
    const registry = new ResearchProviderRegistry({ researchWebSearchProvider: "none" }, process.cwd());
    expect(registry.isProviderAvailable("web-search")).toBe(false);

    registry.refreshSettings({ researchWebSearchProvider: "tavily", researchTavilyApiKey: "key" });
    expect(registry.isProviderAvailable("web-search")).toBe(true);
  });

  it("gracefully degrades disabled providers", () => {
    const registry = new ResearchProviderRegistry({ researchGitHubEnabled: false, researchLocalDocsEnabled: false }, process.cwd());
    expect(registry.isProviderAvailable("github")).toBe(false);
    expect(registry.isProviderAvailable("local-docs")).toBe(false);
  });
});
