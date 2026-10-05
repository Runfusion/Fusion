import type { RankingScan, RankingSessionCandidate, Attribution } from "@fusion/core";
import { summarizeTurnCost, type PricingSettings } from "./session-cost.js";
import type { RankingCoverage } from "./rankings.js";

/*
FNXC:ExternalSessionOverview 2026-09-24-08:12:
The last measured-as-used AgentPulse surface without a Fusion equivalent: a cost OVERVIEW across a range
(`CostOverview.tsx`/`CostPopover.tsx`, recorded "Partial" in docs/agentpulse-used-feature-inventory.md). Its
three open sub-items — turn costs, effective-dated rates, rankings — have since landed; what remained was the
aggregate itself.

Until now every Fusion cost figure answered "this session" or "these top N". The panel's per-server totals cover
only the sessions currently LOADED and say so, which makes "what did this week cost?" unanswerable without
paging the whole history by hand.

Two rules carry over from rankings and are not optional here:
- the scan is bounded and reports truncation, because an aggregate computed over a silently cut scan states a
  total it did not measure, which is worse than declining to answer;
- unpriced and usage-free rows are counted and reported, never dropped, or the total silently becomes "the cost
  of the work we happened to have rates for".

Pricing goes through summarizeTurnCost, the same seam as cards, detail and rankings, so no two surfaces can
disagree about a rate. Per-model buckets price ONE usage band at a time through that same function rather than
re-implementing a rate lookup.
*/
export interface OverviewBucket {
  key: string;
  usd: number;
  /** Sessions contributing to this bucket; for a model bucket, sessions that used that model. */
  sessions: number;
}

export interface Overview {
  /** Total of every priced session in range. Equal to the sum of `byDay`. */
  totalUsd: number;
  coverage: RankingCoverage;
  /** Calendar days (UTC) in range, oldest first. */
  byDay: OverviewBucket[];
  byModel: OverviewBucket[];
  byHost: OverviewBucket[];
  /*
  FNXC:ExternalSessionAttribution 2026-09-24-08:12 (F4 = 1): the part of the total that is Fusion's OWN task
  runs, which task telemetry already counts. This is a SPLIT of the external total, not a combined figure:
  adding it to task totals is exactly the double count F4 exists to prevent. Zero here means "none proven to be
  Fusion runs", which is not the same as "none overlap" — an unattributed session is unproven, not excluded.
  */
  fusionAttributed: { sessions: number; usd: number; ambiguous: number };
}

function bucket(into: Map<string, OverviewBucket>, key: string, usd: number) {
  const current = into.get(key) ?? { key, usd: 0, sessions: 0 };
  current.usd += usd;
  current.sessions += 1;
  into.set(key, current);
}

const sortByUsd = (a: OverviewBucket, b: OverviewBucket) => b.usd - a.usd;

export function summarizeOverview(
  scan: RankingScan<RankingSessionCandidate>,
  settings: PricingSettings | undefined,
  attributed: Map<string, Attribution> = new Map(),
): Overview {
  const byDay = new Map<string, OverviewBucket>();
  const byModel = new Map<string, OverviewBucket>();
  const byHost = new Map<string, OverviewBucket>();
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  let fusionUsd = 0;
  let fusionSessions = 0;
  let ambiguous = 0;

  for (const row of scan.candidates) {
    if (!Array.isArray(row.usage) || !row.usage.length) continue;
    const cost = summarizeTurnCost({ usage: row.usage as never, usageComplete: row.usageComplete },
      row.provider, settings, row.observedAt);
    // A partial amount still counts: it is a floor on what the session cost, and coverage says it is incomplete.
    const usd = cost.estimatedUsd ?? cost.partialUsd;
    if (usd === null) { unpriced += 1; continue; }
    priced += 1;
    total += usd;

    // A session with no timestamp cannot be placed on a day; it is bucketed explicitly rather than dropped.
    bucket(byDay, row.observedAt ? row.observedAt.slice(0, 10) : "undated", usd);
    bucket(byHost, row.hostId, usd);
    for (const band of row.usage as Array<Record<string, unknown>>) {
      const model = typeof band.model === "string" && band.model ? band.model : "unknown model";
      const bandCost = summarizeTurnCost({ usage: [band], usageComplete: true }, row.provider, settings, row.observedAt);
      const bandUsd = bandCost.estimatedUsd ?? bandCost.partialUsd;
      // A band with no applicable rate contributes nothing rather than a guessed share of the session total.
      if (bandUsd !== null) bucket(byModel, model, bandUsd);
    }

    const fusion = attributed.get(row.sessionId);
    if (!fusion) continue;
    if (fusion.ambiguous) { ambiguous += 1; continue; }
    fusionSessions += 1;
    fusionUsd += usd;
  }

  return {
    totalUsd: total,
    coverage: { scanned: scan.scanned, priced, unpriced, withoutUsage: scan.withoutUsage,
      truncated: scan.truncated, pricedTotalUsd: total },
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byModel: [...byModel.values()].sort(sortByUsd),
    byHost: [...byHost.values()].sort(sortByUsd),
    fusionAttributed: { sessions: fusionSessions, usd: fusionUsd, ambiguous },
  };
}
