/**
 * Model pricing → USD cost derivation (KTD6, U3).
 *
 * Cost is **derived at read time** from token counts × a hand-maintained
 * pricing map plus optional user-managed overrides; it is never persisted (so
 * historical rows stay correct when prices change, and no backfill migration is
 * needed). Unknown models surface tokens with cost marked `unavailable` rather
 * than guessing a price.
 *
 * ⚠️ HAND-MAINTAINED MAP. The `MODEL_PRICING` table below is curated by humans
 * from each provider's public pricing pages — it is NOT fetched at runtime.
 * Callers may supply persisted overrides, including entries parsed from the
 * canonical LiteLLM dataset, and those overrides take precedence over this
 * baseline. When you update a baseline rate, bump {@link pricingAsOf} in the
 * same change. The UI surfaces `pricingAsOf` ("prices as of <date>") and marks
 * entries older than {@link PRICING_STALE_AFTER_MS} as low-confidence, so
 * stale-but-present rates (which the unknown-model guard does not catch) are
 * visible rather than silently wrong.
 *
 * Rates are USD **per 1,000,000 tokens**.
 *
 * Pure data module: no DB, no I/O, and no `Date.now()` at import time. Callers
 * that care about staleness pass an explicit `now`; otherwise staleness is
 * judged against {@link pricingAsOf} alone (i.e. never stale).
 */

/**
 * The date the rates in {@link MODEL_PRICING} were last verified, ISO-8601.
 * Bump this whenever you edit a rate. Surfaced in the UI as "prices as of".
 */
export const pricingAsOf = "2026-07-09";

/**
 * Pricing entries older than this (relative to a caller-supplied `now`) are
 * flagged `stale: true`. 180 days ≈ two quarters — long enough that routine
 * price churn doesn't fire constantly, short enough that a long-unmaintained
 * map is surfaced. Compared against {@link pricingAsOf}, not per-entry dates.
 */
export const PRICING_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

/*
 * FNXC:CommandCenter 2026-06-22-00:00:
 * Users need one-click pricing refreshes from LiteLLM's continuously updated community dataset while the core module remains pure. Keep the URL as data only; dashboard routes own HTTP, validation errors, and persistence.
 */
export const LITELLM_PRICING_SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const LITELLM_PRICING_SOURCE_LABEL = "litellm/model_prices_and_context_window.json";

/** A single model's per-1M-token rates plus a citation. */
export interface ModelPricing {
  /** USD per 1M uncached input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cache-read (cached) input tokens. */
  cacheReadPer1M: number;
  /** USD per 1M cache-write tokens. */
  cacheWritePer1M: number;
  /** Where the rate came from (provider pricing page / docs). */
  source: string;
}

/** User-managed pricing overrides keyed by lowercased `provider:model`. */
export type ModelPricingOverrides = Record<string, ModelPricing>;

/** Token counts to price. Mirrors {@link TokenTotals} from token-analytics. */
export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  /** Cache-read tokens (priced at the cache-read rate, NOT the input rate). */
  cachedTokens: number;
  /** Cache-write tokens (priced at the cache-write rate). */
  cacheWriteTokens: number;
}

/** Result of {@link costFor}. */
export interface CostResult {
  /** Derived USD cost, or `null` when no price is known for the model. */
  usd: number | null;
  /** True when the model has no pricing entry (cost is a guess-free `null`). */
  unavailable: boolean;
  /** True when the pricing map is older than the staleness threshold. */
  stale: boolean;
}

/**
 * Hand-maintained pricing table, keyed by `provider:model`.
 *
 * Keys are lowercased `${provider}:${model}`. Lookup also falls back to the
 * bare model id (`:model`) so callers that only know the model still resolve.
 * Model ids match the strings Fusion stores in `tasks.modelId` /
 * `tasks.modelProvider` (see `runtime-provider-probes.ts` and grep for
 * `modelId`/`modelProvider`): Anthropic Claude, OpenAI, Google Gemini.
 *
 * Sources (verified 2026-06-15, see `pricingAsOf`):
 *  - Anthropic: platform.claude.com/docs/en/pricing (per-MTok; cache read ≈
 *    0.1× input, 5-min cache write ≈ 1.25× input).
 *  - OpenAI: openai.com/api/pricing (cached input ≈ 0.5×/0.25× input; OpenAI
 *    has no separate cache-write charge, so cacheWrite = input rate).
 *  - Google Gemini: ai.google.dev/gemini-api/docs/pricing (context-cache read
 *    rate; no distinct cache-write token charge, so cacheWrite = input rate).
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // ── Anthropic Claude ────────────────────────────────────────────────
  // input / output / cacheRead(0.1×) / cacheWrite(1.25×, 5-min TTL)
  /*
   * FNXC:ModelCatalog 2026-07-01-22:40:
   * `anthropic:claude-sonnet-5` is advertised again (works on raw API key + Claude CLI; live-verified), so restore its static pricing. Matches the cost in SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.
   */
  "anthropic:claude-sonnet-5": {
    inputPer1M: 2,
    outputPer1M: 10,
    cacheReadPer1M: 0.2,
    cacheWritePer1M: 2.5,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-opus-4-8": {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-opus-4-7": {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-opus-4-6": {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-opus-4-5": {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-opus-4-1": {
    inputPer1M: 15,
    outputPer1M: 75,
    cacheReadPer1M: 1.5,
    cacheWritePer1M: 18.75,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-opus-4-20250514": {
    inputPer1M: 15,
    outputPer1M: 75,
    cacheReadPer1M: 1.5,
    cacheWritePer1M: 18.75,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-sonnet-4-6": {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-sonnet-4-5": {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-sonnet-4-20250514": {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-haiku-4-5": {
    inputPer1M: 1,
    outputPer1M: 5,
    cacheReadPer1M: 0.1,
    cacheWritePer1M: 1.25,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-haiku-4-5-20251001": {
    inputPer1M: 1,
    outputPer1M: 5,
    cacheReadPer1M: 0.1,
    cacheWritePer1M: 1.25,
    source: "platform.claude.com/docs/en/pricing",
  },
  "anthropic:claude-fable-5": {
    inputPer1M: 10,
    outputPer1M: 50,
    cacheReadPer1M: 1,
    cacheWritePer1M: 12.5,
    source: "platform.claude.com/docs/en/pricing",
  },

  // ── OpenAI ──────────────────────────────────────────────────────────
  // OpenAI has no separate cache-write charge → cacheWrite = input rate.
  "openai:gpt-5": {
    inputPer1M: 1.25,
    outputPer1M: 10,
    cacheReadPer1M: 0.125,
    cacheWritePer1M: 1.25,
    source: "openai.com/api/pricing",
  },
  "openai:gpt-5-mini": {
    inputPer1M: 0.25,
    outputPer1M: 2,
    cacheReadPer1M: 0.025,
    cacheWritePer1M: 0.25,
    source: "openai.com/api/pricing",
  },
  "openai:gpt-4o": {
    inputPer1M: 2.5,
    outputPer1M: 10,
    cacheReadPer1M: 1.25,
    cacheWritePer1M: 2.5,
    source: "openai.com/api/pricing",
  },
  "openai:gpt-4o-mini": {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.075,
    cacheWritePer1M: 0.15,
    source: "openai.com/api/pricing",
  },
  "openai:gpt-4.1": {
    inputPer1M: 2,
    outputPer1M: 8,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 2,
    source: "openai.com/api/pricing",
  },
  "openai:gpt-4-turbo": {
    inputPer1M: 10,
    outputPer1M: 30,
    cacheReadPer1M: 10,
    cacheWritePer1M: 10,
    source: "openai.com/api/pricing",
  },
  "openai:o1": {
    inputPer1M: 15,
    outputPer1M: 60,
    cacheReadPer1M: 7.5,
    cacheWritePer1M: 15,
    source: "openai.com/api/pricing",
  },
  "openai:o3-mini": {
    inputPer1M: 1.1,
    outputPer1M: 4.4,
    cacheReadPer1M: 0.55,
    cacheWritePer1M: 1.1,
    source: "openai.com/api/pricing",
  },

  // ── OpenAI Codex ────────────────────────────────────────────────────
  // OpenAI has no separate cache-write charge → cacheWrite = input rate.
  /*
   * FNXC:CommandCenter 2026-06-21-12:14:
   * Codex runs store the `openai-codex` provider, so pricing must be keyed as `openai-codex:<modelId>` instead of relying on the OpenAI provider or bare-model fallback. Keep these entries explicit so Command Center token cost does not show `unavailable`; rates mirror OpenAI GPT-5 Codex pricing, and `pricingAsOf` must be bumped on every rate edit.
   */
  "openai-codex:gpt-5-codex": {
    inputPer1M: 1.25,
    outputPer1M: 10,
    cacheReadPer1M: 0.125,
    cacheWritePer1M: 1.25,
    source: "openai.com/api/pricing",
  },
  "openai-codex:gpt-5.1-codex": {
    inputPer1M: 1.25,
    outputPer1M: 10,
    cacheReadPer1M: 0.125,
    cacheWritePer1M: 1.25,
    source: "openai.com/api/pricing",
  },
  "openai-codex:gpt-5.2-codex": {
    inputPer1M: 1.25,
    outputPer1M: 10,
    cacheReadPer1M: 0.125,
    cacheWritePer1M: 1.25,
    source: "openai.com/api/pricing",
  },
  "openai-codex:gpt-5.3-codex": {
    inputPer1M: 1.25,
    outputPer1M: 10,
    cacheReadPer1M: 0.125,
    cacheWritePer1M: 1.25,
    source: "openai.com/api/pricing",
  },
  /*
   * FNXC:CommandCenter 2026-07-09-21:30:
   * FN-7757 found that pi-ai 0.80.5 now persists OpenAI Codex model ids from the generated `openai-codex.models.js` catalog (`gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, and codenamed GPT-5.6 variants). The old static table covered only earlier `gpt-5.x-codex` ids, so lookupPricing returned unavailable and every dashboard cost surface rendered `—`. Keep this block aligned with the pinned runtime catalog rates while preserving unknown-model `—` semantics.
   */
  "openai-codex:gpt-5.3-codex-spark": {
    inputPer1M: 1.75,
    outputPer1M: 14,
    cacheReadPer1M: 0.175,
    cacheWritePer1M: 0,
    source: "openai.com/api/pricing",
  },
  "openai-codex:gpt-5.4": {
    inputPer1M: 2.5,
    outputPer1M: 15,
    cacheReadPer1M: 0.25,
    cacheWritePer1M: 0,
    source: "openai.com/api/pricing",
  },
  "openai-codex:gpt-5.4-mini": {
    inputPer1M: 0.75,
    outputPer1M: 4.5,
    cacheReadPer1M: 0.075,
    cacheWritePer1M: 0,
    source: "openai.com/api/pricing",
  },
  "openai-codex:gpt-5.5": {
    inputPer1M: 5,
    outputPer1M: 30,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 0,
    source: "openai.com/api/pricing",
  },
  "openai-codex:gpt-5.6-luna": {
    inputPer1M: 1,
    outputPer1M: 6,
    cacheReadPer1M: 0.1,
    cacheWritePer1M: 0,
    source: "openai.com/api/pricing",
  },
  "openai-codex:gpt-5.6-sol": {
    inputPer1M: 5,
    outputPer1M: 30,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 0,
    source: "openai.com/api/pricing",
  },
  "openai-codex:gpt-5.6-terra": {
    inputPer1M: 2.5,
    outputPer1M: 15,
    cacheReadPer1M: 0.25,
    cacheWritePer1M: 0,
    source: "openai.com/api/pricing",
  },
  "openai-codex:codex-mini-latest": {
    inputPer1M: 1.5,
    outputPer1M: 6,
    cacheReadPer1M: 0.375,
    cacheWritePer1M: 1.5,
    source: "openai.com/api/pricing",
  },

  // ── Google Gemini ───────────────────────────────────────────────────
  // No distinct cache-write token charge → cacheWrite = input rate.
  "google:gemini-2.5-pro": {
    inputPer1M: 1.25,
    outputPer1M: 10,
    cacheReadPer1M: 0.31,
    cacheWritePer1M: 1.25,
    source: "ai.google.dev/gemini-api/docs/pricing",
  },
  "google:gemini-2.5-flash": {
    inputPer1M: 0.3,
    outputPer1M: 2.5,
    cacheReadPer1M: 0.075,
    cacheWritePer1M: 0.3,
    source: "ai.google.dev/gemini-api/docs/pricing",
  },
  "google:gemini-2.0-flash": {
    inputPer1M: 0.1,
    outputPer1M: 0.4,
    cacheReadPer1M: 0.025,
    cacheWritePer1M: 0.1,
    source: "ai.google.dev/gemini-api/docs/pricing",
  },
  "google:gemini-2.0-pro": {
    inputPer1M: 1.25,
    outputPer1M: 10,
    cacheReadPer1M: 0.31,
    cacheWritePer1M: 1.25,
    source: "ai.google.dev/gemini-api/docs/pricing",
  },
};

/** Reference to a model, by provider + id (either may be unset). */
export interface ModelRef {
  provider?: string | null;
  model?: string | null;
}

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function findBareModelPricing(
  model: string,
  entries: Record<string, ModelPricing> | Readonly<Record<string, ModelPricing>>,
): ModelPricing | undefined {
  for (const [key, entry] of Object.entries(entries)) {
    if (key.endsWith(`:${model}`)) return entry;
  }
  return undefined;
}

/**
 * Resolve a pricing entry for a model. Tries override `provider:model` first,
 * then override bare-model fallback, then the built-in baseline using the same
 * precedence. Returns `undefined` for unknown models — callers must treat that
 * as `unavailable`, never as a guessed price.
 *
 * FNXC:CommandCenter 2026-06-22-00:00:
 * Editable/fetched model rates must override the hand-maintained baseline without removing the baseline fallback. Keep exact provider:model checks before bare-model scans so provider-specific overrides stay deterministic.
 */
export function lookupPricing(ref: ModelRef, overrides?: ModelPricingOverrides): ModelPricing | undefined {
  const provider = normalize(ref.provider);
  const model = normalize(ref.model);
  if (!model) return undefined;
  if (provider) {
    const exactOverride = overrides?.[`${provider}:${model}`];
    if (exactOverride) return exactOverride;
  }
  const bareOverride = overrides ? findBareModelPricing(model, overrides) : undefined;
  if (bareOverride) return bareOverride;
  if (provider) {
    const exact = MODEL_PRICING[`${provider}:${model}`];
    if (exact) return exact;
  }
  return findBareModelPricing(model, MODEL_PRICING);
}

function litellmProviderToFusionProvider(provider: unknown): string | null {
  if (typeof provider !== "string") return null;
  const normalized = normalize(provider);
  if (normalized === "openai") return "openai";
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "gemini" || normalized.startsWith("gemini")) return "google";
  if (normalized === "vertex_ai" || normalized.startsWith("vertex_ai")) return "google";
  if (normalized === "vertex_ai-language-models") return "google";
  return null;
}

function numericField(entry: Record<string, unknown>, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse LiteLLM's canonical pricing dataset into Fusion pricing overrides.
 * Pure: no HTTP, DB access, or clock reads. Unsupported providers and non-chat
 * rows are skipped so a broad upstream dataset can safely feed Fusion's known
 * model-provider surface.
 */
export function parseLiteLLMPricing(json: unknown): { overrides: ModelPricingOverrides; count: number } {
  const overrides: ModelPricingOverrides = {};
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { overrides, count: 0 };
  }
  for (const [modelId, value] of Object.entries(json as Record<string, unknown>)) {
    if (modelId === "sample_spec") continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.mode !== "chat") continue;
    const provider = litellmProviderToFusionProvider(entry.litellm_provider);
    if (!provider) continue;
    const inputCost = numericField(entry, "input_cost_per_token");
    const outputCost = numericField(entry, "output_cost_per_token");
    if (inputCost === undefined || outputCost === undefined) continue;
    const inputPer1M = inputCost * 1_000_000;
    const outputPer1M = outputCost * 1_000_000;
    const cacheRead = numericField(entry, "cache_read_input_token_cost");
    const cacheWrite = numericField(entry, "cache_creation_input_token_cost");
    overrides[`${provider}:${normalize(modelId)}`] = {
      inputPer1M,
      outputPer1M,
      cacheReadPer1M: cacheRead === undefined ? inputPer1M : cacheRead * 1_000_000,
      cacheWritePer1M: cacheWrite === undefined ? inputPer1M : cacheWrite * 1_000_000,
      source: LITELLM_PRICING_SOURCE_LABEL,
    };
  }
  return { overrides, count: Object.keys(overrides).length };
}

/** True when the pricing map is older than the threshold relative to `now`. */
function isStale(now: number | undefined): boolean {
  if (now === undefined) return false;
  const asOf = Date.parse(pricingAsOf);
  if (Number.isNaN(asOf)) return false;
  return now - asOf > PRICING_STALE_AFTER_MS;
}

/**
 * Derive USD cost for `usage` under `model`'s rates.
 *
 * - Unknown model → `{ usd: null, unavailable: true, stale }` (never guessed).
 * - Cache-read tokens are priced at the cache-read rate, cache-write tokens at
 *   the cache-write rate — NOT the input rate.
 * - `stale` is true when the (caller-supplied) `now` is more than
 *   {@link PRICING_STALE_AFTER_MS} past {@link pricingAsOf}. With no `now`,
 *   `stale` is always false.
 */
export function costFor(
  usage: UsageForCost,
  model: ModelRef,
  now?: number,
  overrides?: ModelPricingOverrides,
): CostResult {
  const stale = isStale(now);
  const pricing = lookupPricing(model, overrides);
  if (!pricing) {
    return { usd: null, unavailable: true, stale };
  }
  const usd =
    (usage.inputTokens * pricing.inputPer1M +
      usage.outputTokens * pricing.outputPer1M +
      usage.cachedTokens * pricing.cacheReadPer1M +
      usage.cacheWriteTokens * pricing.cacheWritePer1M) /
    1_000_000;
  return { usd, unavailable: false, stale };
}
