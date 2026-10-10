import type { RankingScan, RankingSessionCandidate, RankingTurnCandidate } from "@fusion/core";
import { summarizeTurnCost, type PricingSettings } from "./session-cost.js";

/*
FNXC:ExternalSessionRankings 2026-09-24-00:04:
"What was expensive" is only honest alongside what could not be priced. A ranking that drops unpriced work
silently answers a different question — the most expensive work we happened to have rates for — so coverage is
returned with every ranking and is not optional for the caller to render.

Ranking reuses summarizeTurnCost, so a row in the ranking and the same row in session detail cannot disagree,
and a turn stamped at ingest ranks on its recorded rates rather than today's.
*/
export interface RankedEntry {
  sessionId: string;
  hostId: string;
  provider: string;
  title: string | null;
  at: string | null;
  usd: number;
  /** Set for turn rankings only. */
  nativeTurnId?: string;
  ordinal?: number;
  /** True when the figure used rates recorded at ingest. */
  recordedRates: boolean;
  /** True when the figure is a recalculation at rates newer than the work. */
  recalculated: boolean;
  /** Measured explanation: largest charge category, its amount, and priced request volume. */
  dominant: string | null;
  dominantUsd: number;
  requests: number;
}

export interface RankingCoverage {
  /** Rows examined within the bound. */
  scanned: number;
  /** Rows that produced a usable amount and are therefore rankable. */
  priced: number;
  /** Rows that reported usage but carried no applicable rate. */
  unpriced: number;
  /** Rows that reported no usage at all. */
  withoutUsage: number;
  /** True when the scan bound was reached, so the ranking covers only part of the range. */
  truncated: boolean;
  /** Total of every priced row in range, not just the ones shown. */
  pricedTotalUsd: number;
}

export interface Ranking {
  entries: RankedEntry[];
  coverage: RankingCoverage;
}

function rank(rows: RankedEntry[], coverage: RankingCoverage, limit: number): Ranking {
  return { entries: rows.sort((a, b) => b.usd - a.usd).slice(0, limit), coverage };
}

export function rankTurns(scan: RankingScan<RankingTurnCandidate>, settings: PricingSettings | undefined, limit = 20): Ranking {
  const entries: RankedEntry[] = [];
  let unpriced = 0;
  let total = 0;
  for (const row of scan.candidates) {
    if (!Array.isArray(row.usage) || !row.usage.length) continue;
    const cost = summarizeTurnCost(
      { usage: row.usage as never, usageComplete: row.usageComplete, pricing: row.pricing as never },
      row.provider, settings, row.at);
    // A partial amount still ranks: it is a floor on what the turn cost, and coverage says it is incomplete.
    const usd = cost.estimatedUsd ?? cost.partialUsd;
    if (usd === null) { unpriced += 1; continue; }
    total += usd;
    entries.push({ sessionId: row.sessionId, hostId: row.hostId, provider: row.provider, title: row.title,
      at: row.at, usd, nativeTurnId: row.nativeTurnId, ordinal: row.ordinal,
      recordedRates: cost.basis.recorded, recalculated: cost.basis.recalculated,
      dominant: cost.drivers.dominant, dominantUsd: cost.drivers.dominantUsd, requests: cost.drivers.requests });
  }
  return rank(entries, { scanned: scan.scanned, priced: entries.length, unpriced,
    withoutUsage: scan.withoutUsage, truncated: scan.truncated, pricedTotalUsd: total }, limit);
}

export function rankSessions(scan: RankingScan<RankingSessionCandidate>, settings: PricingSettings | undefined, limit = 20): Ranking {
  const entries: RankedEntry[] = [];
  let unpriced = 0;
  let total = 0;
  for (const row of scan.candidates) {
    if (!Array.isArray(row.usage) || !row.usage.length) continue;
    // Sessions carry no ingest stamp yet, so they price at the current basis and say so through `recalculated`.
    const cost = summarizeTurnCost({ usage: row.usage as never, usageComplete: row.usageComplete },
      row.provider, settings, row.observedAt);
    const usd = cost.estimatedUsd ?? cost.partialUsd;
    if (usd === null) { unpriced += 1; continue; }
    total += usd;
    entries.push({ sessionId: row.sessionId, hostId: row.hostId, provider: row.provider, title: row.title,
      at: row.observedAt, usd, recordedRates: cost.basis.recorded, recalculated: cost.basis.recalculated,
      dominant: cost.drivers.dominant, dominantUsd: cost.drivers.dominantUsd, requests: cost.drivers.requests });
  }
  return rank(entries, { scanned: scan.scanned, priced: entries.length, unpriced,
    withoutUsage: scan.withoutUsage, truncated: scan.truncated, pricedTotalUsd: total }, limit);
}
