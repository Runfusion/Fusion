import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import type { CustomProvider } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

/**
 * Masks an API key for safe display, showing only the first 3 and last 4 characters.
 */
function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return "••••••••";
  }
  return key.slice(0, 3) + "•••••" + key.slice(-4);
}

/**
 * Removes the raw API key from a provider object, replacing it with a masked version.
 */
function sanitizeProvider(provider: CustomProvider): CustomProvider {
  if (!provider.apiKey) {
    return provider;
  }

  return {
    ...provider,
    apiKey: maskApiKey(provider.apiKey),
  };
}

/**
 * Asserts that a value is a non-empty string and returns the trimmed value.
 * @throws {ApiError} with status 400 if the value is not a non-empty string.
 */
function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${fieldName} is required and must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Asserts that a value is a valid custom provider API type.
 * @throws {ApiError} with status 400 if the type is not recognized.
 */
function assertApiType(value: unknown): CustomProvider["apiType"] {
  if (value !== "openai-compatible" && value !== "anthropic-compatible" && value !== "google-generative-ai") {
    throw badRequest("apiType must be 'openai-compatible', 'anthropic-compatible', or 'google-generative-ai'");
  }
  return value;
}

/**
 * Asserts that a value is a valid HTTP/HTTPS URL suitable for use as a base URL.
 * @throws {ApiError} with status 400 if the URL is invalid or uses an unsupported protocol.
 */
function assertBaseUrl(value: unknown): string {
  const baseUrl = assertNonEmptyString(value, "baseUrl");

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw badRequest("baseUrl must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("baseUrl must use http or https");
  }

  return baseUrl;
}

/**
 * Validates and normalizes a models array from a request body.
 * Returns undefined if models is omitted, or an array of { id, name } objects.
 * @throws {ApiError} with status 400 if the structure is invalid.
 */
function validateModels(value: unknown): Array<{ id: string; name: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw badRequest("models must be an array");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw badRequest(`models[${index}] must be an object`);
    }

    const row = entry as Record<string, unknown>;
    return {
      id: assertNonEmptyString(row.id, `models[${index}].id`),
      name: assertNonEmptyString(row.name, `models[${index}].name`),
    };
  });
}

/**
 * Parses and validates the body of a create-custom-provider request.
 * Returns all required and optional fields except the auto-generated id.
 * @throws {ApiError} with status 400 if required fields are missing or invalid.
 */
function parseCreateBody(body: unknown): Omit<CustomProvider, "id"> {
  if (!body || typeof body !== "object") {
    throw badRequest("request body must be an object");
  }

  const row = body as Record<string, unknown>;
  const provider: Omit<CustomProvider, "id"> = {
    name: assertNonEmptyString(row.name, "name"),
    apiType: assertApiType(row.apiType),
    baseUrl: assertBaseUrl(row.baseUrl),
  };

  if (row.apiKey !== undefined) {
    if (typeof row.apiKey !== "string") {
      throw badRequest("apiKey must be a string");
    }
    if (row.apiKey.trim().length > 0) {
      provider.apiKey = row.apiKey;
    }
  }

  const models = validateModels(row.models);
  if (models) {
    provider.models = models;
  }

  return provider;
}

interface ProbeModelResult {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

const MAX_PROBE_MODELS = 100;

type ProbeApiType = "openai-compatible" | "anthropic-compatible" | "google-generative-ai";

/**
 * Check if a model should be excluded (embedding / reranking / audio-only / no-text-input models).
 */
function isNonChatModel(m: Record<string, unknown>): boolean {
  // OpenAI-compatible modalities: { input: ["text"], output: ["embedding"] }
  const modalities = m.modalities as Record<string, unknown> | undefined;
  if (modalities) {
    // Exclude models that don't accept text input (e.g. audio-only, image-only)
    if (Array.isArray(modalities.input)) {
      const inputs = modalities.input.map((i: unknown) => String(i).toLowerCase());
      if (!inputs.includes("text")) {
        return true;
      }
    }

    if (Array.isArray(modalities.output)) {
      const outputs = modalities.output.map((o: unknown) => String(o).toLowerCase());
      if (outputs.includes("embedding") || outputs.includes("scores")) {
        return true;
      }
      // Exclude models that don't produce text output (e.g. audio-only)
      if (!outputs.includes("text")) {
        return true;
      }
    }
  }

  // Google supportedGenerationMethods: no generateContent = not a chat model
  const methods = m.supportedGenerationMethods as unknown[] | undefined;
  if (Array.isArray(methods) && methods.length > 0 && !methods.includes("generateContent")) {
    return true;
  }

  // Heuristic: model ID contains embedding / rerank
  const id = String(m.id ?? m.name ?? "").toLowerCase();
  if (id.includes("embedding") || id.includes("embed-") || id.includes("-embed-") || id.includes("rerank")) {
    return true;
  }

  return false;
}

/**
 * Probe a custom provider's /models endpoint to discover available models.
 * Supports OpenAI-compatible, Anthropic-compatible, and Google Generative AI providers.
 */
async function probeProviderModels(
  baseUrl: string,
  apiKey: string | undefined,
  apiType: ProbeApiType,
): Promise<ProbeModelResult[]> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw badRequest("baseUrl must be a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("baseUrl must use http or https");
  }
  // SSRF protection: reject private/loopback/link-local hosts
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw badRequest("baseUrl must not be a loopback or private address");
  }
  // Resolve hostname to IP and check against private ranges.
  // If resolution fails, let the fetch attempt proceed naturally.
  try {
    const resolved = await dns.lookup(hostname, { all: true });
    const addresses = resolved.map((a) => a.address);
    for (const addr of addresses) {
      if (net.isIP(addr) === 0) continue;
      const parts = addr.split(".").map(Number);
      if (parts.length === 4 && !Number.isNaN(parts[0])) {
        // 127.0.0.0/8
        if (parts[0] === 127) throw badRequest("baseUrl must not be a loopback or private address");
        // 10.0.0.0/8
        if (parts[0] === 10) throw badRequest("baseUrl must not be a loopback or private address");
        // 172.16.0.0/12
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) throw badRequest("baseUrl must not be a loopback or private address");
        // 192.168.0.0/16
        if (parts[0] === 192 && parts[1] === 168) throw badRequest("baseUrl must not be a loopback or private address");
        // 169.254.0.0/16 (link-local, includes cloud metadata)
        if (parts[0] === 169 && parts[1] === 254) throw badRequest("baseUrl must not be a loopback or private address");
      } else if (net.isIPv6(addr)) {
        const lower = addr.toLowerCase();
        // ::1 — IPv6 loopback
        if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") throw badRequest("baseUrl must not be a loopback or private address");
        // fc00::/7 — Unique Local Addresses (private, RFC 4193)
        if (lower.startsWith("fc") || lower.startsWith("fd")) throw badRequest("baseUrl must not be a loopback or private address");
        // fe80::/10 — link-local addresses
        if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) throw badRequest("baseUrl must not be a loopback or private address");
        // ::ffff:0:0/96 — IPv4-mapped IPv6 — extract embedded IPv4 and re-check
        const ipv4Mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
        if (ipv4Mapped) {
          const v4Parts = ipv4Mapped[1].split(".").map(Number);
          if (v4Parts.length === 4) {
            if (v4Parts[0] === 127 || v4Parts[0] === 10 ||
                (v4Parts[0] === 172 && v4Parts[1] >= 16 && v4Parts[1] <= 31) ||
                (v4Parts[0] === 192 && v4Parts[1] === 168) ||
                (v4Parts[0] === 169 && v4Parts[1] === 254)) {
              throw badRequest("baseUrl must not be a loopback or private address");
            }
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // DNS resolution failed — proceed without SSRF check; the fetch will fail naturally
  }

  let modelsUrl: string;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Fusion/1.0",
  };

  if (apiType === "openai-compatible") {
    // OpenAI-compatible: /v1/models relative to baseUrl
    const pathname = url.pathname.replace(/\/+$/, "");
    const modelsPath = pathname ? pathname + "/models" : "/models";
    modelsUrl = new URL(modelsPath, url.origin).toString();
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (apiType === "anthropic-compatible") {
    // Anthropic: GET /v1/models with x-api-key header
    const pathname = url.pathname.replace(/\/+$/, "");
    const modelsPath = pathname ? pathname + "/models" : "/v1/models";
    modelsUrl = new URL(modelsPath, url.origin).toString();
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    // Google Generative AI: GET /v1beta/models?key=API_KEY
    const pathname = url.pathname.replace(/\/+$/, "");
    const modelsPath = pathname ? pathname + "/models" : "/v1beta/models";
    modelsUrl = new URL(modelsPath, url.origin).toString();
    if (apiKey) {
      // Append API key as query parameter (Google convention)
      const separator = modelsUrl.includes("?") ? "&" : "?";
      modelsUrl = `${modelsUrl}${separator}key=${encodeURIComponent(apiKey)}`;
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const message = errorBody.slice(0, 200);
      throw new ApiError(
        response.status,
        `Provider returned ${response.status} ${response.statusText}${message ? `: ${message}` : ""}`,
      );
    }

    const data = await response.json();
    const rawModels = data?.data ?? data?.models ?? [];

    if (!Array.isArray(rawModels) || rawModels.length === 0) {
      throw new ApiError(404, "No models found in provider response");
    }

    // Filter out embedding/reranking/audio-only models and truncate
    const chatModels = rawModels.filter((m: Record<string, unknown>) => !isNonChatModel(m));
    const trimmed = chatModels.length > MAX_PROBE_MODELS ? chatModels.slice(0, MAX_PROBE_MODELS) : chatModels;

    return trimmed.map((m: Record<string, unknown>) => {
      // Extract ID based on provider format
      let id: string;
      let name: string;
      let contextWindow: number | undefined;
      let maxTokens: number | undefined;
      let reasoning: boolean;

      if (apiType === "google-generative-ai") {
        // Google: name = "models/gemini-2.0-flash", baseModelId = "gemini-2.0-flash"
        id = String(m.baseModelId ?? m.name ?? "");
        // Strip "models/" prefix if present
        if (id.startsWith("models/")) id = id.slice(7);
        name = String(m.displayName ?? id);
        contextWindow = typeof m.inputTokenLimit === "number" && m.inputTokenLimit > 0
          ? m.inputTokenLimit
          : undefined;
        maxTokens = typeof m.outputTokenLimit === "number" && m.outputTokenLimit > 0
          ? m.outputTokenLimit
          : undefined;
        reasoning = Boolean(m.thinking);
      } else if (apiType === "anthropic-compatible") {
        // Anthropic: id = "claude-sonnet-4-20250514", display_name = "Claude Sonnet 4"
        id = String(m.id ?? "");
        name = String(m.display_name ?? id);
        // Anthropic doesn't return context/max_tokens in the models list
        reasoning = Boolean(
          id.toLowerCase().includes("opus") ||
            (id.toLowerCase().includes("sonnet") && id.toLowerCase().includes("think")),
        );
      } else {
        // OpenAI-compatible
        id = String(m.id ?? "");
        name = String(m.name ?? m.display_name ?? id);
        reasoning = Boolean(
          m.reasoning ||
            (Array.isArray(m.capabilities) && m.capabilities.includes("reasoning")) ||
            id.toLowerCase().includes("reason") ||
            id.toLowerCase().includes("o1") ||
            id.toLowerCase().includes("o3"),
        );
        // Extract context window and max tokens from limit object
        const limit = m.limit as Record<string, unknown> | undefined;
        contextWindow = typeof limit?.context === "number" && limit.context > 0
          ? limit.context
          : undefined;
        maxTokens = typeof limit?.output === "number" && limit.output > 0
          ? limit.output
          : undefined;
      }

      return { id, name, reasoning, contextWindow, maxTokens };
    }).filter((m) => m.id.length > 0);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parses and validates the body of an update-custom-provider request.
 * Returns an object with only the fields that were provided for partial updates.
 * @throws {ApiError} with status 400 if provided fields are invalid.
 */
function parseUpdateBody(body: unknown): Partial<Omit<CustomProvider, "id">> {
  if (!body || typeof body !== "object") {
    throw badRequest("request body must be an object");
  }

  const row = body as Record<string, unknown>;
  const updates: Partial<Omit<CustomProvider, "id">> = {};

  if (row.name !== undefined) {
    updates.name = assertNonEmptyString(row.name, "name");
  }
  if (row.apiType !== undefined) {
    updates.apiType = assertApiType(row.apiType);
  }
  if (row.baseUrl !== undefined) {
    updates.baseUrl = assertBaseUrl(row.baseUrl);
  }
  if (row.apiKey !== undefined) {
    if (typeof row.apiKey !== "string") {
      throw badRequest("apiKey must be a string");
    }
    updates.apiKey = row.apiKey.trim().length > 0 ? row.apiKey : undefined;
  }
  if (row.models !== undefined) {
    updates.models = validateModels(row.models);
  }

  return updates;
}

/**
 * Registers custom provider CRUD routes and the probe-models endpoint.
 * Routes are ordered so that static paths (probe-models) are registered after
 * parameterized paths (:id) to avoid Express route conflicts.
 */
export const registerCustomProviderRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, rethrowAsApiError } = ctx;

  router.get("/custom-providers", async (_req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }

      const settings = await store.getGlobalSettingsStore().getSettings();
      const providers = (settings.customProviders ?? []).map(sanitizeProvider);
      res.json(providers);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/custom-providers", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }

      const providerInput = parseCreateBody(req.body);
      const provider: CustomProvider = {
        id: crypto.randomUUID(),
        ...providerInput,
      };

      const settings = await store.getGlobalSettingsStore().getSettings();
      const providers = settings.customProviders ?? [];
      await store.updateGlobalSettings({ customProviders: [...providers, provider] });

      res.status(201).json(sanitizeProvider(provider));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.put("/custom-providers/:id", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }

      const providerId = String(req.params.id ?? "").trim();
      if (!providerId) {
        throw badRequest("id path parameter is required");
      }

      const updates = parseUpdateBody(req.body);
      const settings = await store.getGlobalSettingsStore().getSettings();
      const providers = settings.customProviders ?? [];
      const targetIndex = providers.findIndex((provider) => provider.id === providerId);

      if (targetIndex < 0) {
        throw notFound(`custom provider '${providerId}' not found`);
      }

      const updatedProvider: CustomProvider = {
        ...providers[targetIndex],
        ...updates,
      };

      const nextProviders = [...providers];
      nextProviders[targetIndex] = updatedProvider;
      await store.updateGlobalSettings({ customProviders: nextProviders });

      res.json(sanitizeProvider(updatedProvider));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.delete("/custom-providers/:id", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }

      const providerId = String(req.params.id ?? "").trim();
      if (!providerId) {
        throw badRequest("id path parameter is required");
      }

      const settings = await store.getGlobalSettingsStore().getSettings();
      const providers = settings.customProviders ?? [];
      const exists = providers.some((provider) => provider.id === providerId);

      if (!exists) {
        throw notFound(`custom provider '${providerId}' not found`);
      }

      const nextProviders = providers.filter((provider) => provider.id !== providerId);
      await store.updateGlobalSettings({ customProviders: nextProviders });
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

      // NOTE: probe-models must be registered AFTER the :id param routes
      // so Express does not match "probe-models" as an :id value.
  router.post("/custom-providers/probe-models", async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        throw badRequest("request body must be an object");
      }
      const body = req.body as Record<string, unknown>;

      const baseUrl = assertBaseUrl(body.baseUrl);
      const apiKey =
        typeof body.apiKey === "string" && body.apiKey.trim().length > 0
          ? body.apiKey.trim()
          : undefined;

      const rawApiType = body.apiType as string | undefined;
      if (
        rawApiType !== "openai-compatible" &&
        rawApiType !== "anthropic-compatible" &&
        rawApiType !== "google-generative-ai"
      ) {
        throw badRequest(
          "apiType must be 'openai-compatible', 'anthropic-compatible', or 'google-generative-ai'",
        );
      }
      const apiType = rawApiType as ProbeApiType;

      const models = await probeProviderModels(baseUrl, apiKey, apiType);
      res.json({ models, count: models.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
