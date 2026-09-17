// @vitest-environment node
/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — the delivery-lock routes are the ONLY producers of a per-card delivery authorization. This
suite drives the real Express stack so the durable decision, its identity fences, the three distinct
commands, and the server-side capability refusals are all exercised end to end.

Surface enumeration covered here:
  • The three commands, each producing its own distinct durable outcome.
  • Message families: optional note for both positive actions, MANDATORY instruction for a rejection,
    blank/non-string/over-long input.
  • Authority: a client-supplied decidedBy / deliveryAction / approval object is refused outright.
  • Identity fences: stale revision, stale candidate token, unknown action.
  • Idempotence: identical replay returns the stored receipt; the same requestId with a different
    action is a conflict.
  • Capability: no GitHub auth disables «Créer PR» with a reason WITHOUT disabling «Refuser».
  • A card without the lock is untouched by all of this.
*/
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH } from "@fusion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ghAuthenticated = vi.hoisted(() => ({ value: true }));
vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return { ...actual, isGhAuthenticated: () => ghAuthenticated.value };
});

/*
Merge-content capture reads a real worktree. Stub ONLY that probe so the suite exercises the routes,
the decision-point resolver and the store mutations rather than Git.
*/
const contentState = vi.hoisted(() => ({
  descriptor: { kind: "singular", diff: { state: "fingerprint", fingerprint: "a".repeat(40) } } as unknown,
}));
vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return {
    ...actual,
    /* The resolver exposes content capture as an injectable seam; supply the evidence shape directly. */
    resolveHumanMergeDecisionPoint: (task: never, deps: never) => actual.resolveHumanMergeDecisionPoint(task, {
      ...(deps as object),
      captureContent: async () => contentState.descriptor,
    } as never),
  };
});

const { createApiRoutes } = await import("../routes.js");
const { request: performRequest } = await import("../test-request.js");

const TASK_ID = "FN-514";
const EPISODE = "2026-09-17T10:00:00.000Z";

const IR = {
  version: "v2",
  name: "human-merge-approval",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "in-review", name: "Review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
    { id: "done", name: "Complete", traits: [{ trait: "terminal" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "planning" },
    { id: "execute", kind: "execute", column: "building" },
    { id: "merge-gate", kind: "merge-gate", column: "in-review", config: { gate: "auto-merge" } },
    { id: "merge-attempt", kind: "merge-attempt", column: "in-review", config: { capability: "task-merge" } },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [
    { from: "start", to: "execute" },
    { from: "execute", to: "merge-gate" },
    { from: "merge-gate", to: "merge-attempt", condition: "outcome:auto-on" },
    { from: "merge-attempt", to: "end", condition: "success" },
  ],
} as never;

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Verrou de livraison",
    description: "Valider la livraison avec un verrou par tâche",
    column: "in-review",
    branch: "fusion/FN-514",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn514-worktree",
    humanMergeApproval: { enabled: true, generation: 1 },
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [
      { workflowStepId: "code-review", workflowStepName: "Code Review", status: "passed", verdict: "APPROVE", reviewKind: "code", reviewInputFingerprint: "a".repeat(40), completedAt: EPISODE },
    ],
    createdAt: "2026-09-17T09:00:00.000Z",
    updatedAt: "2026-09-17T09:30:00.000Z",
    ...overrides,
  } as Task;
}

/*
The mutation fake mirrors the production contract this feature depends on: read the LIVE row, apply
the field-bounded patch, and bump `updatedAt`. A no-op fake would make every optimistic-revision and
idempotence assertion vacuous.
*/
function createStore(row: Task, rootDir: string): TaskStore {
  const realMutations = {
    setHumanMergeApprovalLock: vi.fn(),
    recordHumanMergeDecision: vi.fn(),
  };
  const store = {
    getRootDir: vi.fn(() => rootDir),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    /* Honour the id: a request for an unknown task must reach the route's 404, not this fixture. */
    getTask: vi.fn(async (id: string) => (id === row.id ? structuredClone(row) : null)),
    listTasks: vi.fn(async () => [structuredClone(row)]),
    searchTasks: vi.fn().mockResolvedValue([]),
    findRecentTasksBySourceParentTaskId: vi.fn().mockResolvedValue([]),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-hma" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-hma", name: "HMA", ir: IR }),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(row, patch);
      return structuredClone(row);
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore & typeof realMutations;

  store.setHumanMergeApprovalLock = vi.fn(async (_id: string, input) => {
    if (input.expectedRevision !== undefined && input.expectedRevision !== row.updatedAt) {
      return { applied: false as const, reason: "revision-mismatch" as const };
    }
    if (row.status === "merging" || row.mergeDetails?.mergeConfirmed) {
      return { applied: false as const, reason: "merge-taken" as const };
    }
    if ((row.humanMergeApproval?.enabled === true) === input.enabled) {
      return { applied: true as const, task: structuredClone(row), replayed: true };
    }
    const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
    row.humanMergeApproval = actual.toggleHumanMergeApprovalState(row.humanMergeApproval, input.enabled) ?? undefined;
    row.updatedAt = new Date(Date.parse(row.updatedAt) + 1000).toISOString();
    return { applied: true as const, task: structuredClone(row), replayed: false };
  }) as never;

  store.recordHumanMergeDecision = vi.fn(async (_id: string, input) => {
    const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
    if (input.expectedRevision !== undefined && input.expectedRevision !== row.updatedAt) {
      return { applied: false as const, reason: "revision-mismatch" as const };
    }
    /* The production mutation performs the take test inside its own transaction; model it here. */
    const taken = actual.describeHumanMergeTaken(row as never, {});
    if (taken) return { applied: false as const, reason: taken };
    const state = row.humanMergeApproval;
    if (state?.enabled !== true) return { applied: false as const, reason: "not-armed" as const };
    if (actual.encodeHumanMergeCandidateToken(input.candidate) !== input.candidateToken) {
      return { applied: false as const, reason: "candidate-superseded" as const };
    }
    const prior = state.decision ?? state.rejection;
    if (prior?.requestId === input.requestId) {
      const priorAction = state.decision?.requestId === input.requestId ? state.decision.action : "reject";
      if (priorAction !== input.action) return { applied: false as const, reason: "request-conflict" as const };
      return { applied: true as const, task: structuredClone(row), replayed: true };
    }
    const now = new Date().toISOString();
    row.humanMergeApproval = input.action === "reject"
      ? {
        enabled: true, generation: state.generation, remediationGeneration: 1,
        rejection: { requestId: input.requestId, instruction: input.message ?? "", rejectedBy: input.actor, rejectedAt: now, candidate: input.candidate, remediationGeneration: 1, state: "pending" },
      }
      : {
        enabled: true, generation: state.generation,
        decision: { requestId: input.requestId, action: input.action, deliveryAction: input.action, ...(input.message ? { message: input.message } : {}), decidedBy: input.actor, decidedAt: now, candidate: input.candidate, receipt: { state: "pending", at: now } },
      };
    row.updatedAt = new Date(Date.parse(row.updatedAt) + 1000).toISOString();
    return { applied: true as const, task: structuredClone(row), replayed: false };
  }) as never;

  return store;
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

const roots: string[] = [];
beforeEach(() => {
  ghAuthenticated.value = true;
  contentState.descriptor = { kind: "singular", diff: { state: "fingerprint", fingerprint: "a".repeat(40) } };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(overrides: Partial<Task> = {}, options: { withRemote?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fusion-fn514-route-"));
  roots.push(root);
  const taskDir = join(root, ".fusion", "tasks", TASK_ID);
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "PROMPT.md"), "# Plan\n");
  /*
  Create-PR capability is resolved from a REAL remote. A repository with no remote is a legitimate
  production shape (local-only project), so both shapes are exercised rather than stubbed.
  */
  if (options.withRemote !== false) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://example.test/owner/repo.git"], { cwd: root });
  }
  const row = taskFixture(overrides);
  const store = createStore(row, root);
  return { root, row, store, app: createApp(store) };
}

function post(app: express.Express, path: string, body: unknown) {
  return performRequest(app, "POST", path, JSON.stringify(body ?? {}), { "Content-Type": "application/json" });
}
function put(app: express.Express, path: string, body: unknown) {
  return performRequest(app, "PUT", path, JSON.stringify(body ?? {}), { "Content-Type": "application/json" });
}
function get(app: express.Express, path: string) {
  return performRequest(app, "GET", path);
}

const DECISION_PATH = `/api/tasks/${TASK_ID}/merge-approval/decision`;
const LOCK_PATH = `/api/tasks/${TASK_ID}/merge-approval`;

async function candidateTokenFor(app: express.Express): Promise<string> {
  const response = await get(app, LOCK_PATH);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const token = (response.body as { candidateToken?: string }).candidateToken;
  expect(token, JSON.stringify(response.body)).toBeTruthy();
  return token!;
}

describe("GET /tasks/:id/merge-approval — availability and capabilities", () => {
  it("presents a candidate with all three actions when the work is finished", async () => {
    const { app } = await setup();
    const response = await get(app, LOCK_PATH);

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.available).toBe(true);
    expect(body.candidateToken).toBeTruthy();
    const capabilities = body.capabilities as { action: string; enabled: boolean }[];
    expect(capabilities.map((entry) => entry.action)).toEqual(["create-pr", "merge", "reject"]);
    expect(capabilities.every((entry) => entry.enabled)).toBe(true);
  });

  it("is a pure read: it records no decision and pre-selects no destination", async () => {
    const { row, app } = await setup();
    await get(app, LOCK_PATH);
    await get(app, LOCK_PATH);
    expect(row.humanMergeApproval).toEqual({ enabled: true, generation: 1 });
    const body = (await get(app, LOCK_PATH)).body as Record<string, unknown>;
    expect(body).not.toHaveProperty("selectedAction");
    expect(body).not.toHaveProperty("deliveryAction");
  });

  it("withholds the decision while the work is not finished, naming the real blocker", async () => {
    const { app } = await setup({ steps: [{ name: "Step 1", status: "pending" }] as never });
    const body = (await get(app, LOCK_PATH)).body as Record<string, unknown>;
    expect(body.available).toBe(false);
    expect(body.unavailableReason).toBe("blocked");
    expect(String(body.blocker)).toContain("incomplete steps");
  });

  it("fails closed when the merge content cannot be read", async () => {
    contentState.descriptor = { kind: "singular", diff: { state: "unavailable", reason: "git failed" } };
    const { app } = await setup();
    const body = (await get(app, LOCK_PATH)).body as Record<string, unknown>;
    expect(body.available).toBe(false);
    expect(body.unavailableReason).toBe("content-unavailable");
    expect(body.candidateToken).toBeUndefined();
  });

  it("treats a proven-empty diff as a usable candidate, not as missing evidence", async () => {
    contentState.descriptor = { kind: "singular", diff: { state: "empty" } };
    const { app } = await setup();
    const body = (await get(app, LOCK_PATH)).body as Record<string, unknown>;
    expect(body.available).toBe(true);
    expect(body.candidateToken).toBeTruthy();
  });

  it("disables Create PR without GitHub auth while Reject and Merge stay available", async () => {
    ghAuthenticated.value = false;
    const { app } = await setup();
    const capabilities = ((await get(app, LOCK_PATH)).body as { capabilities: { action: string; enabled: boolean; reason?: string }[] }).capabilities;
    expect(capabilities.find((entry) => entry.action === "create-pr")).toMatchObject({ enabled: false, reason: "github-auth-unavailable" });
    expect(capabilities.find((entry) => entry.action === "reject")?.enabled).toBe(true);
    expect(capabilities.find((entry) => entry.action === "merge")?.enabled).toBe(true);
  });

  it("disables Create PR with `no-remote` on a repository with no remote, keeping the other two", async () => {
    const { app } = await setup({}, { withRemote: false });
    const capabilities = ((await get(app, LOCK_PATH)).body as { capabilities: { action: string; enabled: boolean; reason?: string }[] }).capabilities;
    expect(capabilities.find((entry) => entry.action === "create-pr")).toMatchObject({ enabled: false, reason: "no-remote" });
    expect(capabilities.find((entry) => entry.action === "merge")?.enabled).toBe(true);
    expect(capabilities.find((entry) => entry.action === "reject")?.enabled).toBe(true);
  });

  it("reports nothing for a card that carries no lock", async () => {
    const { app } = await setup({ humanMergeApproval: undefined });
    const body = (await get(app, LOCK_PATH)).body as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.available).toBe(false);
    expect(body.unavailableReason).toBe("not-armed");
  });

  it("returns 404 for a task this project cannot see", async () => {
    const { app } = await setup();
    expect((await get(app, "/api/tasks/FN-999/merge-approval")).status).toBe(404);
  });
});

describe("PUT /tasks/:id/merge-approval — arming and disarming", () => {
  it("arms and disarms, and replays an identical request without a second change", async () => {
    const { row, app } = await setup({ humanMergeApproval: undefined });

    expect((await put(app, LOCK_PATH, { enabled: true, requestId: "r1" })).status).toBe(200);
    expect(row.humanMergeApproval?.enabled).toBe(true);

    const replay = await put(app, LOCK_PATH, { enabled: true, requestId: "r1" });
    expect(replay.status).toBe(200);
    expect((replay.body as { replayed: boolean }).replayed).toBe(true);

    expect((await put(app, LOCK_PATH, { enabled: false, requestId: "r2" })).status).toBe(200);
    expect(row.humanMergeApproval?.enabled ?? false).toBe(false);
  });

  it("refuses a non-boolean enabled and a stale revision", async () => {
    const { app } = await setup();
    expect((await put(app, LOCK_PATH, { enabled: "yes" })).status).toBe(400);
    expect((await put(app, LOCK_PATH, { enabled: false, expectedRevision: "1999-01-01T00:00:00.000Z" })).status).toBe(409);
  });

  it("refuses once a merge owner has taken the card", async () => {
    const { row, app } = await setup();
    row.status = "merging";
    const response = await put(app, LOCK_PATH, { enabled: false });
    expect(response.status).toBe(409);
    expect(row.humanMergeApproval?.enabled).toBe(true);
  });
});

describe("POST /tasks/:id/merge-approval/decision — the three direct commands", () => {
  it("records a merge command with an optional note", async () => {
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);

    const response = await post(app, DECISION_PATH, { action: "merge", message: "  Livre-le ✅  ", requestId: "d1", candidateToken });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row.humanMergeApproval?.decision).toMatchObject({
      action: "merge",
      deliveryAction: "merge",
      message: "Livre-le ✅",
      decidedBy: "dashboard-operator",
    });
    expect(row.humanMergeApproval?.rejection).toBeUndefined();
  });

  it("records a create-pr command that is NOT a merge authorization", async () => {
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);

    expect((await post(app, DECISION_PATH, { action: "create-pr", requestId: "d2", candidateToken })).status).toBe(200);
    expect(row.humanMergeApproval?.decision?.deliveryAction).toBe("create-pr");

    const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
    expect(actual.hasCurrentHumanMergeApproval(row)).toBe(false);
    expect(actual.getHumanMergeApprovalBlocker(row)).toBe(actual.HUMAN_MERGE_APPROVAL_BLOCKER);
  });

  it("accepts a positive command with no note at all", async () => {
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);
    expect((await post(app, DECISION_PATH, { action: "merge", requestId: "d3", candidateToken })).status).toBe(200);
    expect(row.humanMergeApproval?.decision?.message).toBeUndefined();
  });

  it("requires a non-empty instruction for a rejection", async () => {
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);

    for (const message of [undefined, "", "   ", 42]) {
      const response = await post(app, DECISION_PATH, { action: "reject", message, requestId: "d4", candidateToken });
      expect(response.status, `message=${String(message)}`).toBe(400);
    }
    expect(row.humanMergeApproval?.rejection).toBeUndefined();

    const accepted = await post(app, DECISION_PATH, { action: "reject", message: "  La navigation est fausse  ", requestId: "d4", candidateToken });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(row.humanMergeApproval?.rejection).toMatchObject({ instruction: "La navigation est fausse", state: "pending" });
    expect(row.humanMergeApproval?.decision).toBeUndefined();
  });

  it("refuses an over-long message on both families", async () => {
    const { app } = await setup();
    const candidateToken = await candidateTokenFor(app);
    const tooLong = "x".repeat(HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH + 1);
    expect((await post(app, DECISION_PATH, { action: "merge", message: tooLong, candidateToken })).status).toBe(400);
    expect((await post(app, DECISION_PATH, { action: "reject", message: tooLong, candidateToken })).status).toBe(400);
  });

  it("refuses an unknown action and a generic approval object", async () => {
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);
    for (const action of ["approve", "APPROVE", "", undefined]) {
      expect((await post(app, DECISION_PATH, { action, candidateToken })).status, String(action)).toBe(400);
    }
    expect(row.humanMergeApproval?.decision).toBeUndefined();
  });

  it("refuses client-supplied authority fields outright", async () => {
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);
    for (const forged of [
      { decidedBy: "someone-else" },
      { deliveryAction: "merge" },
      { candidate: { lockGeneration: 1 } },
      { approval: { enabled: true } },
      { target: { base: "production" } },
    ]) {
      const response = await post(app, DECISION_PATH, { action: "create-pr", candidateToken, ...forged });
      expect(response.status, JSON.stringify(forged)).toBe(400);
    }
    expect(row.humanMergeApproval?.decision).toBeUndefined();
  });

  it("refuses a stale candidate token and a stale revision", async () => {
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);
    expect((await post(app, DECISION_PATH, { action: "merge", candidateToken: "stale~token" })).status).toBe(409);
    expect((await post(app, DECISION_PATH, { action: "merge", candidateToken, expectedRevision: "1999-01-01T00:00:00.000Z" })).status).toBe(409);
    expect(row.humanMergeApproval?.decision).toBeUndefined();
  });

  it("is idempotent on an identical replay and a conflict on a different action", async () => {
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);

    expect((await post(app, DECISION_PATH, { action: "merge", requestId: "same", candidateToken })).status).toBe(200);
    const decidedAt = row.humanMergeApproval!.decision!.decidedAt;

    const replay = await post(app, DECISION_PATH, { action: "merge", requestId: "same", candidateToken });
    expect(replay.status).toBe(200);
    expect((replay.body as { replayed: boolean }).replayed).toBe(true);
    expect(row.humanMergeApproval!.decision!.decidedAt).toBe(decidedAt);

    const conflicting = await post(app, DECISION_PATH, { action: "reject", message: "non", requestId: "same", candidateToken });
    expect(conflicting.status).toBe(409);
    expect(row.humanMergeApproval!.decision!.deliveryAction).toBe("merge");
    expect(row.humanMergeApproval!.rejection).toBeUndefined();
  });

  it("refuses an action the server cannot carry out even when the client requests it", async () => {
    ghAuthenticated.value = false;
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);

    const response = await post(app, DECISION_PATH, { action: "create-pr", candidateToken });
    expect(response.status).toBe(409);
    expect(row.humanMergeApproval?.decision).toBeUndefined();

    // Reject does not depend on GitHub and must still be accepted.
    expect((await post(app, DECISION_PATH, { action: "reject", message: "refais la nav", candidateToken })).status).toBe(200);
  });

  it("refuses every command once a merge owner has taken the card", async () => {
    const { row, app } = await setup();
    const candidateToken = await candidateTokenFor(app);
    row.mergeDetails = { mergeConfirmed: true, commitSha: "deadbeef" } as never;

    for (const action of ["merge", "create-pr", "reject"]) {
      const response = await post(app, DECISION_PATH, { action, message: "x", candidateToken });
      expect(response.status, action).toBe(409);
    }
    expect(row.humanMergeApproval?.decision).toBeUndefined();
  });

  it("refuses any command on a card that carries no lock", async () => {
    const { app } = await setup({ humanMergeApproval: undefined });
    const response = await post(app, DECISION_PATH, { action: "merge", candidateToken: "anything" });
    expect(response.status).toBe(409);
  });

  it("returns 404 for a task this project cannot see", async () => {
    const { app } = await setup();
    expect((await post(app, "/api/tasks/FN-999/merge-approval/decision", { action: "merge", candidateToken: "x" })).status).toBe(404);
  });
});
