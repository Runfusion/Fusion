/**
 * FNXC:CodeOrganization 2026-07-16-12:00:
 * Merger autostash label vocabulary and pure parsers peeled from merger.ts.
 * Shared by merger.ts and merger-ai.ts so one label space feeds reclamation.
 */

export const AUTOSTASH_LABEL_PREFIX = "fusion-merger-autostash:";

/*
FNXC:MergeAutostash 2026-07-15-13:20:
`merger-ai`'s local-checkout sync stashed under its own `fusion-ai-merge-sync-<taskId>`
label, which none of the reclamation machinery here matches — every path keys off
AUTOSTASH_LABEL_PREFIX. The entries were therefore never classified, never
subsumed-dropped, never age-swept, and never surfaced as orphans holding work:
they accumulated indefinitely (six entries dating back a month were found on a
single working tree, and their sheer age made real lost work indistinguishable
from litter).

merger-ai now labels through `buildAutostashLabel` so one vocabulary reaches all
of it. This legacy prefix stays recognized so entries already sitting in
developers' stash lists are reclaimed rather than stranded forever; it carries no
timestamp, so the age sweep skips it and only the subsumed check can drop it.
*/
export const LEGACY_AI_SYNC_LABEL_PREFIX = "fusion-ai-merge-sync-";

/** Canonical autostash label. `phase` distinguishes the creating call site
 *  (`pre-merge`, `ai-local-sync`, `finalize-reset`, `race-rescue-<n>`). */
export function buildAutostashLabel(taskId: string, phase: string, at: number): string {
  return `${AUTOSTASH_LABEL_PREFIX}${taskId}:${phase}:${at}`;
}

export const AUTOSTASH_TIMESTAMP_RE = /^fusion-merger-autostash:[A-Za-z]+-\d+:(?:(?:[a-z0-9-]+:)?(?:\d+:)?)?(\d+)$/;

export function parseAutostashTaskId(label: string): string | null {
  const trimmed = label.trim();
  const match = /^fusion-merger-autostash:([A-Za-z]+-\d+):/.exec(trimmed);
  if (match?.[1]) return match[1];
  // Legacy merger-ai label: `fusion-ai-merge-sync-<taskId>` (no trailing fields).
  return /^fusion-ai-merge-sync-([A-Za-z]+-\d+)$/.exec(trimmed)?.[1] ?? null;
}

export function parseAutostashCreatedAt(label: string): string | null {
  const match = AUTOSTASH_TIMESTAMP_RE.exec(label.trim());
  if (!match) return null;
  const ts = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(ts)) return null;
  // Guard RangeError: finite numbers outside JS Date range still produce Invalid Date.
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function parseAutostashSourcePhase(label: string): string | null {
  const trimmed = label.trim();
  const phaseMatch = /^fusion-merger-autostash:[A-Za-z]+-\d+:([a-z-]+):\d+$/.exec(trimmed);
  if (phaseMatch?.[1]) return phaseMatch[1];
  if (/^fusion-merger-autostash:[A-Za-z]+-\d+:race-rescue-\d+:\d+$/.test(trimmed)) return "race-rescue";
  if (/^fusion-merger-autostash:[A-Za-z]+-\d+:\d+$/.test(trimmed)) return "pre-merge";
  if (/^fusion-ai-merge-sync-[A-Za-z]+-\d+$/.test(trimmed)) return "ai-local-sync";
  return null;
}
