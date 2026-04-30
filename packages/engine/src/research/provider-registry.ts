import type { GlobalSettings, ProjectSettings, WebSearchBackend } from "@fusion/core";
import { createLogger } from "../logger.js";
import type { ResearchProvider } from "../research-step-runner.js";
import type { ResearchProviderType } from "./types.js";
import { GitHubProvider } from "./providers/github-provider.js";
import { LLMSynthesisProvider } from "./providers/llm-synthesis-provider.js";
import { LocalDocsProvider } from "./providers/local-docs-provider.js";
import { PageFetchProvider } from "./providers/page-fetch-provider.js";
import { WebSearchProvider } from "./providers/web-search-provider.js";

const log = createLogger("research:provider-registry");

type SettingsLike = Partial<GlobalSettings & ProjectSettings>;

export class ResearchProviderRegistry {
  private providers = new Map<ResearchProviderType, ResearchProvider>();

  constructor(
    private settings: SettingsLike,
    private readonly projectRoot: string,
  ) {
    this.instantiateProviders();
  }

  getProvider(type: ResearchProviderType): ResearchProvider | undefined {
    return this.providers.get(type);
  }

  getAvailableProviders(): ResearchProviderType[] {
    return [...this.providers.entries()]
      .filter(([, provider]) => provider.isConfigured())
      .map(([type]) => type);
  }

  isProviderAvailable(type: ResearchProviderType): boolean {
    const provider = this.providers.get(type);
    return Boolean(provider?.isConfigured());
  }

  refreshSettings(settings: SettingsLike): void {
    this.settings = settings;
    this.instantiateProviders();
  }

  private instantiateProviders(): void {
    const backend = this.resolveSearchBackend();
    const maxResults = Number(this.settings.researchMaxSearchResults ?? 10);
    const fetchTimeoutMs = Number(this.settings.researchFetchTimeoutMs ?? 30_000);
    const userAgent = this.settings.researchUserAgent ?? "FusionResearchBot/1.0";

    this.providers = new Map<ResearchProviderType, ResearchProvider>([
      [
        "web-search",
        new WebSearchProvider({
          backend,
          searxngUrl: this.settings.researchSearxngUrl,
          braveApiKey: this.settings.researchBraveApiKey,
          googleApiKey: this.settings.researchGoogleSearchApiKey,
          googleCx: this.settings.researchGoogleSearchCx,
          tavilyApiKey: this.settings.researchTavilyApiKey,
          maxResults,
          timeoutMs: fetchTimeoutMs,
          userAgent,
        }),
      ],
      ["page-fetch", new PageFetchProvider({ timeoutMs: fetchTimeoutMs, userAgent })],
      ["github", this.settings.researchGitHubEnabled ? new GitHubProvider() : new DisabledProvider("github")],
      [
        "local-docs",
        this.settings.researchLocalDocsEnabled === false
          ? new DisabledProvider("local-docs")
          : new LocalDocsProvider({ projectRoot: this.projectRoot, timeoutMs: fetchTimeoutMs, maxResults }),
      ],
      ["llm-synthesis", new LLMSynthesisProvider({ projectRoot: this.projectRoot })],
    ]);

    log.log("providers refreshed", { available: this.getAvailableProviders(), backend });
  }

  private resolveSearchBackend(): WebSearchBackend {
    const explicit = this.settings.researchWebSearchProvider;
    if (explicit && explicit !== "none") return explicit;

    if (this.settings.researchSearxngUrl) return "searxng";
    if (this.settings.researchTavilyApiKey) return "tavily";
    if (this.settings.researchBraveApiKey) return "brave";
    if (this.settings.researchGoogleSearchApiKey && this.settings.researchGoogleSearchCx) return "google";
    return "none";
  }
}

class DisabledProvider implements ResearchProvider {
  readonly type: string;

  constructor(type: string) {
    this.type = type;
  }

  isConfigured(): boolean {
    return false;
  }

  async search(): Promise<[]> {
    return [];
  }

  async fetchContent(): Promise<{ content: string; metadata: Record<string, unknown> }> {
    return { content: "", metadata: {} };
  }
}
