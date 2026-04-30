import type { ResearchProviderConfig, ResearchSource } from "@fusion/core";
import type { ResearchProvider } from "../../research-step-runner.js";
import { createLogger } from "../../logger.js";
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
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": (config.metadata?.userAgent as string) ?? this.options.userAgent ?? DEFAULT_USER_AGENT,
        },
        signal: requestSignal,
      });

      if (!response.ok) {
        throw new ResearchProviderError({
          providerType: "page-fetch",
          code: response.status >= 500 ? "provider-unavailable" : "network-error",
          message: `fetch failed with status ${response.status}`,
          retryable: response.status >= 500,
        });
      }

      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const mimeType = contentType.split(";")[0].trim().toLowerCase();
      const raw = await response.text();
      const metadata: Record<string, unknown> = {
        url,
        contentType,
        contentLength: raw.length,
      };

      if (mimeType.includes("text/html")) {
        const extracted = extractHtml(raw);
        metadata.title = extracted.title;
        metadata.description = extracted.description;
        metadata.contentLength = extracted.content.length;
        return { content: truncate(extracted.content), metadata, mimeType };
      }

      if (mimeType.includes("application/json") || looksLikeJson(raw)) {
        const pretty = JSON.stringify(JSON.parse(raw), null, 2);
        return { content: truncate(pretty), metadata, mimeType };
      }

      if (mimeType.includes("text/") || mimeType.includes("markdown")) {
        return { content: truncate(raw), metadata, mimeType };
      }

      throw new ResearchProviderError({
        providerType: "page-fetch",
        code: "provider-unavailable",
        message: `unsupported mime type: ${mimeType}`,
      });
    } catch (error) {
      if (error instanceof ResearchProviderError) throw error;
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

function extractHtml(html: string): { title?: string; description?: string; content: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const description = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1]?.trim();
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " ");
  const main = stripped.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? stripped;
  const text = main.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { title, description, content: text };
}

function truncate(value: string): string {
  return value.length > MAX_CONTENT_CHARS ? value.slice(0, MAX_CONTENT_CHARS) : value;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
