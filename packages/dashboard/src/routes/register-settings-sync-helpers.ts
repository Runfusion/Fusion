import { readFile as fsReadFile } from "node:fs/promises";
import type { AuthMaterialSnapshot, NodeConfig, ProviderAuthEntry } from "@fusion/core";
import { ApiError } from "../api-error.js";
import { getAuthFileCandidates, type StoredAuthProvider } from "../auth-paths.js";

export const MISSING_REMOTE_NODE_API_KEY_MESSAGE = "Remote node requires an apiKey for authenticated sync";

// FN-4847: Stable denial-reason enum surfaced by sync-status for actionable remote probe failures.
export const SYNC_STATUS_DENIAL_REASONS = ["missing-remote-api-key", "auth-failed", "unreachable", "unknown"] as const;

// FN-4847: Public contract type for actionable sync-status denial diagnostics.
export type SyncStatusDenialReason = (typeof SYNC_STATUS_DENIAL_REASONS)[number];

// FN-4847: Classify remote probe failures to a non-leaking enum suitable for API responses.
export function classifySyncStatusDenialReason(err: unknown): SyncStatusDenialReason {
  if (err instanceof ApiError && err.message === MISSING_REMOTE_NODE_API_KEY_MESSAGE) {
    return "missing-remote-api-key";
  }

  if (err instanceof ApiError && err.message === "Remote node authentication failed") {
    return "auth-failed";
  }

  if (err instanceof ApiError && err.message === "Remote node unreachable") {
    return "unreachable";
  }

  if (err instanceof Error) {
    const message = err.message ?? "";
    const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
    if (
      err.name === "AbortError"
      || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(message)
      || causeCode === "ECONNREFUSED"
      || causeCode === "ENOTFOUND"
      || causeCode === "ETIMEDOUT"
    ) {
      return "unreachable";
    }
  }

  return "unknown";
}

export async function readStoredAuthProvidersFromDisk(): Promise<Record<string, StoredAuthProvider>> {
  const merged: Record<string, StoredAuthProvider> = {};
  for (const authJsonPath of getAuthFileCandidates()) {
    try {
      const authContent = await fsReadFile(authJsonPath, "utf-8");
      const parsed = JSON.parse(authContent) as Record<string, StoredAuthProvider>;
      for (const [provider, credential] of Object.entries(parsed)) {
        merged[provider] ??= credential;
      }
    } catch {
      // Try next candidate.
    }
  }
  return merged;
}

export function toProviderAuthEntries(
  providers: Record<string, StoredAuthProvider>,
): Record<string, ProviderAuthEntry> {
  const providerAuth: Record<string, ProviderAuthEntry> = {};
  for (const [providerId, credential] of Object.entries(providers)) {
    if (credential?.type === "api_key" && credential.key) {
      providerAuth[providerId] = { type: "api_key", key: credential.key };
      continue;
    }
    if (
      credential?.type === "oauth"
      && typeof credential.access === "string"
      && typeof credential.refresh === "string"
      && typeof credential.expires === "number"
    ) {
      providerAuth[providerId] = {
        type: "oauth",
        accessToken: credential.access,
        refreshToken: credential.refresh,
        expires: credential.expires,
        accountId: credential.accountId,
      };
    }
  }
  return providerAuth;
}

export function getProviderNamesFromAuthSnapshot(snapshot: AuthMaterialSnapshot): string[] {
  return Object.keys(snapshot.payload.providerAuth ?? {});
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
    throw new ApiError(400, MISSING_REMOTE_NODE_API_KEY_MESSAGE);
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
