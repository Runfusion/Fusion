import * as os from "node:os";

export interface AvailableMemoryReading {
  bytes: number;
  /** False when only `os.freemem()` was available — unusable as a pressure signal. */
  reliable: boolean;
}

/**
 * FNXC:SystemMetrics 2026-06-21-13:01:
 * macOS `os.freemem()` only counts truly-free pages and excludes inactive/cached pages that the OS can reclaim on demand, so total-minus-freemem over-reports memory used and can make an idle Mac look ~95–99% full.
 * Prefer Node's `process.availableMemory()` because it reports OS-available memory and matches user-facing tools such as Activity Monitor. Keep the `os.freemem()` fallback for runtimes without the API, but flag it unreliable so pressure-sensitive callers can refuse to act on a garbage ratio.
 */
export function getAvailableMemoryInfo(): AvailableMemoryReading {
  const processFn = (process as unknown as { availableMemory?: () => number }).availableMemory;
  if (typeof processFn === "function") {
    try {
      const value = processFn.call(process);
      if (Number.isFinite(value) && value > 0) {
        return { bytes: value, reliable: true };
      }
    } catch {
      // Fall through to the compatibility path below.
    }
  }

  return { bytes: os.freemem(), reliable: false };
}

export function getAvailableMemoryBytes(): number {
  return getAvailableMemoryInfo().bytes;
}
