// @vitest-environment node

/*
FNXC:PullRequests 2026-06-16-09:44:
U18 auto-resolve-review-comments coverage (PR #1683): extends the PR thread-summary assertions to the fixed/acted thread states the auto-resolution loop produces, so the backward-move-blocked-by-open-PR guard and thread summaries stay correct.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { PrEntity, PrThreadState, Task, TaskStore } from "@fusion/core";
import {
  createPullRequestsRouter,
  isBackwardMoveBlockedByOpenPr,
  PR_OPEN_BLOCKS_MOVE_BACK_MESSAGE,
} from "../routes/register-pull-requests-routes.js";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { request as REQUEST } from "../test-request.js";

function attachErrorHandler(app: express.Express) {
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) {
      sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
      return;
    }
    sendErrorResponse(res, 500, err instanceof Error ? err.message : "Internal server error");
  });
}

function buildEntity(overrides: Partial<PrEntity> = {}): PrEntity {
  return {
    id: "PR-1",
    sourceType: "task",
    sourceId: "FN-1",
    repo: "owner/repo",
    headBranch: "feature/x",
    state: "open",
    prNumber: 42,
    prUrl: "https://example/pr/42",
    mergeable: "clean",
    checksRollup: "success",
    reviewDecision: "APPROVED",
    autoMerge: false,
    unverified: false,
    responseRounds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createStore(entity: PrEntity, threads: PrThreadState[] = []) {
  let current = { ...entity };
  const store = {
    getPrEntity: vi.fn((id: string) => (id === current.id ? current : null)),
    listActivePrEntities: vi.fn(() => [current]),
    listPrThreadStates: vi.fn(() => threads),
    updatePrEntity: vi.fn((_id: string, patch: Partial<PrEntity>) => {
      current = { ...current, ...patch } as PrEntity;
      return current;
    }),
    getTask: vi.fn(async (id: string) => ({ id, column: "in-review" } as Task)),
  } as unknown as TaskStore;
  return { store, getCurrent: () => current, setCurrent: (e: PrEntity) => { current = e; } };
}

function mount(store: TaskStore, opts?: Parameters<typeof createPullRequestsRouter>[1]) {
  const app = express();
  app.use(express.json());
  app.use("/api/pull-requests", createPullRequestsRouter(store, opts));
  attachErrorHandler(app);
  return app;
}

describe("pull request routes", () => {
  let entity: PrEntity;
  let threads: PrThreadState[];

  beforeEach(() => {
    entity = buildEntity();
    threads = [
      { prEntityId: "PR-1", threadId: "T1", headOid: "abc", outcome: "pending", updatedAt: Date.now() },
      { prEntityId: "PR-1", threadId: "T2", headOid: "abc", outcome: "disagreed", updatedAt: Date.now() },
      { prEntityId: "PR-1", threadId: "T3", headOid: "abc", outcome: "fixed", updatedAt: Date.now() },
    ];
  });

  it("GET list returns entity with checks/threads/merge/conflict summary", async () => {
    const { store } = createStore(entity, threads);
    const app = mount(store);
    const res = await REQUEST(app, "GET", "/api/pull-requests");
    expect(res.status).toBe(200);
    expect(res.body.pullRequests).toHaveLength(1);
    const pr = res.body.pullRequests[0];
    expect(pr.threads).toHaveLength(3);
    expect(pr.summary.checksRollup).toBe("success");
    expect(pr.summary.mergeable).toBe("clean");
    expect(pr.summary.conflicting).toBe(false);
    expect(pr.summary.pendingThreads).toBe(1);
    expect(pr.summary.disagreedThreads).toBe(1);
    // U18 (R15): Review-response activity exposed for the Command Center.
    expect(pr.summary.fixedThreads).toBe(1);
    expect(pr.summary.actedThreads).toBe(2); // fixed + disagreed, excludes pending
  });

  it("GET list filters by repo and status", async () => {
    const { store } = createStore(entity, threads);
    const app = mount(store);
    let res = await REQUEST(app, "GET", "/api/pull-requests?repo=other/repo");
    expect(res.body.pullRequests).toHaveLength(0);
    res = await REQUEST(app, "GET", "/api/pull-requests?status=closed");
    expect(res.body.pullRequests).toHaveLength(0);
    res = await REQUEST(app, "GET", "/api/pull-requests?status=open");
    expect(res.body.pullRequests).toHaveLength(1);
  });

  it("GET :id reports conflicting summary and gate reason", async () => {
    const conflict = buildEntity({ mergeable: "conflicting", autoMerge: true });
    const { store } = createStore(conflict, threads);
    const app = mount(store);
    const res = await REQUEST(app, "GET", "/api/pull-requests/PR-1");
    expect(res.status).toBe(200);
    expect(res.body.pullRequest.summary.conflicting).toBe(true);
    expect(res.body.pullRequest.summary.autoMergeReason).toBe("Blocked: conflict");
  });

  it("GET :id returns 404 for unknown PR", async () => {
    const { store } = createStore(entity);
    const app = mount(store);
    const res = await REQUEST(app, "GET", "/api/pull-requests/PR-404");
    expect(res.status).toBe(404);
  });

  it("merge re-fetches authoritative state before acting (not a stale client copy)", async () => {
    const { store } = createStore(entity, threads);
    const mergePr = vi.fn(async () => ({ released: true }));
    const app = mount(store, { mergePr });
    // Client sends a stale body claiming an old/wrong state — the route must ignore it.
    const res = await REQUEST(
      app,
      "POST",
      "/api/pull-requests/PR-1/merge",
      JSON.stringify({ entity: { id: "PR-1", state: "creating", mergeable: "conflicting" } }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    // getPrEntity is the authoritative re-read; it must have been consulted.
    expect((store.getPrEntity as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("PR-1");
    // The capability received the AUTHORITATIVE entity (clean/open), not the stale client copy.
    expect(mergePr).toHaveBeenCalledTimes(1);
    const arg = mergePr.mock.calls[0][0] as { entity: PrEntity };
    expect(arg.entity.state).toBe("open");
    expect(arg.entity.mergeable).toBe("clean");
  });

  it("merge is rejected (409) when the authoritative entity is conflicting", async () => {
    const conflict = buildEntity({ mergeable: "conflicting" });
    const { store } = createStore(conflict, threads);
    const mergePr = vi.fn(async () => ({ released: true }));
    const app = mount(store, { mergePr });
    const res = await REQUEST(app, "POST", "/api/pull-requests/PR-1/merge", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(409);
    expect(mergePr).not.toHaveBeenCalled();
  });

  it("approve/retry/close route to the injected engine capabilities", async () => {
    const { store } = createStore(entity, threads);
    const approvePr = vi.fn(async () => ({ released: true, action: "approve" }));
    const retryPr = vi.fn(async () => ({ released: true, action: "retry" }));
    const closePr = vi.fn(async () => ({ released: true, action: "close" }));
    const app = mount(store, { approvePr, retryPr, closePr });

    for (const [path, spy] of [["approve", approvePr], ["retry", retryPr], ["close", closePr]] as const) {
      const res = await REQUEST(app, "POST", `/api/pull-requests/PR-1/${path}`, JSON.stringify({}), {
        "content-type": "application/json",
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.body.pullRequest.id).toBe("PR-1");
    }
  });

  it("retry-create only acts on failed entities and routes to retryCreate", async () => {
    const failed = buildEntity({ state: "failed", failureReason: "auth" });
    const { store } = createStore(failed);
    const retryCreate = vi.fn(async () => ({ released: true }));
    const app = mount(store, { retryCreate });
    const res = await REQUEST(app, "POST", "/api/pull-requests/PR-1/retry-create", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    expect(retryCreate).toHaveBeenCalledTimes(1);

    // open entity → retry-create rejected (wrong state)
    const { store: openStore } = createStore(buildEntity({ state: "open" }));
    const retryCreate2 = vi.fn();
    const openApp = mount(openStore, { retryCreate: retryCreate2 as unknown as () => Promise<Record<string, unknown>> });
    const res2 = await REQUEST(openApp, "POST", "/api/pull-requests/PR-1/retry-create", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(res2.status).toBe(409);
    expect(retryCreate2).not.toHaveBeenCalled();
  });

  it("action 400s when the capability is not wired", async () => {
    const { store } = createStore(entity);
    const app = mount(store, {}); // no approvePr
    const res = await REQUEST(app, "POST", "/api/pull-requests/PR-1/approve", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(400);
  });

  it("automerge toggle persists the flip and returns the gate reason", async () => {
    const { store, getCurrent } = createStore(buildEntity({ autoMerge: false }));
    const app = mount(store);
    const res = await REQUEST(app, "POST", "/api/pull-requests/PR-1/automerge", JSON.stringify({ enabled: true }), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    expect(getCurrent().autoMerge).toBe(true);
    expect(res.body.pullRequest.summary.autoMergeReason).toBe("Ready to merge");
  });
});

describe("column move-backward guard (R16)", () => {
  // COLUMNS order: triage(0) todo(1) in-progress(2) in-review(3) done(4).
  it("blocks in-review (3) → in-progress (2) while an open PR exists, with guidance", () => {
    expect(
      isBackwardMoveBlockedByOpenPr({
        fromIndex: 3,
        toIndex: 2,
        activePrEntity: buildEntity({ state: "open" }),
      }),
    ).toBe(true);
    expect(PR_OPEN_BLOCKS_MOVE_BACK_MESSAGE).toBe(
      "This task has an open PR. Merge or close the PR before moving it back.",
    );
  });

  it("allows the backward move once the PR is terminal (no active entity)", () => {
    expect(
      isBackwardMoveBlockedByOpenPr({ fromIndex: 3, toIndex: 2, activePrEntity: null }),
    ).toBe(false);
    // A terminal entity should also not block (defensive: store excludes these).
    expect(
      isBackwardMoveBlockedByOpenPr({
        fromIndex: 3,
        toIndex: 2,
        activePrEntity: buildEntity({ state: "closed" }),
      }),
    ).toBe(false);
  });

  it("never blocks a forward move even with an open PR", () => {
    expect(
      isBackwardMoveBlockedByOpenPr({
        fromIndex: 3,
        toIndex: 4,
        activePrEntity: buildEntity({ state: "open" }),
      }),
    ).toBe(false);
  });
});
