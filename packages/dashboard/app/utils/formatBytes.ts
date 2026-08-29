/*
FNXC:CommandCenter 2026-07-16-10:00:
The shared byte formatter is deliberately granular (B/KB/MB/GB) because Project Disk size and System telemetry must not present a sub-megabyte value as 0 MB. Invalid and negative measurements remain unavailable rather than inventing a size.
*/
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
