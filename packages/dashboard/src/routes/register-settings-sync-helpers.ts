import { readFile as fsReadFile } from "node:fs/promises";
import type { NodeConfig } from "@fusion/core";
import { ApiError } from "../api-error.js";
import { getAuthFileCandidates, type StoredAuthProvider } from "../auth-paths.js";

export async function readStoredAuthProvidersFromDisk(): Promise<Record<string, StoredAuthProvider>> {
  for (const authJsonPath of getAuthFileCandidates()) {
    try {
      const authContent = await fsReadFile(authJsonPath, "utf-8");
      return JSON.parse(authContent) as Record<string, StoredAuthProvider>;
    } catch {
      // Try next candidate.
    }
  }
  return {};
}

/**
 * Validate node and make an authenticated fetch call to a remote node.
 * Returns parsed JSON on success, throws ApiError on failure.
 */
export async function fetchFromRemoteNode(
  node: NodeConfig,
  path: string,
  options?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<unknown> {
  // Validate node has URL (can't fetch from local node or node without URL)
  if (!node.url) {
    throw new ApiError(400, "Node has no URL configured");
  }

  // Validate node has apiKey (secure sync requires node authentication)
  if (!node.apiKey) {
    throw new ApiError(400, "Remote node requires an apiKey for authenticated sync");
  }

  const method = options?.method ?? "GET";
  const timeoutMs = options?.timeoutMs ?? 15_000;

  // Construct full URL
  const targetUrl = new URL(path, node.url).toString();

  // Build headers with auth
  const headers: Record<string, string> = {
    Authorization: `Bearer ${node.apiKey}`,
    "Content-Type": "application/json",
  };

  // Build fetch options
  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (options?.body !== undefined && method !== "GET") {
    fetchOptions.body = JSON.stringify(options.body);
  }

  // Create AbortController for timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  fetchOptions.signal = controller.signal;

  try {
    const response = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeout);

    // Handle auth failures from remote
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, "Remote node authentication failed");
    }

    // Handle other non-200 responses
    if (!response.ok) {
      throw new ApiError(502, `Remote node returned ${response.status}`);
    }

    // Parse and return JSON
    return await response.json();
  } catch (err: unknown) {
    clearTimeout(timeout);

    if (err instanceof ApiError) {
      throw err;
    }

    if (err instanceof Error) {
      if (err.name === "AbortError") {
        throw new ApiError(504, "Remote node unreachable");
      }
      // Network errors (DNS, connection refused, etc.)
      throw new ApiError(504, "Remote node unreachable");
    }

    throw new ApiError(502, "Remote node request failed");
  }
}
