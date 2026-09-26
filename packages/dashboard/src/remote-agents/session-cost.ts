import { pricingAsOf, type ExternalSessionView, type ModelPricingOverrides } from "@fusion/core";
import { priceUsage } from "./pricing.js";
import type { RemoteUsage } from "./types.js";

/*
FNXC:RemoteAgents 2026-09-23-21:32:
Session cost is shown in two places that must never disagree: a compact badge on every list card, and the
full breakdown in session detail. Both derive from this one summary so a provider mapping or a
complete/partial rule can only be changed in one place.

`estimatedUsd` is a whole-session total and is null unless EVERY reported usage record priced, because a
number that silently omits an unknown model reads as the session's real cost. `partialUsd` carries what did
price, so the operator sees "some of this is unknown" rather than either a wrong total or nothing at all.
*/
export interface SessionCostSummary {
  usage: RemoteUsage[];
  estimatedUsd: number | null;
  partialUsd: number | null;
  usageComplete: boolean;
  /** Reported usage records that carry no applicable rate. Non-zero means estimatedUsd is deliberately null. */
  unpricedRecords: number;
  /** What the figure was computed on, and whether the work predates those rates. */
  basis: PricingBasis;
}

/** Collectors report a runtime name; Fusion's catalog is keyed by provider. Unmapped names stay unpriced. */
export function pricingProviderFor(provider: string): string {
  return provider === "claude" ? "claude_code" : provider === "codex" ? "codex_cli" : provider;
}

export function summarizeSessionCost(session: ExternalSessionView, settings?: PricingSettings): SessionCostSummary {
  const raw = session.observation.usage ?? [];
  const usage = raw
    .map(entry => priceUsage(entry, pricingProviderFor(session.provider), settings?.modelPricingOverrides))
    .filter((entry): entry is RemoteUsage => entry !== null);
  const priced = usage.filter(entry => entry.usd !== null);
  const total = priced.reduce((sum, entry) => sum + entry.usd!, 0);
  // A dropped record (malformed counters) is as disqualifying as an unpriced one: usage.length must equal raw.length.
  const complete = session.observation.usageComplete === true && usage.length > 0 && usage.length === raw.length && priced.length === usage.length;
  return {
    usage,
    estimatedUsd: complete ? total : null,
    partialUsd: priced.length ? total : null,
    usageComplete: session.observation.usageComplete === true,
    unpricedRecords: raw.length - priced.length,
    basis: pricingBasis(settings, session.observation.observedAt),
  };
}


/*
FNXC:ExternalSessionRates 2026-09-24-00:04:
Fusion's catalog is a single current baseline with one `pricingAsOf` date; neither it nor the operator
overrides carry per-rate effective dates, so there is NO record of what a model cost in the past. A figure for
an old session is therefore a recalculation at today's rates, not what that work was billed.

Rather than invent a rate history, every cost states the basis it was computed on and whether the work
predates it. `recalculated` is true only when the activity is older than the basis date, which is exactly the
case where presenting the number as "the cost" would be false.
*/
export interface PricingBasis {
  asOf: string;
  source: string;
  recalculated: boolean;
  /** True when the rates were recorded at ingest, so this is the cost at the rates that actually applied. */
  recorded: boolean;
}

export interface PricingSettings {
  modelPricingFetchedAt?: string | null;
  modelPricingSource?: string | null;
  modelPricingOverrides?: ModelPricingOverrides;
}

export function pricingBasis(settings: PricingSettings | undefined, activityAt?: string | null): PricingBasis {
  const asOf = settings?.modelPricingFetchedAt || pricingAsOf;
  const source = settings?.modelPricingSource || "Fusion model pricing";
  const activity = activityAt === undefined || activityAt === null ? NaN : Date.parse(activityAt);
  const basisAt = Date.parse(asOf);
  // Unknown activity time cannot be proven older, so it is not claimed to be a recalculation.
  const recalculated = Number.isFinite(activity) && Number.isFinite(basisAt) && activity < basisAt;
  return { asOf, source, recalculated, recorded: false };
}


/*
FNXC:ExternalSessionIncrements 2026-09-24-04:51 (operator decision F1 = 3):
A session's cost is the SUM of what each revision added, each priced at the rates recorded with it. That is why
the increments are priced one at a time rather than concatenated: concatenating would price every band at one
basis and reintroduce exactly the mid-session repricing this decision removes.

An increment recorded without rates is unpriced and makes the whole session's total partial rather than
silently smaller. A session with no increments at all is NOT free: it predates 0091, and the caller must fall
back to pricing its cumulative observation instead of reading an empty list as zero.
*/
export interface IncrementCostSummary {
  estimatedUsd: number | null;
  partialUsd: number | null;
  /** Increments that carried no usable rate, so the total is a floor rather than a figure. */
  unpricedIncrements: number;
  pricedIncrements: number;
  /** Distinct rate bases contributing, so a mid-session rate change is visible rather than averaged away. */
  bases: string[];
}

export function summarizeIncrementCost(
  increments: Array<{ usage: unknown[]; pricing: { asOf: string; source: string; rates: ModelPricingOverrides } | null }>,
  provider: string,
  settings?: PricingSettings,
): IncrementCostSummary {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  const bases = new Set<string>();
  for (const increment of increments) {
    if (!Array.isArray(increment.usage) || !increment.usage.length) continue;
    const summary = summarizeTurnCost(
      { usage: increment.usage as never, usageComplete: true, ...(increment.pricing ? { pricing: increment.pricing } : {}) },
      provider, settings);
    const amount = summary.estimatedUsd ?? summary.partialUsd;
    if (amount === null) { unpriced += 1; continue; }
    total += amount;
    priced += 1;
    bases.add(`${summary.basis.asOf}\u0000${summary.basis.source}`);
    if (summary.estimatedUsd === null) unpriced += 1;
  }
  const complete = priced > 0 && unpriced === 0;
  return {
    estimatedUsd: complete ? total : null,
    partialUsd: priced ? total : null,
    unpricedIncrements: unpriced,
    pricedIncrements: priced,
    bases: [...bases].map(key => key.split("\u0000")[0]!),
  };
}

/** The list card needs the totals, not the per-model breakdown; keep the list response small. */
export type SessionCostBadge = Omit<SessionCostSummary, "usage">;

export function sessionCostBadge(session: ExternalSessionView, settings?: PricingSettings): SessionCostBadge {
  const { estimatedUsd, partialUsd, usageComplete, unpricedRecords, basis } = summarizeSessionCost(session, settings);
  return { estimatedUsd, partialUsd, usageComplete, unpricedRecords, basis };
}


/*
FNXC:ExternalSessionDrivers 2026-09-24-01:44:
Why work was expensive, from measured counts and the rates actually applied — never a narrative guess. Each
category charge is the reported token count for that category times the rate used to price it, and the
categories are disjoint by construction in priceUsage (input excludes cached and cache-write; cacheWrite
excludes the one-hour portion), so they sum to the record's own total. A test pins that sum, because a driver
breakdown that does not reconcile with the total is worse than none: it looks like an explanation.

Only priced records contribute. An unpriced record cannot say what drove its cost, so it is counted and
reported as unexplained rather than folded in at zero.
*/
export type CostCategory = "freshInput" | "cachedInput" | "cacheWrite" | "cacheWriteHour" | "output";

export interface CostDrivers {
  /** Priced requests behind this figure: the measured request volume. */
  requests: number;
  /** Requests that could not be priced and therefore explain nothing. */
  unexplained: number;
  charges: Record<CostCategory, number>;
  /** Largest category by charge, or null when nothing priced. */
  dominant: CostCategory | null;
  dominantUsd: number;
  totalUsd: number;
}

const CATEGORY_RATE: Record<CostCategory, { count: keyof RemoteUsage; rate: string }> = {
  freshInput: { count: "input", rate: "inputPer1M" },
  cachedInput: { count: "cached", rate: "cacheReadPer1M" },
  cacheWrite: { count: "cacheWrite", rate: "cacheWritePer1M" },
  cacheWriteHour: { count: "cacheWriteHour", rate: "cacheWriteHourPer1M" },
  output: { count: "output", rate: "outputPer1M" },
};

/**
 * Per-category charges of ONE priced usage record, or null when it is unpriced. The cost popover and
 * `costDrivers` both use this, so the breakdown an operator reads is the same arithmetic that ranks sessions.
 */
export function categoryCharges(record: RemoteUsage): Record<CostCategory, number> | null {
  if (record.usd === null || !record.rates) return null;
  const charges: Record<CostCategory, number> = { freshInput: 0, cachedInput: 0, cacheWrite: 0, cacheWriteHour: 0, output: 0 };
  for (const [category, { count, rate }] of Object.entries(CATEGORY_RATE) as [CostCategory, { count: keyof RemoteUsage; rate: string }][]) {
    const tokens = record[count];
    const perMillion = (record.rates as unknown as Record<string, number | null>)[rate];
    if (typeof tokens === "number" && typeof perMillion === "number") charges[category] += (tokens * perMillion) / 1_000_000;
  }
  return charges;
}

export function costDrivers(usage: RemoteUsage[]): CostDrivers {
  const charges: Record<CostCategory, number> = { freshInput: 0, cachedInput: 0, cacheWrite: 0, cacheWriteHour: 0, output: 0 };
  let requests = 0;
  let unexplained = 0;
  let totalUsd = 0;
  for (const record of usage) {
    const own = categoryCharges(record);
    if (!own) { unexplained += 1; continue; }
    requests += 1;
    totalUsd += record.usd!;
    for (const category of Object.keys(charges) as CostCategory[]) charges[category] += own[category];
  }
  let dominant: CostCategory | null = null;
  let dominantUsd = 0;
  for (const [category, amount] of Object.entries(charges) as [CostCategory, number][]) {
    if (amount > dominantUsd) { dominant = category; dominantUsd = amount; }
  }
  return { requests, unexplained, charges, dominant, dominantUsd, totalUsd };
}

/*
FNXC:ExternalSessionUsage 2026-09-23-23:24: A turn is priced from its OWN measured requests, through the same
priceUsage the session total uses, so a turn and its session can never disagree about a rate. A turn with no
reported usage is unpriced, never apportioned a share of the session: an invented split reads as measurement.
*/
export interface TurnCostSummary {
  estimatedUsd: number | null;
  partialUsd: number | null;
  unpricedRecords: number;
  /** False when the collector could not read a usage record for this turn. */
  usageComplete: boolean;
  /** Null when the provider reported no context size for this turn. */
  contextTokens: number | null;
  contextCapacity: number | null;
  basis: PricingBasis;
  drivers: CostDrivers;
}

interface TurnLike {
  usage?: Array<Record<string, unknown>>;
  usageComplete?: boolean;
  contextTokens?: number | null;
  contextCapacity?: number | null;
  pricing?: { asOf: string; source: string; rates: ModelPricingOverrides };
}

export function summarizeTurnCost(turn: TurnLike, provider: string, settings?: PricingSettings, activityAt?: string | null): TurnCostSummary {
  const raw = turn.usage ?? [];
  /*
  FNXC:ExternalSessionRates 2026-09-24-00:04: When the turn carries rates recorded at ingest, price with THOSE,
  so the figure is the cost at the rates that actually applied rather than a recalculation at today's. Passing
  them as the override map reuses the one pricing seam; nothing else re-implements a rate lookup.
  */
  const recorded = turn.pricing?.rates && Object.keys(turn.pricing.rates).length ? turn.pricing : undefined;
  const allPriced = raw
    .map(entry => priceUsage(entry, pricingProviderFor(provider), recorded ? recorded.rates : settings?.modelPricingOverrides))
    .filter((entry): entry is RemoteUsage => entry !== null);
  const priced = allPriced.filter(entry => entry.usd !== null);
  const total = priced.reduce((sum, entry) => sum + entry.usd!, 0);
  const complete = turn.usageComplete !== false && raw.length > 0 && priced.length === raw.length;
  return {
    estimatedUsd: complete ? total : null,
    partialUsd: priced.length ? total : null,
    unpricedRecords: raw.length - priced.length,
    usageComplete: turn.usageComplete !== false,
    contextTokens: turn.contextTokens ?? null,
    contextCapacity: turn.contextCapacity ?? null,
    basis: recorded
      ? { asOf: recorded.asOf, source: recorded.source, recalculated: false, recorded: true }
      : pricingBasis(settings, activityAt),
    drivers: costDrivers(allPriced),
  };
}
