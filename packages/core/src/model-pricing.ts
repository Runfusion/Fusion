/**
 * Model pricing → USD cost derivation (KTD6, U3).
 *
 * Cost is **derived at read time** from token counts × a hand-maintained
 * pricing map; it is never persisted (so historical rows stay correct when
 * prices change, and no backfill migration is needed). Unknown models surface
 * tokens with cost marked `unavailable` rather than guessing a price.
 *
 * ⚠️ HAND-MAINTAINED MAP. The `MODEL_PRICING` table below is curated by humans
 * from each provider's public pricing pages — it is NOT fetched at runtime.
 * When you update a rate, bump {@link pricingAsOf} in the same change. The UI
 * surfaces `pricingAsOf` ("prices as of <date>") and marks entries older than
 * {@link PRICING_STALE_AFTER_MS} as low-confidence, so stale-but-present rates
 * (which the unknown-model guard does not catch) are visible rather than
 * silently wrong.
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
export const pricingAsOf = "2026-06-15";

/**
 * Pricing entries older than this (relative to a caller-supplied `now`) are
 * flagged `stale: true`. 180 days ≈ two quarters — long enough that routine
 * price churn doesn't fire constantly, short enough that a long-unmaintained
 * map is surfaced. Compared against {@link pricingAsOf}, not per-entry dates.
 */
export const PRICING_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

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

/**
 * Resolve a pricing entry for a model. Tries `provider:model` first, then the
 * bare `:model` (provider-agnostic) fallback. Returns `undefined` for unknown
 * models — callers must treat that as `unavailable`, never as a guessed price.
 */
export function lookupPricing(ref: ModelRef): ModelPricing | undefined {
  const provider = normalize(ref.provider);
  const model = normalize(ref.model);
  if (!model) return undefined;
  if (provider) {
    const exact = MODEL_PRICING[`${provider}:${model}`];
    if (exact) return exact;
  }
  // Provider-agnostic fallback: scan for any entry whose model id matches.
  for (const [key, entry] of Object.entries(MODEL_PRICING)) {
    if (key.endsWith(`:${model}`)) return entry;
  }
  return undefined;
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
): CostResult {
  const stale = isStale(now);
  const pricing = lookupPricing(model);
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
