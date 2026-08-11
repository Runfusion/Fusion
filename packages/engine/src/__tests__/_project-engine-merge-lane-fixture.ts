type MergeLaneState = {
  mergeQueue: string[];
  mergeActive: Set<string>;
  capacityDeferredMergeTaskIds: Set<string>;
  capacityDeferredMergeReasons: Map<string, string>;
  capacityDeferredMerges: Map<string, unknown>;
  coordinatorAdmittedMergeTaskIds: Set<string>;
  pausedReviewTaskIds: Set<string>;
  mergeRunning: boolean;
  mergeRunningSince: number;
  activeMergeSession: { dispose(): void } | null;
  activeMergeTaskId: string | null;
  activeMergeStartedAtMs: number | null;
  mergeBodyInFlight: Promise<unknown> | null;
  mergeAbortController: AbortController | null;
  mergeRetryTimer: ReturnType<typeof setTimeout> | null;
  prMergeRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  workspaceBusyReenqueues: Map<string, number>;
  workspaceBusyReenqueueTimers: Set<ReturnType<typeof setTimeout>>;
  manualMergeResolvers: Map<string, unknown[]>;
  shuttingDown: boolean;
  startupGeneration: number;
  started: boolean;
};

/**
 * FNXC:MergeQueue 2026-08-09-06:22:
 * Object.create(ProjectEngine.prototype) runs no class field initializers, so a prototype-only
 * merge fake starts with every merge-lane field undefined. FN-8871 requires this fixture to include
 * capacity and PR-retry merge state, preventing production drain additions from drifting test fakes.
 */
export function seedMergeLaneState<T extends object>(
  engine: T,
  overrides: Partial<MergeLaneState> = {},
): T & MergeLaneState {
  const defaults: MergeLaneState = {
    mergeQueue: [],
    mergeActive: new Set(),
    capacityDeferredMergeTaskIds: new Set(),
    capacityDeferredMergeReasons: new Map(),
    capacityDeferredMerges: new Map(),
    coordinatorAdmittedMergeTaskIds: new Set(),
    pausedReviewTaskIds: new Set(),
    mergeRunning: false,
    mergeRunningSince: 0,
    activeMergeSession: null,
    activeMergeTaskId: null,
    activeMergeStartedAtMs: null,
    mergeBodyInFlight: null,
    mergeAbortController: null,
    mergeRetryTimer: null,
    prMergeRetryTimers: new Map(),
    workspaceBusyReenqueues: new Map(),
    workspaceBusyReenqueueTimers: new Set(),
    manualMergeResolvers: new Map(),
    shuttingDown: false,
    startupGeneration: 0,
    started: true,
  };

  return Object.assign(engine, defaults, overrides);
}
