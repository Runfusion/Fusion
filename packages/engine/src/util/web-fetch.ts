import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const dnsResolver = {
  lookup,
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 500 * 1024;
const DEFAULT_USER_AGENT = "FusionWebFetch/1.0";

export interface WebFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  allowPrivateHosts?: boolean;
  signal?: AbortSignal;
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  mimeType: string;
  title?: string;
  description?: string;
  content: string;
  truncated: boolean;
  bytesRead: number;
}

export type WebFetchErrorCode =
  | "invalid-url"
  | "blocked-host"
  | "blocked-scheme"
  | "timeout"
  | "too-large"
  | "unsupported-mime"
  | "http-error"
  | "network-error";

export class WebFetchError extends Error {
  readonly code: WebFetchErrorCode;

  constructor(code: WebFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebFetchError";
    this.code = code;
  }
}

export async function assertSafeUrl(url: string, allowPrivateHosts = false): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new WebFetchError("invalid-url", "Invalid URL", { cause: error });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebFetchError("blocked-scheme", `Blocked URL scheme: ${parsed.protocol}`);
  }

  if (allowPrivateHosts) {
    return;
  }

  const host = normalizeHost(parsed.hostname);
  if (isIpBlocked(host)) {
    throw new WebFetchError("blocked-host", `Blocked private host: ${host}`);
  }

  if (isIP(host) === 0) {
    try {
      const resolved = await dnsResolver.lookup(host, { all: true });
      if (resolved.some((entry) => isIpBlocked(entry.address))) {
        throw new WebFetchError("blocked-host", `Blocked private host: ${host}`);
      }
    } catch (error) {
      if (error instanceof WebFetchError) {
        throw error;
      }
      throw new WebFetchError("network-error", `DNS lookup failed for ${host}`, { cause: error });
    }
  }
}

export async function fetchWebContent(url: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(options.maxBytes ?? DEFAULT_MAX_BYTES);

  await assertSafeUrl(url, options.allowPrivateHosts ?? false);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  try {
    if (requestSignal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
      },
      signal: requestSignal,
    });

    if (!response.ok) {
      throw new WebFetchError("http-error", `fetch failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const mimeType = contentType.split(";")[0].trim().toLowerCase();
    const raw = await response.text();

    let title: string | undefined;
    let description: string | undefined;
    let content: string;

    if (mimeType.includes("text/html")) {
      const extracted = extractHtml(raw);
      title = extracted.title;
      description = extracted.description;
      content = extracted.content;
    } else if (mimeType.includes("application/json") || looksLikeJson(raw)) {
      content = JSON.stringify(JSON.parse(raw), null, 2);
    } else if (mimeType.includes("text/") || mimeType.includes("markdown")) {
      content = raw;
    } else {
      throw new WebFetchError("unsupported-mime", `unsupported mime type: ${mimeType}`);
    }

    const bytesRead = content.length;
    if (bytesRead > maxBytes) {
      return {
        url,
        finalUrl: response.url || url,
        status: response.status,
        contentType,
        mimeType,
        title,
        description,
        content: content.slice(0, maxBytes),
        truncated: true,
        bytesRead,
      };
    }

    return {
      url,
      finalUrl: response.url || url,
      status: response.status,
      contentType,
      mimeType,
      title,
      description,
      content,
      truncated: false,
      bytesRead,
    };
  } catch (error) {
    if (error instanceof WebFetchError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      const timedOut = timeoutSignal.aborted && !(options.signal?.aborted ?? false);
      throw new WebFetchError(timedOut ? "timeout" : "network-error", timedOut ? "Fetch timed out" : "Fetch aborted", { cause: error });
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new WebFetchError("timeout", error.message, { cause: error });
    }
    throw new WebFetchError("network-error", error instanceof Error ? error.message : "fetch failed", { cause: error });
  }
}

function normalizeHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function extractHtml(html: string): { title?: string; description?: string; content: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const description = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1]?.trim();
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " ");
  const main = stripped.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? stripped;
  const content = main.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { title, description, content };
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function isIpBlocked(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const normalized = normalizeMappedIpv4(address);
    if (normalized) {
      return isIpv4Blocked(normalized);
    }
    return isIpv4Blocked(address);
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    const mapped = normalizeMappedIpv4(normalized);
    if (mapped) {
      return isIpv4Blocked(mapped);
    }
  }

  return false;
}

function normalizeMappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) {
    return null;
  }
  const candidate = lower.slice(7);
  return isIP(candidate) === 4 ? candidate : null;
}

function isIpv4Blocked(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
