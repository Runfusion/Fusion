/**
 * Task review-state normalization helper.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: function body is byte-identical to its
 * pre-extraction form. store.ts re-imports this helper.
 */
import type { Task } from "../types.js";

export function normalizeTaskReviewState(reviewState: Task["reviewState"] | undefined): Task["reviewState"] | undefined {
  if (!reviewState) {
    return undefined;
  }

  const itemsById = new Map(reviewState.items.map((item) => [item.id, item]));
  const sourceMode = reviewState.source;
  const normalizedAddressing = reviewState.addressing.map((record) => {
    const item = itemsById.get(record.itemId);
    const source = item?.source === "reviewer-agent" ? "reviewer-agent" : "pr-review";
    const summary = item?.summary?.trim() || item?.body?.trim().slice(0, 160) || `Review item ${record.itemId}`;
    const body = item?.body ?? summary;
    return {
      ...record,
      snapshot: record.snapshot ?? {
        itemId: record.itemId,
        sourceMode,
        source,
        summary,
        body,
        authorLogin: item?.author?.login,
        filePath: item?.path,
        threadId: item?.threadId,
        url: item?.htmlUrl,
      },
    };
  });

  return {
    ...reviewState,
    addressing: normalizedAddressing,
  };
}
