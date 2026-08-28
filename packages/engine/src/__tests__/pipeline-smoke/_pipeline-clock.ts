export interface PipelineClock {
  now(): number;
  advance(ms: number): number;
}

/*
FNXC:PipelineSmoke 2026-08-23-14:18:
FN-182 requires deterministic recovery and capacity timing. Scenarios advance this clock rather
than sleeping, which makes backoff and staleness assertions reproducible without polling.
*/
export function createPipelineClock(initialNow = 0): PipelineClock {
  let current = initialNow;
  return {
    now: () => current,
    advance: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`Pipeline clock advance must be a finite non-negative value, got ${ms}`);
      current += ms;
      return current;
    },
  };
}
