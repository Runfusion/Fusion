export type PatchnodeEntryKind = "completed" | "reverted";

/** A self-contained delivery record that remains readable without its task row. */
export interface PatchnodeEntry {
  entryId: string;
  taskId: string;
  kind: PatchnodeEntryKind;
  occurrenceKey: string;
  /** UTC date, `YYYY-MM-DD`. */
  day: string;
  occurredAt: string;
  title: string;
  body: string;
  revertsEntryId?: string | null;
  revertedAt?: string | null;
  revertedCommitSha?: string | null;
}

export interface PatchnodeDay {
  day: string;
  entries: PatchnodeEntry[];
  completedCount: number;
  revertedCount: number;
}

export interface PatchnodeFeed {
  days: PatchnodeDay[];
  totalEntries: number;
  hasMore: boolean;
}

export interface PatchnodeQuery {
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
