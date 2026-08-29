export interface ActivityTraceEntry {
  ts: string;
  kind: string;
  label: string;
}

const MAX_ENTRIES = 20;
const MAX_CHARS = 4_000;
const entries: ActivityTraceEntry[] = [];

function size(entry: ActivityTraceEntry): number {
  return entry.ts.length + entry.kind.length + entry.label.length;
}

/**
 * FNXC:ReportPipeline 2026-07-16-09:00:
 * Reports may include a small user-facing activity trace by default. Keep it
 * local, bounded text so it receives the same server-side scrub as all report
 * context before any GitHub egress.
 */
export function recordActivity(entry: Omit<ActivityTraceEntry, "ts"> & { ts?: string }): void {
  const next: ActivityTraceEntry = {
    ts: typeof entry.ts === "string" ? entry.ts.slice(0, 64) : new Date().toISOString(),
    kind: String(entry.kind).slice(0, 80),
    label: String(entry.label).slice(0, 1_000),
  };
  entries.push(next);
  while (entries.length > MAX_ENTRIES || entries.reduce((total, item) => total + size(item), 0) > MAX_CHARS) entries.shift();
}

export function snapshotActivityTrace(): ActivityTraceEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function clearActivityTraceForTests(): void {
  entries.length = 0;
}
