export const BROAD_SCOPE_FLAG_VERSION = 1;

export const DEFAULT_BROAD_SCOPE_THRESHOLDS = {
  stepsHigh: 12,
  fileScopeHigh: 20,
  failingFileMentionsHigh: 30,
  sizeLStepsThreshold: 9,
} as const;

export interface BroadScopeSignals {
  size: "S" | "M" | "L" | null;
  stepCount: number;
  fileScopeCount: number;
  failingFileMentions: number;
}

export interface BroadScopeFlagDecision {
  flagged: boolean;
  score: number;
  reasons: string[];
  signals: BroadScopeSignals;
  thresholds: typeof DEFAULT_BROAD_SCOPE_THRESHOLDS;
  version: number;
}

export function extractBroadScopeSignals(input: {
  size: "S" | "M" | "L" | null;
  stepCount: number;
  fileScopeCount: number;
  descriptionText: string;
}): BroadScopeSignals {
  const matches = input.descriptionText.matchAll(/\b(\d{2,})\s+(failing|broken|test|file)s?\b/gi);
  let failingFileMentions = 0;

  for (const match of matches) {
    const value = Number.parseInt(match[1] ?? "0", 10);
    if (Number.isFinite(value)) {
      failingFileMentions = Math.max(failingFileMentions, Math.min(value, 9999));
    }
  }

  return {
    size: input.size,
    stepCount: input.stepCount,
    fileScopeCount: input.fileScopeCount,
    failingFileMentions,
  };
}

export function decideBroadScopeFlag(
  signals: BroadScopeSignals,
  thresholds: Partial<typeof DEFAULT_BROAD_SCOPE_THRESHOLDS> = {},
): BroadScopeFlagDecision {
  const resolvedThresholds = {
    ...DEFAULT_BROAD_SCOPE_THRESHOLDS,
    ...thresholds,
  };
  const reasons: string[] = [];
  let score = 0;

  if (signals.size === "L") {
    score += 2;
    reasons.push("size-l");
  }
  if (signals.stepCount >= resolvedThresholds.stepsHigh) {
    score += 2;
    reasons.push("steps-high");
  }
  if (signals.fileScopeCount >= resolvedThresholds.fileScopeHigh) {
    score += 2;
    reasons.push("file-scope-high");
  }
  if (signals.failingFileMentions >= resolvedThresholds.failingFileMentionsHigh) {
    score += 2;
    reasons.push("failing-file-mentions-high");
  }
  if (signals.size === "L" && signals.stepCount >= resolvedThresholds.sizeLStepsThreshold) {
    score += 1;
    reasons.push("size-l-with-many-steps");
  }

  return {
    flagged: score >= 3,
    score,
    reasons,
    signals,
    thresholds: resolvedThresholds,
    version: BROAD_SCOPE_FLAG_VERSION,
  };
}
