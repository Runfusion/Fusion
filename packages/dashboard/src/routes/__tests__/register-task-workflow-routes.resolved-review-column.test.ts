// @vitest-environment node
/*
FNXC:WorkflowLifecycleColumns 2026-08-01-15:00 (fleet: register-task-workflow-routes.ts review lane):

THE INVARIANT: the task routes decide "is this card in review?" from the task's OWN workflow.

Ten route guards spelled it as `in-review`. Two of them are operator-visible in a way that is worse
than an inert guard, because the wrong answer is REPORTED as a fact about the operator's own board:

  - the user-comment re-engagement returns `suppressedReason: "not-in-review"` for a review card on a
    renamed board, so a comment on a card plainly sitting in review is dropped and the API says the
    card is not in review;
  - the branch-binding recovery and PR-feedback routes reject with 400 messages naming `in-review` —
    a column the operator's board does not have. Both messages now name the resolved columns.

WHICH ROUTE THIS DRIVES, and why the assertions are on the MESSAGE rather than the status: the
branch-binding route's success path continues into the self-healing manager, which a partial store mock
cannot provide, so a passing card also ends in a 400 ("Self-healing manager unavailable"). Asserting
`status !== 400` would therefore be asserting nothing. The discriminator is WHICH 400 comes back — the
column refusal or the manager one — which is exactly the guard under test. My first version drove
`/address-pr-feedback`, a path that does not exist (it is `/pr/address-feedback`), and all five cases
hung for 15s each on the unmatched route: a test that never reached the code it named.

THE ROUTE IS THE SURFACE, not the resolver. A unit test on `resolveReviewColumnForTask` would pass with
every call site still comparing against the literal, which is precisely the gap this file exists to
close.

REVERT PROOF, measured below. The default-board cases pass either way by design — `builtin:coding`'s
review column IS `in-review` — and they are here to prove the conversion did not change the shipped
board's behaviour, not as evidence for it.
*/
import { describe, it, expect, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import express from "express";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

/** Default lifecycle SHAPE, renamed ids — `signoff` carries the merge-orchestration traits. */
const RENAMED_IR = {
  version: "v2",
  id: "wf-renamed",
  name: "Renamed Flow",
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "staging", name: "Staging", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "backlog" }],
  edges: [],
};

function buildStore(options: { taskColumn: string; workflowId?: string }) {
  const task = {
    id: "FN-001",
    column: options.taskColumn,
    dependencies: [],
    steps: [],
    currentStep: 0,
    prInfo: { number: 7, url: "https://example.invalid/pr/7", state: "open" },
  };
  const recoverBranchBinding = vi.fn(async () => ({ recovered: true, branch: "fusion/FN-001" }));

  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({})),
    listTasks: vi.fn(async () => [task]),
    getTaskWorkflowSelection: vi.fn(() => (options.workflowId ? { workflowId: options.workflowId } : undefined)),
    getTaskWorkflowSelectionAsync: vi.fn(async () => (options.workflowId ? { workflowId: options.workflowId } : undefined)),
    getWorkflowDefinition: vi.fn(async (id: string) =>
      id === "wf-renamed" ? { id, name: "Renamed Flow", kind: "workflow", ir: RENAMED_IR } : null,
    ),
    updateTask: vi.fn(async () => task),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    recoverBranchBinding,
  } as unknown as TaskStore;

  return { store, recoverBranchBinding };
}

async function post(store: TaskStore, path: string, body: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return REQUEST(app, "POST", `/api/tasks/FN-001${path}`, JSON.stringify(body), {
    "content-type": "application/json",
  });
}

describe("the task routes resolve the board's own review column", () => {
  const COLUMN_REFUSAL = "to recover branch binding";

  async function refusal(store: TaskStore): Promise<string> {
    const res = await post(store, "/recover-branch-binding");
    const payload = res.body as { error?: string } | undefined;
    return payload?.error ?? JSON.stringify(res.body ?? {});
  }

  it("does not refuse a RENAMED board's review card as being in the wrong column", async () => {
    // Pre-fix: `signoff` !== "in-review", so the route rejected with a message naming a column this
    // board does not have. The card was in review the whole time.
    const { store } = buildStore({ taskColumn: "signoff", workflowId: "wf-renamed" });

    expect(await refusal(store)).not.toContain(COLUMN_REFUSAL);
  });

  it("still refuses a card outside the review lane, naming the board's OWN column", async () => {
    // The paired negative, plus the message fix: an operator must be told `signoff`, not `in-review`.
    const { store } = buildStore({ taskColumn: "building", workflowId: "wf-renamed" });

    const message = await refusal(store);
    expect(message).toContain(COLUMN_REFUSAL);
    expect(message).toContain("signoff");
    expect(message).not.toContain("in-review");
  });

  it("behaves identically on the DEFAULT board, where the literal was already correct", async () => {
    // No workflow selection: the resolver falls back to `in-review`. Passes either way by design.
    const { store } = buildStore({ taskColumn: "in-review" });

    expect(await refusal(store)).not.toContain(COLUMN_REFUSAL);
  });

  it("still refuses an intake-lane card on the DEFAULT board", async () => {
    const { store } = buildStore({ taskColumn: "todo" });

    expect(await refusal(store)).toContain(COLUMN_REFUSAL);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-01-21:40 (PR #2701 review — greptile P1):

THE INVARIANT: an open PR blocks the in-review user-comment re-engagement on ANY board.

THE THIRD FORM OF THIS PROGRAM'S DEFECT, and the most interesting one. The guard was deliberately left
on the legacy `COLUMNS.indexOf` enum, with a comment justifying it: "this whole function is gated on the
literal `task.column !== "in-review"` above and re-engages to the literal `"in-progress"`, so both
endpoints are legacy ids by construction". That was TRUE when written.

Then U5 converted the re-engage target to `resolveWipColumnForTask`, and this PR converted the entry gate
to the resolved review lane. Both halves of the premise are now false, so on a renamed board the enum
scores -1 for both endpoints — and `isBackwardMoveBlockedByOpenPr` treats a negative index as "cannot
tell -> allow". A user comment on a review card with an OPEN PR resumed execution behind that PR.

Nobody edited the guard or the comment. The comment's correctness argument depended on literals
elsewhere, and someone else converted them. When you convert a lane, grep for comments justifying a
nearby legacy path by "the surrounding literals" — they are load-bearing.

REVERT PROOF, measured: restore `COLUMNS.indexOf` and the renamed-board case fails — the task is moved
to the wip lane despite the open PR.
*/
describe("the re-engage open-PR guard survives a renamed board", () => {
  function buildReengageStore(column: string, workflowId: string | undefined, prState: string | null) {
    const task = {
      id: "FN-002", column, dependencies: [], steps: [], currentStep: 0, sessionFile: null,
    };
    const moveTask = vi.fn(async (_id: string, to: string) => ({ ...task, column: to }));
    const logEntry = vi.fn(async () => undefined);

    const store = {
      getRootDir: vi.fn(() => process.cwd()),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(() => (workflowId ? { workflowId } : undefined)),
      getTaskWorkflowSelectionAsync: vi.fn(async () => (workflowId ? { workflowId } : undefined)),
      getWorkflowDefinition: vi.fn(async (id: string) =>
        id === "wf-renamed" ? { id, name: "Renamed Flow", kind: "workflow", ir: RENAMED_IR } : null,
      ),
      getActivePrEntityBySource: vi.fn(async () =>
        prState ? { id: "PR-1", state: prState, sourceType: "task", sourceId: "FN-002" } : null,
      ),
      /* The route calls `addTaskComment` and re-engages the TASK IT RETURNS, so the mock must return the
         task row — returning a bare comment made the whole block vacuous: the route threw before reaching
         the guard, `moveTask` was never called, and both negative cases "passed" for the wrong reason.
         Caught it because the paired POSITIVE case failed; without that case this suite would have looked
         green and proven nothing. */
      addTaskComment: vi.fn(async () => ({ ...task, comments: [{ id: "c1", text: "please fix", author: "user" }] })),
      updateTask: vi.fn(async () => task),
      updateStep: vi.fn(async () => undefined),
      logEntry,
      moveTask,
      recordRunAuditEvent: vi.fn(async () => undefined),
    } as unknown as TaskStore;

    return { store, moveTask, logEntry };
  }

  async function comment(store: TaskStore) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return REQUEST(app, "POST", "/api/tasks/FN-002/comments", JSON.stringify({ text: "please fix", author: "user" }), {
      "content-type": "application/json",
    });
  }

  it("does NOT re-engage a renamed board's review card while a PR is open", async () => {
    // Pre-fix: both endpoints scored -1 on the legacy enum, a negative index means "allow", and the card
    // was moved into the wip lane behind an open PR.
    const { store, moveTask } = buildReengageStore("signoff", "wf-renamed", "open");

    await comment(store);

    expect(moveTask).not.toHaveBeenCalled();
  });

  it("DOES re-engage a renamed board's review card once no PR is active", async () => {
    // The paired positive: the guard must not block re-engagement outright.
    const { store, moveTask } = buildReengageStore("signoff", "wf-renamed", null);

    await comment(store);

    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(moveTask.mock.calls[0]?.[1]).toBe("building");
  });

  it("still blocks on the DEFAULT board with an open PR", async () => {
    // The case the legacy enum already handled; it must keep working.
    const { store, moveTask } = buildReengageStore("in-review", undefined, "open");

    await comment(store);

    expect(moveTask).not.toHaveBeenCalled();
  });
});
