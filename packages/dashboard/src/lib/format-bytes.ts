/*
FNXC:HeapCeilingObservability 2026-10-01-10:56 (RUFU-462):
Byte rendering for operator-facing memory sentences used to be a private helper inside
`retention-pressure-notice.ts`. Now that the heap CEILING is reported on its own (boot log, `/api/health`,
`/api/system-stats`, Mailbox), a second formatter would print a different number for the SAME bytes in two
notices that can appear side by side — the retention notice already renders "% of <ceiling>" against this
exact value, so the two must agree verbatim. Extracted rather than copied; semantics are unchanged.
*/

/** Format bytes for an operator-facing sentence; whole units below 1 GiB, decimal GiB above. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const mib = bytes / (1024 * 1024);
  if (mib < 1) return `${Math.round(bytes / 1024)} KiB`;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}
