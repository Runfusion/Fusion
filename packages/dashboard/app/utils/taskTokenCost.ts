import type { TaskDetail, TaskTokenUsagePerModel } from "@fusion/core";
import { costFor, type CostResult, type ModelPricingOverrides } from "../../../core/src/model-pricing";

export interface TokenCostRow {
  key: string;
  label: string;
  modelProvider?: string;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: CostResult;
}

export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "0";
}

export function formatCost(usd: number | null, unavailable: boolean): string {
  if (unavailable || usd === null || !Number.isFinite(usd)) {
    return "—";
  }
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function toTokenBucketKey(bucket: Pick<TaskTokenUsagePerModel, "modelProvider" | "modelId">): string {
  return `${bucket.modelProvider ?? ""}:${bucket.modelId ?? ""}`;
}

export function toTokenCostRow(
  bucket: Pick<TaskTokenUsagePerModel, "modelProvider" | "modelId" | "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens">,
  unknownLabel: string,
  now: number,
  pricingOverrides?: ModelPricingOverrides,
): TokenCostRow {
  const modelId = bucket.modelId?.trim() || undefined;
  const modelProvider = bucket.modelProvider?.trim() || undefined;
  const label = modelId ?? unknownLabel;
  return {
    key: toTokenBucketKey({ modelProvider, modelId }),
    label,
    modelProvider,
    modelId,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cachedTokens: bucket.cachedTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    totalTokens: bucket.totalTokens,
    cost: costFor(
      {
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cachedTokens: bucket.cachedTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
      },
      { provider: modelProvider, model: modelId },
      now,
      pricingOverrides,
    ),
  };
}

/**
 * FNXC:TaskDetailCost 2026-07-11-12:00:
 * Task cost is a read-time derivation shared by the done Summary tab, always-available Cost tab, and optional card badge. Keep the costFor/pricing-overrides path centralized here so unpriced or zero-usage states keep the guess-free “—” sentinel everywhere and derived USD is never persisted.
 *
 * FNXC:TaskDetailSummaryTokenCost 2026-06-27-00:00:
 * FNXC:TaskCost 2026-08-01-10:00: tokenUsage is a full-task additive ledger;
 * triage and graph Plan Review buckets intentionally have no role filter here.
 * Done-task Summary shows durable token usage broken down by model with derived USD cost. Use already-loaded task.tokenUsage.perModel buckets plus costFor and global pricing overrides threaded from TaskDetailModal; do not fetch or persist cost here. Unpriced models render “—” instead of $0 and make the task total unavailable so estimates are never understated.
 */
export function buildTokenCostRows(task: TaskDetail, unknownLabel: string, pricingOverrides?: ModelPricingOverrides): TokenCostRow[] {
  const tokenUsage = task.tokenUsage;
  if (!tokenUsage) return [];

  const buckets = tokenUsage.perModel?.length
    ? tokenUsage.perModel
    : [
        {
          modelProvider: tokenUsage.modelProvider,
          modelId: tokenUsage.modelId,
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          cachedTokens: tokenUsage.cachedTokens,
          cacheWriteTokens: tokenUsage.cacheWriteTokens,
          totalTokens: tokenUsage.totalTokens,
        },
      ];

  const merged = new Map<string, Pick<TaskTokenUsagePerModel, "modelProvider" | "modelId" | "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens">>();
  buckets.forEach((bucket) => {
    const modelProvider = bucket.modelProvider?.trim() || undefined;
    const modelId = bucket.modelId?.trim() || undefined;
    const key = toTokenBucketKey({ modelProvider, modelId });
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...bucket, modelProvider, modelId });
      return;
    }
    current.inputTokens += bucket.inputTokens;
    current.outputTokens += bucket.outputTokens;
    current.cachedTokens += bucket.cachedTokens;
    current.cacheWriteTokens += bucket.cacheWriteTokens;
    current.totalTokens += bucket.totalTokens;
  });

  const now = Date.now();
  return Array.from(merged.values()).map((bucket) => toTokenCostRow(bucket, unknownLabel, now, pricingOverrides));
}

export function totalCostForRows(rows: TokenCostRow[]): { usd: number | null; unavailable: boolean } {
  let usd = 0;
  let unavailable = false;
  let hasPositiveUsage = false;
  rows.forEach((row) => {
    if (row.totalTokens <= 0) return;
    hasPositiveUsage = true;
    if (row.cost.unavailable || row.cost.usd === null || !Number.isFinite(row.cost.usd)) {
      unavailable = true;
      return;
    }
    usd += row.cost.usd;
  });
  return { usd: unavailable || !hasPositiveUsage ? null : usd, unavailable: unavailable || !hasPositiveUsage };
}

export function hasTaskCost(task: TaskDetail): boolean {
  const tokenUsage = task.tokenUsage;
  if (!tokenUsage) return false;
  const totalTokens = tokenUsage.totalTokens
    ?? ((tokenUsage.inputTokens ?? 0) + (tokenUsage.outputTokens ?? 0) + (tokenUsage.cachedTokens ?? 0) + (tokenUsage.cacheWriteTokens ?? 0));
  if (totalTokens > 0) return true;
  return (tokenUsage.perModel ?? []).some((bucket) => bucket.totalTokens > 0);
}

export function taskTotalCost(task: TaskDetail, pricingOverrides?: ModelPricingOverrides): CostResult {
  const total = totalCostForRows(buildTokenCostRows(task, "(unknown)", pricingOverrides));
  return { usd: total.usd, unavailable: total.unavailable, stale: false };
}
