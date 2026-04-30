import type { ResearchProviderConfig, ResearchSource, WebSearchBackend } from "@fusion/core";
import type { ResearchProvider } from "../../research-step-runner.js";
import { createLogger } from "../../logger.js";
import { ResearchProviderError } from "../types.js";

const log = createLogger("research:web-search");

export interface WebSearchProviderOptions {
  backend?: WebSearchBackend;
  searxngUrl?: string;
  braveApiKey?: string;
  googleApiKey?: string;
  googleCx?: string;
  tavilyApiKey?: string;
  maxResults?: number;
  timeoutMs?: number;
  userAgent?: string;
}

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 10_000;
const RETRY_MAX_ATTEMPTS = 3;

export class WebSearchProvider implements ResearchProvider {
  readonly type = "web-search";

  constructor(private readonly options: WebSearchProviderOptions = {}) {}

  isConfigured(): boolean {
    const backend = this.options.backend ?? "none";
    if (backend === "none") return false;
    if (backend === "searxng") return Boolean(this.options.searxngUrl);
    if (backend === "brave") return Boolean(this.options.braveApiKey);
    if (backend === "google") return Boolean(this.options.googleApiKey && this.options.googleCx);
    if (backend === "tavily") return Boolean(this.options.tavilyApiKey);
    return false;
  }

  async search(query: string, config: ResearchProviderConfig = {}, signal?: AbortSignal): Promise<ResearchSource[]> {
    const backend = this.options.backend ?? "none";
    if (!this.isConfigured()) return [];

    const maxResults = Number(config.maxResults ?? this.options.maxResults ?? DEFAULT_MAX_RESULTS);
    const timeoutMs = Number(config.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const results = await this.withHttpRetry(async () => {
      if (backend === "searxng") return this.searchSearxng(query, maxResults, requestSignal);
      if (backend === "brave") return this.searchBrave(query, maxResults, requestSignal);
      if (backend === "google") return this.searchGoogle(query, maxResults, requestSignal);
      if (backend === "tavily") return this.searchTavily(query, maxResults, requestSignal);
      return [];
    }, requestSignal, backend);

    return results.slice(0, maxResults).map((result, index) => ({
      id: `${backend}-${index}-${result.url}`,
      type: "web",
      reference: result.url,
      title: result.title,
      excerpt: result.snippet,
      status: "completed",
      metadata: {
        backend,
        rank: index + 1,
      },
    }));
  }

  async fetchContent(
    _url: string,
    _options: ResearchProviderConfig = {},
    _signal?: AbortSignal,
  ): Promise<{ content: string; metadata: Record<string, unknown> }> {
    return { content: "", metadata: {} };
  }

  private async searchSearxng(query: string, maxResults: number, signal: AbortSignal) {
    const base = this.options.searxngUrl?.replace(/\/$/, "") ?? "";
    const url = new URL(`${base}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    const response = await this.requestJson<{ results?: Array<{ url: string; title?: string; content?: string }> }>(
      url.toString(),
      {
        method: "GET",
        signal,
      },
      "searxng",
    );

    return (response.results ?? []).slice(0, maxResults).map((item) => ({
      url: item.url,
      title: item.title ?? item.url,
      snippet: item.content ?? "",
    }));
  }

  private async searchBrave(query: string, maxResults: number, signal: AbortSignal) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));

    const response = await this.requestJson<{ web?: { results?: Array<{ url: string; title?: string; description?: string }> } }>(
      url.toString(),
      {
        method: "GET",
        headers: {
          "X-Subscription-Token": this.options.braveApiKey ?? "",
          "User-Agent": this.options.userAgent ?? "FusionResearchBot/1.0",
        },
        signal,
      },
      "brave",
    );

    return (response.web?.results ?? []).slice(0, maxResults).map((item) => ({
      url: item.url,
      title: item.title ?? item.url,
      snippet: item.description ?? "",
    }));
  }

  private async searchGoogle(query: string, maxResults: number, signal: AbortSignal) {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(maxResults));
    url.searchParams.set("key", this.options.googleApiKey ?? "");
    url.searchParams.set("cx", this.options.googleCx ?? "");

    const response = await this.requestJson<{ items?: Array<{ link: string; title?: string; snippet?: string }> }>(
      url.toString(),
      {
        method: "GET",
        signal,
      },
      "google",
    );

    return (response.items ?? []).slice(0, maxResults).map((item) => ({
      url: item.link,
      title: item.title ?? item.link,
      snippet: item.snippet ?? "",
    }));
  }

  private async searchTavily(query: string, maxResults: number, signal: AbortSignal) {
    const response = await this.requestJson<{ results?: Array<{ url: string; title?: string; content?: string }> }>(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.options.userAgent ?? "FusionResearchBot/1.0",
        },
        body: JSON.stringify({
          api_key: this.options.tavilyApiKey,
          query,
          max_results: maxResults,
        }),
        signal,
      },
      "tavily",
    );

    return (response.results ?? []).slice(0, maxResults).map((item) => ({
      url: item.url,
      title: item.title ?? item.url,
      snippet: item.content ?? "",
    }));
  }

  private async withHttpRetry<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    backend: WebSearchBackend,
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown;
    while (attempt < RETRY_MAX_ATTEMPTS) {
      if (signal.aborted) {
        throw new ResearchProviderError({ providerType: "web-search", code: "abort", message: "Search aborted" });
      }

      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const isRetryableHttp =
          error instanceof ResearchProviderError &&
          (error.code === "rate-limited" || error.code === "network-error" || error.code === "provider-unavailable") &&
          error.retryable;

        attempt += 1;
        if (!isRetryableHttp || attempt >= RETRY_MAX_ATTEMPTS) {
          break;
        }

        const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
        const jitter = delay * (Math.random() * 0.2 - 0.1);
        const totalDelay = Math.max(0, delay + jitter);
        log.warn(`retrying ${backend} search`, { attempt, totalDelay });
        await sleep(totalDelay, signal);
      }
    }

    throw lastError;
  }

  private async requestJson<T>(url: string, init: RequestInit, backend: WebSearchBackend): Promise<T> {
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        const message = `${backend} request failed with status ${response.status}`;
        if (response.status === 401 || response.status === 403) {
          throw new ResearchProviderError({ providerType: "web-search", code: "auth-failed", message });
        }
        if (response.status === 429) {
          throw new ResearchProviderError({
            providerType: "web-search",
            code: "rate-limited",
            message,
            retryable: true,
          });
        }
        if (response.status >= 500) {
          throw new ResearchProviderError({
            providerType: "web-search",
            code: "provider-unavailable",
            message,
            retryable: true,
          });
        }
        throw new ResearchProviderError({ providerType: "web-search", code: "network-error", message });
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ResearchProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ResearchProviderError({ providerType: "web-search", code: "abort", message: "Search aborted", cause: error });
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ResearchProviderError({ providerType: "web-search", code: "timeout", message: error.message, retryable: true, cause: error });
      }
      throw new ResearchProviderError({
        providerType: "web-search",
        code: "network-error",
        message: error instanceof Error ? error.message : "Unexpected network error",
        retryable: true,
        cause: error,
      });
    }
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ResearchProviderError({ providerType: "web-search", code: "abort", message: "Search aborted" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
