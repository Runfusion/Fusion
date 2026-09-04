import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  resolveWorkflowIrForTask: vi.fn(),
  computeWorkflowIrPin: vi.fn(() => ({ irHash: "inline-review-ir" })),
}));
const agentSession = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  ...core,
}));

vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-session-helpers.js")>()),
  createResolvedAgentSession: agentSession.create,
}));
import { executeWorkflowStep } from "../executor/execute-workflow-step.js";
import { persistWorkflowStepResult } from "../executor/execute-workflow-graph.js";
import { rerouteSingularStaleContentToReview } from "../merge/stale-content-review-reroute.js";
import { computeCodeReviewInputFingerprint } from "../worktree/review-diff-fingerprint.js";
import { readHeadSha } from "../worktree/review-inline-fix-recapture.js";
import { evaluatePreMergeApprovals, getTaskMergeBlocker } from "@fusion/core";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "fusion-inline-review-"));
  directories.push(directory);
  await git(directory, ["init"]);
  await git(directory, ["config", "user.email", "test@example.test"]);
  await git(directory, ["config", "user.name", "Test"]);
  await writeFile(join(directory, "app.txt"), "base\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "base"]);
  const base = (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(directory, "app.txt"), "implementation\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "implementation"]);
  return { directory, base, reviewed: (await git(directory, ["rev-parse", "HEAD"])).stdout.trim() };
}

function codeReviewStep(id = "code-review") {
  return {
    id,
    name: "Code Review",
    description: "Review the implementation.",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Review the implementation.",
    toolMode: "readonly",
    enabled: true,
    optionalGroupId: "code-review",
    reviewKind: "code",
  } as any;
}

function installReviewer(respond: () => Promise<string>) {
  agentSession.create.mockImplementation(async () => {
    const listeners: Array<(event: any) => void> = [];
    return {
      session: {
        state: {},
        subscribe(listener: (event: any) => void) {
          listeners.push(listener);
          return () => undefined;
        },
        prompt: vi.fn(async () => {
          const output = await respond();
          for (const listener of listeners) {
            listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: output, partial: output } });
          }
        }),
        dispose: vi.fn(),
      },
    };
  });
}

function installInlineFixReviewer(worktree: string) {
  installReviewer(async () => {
    await writeFile(join(worktree, "review-fix.txt"), "fixed in review\n");
    await git(worktree, ["add", "."]);
    await git(worktree, ["commit", "-m", "review fix"]);
    return JSON.stringify({
      verdict: "APPROVE_WITH_NOTES",
      notes: "Fixed and re-tested during review.",
      findings: [{ id: "f1", title: "Fix", body: "Fixed in review.", severity: "medium", resolution: "resolved-in-review" }],
    });
  });
}

function installApproveReviewer() {
  installReviewer(async () => JSON.stringify({ verdict: "APPROVE", notes: "Reviewed current content." }));
}

async function persist(store: any, taskId: string, stepId: string, stepName: string, outcome: any) {
  await persistWorkflowStepResult({
    store,
    getRunContextFor: () => undefined,
    readTaskArtifact: vi.fn(async () => "# Approved task\n"),
  } as any, taskId, {
    workflowStepId: stepId,
    workflowStepName: stepName,
    phase: "pre-merge",
    status: outcome.success ? "passed" : "failed",
    verdict: outcome.verdict,
    output: outcome.output,
    notes: outcome.notes,
    findings: outcome.findings,
    reviewInputFingerprint: outcome.reviewInputFingerprint,
    reviewedCommitSha: outcome.reviewedCommitSha,
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:01:00.000Z",
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeEach(() => {
  agentSession.create.mockReset();
  core.resolveWorkflowIrForTask.mockResolvedValue({
    name: "review-gated",
    nodes: [
      { id: "security-review", kind: "step-review", column: "in-review", config: { name: "Security Code Review", reviewKind: "code", defaultOn: true } },
      { id: "code-review", kind: "step-review", column: "in-review", config: { name: "Code Review", reviewKind: "code", defaultOn: true } },
    ],
  });
});

describe("inline review fingerprint recapture", () => {
  it("executes, persists, gates, reroutes, and converges a reviewer inline fix without mutating its sibling lane", async () => {
    const repo = await repository();
    const preFixFingerprint = await computeCodeReviewInputFingerprint(repo.directory, repo.base);
    const securityResult = {
      workflowStepId: "security-review",
      workflowStepName: "Security Code Review",
      phase: "pre-merge",
      status: "passed",
      verdict: "APPROVE",
      reviewKind: "code",
      reviewInputFingerprint: preFixFingerprint,
      reviewedCommitSha: repo.reviewed,
      completedAt: "2026-09-01T00:00:00.000Z",
    };
    const subject = {
      id: "FN-9234",
      title: "Inline review fix",
      description: "Regression fixture",
      column: "in-review",
      worktree: repo.directory,
      branch: "fusion/fn-9234",
      baseCommitSha: repo.base,
      autoMerge: true,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      workflowStepResults: [securityResult],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    } as any;
    const store = {
      getTask: vi.fn(async () => subject),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(subject, patch)),
      logEntry: vi.fn(async () => undefined),
      appendAgentLog: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
      isBackendMode: vi.fn(() => false),
      getTaskWorkflowSelection: vi.fn(() => ({ stepIds: ["security-review", "code-review"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ stepIds: ["security-review", "code-review"] })),
      listWorkflowWorkItemsForTask: vi.fn(async () => []),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded: true })),
    } as any;
    installInlineFixReviewer(repo.directory);
    const deps = {
      store,
      rootDir: repo.directory,
      options: {},
      activePlanningWorkflowSessions: new Set(),
      activeWorkflowStepSessions: new Map(),
      getRunContextFor: () => ({ agentId: "test-reviewer", runId: "review-run" }),
      captureModifiedFiles: async () => [],
      createSpawnAgentTool: () => undefined,
      sharedWorkerTools: {},
      deleteActiveWorkflowStepSession: () => undefined,
      getAssignedAgentRuntimeConfig: () => undefined,
      getAuthoritativeAssignedAgent: async () => undefined,
      readTaskArtifact: async () => "# Approved task\n",
      resolveInstructionsForRole: async () => "",
      resolveMcpServers: async () => [],
      setActiveWorkflowStepSession: () => undefined,
    } as any;

    const outcome = await executeWorkflowStep(deps, subject, codeReviewStep(), repo.directory, {});
    await persist(store, subject.id, "code-review", "Code Review", outcome);
    const postFixHead = (await git(repo.directory, ["rev-parse", "HEAD"])).stdout.trim();
    const postFixDiff = (await git(repo.directory, ["diff", "--binary", `${repo.base}..${postFixHead}`])).stdout;
    const live = await store.getTask(subject.id);
    const required = new Set(["security-review", "code-review"]);
    const descriptor = { kind: "singular", diff: { state: "fingerprint", fingerprint: createHash("sha256").update(postFixDiff).digest("hex") } } as any;

    expect(outcome).toMatchObject({
      verdict: "APPROVE_WITH_NOTES",
      reviewInputFingerprint: descriptor.diff.fingerprint,
      reviewedCommitSha: postFixHead,
    });
    expect(live.workflowStepResults.find((result: any) => result.workflowStepId === "security-review")).toEqual(securityResult);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:review-input-recaptured" }));
    expect(evaluatePreMergeApprovals(live, { requiredPreMergeStepIds: required, mergeContent: descriptor })).toEqual([
      { workflowStepId: "security-review", state: "stale-content" },
      { workflowStepId: "code-review", state: "approved" },
    ]);
    expect(getTaskMergeBlocker(live, { requiredPreMergeStepIds: required, mergeContent: descriptor })).toBe("task has a pre-merge approval recorded against different content");

    await expect(rerouteSingularStaleContentToReview(store, live, { requiredPreMergeStepIds: required, mergeContent: descriptor })).resolves.toMatchObject({
      rerouted: true,
      nodeId: "security-review",
    });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);

    installApproveReviewer();
    const securityOutcome = await executeWorkflowStep(deps, live, codeReviewStep("security-review"), repo.directory, {});
    await persist(store, subject.id, "security-review", "Security Code Review", securityOutcome);
    const converged = await store.getTask(subject.id);
    expect(securityOutcome).toMatchObject({
      verdict: "APPROVE",
      reviewInputFingerprint: descriptor.diff.fingerprint,
      reviewedCommitSha: postFixHead,
    });
    expect(evaluatePreMergeApprovals(converged, { requiredPreMergeStepIds: required, mergeContent: descriptor }).every((approval) => approval.state === "approved")).toBe(true);
    expect(getTaskMergeBlocker(converged, { requiredPreMergeStepIds: required, mergeContent: descriptor })).toBeUndefined();

    const reusable = await executeWorkflowStep(deps, converged, codeReviewStep(), repo.directory, {});
    expect(reusable).toMatchObject({ reviewInputFingerprint: descriptor.diff.fingerprint, reviewedCommitSha: postFixHead });
    expect(agentSession.create).toHaveBeenCalledTimes(2);
  });
});
