import { existsSync } from "node:fs";

/**
 * Terminal labels deliberately form a closed union: a scenario must explicitly opt into every
 * successful stopping condition instead of treating an unfamiliar parked shape as success.
 */
export type PipelineTerminalState =
  | "merged-done"
  | "inert-intake"
  | "blocked"
  | "parked"
  | "manual-hold"
  | "no-op-merge"
  | "wedge";

export type PipelineWedgeDetector =
  | "W1 contradictory park"
  | "W2 finalization loop"
  | "W3 severed session"
  | "W4 unreachable wait"
  | "W5 quiescence violation";

export interface PipelineObservedWorkItem {
  readonly nodeId: string;
  readonly state: string;
}

export interface PipelineRepeatedWorkItem {
  readonly nodeId: string;
  readonly state: string;
  readonly count: number;
}

export interface PipelineObservedSession {
  readonly path: string;
  /** True only when the registry entry still points at a usable session artifact. */
  readonly available: boolean;
}

/** The persisted task fields used by terminal classification, read after cache eviction. */
export interface PipelineObservedTask {
  readonly column: string;
  readonly status?: string;
  readonly mergeConfirmed?: boolean;
  readonly intake?: boolean;
  readonly manualHold?: boolean;
  readonly done?: boolean;
}

/**
 * A normalized, observed snapshot. It intentionally contains facts rather than product objects so
 * the forthcoming real-store harness can assemble it without this model importing engine code.
 */
export interface PipelineObservedState extends PipelineObservedTask {
  readonly branchReachableFromIntegration?: boolean;
  readonly activeWorkItems: readonly PipelineObservedWorkItem[];
  readonly finalizationPasses: number;
  readonly repeatedWorkItemPairs: readonly PipelineRepeatedWorkItem[];
  readonly liveSessionPaths: readonly string[];
  readonly sessions?: readonly PipelineObservedSession[];
  /** Durable projection signatures let the bounded driver distinguish real review/rework progress from a wedge in the same column. */
  readonly stepSignature?: string;
  readonly reviewSignature?: string;
  readonly noReleaser?: boolean;
  readonly noProgress?: boolean;
  readonly emptyDiff?: boolean;
}

/**
 * Store seam for the harness. `readFreshTask` must clear any task cache before returning, matching
 * the live-E2E observed-persisted-state assertion rule.
 */
export interface PipelineTerminalStateStore {
  readFreshTask(): Promise<PipelineObservedTask>;
  readActiveWorkItems(): Promise<readonly PipelineObservedWorkItem[]>;
  readFinalizationPasses(): Promise<number>;
  readRepeatedWorkItemPairs(): Promise<readonly PipelineRepeatedWorkItem[]>;
  readNoReleaser?(): Promise<boolean>;
  readNoProgress?(): Promise<boolean>;
}

/** Git evidence seam; the fixture supplies real integration reachability and diff facts. */
export interface PipelineTerminalGitFixture {
  isBranchReachableFromIntegration(): Promise<boolean>;
  hasEmptyDiff(): Promise<boolean>;
}

/** Session/ownership registry seam; no product registry is imported by this pure model. */
export interface PipelineTerminalStateRegistry {
  readLiveSessions(): Promise<readonly PipelineObservedSession[]>;
}

/** Hooks that let a scenario drive the real engine while preserving deterministic observation. */
export interface PipelineDriveHooks {
  drive(): Promise<void>;
  signature(state: PipelineObservedState): string;
  onObservation?(state: PipelineObservedState): Promise<void> | void;
}

export interface PipelineTerminalModelDependencies {
  readonly store: PipelineTerminalStateStore;
  readonly git: PipelineTerminalGitFixture;
  readonly registry: PipelineTerminalStateRegistry;
  readonly driving: PipelineDriveHooks;
}

export interface PipelineDriveOptions {
  /** A finite positive ceiling prevents a scenario from converting a wedge into polling. */
  readonly maxIterations: number;
}

export interface PipelineDriveResult {
  readonly terminal: PipelineTerminalState;
  readonly iterations: number;
  readonly wedge?: PipelineWedgeDetector;
}

/** Backward-compatible short name for scenario result reporting. */
export type DriveResult = PipelineDriveResult;

/*
FNXC:PipelineSmoke 2026-08-23-14:54:
FN-182 adopts the live lifecycle E2E assertion rule: every lifecycle claim is asserted on
observed persisted state (a fresh task read, persisted work items, and durable git/session facts),
never on a function call. This model is dependency-inverted so the forthcoming harness supplies
those observations without product changes or a second lifecycle authority.
*/
export async function observePipelineTerminalState(
  dependencies: Omit<PipelineTerminalModelDependencies, "driving">,
): Promise<PipelineObservedState> {
  const [
    task,
    activeWorkItems,
    finalizationPasses,
    repeatedWorkItemPairs,
    branchReachableFromIntegration,
    emptyDiff,
    sessions,
    noReleaser,
    noProgress,
  ] = await Promise.all([
    dependencies.store.readFreshTask(),
    dependencies.store.readActiveWorkItems(),
    dependencies.store.readFinalizationPasses(),
    dependencies.store.readRepeatedWorkItemPairs(),
    dependencies.git.isBranchReachableFromIntegration(),
    dependencies.git.hasEmptyDiff(),
    dependencies.registry.readLiveSessions(),
    dependencies.store.readNoReleaser?.(),
    dependencies.store.readNoProgress?.(),
  ]);

  return {
    ...task,
    activeWorkItems,
    finalizationPasses,
    repeatedWorkItemPairs,
    branchReachableFromIntegration,
    emptyDiff,
    sessions,
    liveSessionPaths: sessions.map((session) => session.path),
    noReleaser,
    noProgress,
  };
}

/**
 * Finds the first named wedge in deterministic priority order. A detector is deliberately a
 * diagnostic label, not a recovery action: scenarios must expose a bad terminal shape rather than
 * mutate it into a passing one.
 */
export function detectPipelineWedge(
  state: PipelineObservedState,
  repeatedWorkItemBound = 2,
): PipelineWedgeDetector | undefined {
  if (!Number.isInteger(repeatedWorkItemBound) || repeatedWorkItemBound < 1) {
    throw new Error(`repeatedWorkItemBound must be a positive integer, got ${repeatedWorkItemBound}`);
  }

  if (
    (state.status === "failed" || state.status === "needs-replan")
    && (state.mergeConfirmed || state.branchReachableFromIntegration)
  ) {
    return "W1 contradictory park";
  }
  if (
    state.finalizationPasses > 1
    || state.repeatedWorkItemPairs.some((pair) => pair.count > repeatedWorkItemBound)
  ) {
    return "W2 finalization loop";
  }
  if (state.sessions?.some((session) => !session.available)) return "W3 severed session";
  // FNXC:PipelineSmoke 2026-08-23-15:18: Legacy/direct snapshots carry paths only, so retain the real artifact check for that narrow session-liveness seam.
  if (state.liveSessionPaths.some((sessionPath) => !sessionPath.trim() || !existsSync(sessionPath))) {
    return "W3 severed session";
  }
  if (
    state.activeWorkItems.some((item) => item.state === "held" || item.state === "runnable")
    && state.noReleaser
  ) {
    return "W4 unreachable wait";
  }
  if (state.noProgress) return "W5 quiescence violation";
  return undefined;
}

export function classifyTerminalState(state: PipelineObservedState): PipelineTerminalState {
  if (detectPipelineWedge(state)) return "wedge";
  /* FNXC:ExternalBlockPipeline 2026-08-28-04:56: a deliberate external freeze is terminal, not a parked shape for the bounded driver to keep dispatching into W5. */
  if (state.status === "blocked") return "blocked";
  if (state.emptyDiff) return "no-op-merge";
  if (state.manualHold) return "manual-hold";
  if (state.intake) return "inert-intake";
  if (state.done && state.mergeConfirmed) return "merged-done";
  return "parked";
}

function assertDriveIterations(maxIterations: number): void {
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`maxIterations must be a positive integer, got ${maxIterations}`);
  }
}

/**
 * Drives at most `maxIterations` times. Repeating an observed signature is W5 immediately;
 * changing forever until the ceiling is also W5, so this helper cannot become an unbounded poll.
 */
export async function driveToQuiescence(
  observe: () => Promise<PipelineObservedState>,
  act: () => Promise<void>,
  options: PipelineDriveOptions & Pick<PipelineDriveHooks, "signature">,
): Promise<PipelineDriveResult> {
  assertDriveIterations(options.maxIterations);
  let previousSignature: string | undefined;

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    const state = await observe();
    const wedge = detectPipelineWedge(state);
    const terminal = classifyTerminalState(state);
    if (wedge || terminal !== "parked") return { terminal, iterations: iteration, wedge };

    const signature = options.signature(state);
    if (signature === previousSignature) {
      return { terminal: "wedge", iterations: iteration, wedge: "W5 quiescence violation" };
    }
    previousSignature = signature;
    await act();
  }

  return { terminal: "wedge", iterations: options.maxIterations, wedge: "W5 quiescence violation" };
}

/** Drives a dependency-inverted real harness without coupling this model to product seams. */
export async function drivePipelineToQuiescence(
  dependencies: PipelineTerminalModelDependencies,
  options: PipelineDriveOptions,
): Promise<PipelineDriveResult> {
  return driveToQuiescence(
    async () => {
      const state = await observePipelineTerminalState(dependencies);
      await dependencies.driving.onObservation?.(state);
      return state;
    },
    () => dependencies.driving.drive(),
    { ...options, signature: dependencies.driving.signature },
  );
}
