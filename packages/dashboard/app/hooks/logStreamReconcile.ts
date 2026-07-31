import type { AgentLogEntry } from "@fusion/core";

/*
FNXC:AgentLogResync 2026-07-26-16:05:
Shared reconciliation for LIVE-ONLY agent-log SSE channels.

`/api/tasks/:id/logs/stream` pipes `agent:log` events as they happen: no ring buffer, no
Last-Event-ID replay (packages/dashboard/src/server.ts). Everything the server emitted while the
channel was down is therefore unrecoverable from the socket, and the mobile hidden-tab SSE suspend
makes that window minutes long. Any hook that tails this channel must refetch the authoritative page
on reconnect and either PROVE the splice or render a VISIBLE gap — implied continuity is data loss
the reader cannot see.

This module exists because that fix landed in `useAgentLogs` only, while `useMultiAgentLogs`
subscribed to the same channel with a blunt "replace the buffer" resync. A hand-copied reconcile is
how this defect class survived into a third round (AGENTS.md "Reuse Components ... (No Drift)"), so
both hooks now import ONE implementation and cannot diverge.
*/

/*
FNXC:MobileTabRetention 2026-07-26-10:20:
Mobile browsers (iOS Safari tabs, iOS PWAs, Chrome Android) discard a backgrounded page whose
resident set is large, which the operator sees as a full white-splash reload on return. Every live
log tail must therefore be a bounded ring, never an array that grows for the lifetime of the session:
an agent streaming for an hour otherwise pins tens of MB of log entries per open surface.
500 is the one number shared by every log surface (agent detail, multi-agent, dev server) so the
per-surface memory ceiling stays predictable.
*/
export const MAX_LOG_ENTRIES = 500;

/**
 * Keep only the newest `cap` items of a streaming buffer.
 *
 * Whole-list cap: it bounds how many entries are retained, never the content of an individual
 * entry. Newest-wins — a log tail is read from the bottom, so dropping the oldest entries is the
 * only truncation that preserves what the reader is actually looking at.
 *
 * Generic so the agent-detail, multi-agent, and command-center streams share this one
 * implementation instead of each re-deriving the same `slice(-N)`.
 */
export function capLogEntries<T>(entries: T[], cap: number = MAX_LOG_ENTRIES): T[] {
  return entries.length > cap ? entries.slice(-cap) : entries;
}

const LOG_GAP_MARKER_FLAG = "__fusionLogGap";

export const LOG_GAP_MARKER_TEXT =
  "Log stream reconnected. Output emitted while this view was disconnected is not shown above; use \"load older\" to fetch it.";

/** A synthetic, client-only entry marking a proven discontinuity in the rendered log. */
export type AgentLogGapMarker = AgentLogEntry & { readonly [LOG_GAP_MARKER_FLAG]: true };

/**
 * True for the synthetic gap marker. Renderers use it to style the break; the hooks use it to keep
 * the marker out of every count that maps onto server-side offsets.
 */
export function isLogGapMarker(entry: AgentLogEntry): boolean {
  return (entry as Partial<AgentLogGapMarker>)[LOG_GAP_MARKER_FLAG] === true;
}

export function createLogGapMarker(taskId: string, timestamp: string): AgentLogGapMarker {
  return { timestamp, taskId, text: LOG_GAP_MARKER_TEXT, type: "status", [LOG_GAP_MARKER_FLAG]: true };
}

/** 1 when the buffer carries a leading gap marker, else 0. Every server-offset sum uses this. */
export function countLeadingGapMarkers(entries: readonly AgentLogEntry[]): number {
  return entries.length > 0 && isLogGapMarker(entries[0]) ? 1 : 0;
}

/** True when the buffer carries a gap marker ANYWHERE, not only at the head. */
export function hasLogGapMarker(entries: readonly AgentLogEntry[]): boolean {
  return entries.some(isLogGapMarker);
}

/*
FNXC:AgentLogPaging 2026-07-26-18:05:
Server `offset` counts back from the NEWEST entry, so the only sound offset is the size of the
newest CONTIGUOUS run the client holds — the entries below the last gap marker. `entries.length -
countLeadingGapMarkers(entries)` was only correct while a marker could exist at index 0 alone; with
`preservePagedHistory` a marker sits between the retained history and the refetched page, and
counting the entries above it would page past the gap and prepend the wrong window at the top.
*/
export function countNewestContiguousEntries(entries: readonly AgentLogEntry[]): number {
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (isLogGapMarker(entries[index])) break;
    count++;
  }
  return count;
}

function lastGapMarkerIndex(entries: readonly AgentLogEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (isLogGapMarker(entries[index])) return index;
  }
  return -1;
}

/**
 * Identity of a log entry for de-duplication. Agent log rows carry no server id, so the full
 * persisted content is the only available key; `timestamp` alone is not unique (streamed deltas
 * share a millisecond).
 *
 * FNXC:DashboardLogs 2026-07-26-10:15:
 * The separator MUST stay written as the LOG_ENTRY_KEY_SEPARATOR constant, never as a raw NUL byte in the source.
 * A literal NUL makes git classify this file as binary (`git diff` prints "Bin", so the file becomes
 * undiffable and unreviewable) and makes plain `grep` skip it entirely — both were observed here.
 * The runtime value is identical; only the on-disk encoding differs.
 */
const LOG_ENTRY_KEY_SEPARATOR = String.fromCharCode(0);

function logEntryKey(entry: AgentLogEntry): string {
  return [entry.timestamp, entry.type, entry.text, entry.detail ?? "", entry.agent ?? ""].join(LOG_ENTRY_KEY_SEPARATOR);
}

/**
 * Length of the longest suffix of `prev` that is also a prefix of `next`, i.e. how much of `next`
 * the caller already holds. 0 means the two windows do not provably touch.
 *
 * The LARGEST such overlap is chosen deliberately: with repeated identical lines several alignments
 * can match, and the largest one is the only choice that cannot duplicate entries (it can at worst
 * treat a repeat as already-held, which the next event corrects).
 */
export function findLogWindowOverlap(prev: AgentLogEntry[], next: AgentLogEntry[]): number {
  const max = Math.min(prev.length, next.length);
  if (max === 0) return 0;
  const prevKeys = prev.slice(prev.length - max).map(logEntryKey);
  const nextKeys = next.slice(0, max).map(logEntryKey);
  for (let k = max; k > 0; k--) {
    let matches = true;
    for (let i = 0; i < k; i++) {
      if (prevKeys[max - k + i] !== nextKeys[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return k;
  }
  return 0;
}

/** Append `next` after `prev`, dropping the leading entries of `next` that `prev` already holds. */
export function appendWithoutDuplicates(prev: AgentLogEntry[], next: AgentLogEntry[]): AgentLogEntry[] {
  if (next.length === 0) return prev;
  if (prev.length === 0) return next;
  const overlap = findLogWindowOverlap(prev, next);
  return [...prev.slice(0, prev.length - overlap), ...next];
}

/*
FNXC:AgentLogResync 2026-07-26-16:12:
Live-tail append with the ring ceiling applied.

Ceiling is `max(MAX_LOG_ENTRIES, prev.length)`: streaming holds the buffer at whatever size it has
(dropping one oldest entry per new line) instead of collapsing a transcript the reader deliberately
expanded with loadMore() straight back down to the cap.

A leading gap marker is client-only and is re-attached after the trim: dropping it would delete the
only visible evidence that entries are missing while the entries stay missing — the same "implied
continuity" failure this module exists to prevent (the reconcile path already re-attaches it after
its own cap; the live path used to not, which is the drift this shared helper closes).

`trimmed` is returned rather than mutated into a ref so the caller owns the "older entries still
exist server-side" signal that forces `hasMore` on.
*/
export function appendLiveEntry(
  prev: AgentLogEntry[],
  entry: AgentLogEntry,
): { entries: AgentLogEntry[]; trimmed: boolean } {
  const limit = Math.max(MAX_LOG_ENTRIES, prev.length);
  if (prev.length + 1 <= limit) return { entries: [...prev, entry], trimmed: false };

  const gapMarkerCount = countLeadingGapMarkers(prev);
  const marker = gapMarkerCount === 1 ? (prev[0] as AgentLogGapMarker) : null;
  const real = gapMarkerCount === 1 ? prev.slice(1) : prev;
  const realLimit = Math.max(1, limit - gapMarkerCount);
  const kept = [...real.slice(real.length + 1 - realLimit), entry];
  return { entries: marker ? [marker, ...kept] : kept, trimmed: true };
}

/*
FNXC:AgentLogResync 2026-07-26-18:10:
Bulk sibling of appendLiveEntry for flushing a batch of parked live events (the reconnect-refetch
holding buffer). Two deliberate differences from the single-entry path:
  1. It de-duplicates against the buffer tail, because a parked batch can overlap entries an
     authoritative page already merged; the single-entry path must NOT dedupe, since two identical
     consecutive log lines are legitimate content.
  2. It applies the same ring ceiling. The previous flush paths appended a raw array with no cap, so
     a verbose agent on a slow reconnect could push the buffer arbitrarily past MAX_LOG_ENTRIES —
     the exact unbounded growth the mobile-retention cap exists to prevent.
A leading gap marker is re-attached after the trim for the same reason as appendLiveEntry.
*/
export function appendLiveEntries(
  prev: AgentLogEntry[],
  incoming: AgentLogEntry[],
): { entries: AgentLogEntry[]; trimmed: boolean } {
  if (incoming.length === 0) return { entries: prev, trimmed: false };
  const merged = appendWithoutDuplicates(prev, incoming);
  const limit = Math.max(MAX_LOG_ENTRIES, prev.length);
  if (merged.length <= limit) return { entries: merged, trimmed: false };

  const gapMarkerCount = countLeadingGapMarkers(merged);
  const marker = gapMarkerCount === 1 ? (merged[0] as AgentLogGapMarker) : null;
  const real = gapMarkerCount === 1 ? merged.slice(1) : merged;
  const realLimit = Math.max(1, limit - gapMarkerCount);
  const kept = real.slice(real.length - realLimit);
  return { entries: marker ? [marker, ...kept] : kept, trimmed: true };
}

/*
FNXC:AgentLogPaging 2026-07-26-18:18:
Merge one "load older" page into the buffer. Replaces the hand-rolled prepend that each log hook
carried, which had three silent-incorrectness defects:

  1. Blind concatenation. The server resolves `offset` against its CURRENT total, so any entry
     persisted between the client reading its offset and the server reading the log shifts the
     returned window N entries newer. Concatenating it duplicated N entries at the seam and (before
     dedup) implied adjacency that did not hold. `appendWithoutDuplicates(page, block)` drops exactly
     the page tail the buffer already holds, which makes the splice correct for any shift smaller
     than a page; a shift of a whole page or more degenerates to a no-op fetch, never a hole.
  2. Retiring a gap marker on ANY non-empty page. A leading marker means an unbounded amount of
     output is missing ABOVE the buffer; one 100-entry page proves nothing about the rest of it.
     The marker is retired only on proof: the page reaching entry 0 (`serverHasMore === false`), or
     the page overlapping the retained block above the marker.
  3. Paging from the wrong end. With history retained above a gap marker, the page belongs directly
     ABOVE the newest contiguous block (i.e. immediately below the marker), so each "load older"
     shrinks the gap from the bottom until it overlaps the retained history and the marker retires.
*/
export function mergeOlderPage(
  prev: AgentLogEntry[],
  page: AgentLogEntry[],
  options: { serverHasMore: boolean },
): AgentLogEntry[] {
  const markerIndex = lastGapMarkerIndex(prev);
  if (markerIndex === -1) return appendWithoutDuplicates(page, prev);

  const marker = prev[markerIndex];
  const above = prev.slice(0, markerIndex);
  const below = appendWithoutDuplicates(page, prev.slice(markerIndex + 1));

  if (above.length === 0) {
    // Nothing retained above the gap: only reaching entry 0 disproves "output is missing above".
    if (!options.serverHasMore) return below;
    return page.length > 0 ? [marker, ...below] : prev;
  }

  const aboveBlock = above.slice(lastGapMarkerIndex(above) + 1);
  const overlap = page.length > 0 ? findLogWindowOverlap(aboveBlock, page) : 0;
  if (overlap > 0) return [...above.slice(0, above.length - overlap), ...below];
  return [...above, marker, ...below];
}

/*
FNXC:AgentLogResync 2026-07-26-14:12:
Reconnect reconciliation. Inputs: the buffer as rendered (`prev`, which may already carry a leading
gap marker), the authoritative newest page (`fresh`), and any live events that arrived while the
refetch was in flight (`pending`, held out of `prev` so the merge sees a stable snapshot).

Overlap case: the reader's buffer and the refetched page share entries, so the missed lines are
exactly `fresh`'s non-overlapping tail — splice and keep the whole paged-back history.
No-overlap case: more than one page was missed, so the two windows cannot be proven adjacent and a
gap marker is required.

FNXC:AgentLogResync 2026-07-26-18:26:
CORRECTION to the note that stood here: it claimed the older prefix HAD to be dropped because
keeping it would break `loadMore`'s offset arithmetic. That reasoning was wrong, and the behaviour it
justified destroyed data the reader had explicitly fetched — five "load older" clicks (~600 entries)
were replaced by the newest 100 whenever a hidden-tab resync missed more than a page. Offsets are
sound with the history retained as long as paging counts only the newest CONTIGUOUS block
(`countNewestContiguousEntries`) and merges through `mergeOlderPage`, which is what both now do.
`preservePagedHistory` therefore keeps the retained entries BELOW the marker, in place:
`[...history, gapMarker, ...fresh]`. It is opt-in only because the remaining callers of this helper
(useMultiAgentLogs, AgentDetailView) still compute offsets with `countLeadingGapMarkers` and must be
migrated to the contiguous-block count in the same change that flips them; until then they keep the
legacy head-marker shape rather than silently paging into the gap.

Cap: the merged buffer honours the same ring ceiling as the live tail (`max(MAX_LOG_ENTRIES,
prev.length)`) so a resync cannot blow past the memory budget that the mobile-retention work exists
to enforce. The trim is a front trim, so a retained marker keeps its meaning: whatever it said was
missing above it is still missing, plus whatever the trim removed.
*/
export function reconcileReconnectedEntries(
  prev: AgentLogEntry[],
  fresh: AgentLogEntry[],
  pending: AgentLogEntry[],
  taskId: string,
  options: { preservePagedHistory?: boolean } = {},
): { entries: AgentLogEntry[]; trimmed: boolean; gapInserted: boolean } {
  const hadGapMarker = prev.length > 0 && isLogGapMarker(prev[0]);
  const previousGapMarker = hadGapMarker ? (prev[0] as AgentLogGapMarker) : null;
  const prevReal = hadGapMarker ? prev.slice(1) : prev;

  let gapMarker: AgentLogGapMarker | null = previousGapMarker;
  let gapInserted = false;
  let merged: AgentLogEntry[];

  if (fresh.length === 0) {
    merged = prevReal;
  } else if (prevReal.length === 0) {
    merged = fresh;
  } else {
    const overlap = findLogWindowOverlap(prevReal, fresh);
    if (overlap > 0) {
      merged = [...prevReal.slice(0, prevReal.length - overlap), ...fresh];
    } else {
      const marker = createLogGapMarker(taskId, fresh[0]?.timestamp ?? new Date(0).toISOString());
      gapInserted = true;
      if (options.preservePagedHistory) {
        merged = [...prevReal, marker, ...fresh];
      } else {
        merged = fresh;
        gapMarker = marker;
      }
    }
  }

  merged = appendWithoutDuplicates(merged, pending);

  /*
  FNXC:AgentLogResync 2026-07-26-18:34:
  The ceiling is unchanged by `preservePagedHistory`: retaining history must not let one resync grow
  the resident set by a whole page on every reconnect. Consequence to be honest about — a
  history-preserving merge whose result exceeds `max(MAX_LOG_ENTRIES, prev.length)` still front-trims
  the OLDEST retained entries. That is the ring policy (newest-wins), it is reported through
  `trimmed` -> `hasMore`, and it removes strictly less than the previous behaviour, which dropped the
  entire retained history.
  */
  const limit = Math.max(MAX_LOG_ENTRIES, prev.length);
  const trimmed = merged.length > limit;
  if (trimmed) merged = merged.slice(merged.length - limit);

  return {
    entries: gapMarker ? [gapMarker, ...merged] : merged,
    trimmed,
    gapInserted,
  };
}
