import type { ResearchProviderConfig, ResearchSource } from "@fusion/core";
import type { ResearchProvider } from "../research-step-runner.js";
import { createLogger } from "../../logger.js";
import { fetchWebContent, WebFetchError } from "../../util/web-fetch.js";
import { ResearchProviderError, type ResearchFetchResult } from "../types.js";

const log = createLogger("research:page-fetch");
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = "FusionResearchBot/1.0";
export const MAX_CONTENT_CHARS = 500 * 1024;

export interface PageFetchProviderOptions {
  timeoutMs?: number;
  userAgent?: string;
}

export class PageFetchProvider implements ResearchProvider {
  readonly type = "page-fetch";

  constructor(private readonly options: PageFetchProviderOptions = {}) {}

  isConfigured(): boolean {
    return true;
  }

  async search(_query: string, _config: ResearchProviderConfig = {}, _signal?: AbortSignal): Promise<ResearchSource[]> {
    return [];
  }

  async fetchContent(url: string, config: ResearchProviderConfig = {}, signal?: AbortSignal): Promise<ResearchFetchResult> {
    const timeoutMs = Number(config.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const result = await fetchWebContent(url, {
        timeoutMs,
        maxBytes: MAX_CONTENT_CHARS,
        userAgent: (config.metadata?.userAgent as string) ?? this.options.userAgent ?? DEFAULT_USER_AGENT,
        signal,
      });

      const metadata: Record<string, unknown> = {
        url,
        contentType: result.contentType,
        contentLength: result.bytesRead,
        title: result.title,
        description: result.description,
      };

      return {
        content: result.content,
        metadata,
        mimeType: result.mimeType,
      };
    } catch (error) {
      if (error instanceof ResearchProviderError) throw error;
      if (error instanceof WebFetchError) {
        throw mapWebFetchError(error);
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ResearchProviderError({ providerType: "page-fetch", code: "abort", message: "Fetch aborted", cause: error });
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ResearchProviderError({ providerType: "page-fetch", code: "timeout", message: error.message, retryable: true, cause: error });
      }
      log.warn("page fetch failed", { error });
      throw new ResearchProviderError({
        providerType: "page-fetch",
        code: "network-error",
        message: error instanceof Error ? error.message : "fetch failed",
        retryable: true,
        cause: error,
      });
    }
  }
}

function mapWebFetchError(error: WebFetchError): ResearchProviderError {
  switch (error.code) {
    case "timeout":
      return new ResearchProviderError({ providerType: "page-fetch", code: "timeout", message: error.message, retryable: true, cause: error });
    case "unsupported-mime":
      return new ResearchProviderError({ providerType: "page-fetch", code: "provider-unavailable", message: error.message, cause: error });
    case "http-error": {
      const isServerError = /status\s+5\d\d/.test(error.message);
      return new ResearchProviderError({
        providerType: "page-fetch",
        code: isServerError ? "provider-unavailable" : "network-error",
        message: error.message,
        retryable: isServerError,
        cause: error,
      });
    }
    case "network-error":
      if (error.cause instanceof DOMException && error.cause.name === "AbortError") {
        return new ResearchProviderError({ providerType: "page-fetch", code: "abort", message: "Fetch aborted", cause: error.cause });
      }
      return new ResearchProviderError({ providerType: "page-fetch", code: "network-error", message: error.message, retryable: true, cause: error });
    case "blocked-host":
    case "blocked-scheme":
    case "invalid-url":
    case "too-large":
      return new ResearchProviderError({ providerType: "page-fetch", code: "network-error", message: error.message, cause: error });
    default:
      return new ResearchProviderError({ providerType: "page-fetch", code: "network-error", message: error.message, retryable: true, cause: error });
  }
}
