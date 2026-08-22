import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { CUSTOM_PROVIDER_THINKING_FORMATS, type CustomProvider, type CustomProviderThinkingFormat } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";

/**
 * Sentinel character used to mask API keys for display. A real API key is an
 * ASCII/Latin1 credential and will never contain this character, so its
 * presence in an inbound value reliably indicates the client echoed back a
 * masked (unchanged) key rather than a freshly entered one.
 */
const API_KEY_MASK_CHAR = "•";

/**
 * Masks an API key for safe display, showing only the first 3 and last 4 characters.
 */
function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return API_KEY_MASK_CHAR.repeat(8);
  }
  return key.slice(0, 3) + API_KEY_MASK_CHAR.repeat(5) + key.slice(-4);
}

/**
 * Returns true when a value is a masked API key echoed back from the UI rather
 * than a real credential. Persisting a masked value would corrupt the stored
 * key and break HTTP header encoding (the mask char is not a valid ByteString).
 */
function isMaskedApiKey(value: string): boolean {
  return value.includes(API_KEY_MASK_CHAR);
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
  if (
    value !== "openai-compatible" &&
    value !== "anthropic-compatible" &&
    value !== "google-generative-ai" &&
    value !== "openai-responses"
  ) {
    throw badRequest("apiType must be 'openai-compatible', 'anthropic-compatible', 'google-generative-ai', or 'openai-responses'");
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
 * FNXC:CustomProviderModelWindows 2026-08-19-14:16:
 * RUFU-123: per-model contextWindow/maxTokens arrived on the custom-provider settings
 * shape (CustomProvider.models entries). Request bodies may carry either field per model
 * entry; a value that is not a positive finite number is rejected 400 with the exact
 * field path named, mirroring the registry builder's positive-finite fallback contract
 * (custom-provider-registry.ts) so a corrupted value can never be persisted and later
 * collapse a compaction threshold. Absent keys are omitted entirely — never persisted
 * as explicit undefined.
 *
 * FNXC:CustomProviderThinkingFormat 2026-08-21-05:46:
 * RUFU-143: the same entries may also carry the per-model thinking flags — thinkingFormat
 * (a pi-ai thinkingFormat literal, see assertThinkingFormat) and reasoning (strict boolean).
 * Both are optional and omitted when absent, so default registrations round-trip unchanged.
 */
function assertPositiveFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw badRequest(`${fieldName} must be a positive finite number`);
  }
  return value;
}

/*
FNXC:CustomProviderThinkingFormat 2026-08-21-05:46:
RUFU-143: the dashboard persists the per-model thinking flags verbatim (they are additive to the
RUFU-123 window fields). thinkingFormat must be one of the pi-ai thinkingFormat literals
(CUSTOM_PROVIDER_THINKING_FORMATS, in lockstep with the pinned pi-ai version); reasoning is a
strict boolean (false = opt out of all thinking params). Invalid values are rejected 400 with the
exact field path named so a corrupted flag can never be persisted and later sent to the provider.
*/
function assertThinkingFormat(value: unknown, fieldName: string): CustomProviderThinkingFormat {
  if (typeof value !== "string" || !(CUSTOM_PROVIDER_THINKING_FORMATS as readonly string[]).includes(value)) {
    throw badRequest(`Invalid ${fieldName} "${value}". Allowed: ${CUSTOM_PROVIDER_THINKING_FORMATS.join(", ")}`);
  }
  return value as CustomProviderThinkingFormat;
}

function assertReasoning(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw badRequest(`${fieldName} must be a boolean`);
  }
  return value;
}

/**
 * Validates and normalizes a models array from a request body.
 * Returns undefined if models is omitted, or an array of
 * { id, name, contextWindow?, maxTokens?, thinkingFormat?, reasoning? } objects
 * (window and thinking-flag keys omitted when absent).
 * @throws {ApiError} with status 400 if the structure is invalid.
 */
function validateModels(
  value: unknown,
): Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number; thinkingFormat?: CustomProviderThinkingFormat; reasoning?: boolean }> | undefined {
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
    const model: { id: string; name: string; contextWindow?: number; maxTokens?: number; thinkingFormat?: CustomProviderThinkingFormat; reasoning?: boolean } = {
      id: assertNonEmptyString(row.id, `models[${index}].id`),
      name: assertNonEmptyString(row.name, `models[${index}].name`),
    };
    if (row.contextWindow !== undefined) {
      model.contextWindow = assertPositiveFiniteNumber(row.contextWindow, `models[${index}].contextWindow`);
    }
    if (row.maxTokens !== undefined) {
      model.maxTokens = assertPositiveFiniteNumber(row.maxTokens, `models[${index}].maxTokens`);
    }
    /*
    FNXC:CustomProviderModelWindows 2026-08-20-22:27: RUFU-145 PR #3493 review invariant:
    the output reservation must fit inside the context window. A pair where
    maxTokens >= contextWindow makes the chat-lane compaction hard limit
    (contextWindow - max(16384, maxTokens)) non-positive, so every chat call enters
    compaction or fails before sending. An explicitly registered contradictory pair is
    an operator input error — reject 400 with both field paths named.
    */
    if (
      model.contextWindow !== undefined &&
      model.maxTokens !== undefined &&
      model.maxTokens >= model.contextWindow
    ) {
      throw badRequest(
        `models[${index}].maxTokens (${model.maxTokens}) must be smaller than models[${index}].contextWindow (${model.contextWindow})`,
      );
    }
    if (row.thinkingFormat !== undefined) {
      model.thinkingFormat = assertThinkingFormat(row.thinkingFormat, `models[${index}].thinkingFormat`);
    }
    if (row.reasoning !== undefined) {
      model.reasoning = assertReasoning(row.reasoning, `models[${index}].reasoning`);
    }
    return model;
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
    if (isMaskedApiKey(row.apiKey)) {
      throw badRequest("apiKey appears to be a masked value; enter the real API key");
    }
    if (row.apiKey.trim().length > 0) {
      provider.apiKey = row.apiKey;
    }
  }

  // FNXC:ProviderAuth 2026-07-08-00:00:
  // FN-7689: accept the Anthropic prompt-caching opt-in from the dashboard editor so it survives
  // the round trip to registerCustomProviders/reregisterCustomProviders (custom-provider-registry.ts).
  if (row.anthropicPromptCaching !== undefined) {
    if (typeof row.anthropicPromptCaching !== "boolean") {
      throw badRequest("anthropicPromptCaching must be a boolean");
    }
    provider.anthropicPromptCaching = row.anthropicPromptCaching;
  }

  const models = validateModels(row.models);
  if (models) {
    provider.models = models;
  }

  return provider;
}

export interface ProbeModelResult {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface RefreshCustomProviderModelsResult {
  provider: CustomProvider;
  modelsRefreshed: number;
}

export interface RefreshAllCustomProviderModelsResult {
  refreshed: number;
  failed: number;
  skipped: number;
}

interface CustomProviderSettingsStore {
  getGlobalSettingsStore: () => { getSettings: () => Promise<{ customProviders?: CustomProvider[] }> };
  updateGlobalSettings: (patch: { customProviders: CustomProvider[] }) => Promise<unknown>;
}

const MAX_PROBE_MODELS = 100;

/*
FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
RUFU-138: local backends (Ollama, LM Studio, vLLM) expose per-model context windows in backend-
specific fields of the OpenAI-compatible /v1/models entry, so the server-side probe reads them
body-level instead of forcing operators to type each window into the custom-provider row editor.
The openai-compatible branch resolves contextWindow as the first positive finite number in the
precedence order limit.context (existing OpenRouter shape, behavior unchanged) -> max_model_len
(vLLM --max-model-len) -> max_context_size (LM Studio) -> max_context_length (generic) ->
context_length (generic). Body-level reads are safe on public hosts: they parse the already-fetched
main-probe response and add no outbound calls. vLLM LoRA adapters are listed as separate ids with a
`parent` field pointing at the base model id; an adapter inherits the parent's body-level window
(one level only, non-transitive).
*/
const MAIN_PROBE_TIMEOUT_MS = 10_000;

/*
FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
RUFU-138: trusted local-backend enrichment budget. The Ollama tags / LM Studio native passes are
single bounded local round-trips (5s each); the per-model Ollama /api/show fallback is capped at
25 parallel 5s calls, so even a 100-model install adds at most one 5s batch to the trusted
refresh path. Enrichment is reachable only via the trusted refresh path (allowPrivateAddress +
literal local hostname) and only when at least one model still lacks a window after body-level
extraction and LoRA inheritance — a fully windowed list costs exactly one fetch (the main probe).
*/
const ENRICH_TIMEOUT_MS = 5_000;
const MAX_OLLAMA_SHOW_PROBES = 25;

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
 * RUFU-138: shared bounded fetch for the main probe and the trusted local-backend enrichment
 * phases. Each call gets its own AbortController so a stalled enrichment round-trip can never
 * hold the main-probe budget, and the timer is always cleared. The controller's signal supersedes
 * any caller-provided signal (callers never pass one).
 */
async function probeFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
 * RUFU-138: vLLM lists LoRA adapters as separate ids carrying a `parent` field that points at the
 * base model's id, so an adapter inherits the parent's body-level window and a --max-model-len
 * server reports one window for the whole family. Inheritance is exactly one level: the parent's
 * own inherited window is never propagated, so an adapter-of-an-adapter chain stays undefined
 * rather than silently borrowing a grandparent's value.
 */
function applyLoraWindowInheritance(rawEntries: Record<string, unknown>[], results: ProbeModelResult[]): ProbeModelResult[] {
  const bodyWindowById = new Map<string, number | undefined>();
  for (const result of results) {
    bodyWindowById.set(result.id, result.contextWindow);
  }
  return results.map((result, index) => {
    if (result.contextWindow !== undefined) {
      return result;
    }
    const raw = rawEntries[index];
    const parent = raw?.parent;
    if (!raw || typeof parent !== "string") {
      return result;
    }
    const parentWindow = bodyWindowById.get(parent);
    return typeof parentWindow === "number" ? { ...result, contextWindow: parentWindow } : result;
  });
}

/**
 * FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
 * RUFU-138: literal-only local hostname gate for the trusted-refresh enrichment phase.
 * Intentionally conservative: a hostname that merely *resolves* to a private IP does not
 * qualify — the existing SSRF block owns DNS-based checks, and enrichment must not run on
 * public or corporate DNS names. Mirrors the SSRF block's literal ranges (loopback,
 * 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fe80::/10) plus
 * .local/.internal mDNS-style names; 169.254.0.0/16 cloud-metadata literals are deliberately
 * absent from the allowlist.
 */
function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]" ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  if (net.isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    return false;
  }
  if (net.isIP(h) === 6) {
    // fc00::/7 — Unique Local Addresses (hex prefixes fc/fd)
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
    // fe80::/10 — link-local addresses
    return h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb");
  }
  return false;
}

/**
 * FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
 * RUFU-138: best-effort same-origin native-API enrichment of per-model context windows for local
 * backends (Ollama, LM Studio) whose OpenAI-compatible /v1/models listing is not a reliable
 * window source. Contract: mutates contextWindow only where it is currently undefined; never
 * touches maxTokens (deriving maxTokens from a window field would silently disable the engine
 * chat-context guard's pre-overflow compaction reservation); never overwrites a body-level or
 * LoRA-inherited window; never throws or fails the probe — non-2xx, abort/timeout, network
 * error, json() rejection, or an unexpected shape skips that phase silently (at most one
 * console.debug line per skipped phase, never per model); and derives every URL exclusively
 * from the already-SSRF-validated baseUrl origin — never from response content (no
 * response-driven request targeting).
 *
 * Phase order: (1) Ollama GET /api/tags — detection plus the tags' details.context_length map;
 * (2) only when Ollama was detected, per-model POST /api/show (capped at
 * MAX_OLLAMA_SHOW_PROBES ids) reading the first positive-finite *.context_length key of
 * model_info (JSON key iteration order); (3) only when Ollama was NOT detected, LM Studio
 * GET /api/v1/models (key -> max_context_length, falling back to
 * loaded_instances[0].config.context_length; OpenAI-compat ids may carry a @variant suffix the
 * native key omits, so match on exact key or startsWith(key + "@")), so a backend that exposes
 * both native APIs is only ever probed as Ollama.
 */
async function enrichOpenAiCompatibleWindows(
  base: URL,
  models: ProbeModelResult[],
  opts: { headers: Record<string, string> },
): Promise<void> {
  if (!models.some((m) => m.contextWindow === undefined)) {
    return;
  }
  const origin = base.origin;
  const headers = opts.headers;

  // --- Phase 1: Ollama native GET /api/tags — single bounded local round-trip ---
  const ollamaWindowsById = new Map<string, number>();
  let ollamaDetected = false;
  try {
    const tagsResponse = await probeFetch(new URL("/api/tags", origin).toString(), { headers }, ENRICH_TIMEOUT_MS);
    if (tagsResponse.ok) {
      const tagsData: unknown = await tagsResponse.json();
      const entries = tagsData && typeof tagsData === "object" ? (tagsData as Record<string, unknown>).models : undefined;
      if (Array.isArray(entries)) {
        ollamaDetected = true;
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const row = entry as Record<string, unknown>;
          const key = row.name ?? row.model;
          const win = (row.details as Record<string, unknown> | undefined)?.context_length;
          if (typeof key === "string" && key.length > 0 && isPositiveFiniteNumber(win)) {
            ollamaWindowsById.set(key, win);
          }
        }
      }
    }
  } catch {
    console.debug("RUFU-138: Ollama /api/tags enrichment skipped (non-2xx, timeout, or unexpected shape)");
  }

  if (ollamaDetected) {
    // Apply the tags map (exact id match); tags-provided windows are authoritative for that model.
    for (const model of models) {
      if (model.contextWindow === undefined) {
        const win = ollamaWindowsById.get(model.id);
        if (win !== undefined) model.contextWindow = win;
      }
    }
    // --- Phase 2: Ollama native POST /api/show — capped parallel batch (25 ids, 5s each) ---
    const pending = models.filter((m) => m.contextWindow === undefined).slice(0, MAX_OLLAMA_SHOW_PROBES);
    if (pending.length > 0) {
      try {
        const settled = await Promise.allSettled(
          pending.map((m) =>
            probeFetch(
              new URL("/api/show", origin).toString(),
              { method: "POST", headers, body: JSON.stringify({ name: m.id }) },
              ENRICH_TIMEOUT_MS,
            ),
          ),
        );
        await Promise.all(
          settled.map(async (outcome, index) => {
            if (outcome.status !== "fulfilled") return; // per-model transport failure — silent by design
            try {
              const response = outcome.value;
              if (!response.ok) return;
              const data: unknown = await response.json();
              const modelInfo = data && typeof data === "object" ? (data as Record<string, unknown>).model_info : undefined;
              if (!modelInfo || typeof modelInfo !== "object") return;
              // model_info is Ollama's merged params.json: the context key carries the model
              // architecture prefix (e.g. llama.context_length, qwen3.context_length), so take
              // the first key (JSON key iteration order) ending in ".context_length" whose
              // value is positive and finite.
              for (const [key, value] of Object.entries(modelInfo)) {
                if (key.endsWith(".context_length") && isPositiveFiniteNumber(value)) {
                  pending[index].contextWindow = value;
                  break;
                }
              }
            } catch {
              // Per-model json() rejection — leave that model windowless (silent by design).
            }
          }),
        );
      } catch {
        console.debug("RUFU-138: Ollama /api/show enrichment skipped (timeout or unexpected shape)");
      }
    }
    return; // Ollama detected — skip the LM Studio pass entirely.
  }

  // --- Phase 3: LM Studio native GET /api/v1/models (only when Ollama was NOT detected) ---
  try {
    const nativeResponse = await probeFetch(new URL("/api/v1/models", origin).toString(), { headers }, ENRICH_TIMEOUT_MS);
    if (!nativeResponse.ok) return;
    const nativeData: unknown = await nativeResponse.json();
    const nativeEntries = nativeData && typeof nativeData === "object" ? (nativeData as Record<string, unknown>).models : undefined;
    if (!Array.isArray(nativeEntries)) return;
    const nativeWindowsByKey = new Map<string, number>();
    for (const entry of nativeEntries) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.key !== "string" || row.key.length === 0) continue;
      const loadedInstances = Array.isArray(row.loaded_instances) ? row.loaded_instances : undefined;
      const firstInstance = loadedInstances?.[0];
      const config = firstInstance && typeof firstInstance === "object" ? (firstInstance as Record<string, unknown>).config : undefined;
      const configWindow = config && typeof config === "object" ? (config as Record<string, unknown>).context_length : undefined;
      const win = isPositiveFiniteNumber(row.max_context_length) ? row.max_context_length : configWindow;
      if (isPositiveFiniteNumber(win)) {
        nativeWindowsByKey.set(row.key, win);
      }
    }
    for (const model of models) {
      if (model.contextWindow !== undefined) continue;
      const exact = nativeWindowsByKey.get(model.id);
      if (exact !== undefined) {
        model.contextWindow = exact;
        continue;
      }
      // LM Studio OpenAI-compat ids may carry a @variant suffix (e.g. "nomic-embed@q8_0")
      // that the native key omits.
      for (const [key, win] of nativeWindowsByKey) {
        if (model.id.startsWith(key + "@")) {
          model.contextWindow = win;
          break;
        }
      }
    }
  } catch {
    console.debug("RUFU-138: LM Studio /api/v1/models enrichment skipped (non-2xx, timeout, or unexpected shape)");
  }
}

type ProbeApiType = "openai-compatible" | "anthropic-compatible" | "google-generative-ai" | "openai-responses";

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
interface ProbeProviderModelsOptions {
  allowPrivateAddress?: boolean;
}

export async function probeProviderModels(
  baseUrl: string,
  apiKey: string | undefined,
  apiType: ProbeApiType,
  options: ProbeProviderModelsOptions = {},
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
  const hostname = url.hostname.toLowerCase();
  /*
   * FNXC:CustomProviders 2026-06-30-00:00:
   * Detect Models accepts untrusted form input, so it keeps SSRF rejection for loopback, LAN, link-local, .local, and .internal hosts. Startup and Settings Refresh Models operate on an already-saved custom provider baseUrl that the user intentionally configured for generation, so they may probe local tools such as LM Studio, Ollama, vLLM, or internal proxies without exposing raw keys to the browser.
   */
  if (!options.allowPrivateAddress) {
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
  }

  let modelsUrl: string;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Fusion/1.0",
  };

  if (apiType === "openai-compatible" || apiType === "openai-responses") {
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

  // FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
  // RUFU-138: behavior-preserving refactor — the inline AbortController/10s timeout moved into
  // probeFetch so the trusted local-backend enrichment phases share the same bounded-fetch
  // contract; the main probe no longer needs a try/finally timer cleanup.
  const response = await probeFetch(modelsUrl, { method: "GET", headers }, MAIN_PROBE_TIMEOUT_MS);

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

  const mapped = trimmed.map((m: Record<string, unknown>) => {
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
      /*
      FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
      RUFU-138: resolve the body-level context window as the first positive finite number in
      precedence order — limit.context (existing OpenRouter shape, behavior unchanged) ->
      max_model_len (vLLM --max-model-len server value) -> max_context_size (LM Studio
      OpenAI-compatible listing) -> max_context_length (generic) -> context_length (generic).
      maxTokens stays limit.output-only and is NEVER derived from a context-window field: the
      engine chat-context guard reserves max(16384, maxTokens) for the reply, so a maxTokens >=
      contextWindow would silently disable the pre-overflow compaction gate.
      */
      const limit = m.limit as Record<string, unknown> | undefined;
      const windowCandidates: unknown[] = [
        limit?.context,
        m.max_model_len,
        m.max_context_size,
        m.max_context_length,
        m.context_length,
      ];
      contextWindow = windowCandidates.find(isPositiveFiniteNumber);
      maxTokens = typeof limit?.output === "number" && limit.output > 0
        ? limit.output
        : undefined;
    }

    return { id, name, reasoning, contextWindow, maxTokens };
  });

  // FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
  // RUFU-138: one-level vLLM LoRA parent inheritance runs before the trusted local-backend
  // enrichment phase so the enrichment gate sees post-inheritance windows and stays silent when
  // every model has a window (directly or via parent).
  const resolved = applyLoraWindowInheritance(trimmed, mapped);

  // FNXC:LocalProviderWindowDetection 2026-08-22-02:05:
  // RUFU-138: trusted local-backend enrichment gate. The browser-facing probe-models route
  // never passes allowPrivateAddress (loopback/LAN inputs 400 earlier in the SSRF block), and
  // public hosts fail isLocalHostname, so this same-origin native-API pass is reachable only
  // from the startup sweep and the saved-provider Refresh Models action — and only when some
  // model still lacks a window after body-level extraction + LoRA inheritance (a fully
  // windowed list adds zero fetches).
  if (
    (apiType === "openai-compatible" || apiType === "openai-responses") &&
    options.allowPrivateAddress === true &&
    isLocalHostname(url.hostname) &&
    resolved.some((m) => m.contextWindow === undefined)
  ) {
    await enrichOpenAiCompatibleWindows(url, resolved, { headers });
  }

  return resolved.filter((m) => m.id.length > 0);
}

function dedupeProviderModels(models: ProbeModelResult[]): ProbeModelResult[] {
  const seen = new Set<string>();
  const deduped: ProbeModelResult[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push({ ...model, id, name: model.name.trim() || id });
  }
  return deduped;
}

async function discoverUsableProviderModels(provider: Pick<CustomProvider, "baseUrl" | "apiKey" | "apiType">): Promise<ProbeModelResult[]> {
  const models = dedupeProviderModels(
    await probeProviderModels(provider.baseUrl, provider.apiKey, provider.apiType, { allowPrivateAddress: true }),
  );
  if (models.length === 0) {
    throw new ApiError(404, "No chat models found in provider response");
  }
  return models;
}

/**
 * FNXC:CustomProviders 2026-06-29-00:00:
 * Startup and Settings refreshes share this seam so persisted custom-provider model lists can be updated from the stored provider record while the browser only receives sanitized providers. The refresh must reuse probe SSRF checks, use the raw stored API key, and preserve the previous model list when probing fails or yields no chat models.
 */
export async function refreshCustomProviderModels(
  store: CustomProviderSettingsStore,
  providerId: string,
): Promise<RefreshCustomProviderModelsResult> {
  const settings = await store.getGlobalSettingsStore().getSettings();
  const providers = settings.customProviders ?? [];
  const targetIndex = providers.findIndex((provider) => provider.id === providerId);
  if (targetIndex < 0) {
    throw notFound(`custom provider '${providerId}' not found`);
  }

  const targetProvider = providers[targetIndex];
  const models = await discoverUsableProviderModels(targetProvider);

  /*
   * FNXC:CustomProviders 2026-06-30-00:00:
   * Model refresh can be slow because it probes a user-configured endpoint. Re-read settings after discovery and merge only the target provider's models so startup/manual refresh cannot overwrite concurrent provider edits, additions, or deletions made while the probe was in flight.
   *
   * FNXC:CustomProviders 2026-06-30-10:24:
   * The probed connection fields are part of the model-list provenance. If the user edits baseUrl, apiType, or apiKey while a refresh is in flight, abort instead of persisting model IDs discovered from the previous endpoint onto the updated provider.
   */
  const latestSettings = await store.getGlobalSettingsStore().getSettings();
  const latestProviders = latestSettings.customProviders ?? [];
  const latestTargetIndex = latestProviders.findIndex((provider) => provider.id === providerId);
  if (latestTargetIndex < 0) {
    throw notFound(`custom provider '${providerId}' not found`);
  }

  const latestTargetProvider = latestProviders[latestTargetIndex];
  if (
    latestTargetProvider.baseUrl !== targetProvider.baseUrl ||
    latestTargetProvider.apiType !== targetProvider.apiType ||
    latestTargetProvider.apiKey !== targetProvider.apiKey
  ) {
    throw new ApiError(409, "Custom provider connection changed during model refresh; retry refresh to use the latest endpoint");
  }

  /*
   * FNXC:CustomProviderModelWindows 2026-08-19-14:16:
   * RUFU-123: probes do not always report per-model windows (Anthropic-compatible never
   * does; OpenAI-compatible endpoints may omit the limit object), so a naive list
   * replacement would silently drop operator-entered contextWindow/maxTokens. Build a
   * model-id -> persisted-windows map and let the probe value win when present
   * (positive-finite), otherwise keep the prior persisted value for that id. Discovered
   * models that no longer exist are still dropped (list replacement semantics unchanged).
   *
   * FNXC:CustomProviderModelWindows 2026-08-20-22:24: RUFU-145 PR #3493 review: the map is
   * built from the RE-READ provider record (below), not the pre-probe snapshot — a
   * concurrent model-limit edit during the probe window was previously lost, because the
   * probe result merged against the stale pre-probe windows and was written back over the
   * newer edit.
   *
   * FNXC:CustomProviderThinkingFormat 2026-08-21-05:46:
   * RUFU-143: the same map now also carries the per-model thinking flags. The probe never
   * reports them, so a prior thinkingFormat is carried over when set and a prior
   * reasoning opt-out (false) is the only prior reasoning re-emitted (true/absent means the
   * default presumed-thinking-capable behavior and must not be re-emitted as an explicit
   * value).
   */
  const persistedModelFieldsById = new Map<string, { contextWindow?: number; maxTokens?: number; thinkingFormat?: CustomProviderThinkingFormat; reasoning?: boolean }>();
  for (const model of latestTargetProvider.models ?? []) {
    if (model.contextWindow !== undefined || model.maxTokens !== undefined || model.thinkingFormat !== undefined || model.reasoning === false) {
      persistedModelFieldsById.set(model.id, { contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingFormat: model.thinkingFormat, reasoning: model.reasoning });
    }
  }
  const persistedModels = models.map((model) => {
    const prior = persistedModelFieldsById.get(model.id);
    const entry: { id: string; name: string; contextWindow?: number; maxTokens?: number; thinkingFormat?: CustomProviderThinkingFormat; reasoning?: boolean } = {
      id: model.id,
      name: model.name,
    };
    if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
      entry.contextWindow = model.contextWindow;
    } else if (prior?.contextWindow !== undefined) {
      entry.contextWindow = prior.contextWindow;
    }
    if (typeof model.maxTokens === "number" && model.maxTokens > 0) {
      entry.maxTokens = model.maxTokens;
    } else if (prior?.maxTokens !== undefined) {
      entry.maxTokens = prior.maxTokens;
    }
    /*
    FNXC:CustomProviderThinkingFormat 2026-08-21-05:46:
    RUFU-143: probes never report thinkingFormat and never report a *negative* reasoning (the probe
    heuristic only guesses the positive, and the default is already "presumed thinking-capable"), so
    a prior flag is carried over only from the persisted record — never pre-filled from probe
    heuristics, which would silently change the wire behavior of a model that was working. A prior
    reasoning opt-out (false) is the only meaningful explicit value, so it survives re-probing; a
    prior true/absent is not re-emitted.
    */
    if (prior?.thinkingFormat !== undefined) {
      entry.thinkingFormat = prior.thinkingFormat;
    }
    if (prior?.reasoning === false) {
      entry.reasoning = false;
    }
    // FNXC:CustomProviderModelWindows 2026-08-20-22:27: RUFU-145 PR #3493 review
    // invariant (refresh surface): a probe that reports an output limit at/above its
    // own context window is internally inconsistent; persisting it would make the
    // compaction hard limit non-positive. Drop the limit and let the engine default +
    // safe small-window guard threshold apply.
    if (
      typeof entry.contextWindow === "number" &&
      typeof entry.maxTokens === "number" &&
      entry.maxTokens >= entry.contextWindow
    ) {
      delete entry.maxTokens;
    }
    return entry;
  });

  const updatedProvider: CustomProvider = {
    ...latestTargetProvider,
    models: persistedModels,
  };
  const nextProviders = [...latestProviders];
  nextProviders[latestTargetIndex] = updatedProvider;
  await store.updateGlobalSettings({ customProviders: nextProviders });
  invalidateAllGlobalSettingsCaches();

  return { provider: sanitizeProvider(updatedProvider), modelsRefreshed: persistedModels.length };
}

export async function refreshAllCustomProviderModels(
  store: CustomProviderSettingsStore,
  logFn: (message: string) => void,
): Promise<RefreshAllCustomProviderModelsResult> {
  const settings = await store.getGlobalSettingsStore().getSettings();
  const providers = settings.customProviders ?? [];
  if (providers.length === 0) {
    return { refreshed: 0, failed: 0, skipped: 0 };
  }

  let refreshed = 0;
  let failed = 0;
  for (const provider of providers) {
    try {
      const result = await refreshCustomProviderModels(store, provider.id);
      refreshed += 1;
      logFn(`Refreshed ${result.modelsRefreshed} model(s) for custom provider "${provider.name}" (id=${provider.id})`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logFn(`Failed to refresh models for custom provider "${provider.name}" (id=${provider.id}): ${message}`);
    }
  }

  return { refreshed, failed, skipped: 0 };
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
    // The UI loads the existing key masked (e.g. "abc•••••wxyz"). If the user
    // saves without retyping it, that masked value is echoed back — leave the
    // field absent from the update so the stored key is preserved rather than
    // overwritten with the mask.
    if (!isMaskedApiKey(row.apiKey)) {
      updates.apiKey = row.apiKey.trim().length > 0 ? row.apiKey : undefined;
    }
  }
  if (row.anthropicPromptCaching !== undefined) {
    if (typeof row.anthropicPromptCaching !== "boolean") {
      throw badRequest("anthropicPromptCaching must be a boolean");
    }
    updates.anthropicPromptCaching = row.anthropicPromptCaching;
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
      invalidateAllGlobalSettingsCaches();

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
      invalidateAllGlobalSettingsCaches();

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
      invalidateAllGlobalSettingsCaches();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/custom-providers/:id/refresh-models", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }

      const providerId = String(req.params.id ?? "").trim();
      if (!providerId) {
        throw badRequest("id path parameter is required");
      }

      res.json(await refreshCustomProviderModels(store, providerId));
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
      if (typeof body.apiKey === "string" && isMaskedApiKey(body.apiKey)) {
        throw badRequest("apiKey appears to be a masked value; enter the real API key");
      }
      const apiKey =
        typeof body.apiKey === "string" && body.apiKey.trim().length > 0
          ? body.apiKey.trim()
          : undefined;

      const rawApiType = body.apiType as string | undefined;
      if (
        rawApiType !== "openai-compatible" &&
        rawApiType !== "anthropic-compatible" &&
        rawApiType !== "google-generative-ai" &&
        rawApiType !== "openai-responses"
      ) {
        throw badRequest(
          "apiType must be 'openai-compatible', 'anthropic-compatible', 'google-generative-ai', or 'openai-responses'",
        );
      }
      const apiType = rawApiType as ProbeApiType;

      const models = dedupeProviderModels(await probeProviderModels(baseUrl, apiKey, apiType));
      res.json({ models, count: models.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
