import { lookupPricing, pricingAsOf, type ExternalSessionTurnPricing, type ModelPricingOverrides } from "@fusion/core";
import { pricingProviderFor, type PricingSettings } from "./session-cost.js";

/*
FNXC:ExternalSessionRates 2026-09-24-00:04:
Record the rates applicable to a turn at the moment it is ingested. Fusion's catalog is a single current
baseline with no effective dates, so a past rate cannot be reconstructed later: recording at ingest is the
only point at which the true rate is still knowable.

Only rates for models this turn actually used are recorded, so the stamp stays small and says nothing about
models it did not touch. A model with no applicable rate is simply absent — recording a zero would turn
"unpriced" into "free".
*/
export function recordedRatesFor(
  usage: Array<{ model?: unknown }> | undefined,
  provider: string,
  settings?: PricingSettings,
): ExternalSessionTurnPricing | undefined {
  const models = new Set<string>();
  for (const entry of usage ?? []) {
    if (typeof entry?.model === "string" && entry.model) models.add(entry.model);
  }
  if (!models.size) return undefined;
  const pricingProvider = pricingProviderFor(provider);
  const overrides: ModelPricingOverrides | undefined = settings?.modelPricingOverrides;
  const rates: ExternalSessionTurnPricing["rates"] = {};
  for (const model of models) {
    const rate = lookupPricing({ provider: pricingProvider === "claude_code" ? "anthropic" : pricingProvider === "codex_cli" ? "openai-codex" : pricingProvider, model }, overrides);
    if (rate) rates[`${pricingProvider}:${model}`] = { ...rate };
  }
  if (!Object.keys(rates).length) return undefined;
  return { asOf: settings?.modelPricingFetchedAt || pricingAsOf, source: settings?.modelPricingSource || "Fusion model pricing", rates };
}
