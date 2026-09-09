import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { createPipelineClock } from "./_pipeline-clock.js";
import { createPipelineGitFixture, fixturePathsExist, hasGit } from "./_pipeline-git-fixture.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import { createPipelineNoAiGuard } from "./_pipeline-no-ai-guard.js";
import { PipelineSmokeHarness } from "./_pipeline-harness.js";
import { classifyTerminalState, detectPipelineWedge, type PipelineObservedState } from "./_pipeline-terminal-state.js";

const describeIfGit = hasGit ? describe : describe.skip;
const describeIfReady = hasGit ? pgDescribe : describe.skip;

describeIfGit("pipeline smoke harness guards", () => {
  const fixtures: Array<ReturnType<typeof createPipelineGitFixture>> = [];
  const guards: Array<ReturnType<typeof createPipelineNoAiGuard>> = [];
  afterEach(() => {
    guards.splice(0).forEach((guard) => guard.restore());
    fixtures.splice(0).forEach((fixture) => fixture.cleanup());
  });

  it("creates and removes only its disposable local fixture", () => {
    const fixture = createPipelineGitFixture();
    fixtures.push(fixture);
    expect(fixturePathsExist(fixture)).toBe(true);
    expect(fixture.git(["remote", "get-url", "origin"])).toBe(fixture.bareOriginDir);
    fixture.cleanup();
    expect(fixturePathsExist(fixture)).toBe(false);
  });

  it("advances deterministic time without real waiting", () => {
    const clock = createPipelineClock(100);
    expect(clock.advance(25)).toBe(125);
    expect(clock.now()).toBe(125);
    expect(() => clock.advance(-1)).toThrow("non-negative");
  });

  it("rejects disabled test mode, non-mock runtimes, and non-local remotes", () => {
    const fixture = createPipelineGitFixture();
    fixtures.push(fixture);
    const guard = createPipelineNoAiGuard("postgresql://localhost:5432");
    guards.push(guard);
    expect(() => guard.assertTestMode({ testMode: false })).toThrow("testMode");
    expect(() => guard.assertMockRuntime("provider/live")).toThrow("runtime");
    guard.assertMockRuntime("mock/scripted");
    expect(guard.observedRuntimeIds()).toEqual(["provider/live", "mock/scripted"]);
    fixture.git(["remote", "set-url", "origin", "https://example.test/repository.git"]);
    expect(() => guard.assertLocalGitRemotes(fixture)).toThrow("non-local");
  });

  it("proves the fetch and socket tripwires reject network destinations", () => {
    const guard = createPipelineNoAiGuard("postgresql://localhost:5432");
    guards.push(guard);
    guard.installNetworkTripwire();
    expect(() => fetch("https://example.test")).toThrow("guard rejected fetch");
    expect(() => new net.Socket().connect(443, "example.test")).toThrow("guard rejected socket connect");
  });

  it.each([
    ["W1 contradictory park", { status: "failed", mergeConfirmed: true }],
    ["W2 finalization loop", { finalizationPasses: 2 }],
    ["W3 severed session", { sessions: [{ path: "missing-session", available: false }] }],
    ["W4 unreachable wait", { activeWorkItems: [{ nodeId: "review", state: "held" }], noReleaser: true }],
    ["W5 quiescence violation", { noProgress: true }],
  ] as const)("proves %s is classified as a wedge", (detector, patch) => {
    const state: PipelineObservedState = {
      column: "in-review",
      activeWorkItems: [],
      finalizationPasses: 0,
      repeatedWorkItemPairs: [],
      liveSessionPaths: [],
      ...patch,
    };
    expect(detectPipelineWedge(state)).toBe(detector);
    expect(classifyTerminalState(state)).toBe("wedge");
  });

  it("rejects imports of FN-180-introduced helper modules", () => {
    const root = path.dirname(new URL(import.meta.url).pathname);
    const forbidden = ["merge-content-capture", "merge-execution-exclusion", "merger-errors", "confirmed-merge-reconciliation"];
    const files = readdirSync(root).filter((entry) => entry.endsWith(".ts"));
    const imports = files.map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") }));
    for (const { file, source } of imports) {
      const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)]
        .map((match) => match[1] ?? match[2]);
      expect(specifiers.some((value) => forbidden.some((specifier) => value.includes(specifier))), `${file} imports an FN-180-only module`).toBe(false);
    }
  });
});

/*
FNXC:PipelineSmoke 2026-08-23-17:21:
The composition self-test proves that a pipeline scenario reaches the public executor seams and
PostgreSQL-backed store rather than a hand-written runner/store double. Session paths are observed
through the real registry before cleanup can remove the disposable task worktree.
*/
describeIfReady("pipeline smoke production composition", () => {
  const pg: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pipeline_smoke_composition",
    projectId: "pipeline-smoke-composition",
  });
  let harness: PipelineSmokeHarness;

  beforeAll(pg.beforeAll);
  beforeEach(async () => {
    await pg.beforeEach();
    harness = await PipelineSmokeHarness.create(pg);
  });
  afterEach(async () => {
    await harness.dispose();
    await pg.afterEach();
  });
  afterAll(pg.afterAll);

  it("uses authoritative executor seams, the shared layer, and live registry paths", async () => {
    const graphTask = await harness.createPipelineTask("builtin:coding-ideas-v2", { idPrefix: "COMPOSITION" });
    await harness.runProductionTurn(graphTask.id);
    expect(harness.hasAuthoritativeSeams()).toBe(true);
    expect(harness.store.getAsyncLayer()).toBe(pg.layer());

    const liveTask = await harness.createPipelineTask("builtin:coding-ideas-v2", { idPrefix: "LIVE-PATH" });
    await harness.runProductionTurn(liveTask.id);
    const worktree = await harness.requireTaskWorktree(liveTask.id);
    activeSessionRegistry.registerPath(worktree, {
      taskId: liveTask.id,
      kind: "executor",
      ownerKey: `pipeline-composition:${liveTask.id}`,
    });
    try {
      expect((await harness.observe(liveTask.id)).liveSessionPaths).toContain(worktree);
    } finally {
      activeSessionRegistry.unregisterPath(worktree);
    }
  });
});
