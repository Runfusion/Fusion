import { describe, expect, it, vi } from "vitest";
import {
  classifyTerminalState,
  detectPipelineWedge,
  drivePipelineToQuiescence,
  driveToQuiescence,
  observePipelineTerminalState,
  type PipelineObservedState,
  type PipelineTerminalModelDependencies,
} from "./_pipeline-terminal-state.js";

function observed(patch: Partial<PipelineObservedState> = {}): PipelineObservedState {
  return {
    column: "in-review",
    activeWorkItems: [],
    finalizationPasses: 0,
    repeatedWorkItemPairs: [],
    liveSessionPaths: [],
    ...patch,
  };
}

describe("pipeline terminal-state model", () => {
  it.each([
    ["W1 contradictory park", { status: "failed", mergeConfirmed: true }],
    ["W2 finalization loop", { finalizationPasses: 2 }],
    ["W3 severed session", { sessions: [{ path: "session", available: false }] }],
    ["W4 unreachable wait", { activeWorkItems: [{ nodeId: "review", state: "held" }], noReleaser: true }],
    ["W5 quiescence violation", { noProgress: true }],
  ] as const)("classifies %s from observed state", (detector, patch) => {
    const state = observed(patch);
    expect(detectPipelineWedge(state)).toBe(detector);
    expect(classifyTerminalState(state)).toBe("wedge");
  });

  it("keeps allowed terminals closed and classifies an otherwise unknown state as parked", () => {
    expect(classifyTerminalState(observed({ done: true, mergeConfirmed: true }))).toBe("merged-done");
    expect(classifyTerminalState(observed({ intake: true }))).toBe("inert-intake");
    expect(classifyTerminalState(observed({ manualHold: true }))).toBe("manual-hold");
    expect(classifyTerminalState(observed({ emptyDiff: true }))).toBe("no-op-merge");
    expect(classifyTerminalState(observed({ status: "unexpected-terminal-shape" }))).toBe("parked");
  });

  it("assembles fresh store, git, and registry evidence for a harness", async () => {
    const dependencies: Omit<PipelineTerminalModelDependencies, "driving"> = {
      store: {
        readFreshTask: async () => ({ column: "done", done: true, mergeConfirmed: true }),
        readActiveWorkItems: async () => [],
        readFinalizationPasses: async () => 1,
        readRepeatedWorkItemPairs: async () => [],
        readNoReleaser: async () => false,
      },
      git: {
        isBranchReachableFromIntegration: async () => true,
        hasEmptyDiff: async () => false,
      },
      registry: {
        readLiveSessions: async () => [],
      },
    };

    await expect(observePipelineTerminalState(dependencies)).resolves.toMatchObject({
      column: "done",
      branchReachableFromIntegration: true,
      liveSessionPaths: [],
    });
  });

  it("bounds a stalled drive as W5 instead of polling", async () => {
    const state = observed({ column: "in-progress" });
    const drive = vi.fn(async () => undefined);
    const result = await driveToQuiescence(async () => state, drive, {
      maxIterations: 3,
      signature: (current) => current.column,
    });

    expect(result).toEqual({ terminal: "wedge", iterations: 2, wedge: "W5 quiescence violation" });
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it("routes a dependency-inverted drive through the supplied hook", async () => {
    let drives = 0;
    const dependencies: PipelineTerminalModelDependencies = {
      store: {
        readFreshTask: async () => drives > 0
          ? { column: "done", done: true, mergeConfirmed: true }
          : { column: "in-progress" },
        readActiveWorkItems: async () => [],
        readFinalizationPasses: async () => 0,
        readRepeatedWorkItemPairs: async () => [],
      },
      git: {
        isBranchReachableFromIntegration: async () => false,
        hasEmptyDiff: async () => false,
      },
      registry: { readLiveSessions: async () => [] },
      driving: {
        drive: async () => { drives += 1; },
        signature: (state) => state.column,
      },
    };

    await expect(drivePipelineToQuiescence(dependencies, { maxIterations: 2 })).resolves.toEqual({
      terminal: "merged-done",
      iterations: 2,
      wedge: undefined,
    });
    expect(drives).toBe(1);
  });
});
