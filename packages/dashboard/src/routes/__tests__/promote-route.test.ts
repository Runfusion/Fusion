// @vitest-environment node
//
// FN-1404: route-level integration coverage for POST /tasks/:id/promote.
//
// The promote endpoint has four error branches plus a success path, none of
// which were exercised at the HTTP layer:
//   - flag OFF                       → 400 (workflow columns not enabled)
//   - promoteHeldTask success        → 200 (returns the promoted task)
//   - capacity-exhausted-or-no-slot  → 409 code:"capacity-exhausted"
//   - other engine rejection         → 409 code:"guard-rejected"
//   - TransitionRejectionError       → 409 carrying the rejection's code/messageKey
//
// promoteHeldTask is engine-internal cross-package logic; we mock it so the
// route's branch-to-HTTP mapping is what's under test (the documented incident
// class is route tests not matching real engine shapes — so we assert the
// real { released, rejection } shape promoteHeldTask returns).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { request as REQUEST } from "../../test-request.js";

// Mock only promoteHeldTask out of @fusion/engine; everything else
// (planTaskWorktreePath, the engine surface createApiRoutes pulls in) stays real.
const promoteHeldTask = vi.fn();
vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return { ...actual, promoteHeldTask: (...args: unknown[]) => promoteHeldTask(...args) };
});

// Import after the mock is registered.
const { createApiRoutes } = await import("../../routes.js");
const { TransitionRejectionError } = await import("@fusion/core");

const HELD_TASK = { id: "FN-001", column: "todo", dependencies: [], steps: [], currentStep: 0 };
const PROMOTED_TASK = { ...HELD_TASK, column: "in-progress" };

function buildApp(opts: { flagEnabled: boolean }) {
  const getTask = vi.fn(async () => (promoteHeldTask.mock.calls.length > 0 ? PROMOTED_TASK : HELD_TASK));
  const store: TaskStore = {
    getRootDir: vi.fn(() => process.cwd()),
    getSettingsFast: vi.fn(async () => ({
      experimentalFeatures: { workflowColumns: opts.flagEnabled },
      worktreeNaming: {},
    })),
    getTask,
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, store };
}

const promote = (app: express.Express) =>
  REQUEST(app, "POST", "/api/tasks/FN-001/promote", JSON.stringify({}), { "content-type": "application/json" });

describe("POST /tasks/:id/promote", () => {
  beforeEach(() => {
    promoteHeldTask.mockReset();
  });

  it("flag OFF → 400 and never calls the engine", async () => {
    const { app } = buildApp({ flagEnabled: false });
    const res = await promote(app);
    expect(res.status).toBe(400);
    expect(promoteHeldTask).not.toHaveBeenCalled();
  });

  it("success → 200 and returns the promoted task", async () => {
    const { app } = buildApp({ flagEnabled: true });
    promoteHeldTask.mockResolvedValue({ released: true, toColumn: "in-progress" });
    const res = await promote(app);
    expect(res.status).toBe(200);
    expect(promoteHeldTask).toHaveBeenCalledTimes(1);
    expect((res.body as { column: string }).column).toBe("in-progress");
  });

  it("capacity-exhausted-or-no-slot → 409 with code capacity-exhausted (retryable)", async () => {
    const { app } = buildApp({ flagEnabled: true });
    promoteHeldTask.mockResolvedValue({ released: false, rejection: "capacity-exhausted-or-no-slot" });
    const res = await promote(app);
    expect(res.status).toBe(409);
    const details = (res.body as { details?: { code?: string; retryable?: boolean } }).details;
    expect(details?.code).toBe("capacity-exhausted");
    expect(details?.retryable).toBe(true);
  });

  it("any other engine rejection → 409 with code guard-rejected (not retryable)", async () => {
    const { app } = buildApp({ flagEnabled: true });
    promoteHeldTask.mockResolvedValue({ released: false, rejection: "not-held" });
    const res = await promote(app);
    expect(res.status).toBe(409);
    const details = (res.body as { details?: { code?: string; retryable?: boolean } }).details;
    expect(details?.code).toBe("guard-rejected");
    expect(details?.retryable).toBe(false);
  });

  it("TransitionRejectionError → 409 carrying the rejection's code + messageKey", async () => {
    const { app } = buildApp({ flagEnabled: true });
    promoteHeldTask.mockRejectedValue(
      new TransitionRejectionError(
        { code: "capacity-exhausted", messageKey: "board.rejection.capacityExhausted", retryable: true },
        "Downstream column is at capacity",
      ),
    );
    const res = await promote(app);
    expect(res.status).toBe(409);
    const details = (res.body as { details?: { code?: string; messageKey?: string } }).details;
    expect(details?.code).toBe("capacity-exhausted");
    expect(details?.messageKey).toBe("board.rejection.capacityExhausted");
  });
});
