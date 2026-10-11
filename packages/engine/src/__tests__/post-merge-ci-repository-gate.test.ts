/**
 * RUFU-375 — the post-merge Full Suite gate is refused at DISPATCH when it cannot be told which
 * repository holds its CI evidence.
 *
 * This is the acceptance-critical file: every case is about whether a session was created and what text it
 * was handed. The load-bearing pair is (a) an unresolved `postMergeCiRepo` creates NO session at all — the
 * RUFU-348 measurement of 12 refusals, each needing a named human waiver, was 12 sessions that ran a model
 * to conclude the question was unanswerable — and (b) a resolved one dispatches a prompt that names the
 * repository and carries no surviving `{{ciRepo}}` token.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POST_MERGE_CI_REPOSITORY_PLACEHOLDER,
  POST_MERGE_CI_REPOSITORY_REFUSAL_PREFIX,
  POST_MERGE_CI_REPOSITORY_SETTING_KEY,
  POST_MERGE_VERIFICATION_PROMPT,
  POST_MERGE_VERIFICATION_GROUP_ID,
  getRequiredPostMergeEvidenceBlocker,
  getRequiredPostMergeEvidenceDecision,
  type Settings,
  type TaskDetail,
  type WorkflowIr,
} from "@fusion/core";

import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { isPostMergeGateRecoveryDue } from "../merge/post-merge-gate-reseed.js";
import { WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY } from "../workflows/workflow-graph-executor.js";

const roots: string[] = [];

/** The built-in gate's inner prompt node, as `postMergeVerificationOptionalGroupNode()` authors it. */
const BUILTIN_POST_MERGE_STEP = {
  id: `${POST_MERGE_VERIFICATION_GROUP_ID}-step`,
  kind: "prompt",
  config: {
    name: "Post-merge verification",
    description: "Verify the integrated result after merge proof before final completion",
    prompt: POST_MERGE_VERIFICATION_PROMPT,
    toolMode: "readonly",
    gateMode: "gate",
    requiresCiRepository: true,
  },
} as const;

/** The same gate shape with an authored prompt that carries no token (an edited gate, or a non-CI contract). */
const TOKENLESS_POST_MERGE_STEP = {
  ...BUILTIN_POST_MERGE_STEP,
  config: { ...BUILTIN_POST_MERGE_STEP.config, prompt: "Verify the integrated result against this board's own reporter." },
} as const;

/** The built-in gate's owning optional-group node, as the coding workflow authors it (for recovery decisions). */
function irWithPostMergeGate(): WorkflowIr {
  return {
    version: "v2",
    id: "builtin:coding",
    name: "Coding",
    nodes: [{
      id: POST_MERGE_VERIFICATION_GROUP_ID,
      kind: "optional-group",
      column: "in-review",
      config: {
        phase: "post-merge",
        defaultOn: true,
        template: { nodes: [{ id: "post-merge-check", kind: "prompt", config: { gateMode: "gate" } }] },
      },
    }],
    edges: [],
    columns: [{ id: "in-review", label: "In review", traits: [] }],
  } as unknown as WorkflowIr;
}

function singularTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const now = "2026-10-11T00:00:00.000Z";
  return {
    id: "FN-375",
    title: "Post-merge CI repository gate",
    description: "The gate must be told which repository holds its CI evidence.",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    status: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    prompt: "# Task\n",
    worktree: undefined,
    branch: "fusion/fn-375",
    ...overrides,
  } as TaskDetail;
}

function workspaceTask(root: string, paths: Record<string, string | undefined>, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return singularTask({
    workspaceRoot: root,
    repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo1", "repo2"] },
    workspaceWorktrees: Object.fromEntries(Object.entries(paths).map(([repo, worktreePath]) => [
      repo,
      worktreePath ? { worktreePath, branch: `fusion/fn-375-${repo}`, baseCommitSha: "base" } : {},
    ])),
    ...overrides,
  });
}

/**
 * The dispatch spy is the whole point of this harness: `executeWorkflowStep` is what creates the session,
 * so `not.toHaveBeenCalled()` is the assertion that a refusal is real rather than cosmetic.
 */
function createHarness(root: string, row: TaskDetail) {
  const store = {
    getTask: vi.fn(async () => row),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(row, patch)),
  };
  return {
    store,
    rootDir: root,
    // Typed as the dep declares it: `undefined` = single-repository board, a `{ repos }` value = workspace.
    workspaceConfig: undefined as { repos: string[] } | undefined,
    options: {},
    graphUnattendedRuns: new Set<string>(),
    getRunContextFor: () => undefined,
    adoptColumnAgentForNode: vi.fn(async () => undefined),
    buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
    ensureGraphCustomNodeWorktree: vi.fn(async (current: TaskDetail) => current),
    executeScriptWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    executeWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE", verdict: "APPROVE" })),
    pauseForCliApproval: vi.fn(),
    resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
    runAwaitInputNode: vi.fn(),
    runCliAgentNode: vi.fn(),
    runRawCliCommand: vi.fn(),
  };
}

async function createWorkspacePaths(root: string) {
  const taskDir = join(root, ".fusion", "worktrees", "fn-375");
  const paths = {
    repo1: join(taskDir, "repo1"),
    repo2: join(taskDir, "repo2"),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  return { taskDir, paths };
}

/** Dispatch the built-in gate the way the optional-group executor does: template node + owning group id. */
function dispatch(harness: ReturnType<typeof createHarness>, task: TaskDetail, settings: Settings, node = BUILTIN_POST_MERGE_STEP) {
  return runGraphCustomNode(
    harness as never,
    node as never,
    task,
    settings,
    undefined,
    { [WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY]: POST_MERGE_VERIFICATION_GROUP_ID },
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("post-merge gate refuses dispatch when the CI-evidence repository is unresolved", () => {
  it("runs no session for an unset setting and records the refusal under its own cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-unset-"));
    roots.push(root);
    const task = singularTask();
    const harness = createHarness(root, task);

    const result = await dispatch(harness, task, {} as Settings);

    expect(result).toMatchObject({
      outcome: "success",
      value: "ci-repository-unresolved",
      contextPatch: { notRunReason: "ci-repository-unresolved" },
    });
    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
    expect(harness.executeScriptWorkflowStep).not.toHaveBeenCalled();
    expect(harness.buildInjectedRuntimeEnv).not.toHaveBeenCalled();
    expect(String(result.contextPatch?.output).startsWith(POST_MERGE_CI_REPOSITORY_REFUSAL_PREFIX)).toBe(true);
  });

  it("names the setting key, the publish targets, and what was NOT searched in the refusal the card sees", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-text-"));
    roots.push(root);
    const task = singularTask();
    const harness = createHarness(root, task);

    const result = await dispatch(harness, task, {} as Settings);
    const output = String(result.contextPatch?.output);

    expect(output).toContain(POST_MERGE_CI_REPOSITORY_SETTING_KEY);
    // Finding P2: the refusal must not read as an allow-list of every remote on the machine. This harness's
    // checkout declares no publishing target, so the honest answer is "none declared"; the clause that names
    // remotes which merely EXIST is core-owned wording and is pinned in post-merge-ci-repository.test.ts.
    expect(output).toContain("Publish targets: none declared");
    expect(output).toContain("no CI run was searched for and none was asserted to exist or be absent");
    // The misreading that would spend a re-run budget on a fix nobody needs.
    expect(output).not.toMatch(/no (post-merge )?ci (run|workflow) (exists|found)/i);
    expect(output).not.toMatch(/ci (run|check) (is )?(missing|absent|failing)/i);
    // `origin` may appear only in a prohibition, never beside a permission — the sentence-level form of the
    // guard this file has always pinned, widened because the new wording names `origin` in two places.
    const originSentences = output.split(/(?<=[.!?])\s+/).filter((line) => /\borigin\b/u.test(line));
    expect(originSentences.length).toBeGreaterThan(0);
    for (const sentence of originSentences) {
      expect(sentence).toMatch(/never|canonical|not authorization/iu);
    }
    // The card itself must carry the refusal, not only the graph result.
    expect(harness.store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("did not run"),
      expect.stringContaining(POST_MERGE_CI_REPOSITORY_SETTING_KEY),
      undefined,
    );
  });

  it("distinguishes an invalid slug from an unset value, because the two remedies differ", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-invalid-"));
    roots.push(root);
    const task = singularTask();
    const harness = createHarness(root, task);

    const result = await dispatch(harness, task, { postMergeCiRepo: "https://github.com/acme/widget" } as unknown as Settings);

    expect(result).toMatchObject({ value: "ci-repository-unresolved" });
    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
    expect(String(result.contextPatch?.output)).toContain("is set to a value that is not an `owner/repo` slug");
  });

  /*
  FNXC:PostMergeCiRepository 2026-10-11-04:20 (RUFU-375, Code Review finding P0):
  The two halves of this feature met nowhere: the dispatch seam refused, and a separate module decided whether a
  card carrying that refusal could ever be re-run. Measured consequence before the fix: the refusal wrote a
  `skipped` row, `skipped` was classified as a decision the card had lost, and `blocked` is neither re-seedable
  nor finalizable — so an operator who set the recommended key and pressed Retry changed nothing. RUFU-348's
  twelve waived cards were the same dead-end with a different cause. This is the operator's real sequence in one
  test: refused, the setting gets set, recovery admits the card, and the gate finally runs against a named repo.
  */
  it("a refused gate stays recoverable, and the re-dispatch after the fix names the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-roundtrip-"));
    roots.push(root);
    const task = singularTask({ enabledWorkflowSteps: [POST_MERGE_VERIFICATION_GROUP_ID], workflowStepResults: [] });

    // 1. Unresolved setting: refused at dispatch, and the refusal carries its own cause.
    const refused = await dispatch(createHarness(root, task), task, {} as Settings);
    expect(refused).toMatchObject({ value: "ci-repository-unresolved" });

    // 2. The row the graph executor records from that patch — `skipped` plus the cause, verbatim.
    const carried = {
      ...task,
      workflowStepResults: [{
        workflowStepId: POST_MERGE_VERIFICATION_GROUP_ID,
        workflowStepName: "Post-merge verification",
        phase: "post-merge" as const,
        status: "skipped" as const,
        notRunReason: refused.contextPatch?.notRunReason,
        completedAt: "2026-10-11T04:00:00.000Z",
      }],
    };
    const irStore = {
      getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [POST_MERGE_VERIFICATION_GROUP_ID] }),
      getWorkflowDefinition: async () => ({ ir: irWithPostMergeGate() }),
    };

    // 3. The recovery authority agrees this card is still owed a run, and the recovery lane is due for it.
    const decision = await getRequiredPostMergeEvidenceDecision(irStore as never, carried as never);
    expect(decision).toEqual({ outcome: "resumable", gateId: POST_MERGE_VERIFICATION_GROUP_ID });
    expect(isPostMergeGateRecoveryDue(carried as never, decision)).toBe(true);
    // And the card says so in the operator's language: it never ran, rather than it failed review.
    expect(await getRequiredPostMergeEvidenceBlocker(irStore as never, carried as never))
      .toBe(`required post-merge evidence gate '${POST_MERGE_VERIFICATION_GROUP_ID}' has not reported`);

    // 4. The operator sets the setting; the bounded re-seed re-dispatches and the prompt names the repository.
    const retryHarness = createHarness(root, task);
    await dispatch(retryHarness, task, { postMergeCiRepo: "acme/widget" } as unknown as Settings);
    expect(retryHarness.executeWorkflowStep).toHaveBeenCalledTimes(1);
    const prompt = String(retryHarness.executeWorkflowStep.mock.calls[0]?.[1]?.prompt);
    expect(prompt).toContain("acme/widget");
    expect(prompt).not.toContain(POST_MERGE_CI_REPOSITORY_PLACEHOLDER);
  });
});

describe("post-merge gate dispatches with the repository named", () => {
  it("substitutes the resolved slug into the dispatched prompt and leaves no token behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-resolved-"));
    roots.push(root);
    const task = singularTask();
    const harness = createHarness(root, task);

    const result = await dispatch(harness, task, { postMergeCiRepo: "acme/widget" } as unknown as Settings);

    expect(harness.executeWorkflowStep).toHaveBeenCalledTimes(1);
    const dispatchedPrompt = String(harness.executeWorkflowStep.mock.calls[0]?.[1]?.prompt);
    expect(dispatchedPrompt).toContain("acme/widget");
    expect(dispatchedPrompt).not.toContain(POST_MERGE_CI_REPOSITORY_PLACEHOLDER);
    // RUFU-457's pinned contract sentence survives substitution untouched.
    expect(dispatchedPrompt).toContain("first Full Suite push-to-main run at or after that SHA");
    // The publish guardrail is intact and still forbids PRs.
    expect(dispatchedPrompt).toContain("Do not create a pull request");
    expect(result.outcome).toBe("success");
  });

  it("logs the resolved repository and its setting key before dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-log-"));
    roots.push(root);
    const task = singularTask();
    const harness = createHarness(root, task);

    await dispatch(harness, task, { postMergeCiRepo: "acme/widget" } as unknown as Settings);

    expect(harness.store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("acme/widget"),
      expect.stringContaining(POST_MERGE_CI_REPOSITORY_SETTING_KEY),
      undefined,
    );
  });

  it("leaves a token-free prompt untouched even though the gate is flagged, so other contracts gain no slug demand", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-tokenless-"));
    roots.push(root);
    const task = singularTask();
    const harness = createHarness(root, task);

    // An edited gate (or a contract materialized to integration-only/OneDev/GitLab) has no token, so the
    // requirement is read off the text actually being dispatched, not off the flag alone.
    const result = await dispatch(harness, task, {} as Settings, TOKENLESS_POST_MERGE_STEP);

    expect(harness.executeWorkflowStep).toHaveBeenCalledTimes(1);
    expect(String(harness.executeWorkflowStep.mock.calls[0]?.[1]?.prompt))
      .toBe("Verify the integrated result against this board's own reporter.");
    expect(result.outcome).toBe("success");
  });

  it("refuses a token-carrying node even without the config flag, so a raw token can never reach a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-unflagged-"));
    roots.push(root);
    const task = singularTask();
    const harness = createHarness(root, task);
    const unflagged = {
      ...BUILTIN_POST_MERGE_STEP,
      config: { ...BUILTIN_POST_MERGE_STEP.config, requiresCiRepository: undefined },
    };

    const result = await dispatch(harness, task, {} as Settings, unflagged as never);

    // The requirement is read off the dispatched text, so an IR that carries the token without the flag (an
    // operator-authored copy of the built-in wording) is refused rather than shown a literal placeholder.
    expect(result).toMatchObject({ value: "ci-repository-unresolved" });
    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
  });

  it("dispatches an unflagged, token-free node untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-plain-"));
    roots.push(root);
    const task = singularTask();
    const harness = createHarness(root, task);
    const plain = {
      ...TOKENLESS_POST_MERGE_STEP,
      config: { ...TOKENLESS_POST_MERGE_STEP.config, requiresCiRepository: undefined },
    } as const;

    const result = await dispatch(harness, task, {} as Settings, plain as never);

    expect(harness.executeWorkflowStep).toHaveBeenCalledTimes(1);
    expect(String(harness.executeWorkflowStep.mock.calls[0]?.[1]?.prompt))
      .toBe("Verify the integrated result against this board's own reporter.");
    expect(result.outcome).toBe("success");
  });
});

describe("existing precedents keep their order", () => {
  it("a workspace card without resolved repository context still returns the workspace cause, not the CI cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-workspace-"));
    roots.push(root);
    const { paths } = await createWorkspacePaths(root);
    const task = workspaceTask(root, { repo1: paths.repo1, repo2: undefined });
    const harness = createHarness(root, task);
    harness.workspaceConfig = { repos: ["repo1", "repo2"] };

    const result = await dispatch(harness, task, {} as Settings);

    expect(result).toMatchObject({ value: "repository-context-unresolved" });
    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
  });

  it("a workspace card WITH resolved context reaches the CI cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-workspace-ok-"));
    roots.push(root);
    const { paths } = await createWorkspacePaths(root);
    const task = workspaceTask(root, paths);
    const harness = createHarness(root, task);
    harness.workspaceConfig = { repos: ["repo1", "repo2"] };

    const result = await dispatch(harness, task, {} as Settings);

    expect(result).toMatchObject({ value: "ci-repository-unresolved" });
    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
  });

  it("a Fast-mode card keeps the execution-mode skip, which returns before any CI resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-rufu375-ci-fast-"));
    roots.push(root);
    const task = singularTask({ executionMode: "fast" });
    const harness = createHarness(root, task);

    // A top-level (non-optional-group) custom node is the fast-lane skip candidate; the post-merge template
    // body is not, which is exactly why the precedence test dispatches it without the group context.
    const result = await runGraphCustomNode(
      harness as never,
      BUILTIN_POST_MERGE_STEP as never,
      task,
      {} as Settings,
      undefined,
      { "workflow:fast-lane-active": true },
    );

    expect(result).toMatchObject({
      value: "workflow-step-skipped",
      contextPatch: { notRunReason: "execution-mode-skip" },
    });
    expect(harness.executeWorkflowStep).not.toHaveBeenCalled();
  });
});
