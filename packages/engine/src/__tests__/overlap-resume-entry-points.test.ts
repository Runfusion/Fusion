import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchCliTaskSessionMock } = vi.hoisted(() => ({ launchCliTaskSessionMock: vi.fn() }));
vi.mock("../cli-agent/task-session.js", () => ({
  CliTaskSession: class {},
  launchCliTaskSession: launchCliTaskSessionMock,
  killLiveTaskSessions: vi.fn(),
}));
import { buildExecutionPrompt } from "../executor/execution-prompt.js";
import { buildFastLanePrompt, buildReducedStepPrompt, buildStepPrompt } from "../execution/step-session-executor.js";
import { acknowledgeOverlapResumeContext, OVERLAP_RESUME_CONTEXT_MARKER, readOverlapResumeContext, readOverlapResumeContextDelivery } from "../execution/overlap-resume-context.js";
import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { runCliAgentNode } from "../executor/run-cli-agent-node.js";
import { dispatchHeartbeatTransportWithOverlapAck } from "../agent-heartbeat.js";
import { finalizeImplementationTransportWithOverlapAck } from "../executor/run-implementation.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { __resetOverlapReconciliationDiagnosticDedup, synchronizeOverlapWaitBeforeExecution, OverlapResumeSynchronizationError } from "../executor/overlap-resume-gate.js";
import { OVERLAP_DELIVERY_UNAVAILABLE_ERROR } from "@fusion/core";

const context = `${OVERLAP_RESUME_CONTEXT_MARKER}\nDuring this task's wait, FN-A delivered changes.\n- src/shared.ts`;
const task = { id: "FN-B", title: "Waiting task", description: "Implement", prompt: "## Mission\nImplement.\n\n## File Scope\n- `src/shared.ts`\n\n## Steps\n\n### Step 0: Work\nDo it.", steps: [{ name: "Work", status: "pending" }], currentStep: 0, dependencies: [], attachments: [], steeringComments: [] } as any;

describe("overlap resume execution entry points", () => {
  it("injects the same factual context in normal, step, reduced, and Fast prompts", () => {
    expect(buildExecutionPrompt(task, "/repo", undefined, "/repo/wt", undefined, undefined, null, { overlapResumeContext: context })).toContain(context);
    expect(buildStepPrompt(task, 0, "/repo", undefined, "/repo/wt", context)).toContain(context);
    expect(buildReducedStepPrompt(task, 0, "/repo", context)).toContain(context);
    expect(buildFastLanePrompt({ ...task, executionMode: "fast" }, "/repo", undefined, "/repo/wt", context)).toContain(context);
  });

  it("omits empty synchronization sections for tasks without an episode", () => {
    expect(buildExecutionPrompt(task)).not.toContain(OVERLAP_RESUME_CONTEXT_MARKER);
    expect(buildStepPrompt(task, 0)).not.toContain(OVERLAP_RESUME_CONTEXT_MARKER);
  });

  it("reads only ready receipts and deduplicates repeated context", async () => {
    const store = { listTaskOverlapWaits: async () => [
      { phase: "ready", receipt: { briefing: context } },
      { phase: "ready", receipt: { briefing: context } },
      { phase: "analyzing", receipt: { briefing: "not ready" } },
    ] } as any;
    expect(await readOverlapResumeContext(store, task.id)).toBe(context);
  });

  it("passes the briefing through the real custom-model dispatch and acknowledges it", async () => {
    const ready = {
      phase: "ready",
      episodeId: "episode-custom",
      revision: 7,
      owner: "run-custom",
      receipt: { briefing: context, decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "fp-custom", decidedAt: new Date().toISOString() },
    };
    const completeTaskOverlapWait = vi.fn(async () => ready);
    const executeWorkflowStep = vi.fn(async () => ({ success: true, output: "done" }));
    const live = { ...task, worktree: process.cwd(), column: "in-progress" };
    const store = {
      getTask: vi.fn(async () => live),
      listTaskOverlapWaits: vi.fn(async () => [ready]),
      completeTaskOverlapWait,
      logEntry: vi.fn(),
      updateTask: vi.fn(),
    };
    const result = await runGraphCustomNode({
      store,
      rootDir: process.cwd(),
      workspaceConfig: null,
      options: {},
      graphUnattendedRuns: new Set(),
      getRunContextFor: () => undefined,
      adoptColumnAgentForNode: vi.fn(async () => undefined),
      buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
      ensureGraphCustomNodeWorktree: vi.fn(async () => live),
      executeScriptWorkflowStep: vi.fn(),
      executeWorkflowStep,
      pauseForCliApproval: vi.fn(),
      resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
      runAwaitInputNode: vi.fn(),
      runCliAgentNode: vi.fn(),
      runRawCliCommand: vi.fn(),
      runConfiguredCommand: vi.fn(),
    } as any, { id: "custom-work", kind: "prompt", config: { prompt: "Perform custom work", toolMode: "coding" } } as any, live as any, {});

    expect(result.outcome).toBe("success");
    expect(executeWorkflowStep.mock.calls[0]?.[1]?.prompt).toContain(context);
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-custom", phase: "delivered" }));
  });

  it("delivers and acknowledges CLI context only after launch succeeds", async () => {
    const ready = {
      phase: "ready", episodeId: "episode-cli", revision: 2, owner: "run-cli",
      receipt: { briefing: context, decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "fp-cli", decidedAt: new Date().toISOString() },
    };
    const completeTaskOverlapWait = vi.fn(async () => ready);
    const store = { listTaskOverlapWaits: vi.fn(async () => [ready]), completeTaskOverlapWait, logEntry: vi.fn() } as any;
    const session = { result: vi.fn(async () => ({ kind: "success" })), kill: vi.fn() };
    launchCliTaskSessionMock.mockRejectedValueOnce(new Error("launch failed")).mockResolvedValueOnce(session);
    const deps = {
      store, getRunContextFor: () => undefined, activeCliTaskSessions: new Map(),
      cliAgentRuntime: { manager: {}, hub: {}, registry: {}, store: {}, projectId: "p", hookEndpointUrl: "http://hooks" },
      reapCliTaskSessionForHandoff: vi.fn(),
    } as any;
    const node = { id: "cli", kind: "prompt" } as any;
    const cfg = { cliAdapterId: "test", prompt: "Run CLI" };
    const live = { ...task, worktree: process.cwd() };

    await expect(runCliAgentNode(deps, node, live, cfg)).rejects.toThrow("launch failed");
    expect(completeTaskOverlapWait).not.toHaveBeenCalled();
    await expect(runCliAgentNode(deps, node, live, cfg)).resolves.toMatchObject({ outcome: "success" });
    expect(launchCliTaskSessionMock.mock.calls[1]?.[0]?.prompt).toContain(context);
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-cli", phase: "delivered" }));
  });

  it("keeps heartbeat context pending after a failed send and acknowledges the successful retry", async () => {
    const delivery = { context, episodes: [{ episodeId: "heartbeat-episode", revision: 3, owner: "heartbeat", receipt: { decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "heartbeat-fp", briefing: context, decidedAt: new Date().toISOString() } }] } as any;
    const completeTaskOverlapWait = vi.fn(async () => undefined);
    const store = { completeTaskOverlapWait } as any;
    await expect(dispatchHeartbeatTransportWithOverlapAck({ send: async () => { throw new Error("transport failed"); }, store, taskId: task.id, delivery })).rejects.toThrow("transport failed");
    expect(completeTaskOverlapWait).not.toHaveBeenCalled();
    const send = vi.fn(async () => undefined);
    await dispatchHeartbeatTransportWithOverlapAck({ send, store, taskId: task.id, delivery });
    expect(send).toHaveBeenCalledOnce();
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "heartbeat-episode", phase: "delivered" }));
  });

  it("fences external implementation acknowledgement on the real session success check", async () => {
    const delivery = { context, episodes: [{ episodeId: "external-episode", revision: 5, owner: "external", receipt: { decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "external-fp", briefing: context, decidedAt: new Date().toISOString() } }] } as any;
    const completeTaskOverlapWait = vi.fn(async () => undefined);
    const store = { completeTaskOverlapWait } as any;
    await expect(finalizeImplementationTransportWithOverlapAck({ session: { state: { errorMessage: "send failed" } } as any, store, taskId: task.id, delivery })).rejects.toThrow("send failed");
    expect(completeTaskOverlapWait).not.toHaveBeenCalled();
    await finalizeImplementationTransportWithOverlapAck({ session: { state: {} } as any, store, taskId: task.id, delivery });
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "external-episode", phase: "delivered" }));
  });

  it("acknowledges only generations captured before the successful transport", async () => {
    const completeTaskOverlapWait = vi.fn(async () => undefined);
    const store = {
      listTaskOverlapWaits: vi.fn(async () => [{
        phase: "ready",
        episodeId: "episode-a",
        revision: 4,
        owner: "run-a",
        receipt: { briefing: context, decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "fp-a", decidedAt: new Date().toISOString() },
      }]),
      completeTaskOverlapWait,
    } as any;
    const delivery = await readOverlapResumeContextDelivery(store, task.id);
    // A newer generation can become ready while the captured prompt is in flight.
    store.listTaskOverlapWaits.mockResolvedValue([{ phase: "ready", episodeId: "episode-c", revision: 1, owner: "run-c", receipt: { briefing: "new context" } }]);

    await acknowledgeOverlapResumeContext(store, task.id, delivery);

    expect(completeTaskOverlapWait).toHaveBeenCalledOnce();
    expect(completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-a", expectedRevision: 4, owner: "run-a", phase: "delivered" }));
    expect(completeTaskOverlapWait).not.toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-c" }));
  });
});

/*
FNXC:OverlapWaitSynchronization 2026-09-15-19:20:
FN-429. The rewritten-delivery reconciliation must be reachable from every worktree-acquisition surface, not
only from a direct helper call: FN-428 failed inside acquisition, before Preflight. Fresh creation, warm
reuse, and reuse of a persisted pinned pointer all route through `synchronizePreparedWorktree`, so each one
is driven here against a real integration branch whose delivered commit was rebased to a new SHA.
*/
const acquisitionRoots: string[] = [];
afterEach(() => {
  for (const path of acquisitionRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function rebasedIntegrationRepository() {
  const root = mkdtempSync(join(tmpdir(), "fn-429-acquisition-"));
  acquisitionRoots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fusion@example.test");
  git(root, "config", "user.name", "Fusion Test");
  writeFileSync(join(root, "shared.ts"), "export const contract = 'v0';\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "C0");
  const c0 = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "holder", c0);
  writeFileSync(join(root, "shared.ts"), "export const contract = 'v1';\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "feat(FN-A): deliver the shared contract", "-m", "Fusion-Task-Id: FN-A\nFusion-Task-Lineage: lineage-a");
  const landedShaBefore = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "upstream.ts"), "export const upstream = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "upstream work");
  git(root, "checkout", "-q", "holder");
  git(root, "rebase", "-q", "--onto", "main", c0, "holder");
  const landedShaAfter = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--ff-only", "holder");
  return { root, c0, landedShaBefore, landedShaAfter };
}

function acquisitionStore(landedSha: string) {
  let episode: any = {
    taskId: "FN-B", episodeId: "episode-acquire", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", phase: "observed", revision: 1, attempt: 0,
    observation: { deliveries: [{ blockerTaskId: "FN-A", blockerLineageId: "lineage-a", repository: ".", landedSha, summary: "Changed the shared contract", evidence: "merge-details" }] },
  };
  const live: any = { id: "FN-B", title: "FN-B", description: "", prompt: "## Mission\nWork.\n\n## File Scope\n- `shared.ts`\n\n## Steps\n", modifiedFiles: [], lineageId: "lineage-b", column: "todo", dependencies: [], steps: [] };
  const store: any = {
    getTask: vi.fn(async () => live),
    updateTask: vi.fn(async (_id: string, patch: any) => Object.assign(live, patch)),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    listTaskOverlapWaits: vi.fn(async (_id: string, options?: { pendingOnly?: boolean }) =>
      options?.pendingOnly && (episode.phase === "delivered" || episode.phase === "cancelled") ? [] : [episode]),
    claimTaskOverlapWait: vi.fn(async (claim: any) => {
      if (claim.expectedRevision !== episode.revision) return null;
      episode = { ...episode, phase: "analyzing", owner: claim.owner, revision: episode.revision + 1, attempt: episode.attempt + 1 };
      return episode;
    }),
    completeTaskOverlapWait: vi.fn(async (input: any) => {
      if (input.expectedRevision !== episode.revision || input.owner !== episode.owner) return null;
      episode = { ...episode, phase: input.phase, receipt: input.receipt, revision: episode.revision + 1 };
      return episode;
    }),
  };
  return {
    store,
    live,
    get episode() { return episode; },
    /** Re-arm the wait so the next acquisition surface must prove the rewrite for itself. */
    rearm() { episode = { ...episode, phase: "observed", revision: episode.revision + 1, owner: undefined, receipt: undefined }; },
  };
}

describe("overlap resume reconciliation at each acquisition surface (FN-429)", () => {
  it("reconciles a rewritten delivery on fresh, warm-reused, and pinned-pointer acquisition", async () => {
    const repo = rebasedIntegrationRepository();
    const h = acquisitionStore(repo.landedShaBefore);
    const settings = { refreshWorktreeBaseBeforeExecution: true } as any;

    for (const surface of ["fresh", "reused", "pinned"] as const) {
      __resetOverlapReconciliationDiagnosticDedup();
      if (surface === "reused") h.live.worktree = null;
      const acquisition = await acquireTaskWorktree({ task: { ...h.live }, rootDir: repo.root, store: h.store, settings, runInitCommand: false });

      expect(acquisition.source).toBe(surface === "fresh" ? "fresh" : "existing");
      expect(git(acquisition.worktreePath, "merge-base", "--is-ancestor", repo.landedShaAfter, "HEAD")).toBe("");
      expect(h.episode.phase).toBe("ready");
      expect(h.episode.receipt.deliveryProofs[0]).toMatchObject({
        landedSha: repo.landedShaBefore, reconciledSha: repo.landedShaAfter, reconciliationProof: "patch-id+task-trailer", freshness: "proven",
      });
      h.live.worktree = acquisition.worktreePath;
      h.live.branch = acquisition.branch;
      h.rearm();
    }
  });
});

/*
FNXC:OverlapAcquisitionPark 2026-11-04-02:05 (RUFU-373):
The producer half of the refusal payload and the restricted-seam lane. The heartbeat can only forward
whatever the gate produced, so the payload's CONTENT is pinned here: a delivery-unavailable refusal must
name the episode, the predecessor task, and the repository it is missing evidence for. SANE-436's operator
saw only `Delivered file evidence is not yet available for overlap synchronization` — the ids existed in
the store and reached nobody.

The second case is the workspace shape: the per-repository acquisition callback holds the task's
non-reentrant advisory lock, so its store hands out `undefined` for the overlap persistence methods. The
gate must then run the SAME analysis and raise the SAME refusal without any write, so deferring can never
become silently resuming an unmet obligation.
*/
describe("overlap gate refusal payload and restricted-seam persistence", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  __resetOverlapReconciliationDiagnosticDedup();

  function checkout() {
    const path = mkdtempSync(join(tmpdir(), "rufu373-gate-"));
    roots.push(path);
    git(path, "init", "-b", "main");
    git(path, "config", "user.email", "test@example.com");
    git(path, "config", "user.name", "Test");
    writeFileSync(join(path, "src.ts"), "v1\n");
    git(path, "add", ".");
    git(path, "commit", "-m", "seed");
    return path;
  }

  /** A pending episode whose predecessor published nothing: the SANE-436 / ROZV-197 state. */
  const waitingEpisode = {
    episodeId: "ep-9", revision: 1, owner: null, taskId: "FN-B", blockerTaskId: "FN-A",
    phase: "pending", receipt: null,
    // `evidence: "unavailable"` with no landed SHA is exactly what a not-yet-merged predecessor produces.
    observation: { deliveries: [{ blockerTaskId: "FN-A", repository: "repo-a", evidence: "unavailable" }] },
  };

  function storeWithoutDelivery(persistence: "present" | "absent") {
    const writes = {
      reconcileTaskOverlapWaits: vi.fn(async () => []),
      claimTaskOverlapWait: vi.fn(async () => ({ ...waitingEpisode, revision: 2, owner: "run-1", phase: "analyzing" })),
      completeTaskOverlapWait: vi.fn(async () => ({ ...waitingEpisode, phase: "freshness-pending" })),
    };
    return {
      store: {
        listTaskOverlapWaits: vi.fn(async () => [waitingEpisode]),
        getTask: vi.fn(async () => ({ id: "FN-A", title: "Blocker", mergeDetails: null })),
        logEntry: vi.fn(async () => undefined),
        ...(persistence === "present" ? writes : {}),
      } as any,
      writes,
    };
  }

  it("names the episode, the predecessor, and the repository in a delivery-unavailable refusal", async () => {
    const worktreePath = checkout();
    const { store } = storeWithoutDelivery("present");

    const error = await synchronizeOverlapWaitBeforeExecution({
      task: { id: "FN-B", title: "Waiter", column: "in-progress" } as any,
      store, worktreePath, owner: "run-1", repository: "repo-a",
    }).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(OverlapResumeSynchronizationError);
    expect((error as OverlapResumeSynchronizationError).reason).toBe("delivery-unavailable");
    expect((error as OverlapResumeSynchronizationError).message).toBe(OVERLAP_DELIVERY_UNAVAILABLE_ERROR);
    expect((error as OverlapResumeSynchronizationError).artifacts).toEqual({
      episodeIds: ["ep-9"],
      blockerTaskIds: ["FN-A"],
      repositories: ["repo-a"],
      missingEvidence: "delivery-evidence-unavailable",
    });
  });

  it("raises the identical refusal from a restricted seam that cannot persist, writing nothing", async () => {
    const worktreePath = checkout();
    const { store, writes } = storeWithoutDelivery("absent");

    const error = await synchronizeOverlapWaitBeforeExecution({
      task: { id: "FN-B", title: "Waiter", column: "in-progress" } as any,
      store, worktreePath, owner: "run-1", repository: "repo-a",
      deferPersistence: typeof store.claimTaskOverlapWait !== "function",
    }).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(OverlapResumeSynchronizationError);
    expect((error as OverlapResumeSynchronizationError).message).toBe(OVERLAP_DELIVERY_UNAVAILABLE_ERROR);
    expect((error as OverlapResumeSynchronizationError).artifacts.missingEvidence).toBe("delivery-evidence-unavailable");
    // Deferral is a persistence policy, never an analysis change: no lock-taking write was attempted.
    expect(writes.claimTaskOverlapWait).not.toHaveBeenCalled();
    expect(writes.completeTaskOverlapWait).not.toHaveBeenCalled();
    expect(writes.reconcileTaskOverlapWaits).not.toHaveBeenCalled();
  });

  it("never resolves successfully for a restricted seam just because it cannot persist", async () => {
    const worktreePath = checkout();
    const { store, writes } = storeWithoutDelivery("absent");
    // A pending episode with CONCRETE delivery evidence whose SHA the checkout does not contain must also
    // refuse; an absent persistence lane may not turn a refusal into a green result.
    store.listTaskOverlapWaits.mockResolvedValue([{
      ...waitingEpisode,
      observation: { deliveries: [{ blockerTaskId: "FN-A", repository: "repo-a", landedSha: "0".repeat(40), paths: [{ repository: "repo-a", path: "src.ts", status: "modified" }] }] },
    }]);

    const error = await synchronizeOverlapWaitBeforeExecution({
      task: { id: "FN-B", title: "Waiter", column: "in-progress" } as any,
      store, worktreePath, owner: "run-1", repository: "repo-a",
      deferPersistence: true,
    }).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(OverlapResumeSynchronizationError);
    expect((error as OverlapResumeSynchronizationError).reason).toBe("freshness-unproven");
    expect((error as OverlapResumeSynchronizationError).artifacts.missingEvidence).toBe("checkout-freshness-unproven");
    expect(writes.claimTaskOverlapWait).not.toHaveBeenCalled();
    expect(writes.completeTaskOverlapWait).not.toHaveBeenCalled();
  });
});

/*
FNXC:WorkspaceWorktree 2026-11-04-02:20 (RUFU-373):
Structural guard for the restricted-seam signal, not a comment assertion: the per-repository acquisition
callback holds the same non-reentrant task advisory lock the three overlap-wait PERSISTENCE methods take,
so handing them out is a self-deadlock and handing out a THROWING stub was the original defect — a
workspace card with any pending episode died before the gate could analyse it. The gate chooses deferred
persistence by `typeof store.claimTaskOverlapWait !== "function"`, so `undefined` is load-bearing.
Everything else stays fail-closed: a newly added TaskStore method must be classified before acquisition
may call it, which is FN-9295's rule and this guard keeps honest.
*/
describe("workspace acquisition restricted store seam", () => {
  const acquisitionSource = readFileSync(
    new URL("../worktree/worktree-acquisition.ts", import.meta.url),
    "utf8",
  );

  it("hands out undefined for the three lock-taking overlap persistence methods", () => {
    const restricted = /property === "reconcileTaskOverlapWaits"\s*\|\|\s*property === "claimTaskOverlapWait"\s*\|\|\s*property === "completeTaskOverlapWait"\s*\)\s*\{\s*return undefined;/;
    expect(restricted.test(acquisitionSource), "the restricted proxy must return undefined for the overlap persistence methods").toBe(true);
  });

  it("keeps every other unclassified TaskStore method fail-closed", () => {
    // The fall-through throw is what makes the absence signal specific rather than a blanket passthrough.
    expect(acquisitionSource).toContain("Workspace acquisition cannot call unsupported TaskStore method");
    expect(acquisitionSource).toMatch(/if \(property === "listTaskOverlapWaits"\) return value\.bind\(target\);/);
  });

  it("tells the acquisition seam to defer gate persistence when the claim method is absent", () => {
    expect(acquisitionSource).toMatch(/deferPersistence: typeof store\.claimTaskOverlapWait !== "function"/);
  });
});
