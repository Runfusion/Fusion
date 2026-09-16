// @vitest-environment node

/*
FNXC:ReviewLaneBypassTargets 2026-09-03-00:00:
GET /tasks/:id/bypass-review-target is the read-only affordance probe behind the dashboard's
review-lane bypass button. Contract:
1. It returns EXACTLY the store's resolution (the same resolution
   `bypassFailedPreMergeReviewStep` performs) so menu visibility cannot drift from acceptance.
2. It never errors: a missing/older store method, a thrown resolution failure, or a project
   context problem all answer `{ target: null }` — hiding a privileged affordance is the safe
   direction; surfacing an error on every board card render is not.
In-memory store fakes only (no DB, no network, no timers) per the AGENTS.md slow-test rule.
*/

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

type Target = { kind: "failed" | "absent"; workflowStepId: string; workflowStepName: string };

function makeHarness(resolver: "absent" | "failed" | "none" | "throw" | "missing") {
  const getTarget = vi.fn(async (): Promise<Target | null> => {
    if (resolver === "throw") throw new Error("ir resolution exploded");
    if (resolver === "none") return null;
    if (resolver === "failed") return { kind: "failed", workflowStepId: "code-review", workflowStepName: "Code Review" };
    return { kind: "absent", workflowStepId: "plan-review", workflowStepName: "plan-review" };
  });
  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    ...(resolver === "missing" ? {} : { getPreMergeReviewBypassTarget: getTarget }),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, getTarget };
}

describe("GET /tasks/:id/bypass-review-target", () => {
  it("returns the store-resolved absent-gate target verbatim", async () => {
    const { app, getTarget } = makeHarness("absent");
    const res = await REQUEST(app, "GET", "/api/tasks/SANE-387/bypass-review-target");
    expect(res.status).toBe(200);
    expect(res.body.target).toEqual({ kind: "absent", workflowStepId: "plan-review", workflowStepName: "plan-review" });
    expect(getTarget).toHaveBeenCalledWith("SANE-387");
  });

  it("returns the failed-result target", async () => {
    const { app } = makeHarness("failed");
    const res = await REQUEST(app, "GET", "/api/tasks/FN-1/bypass-review-target");
    expect(res.status).toBe(200);
    expect(res.body.target).toEqual({ kind: "failed", workflowStepId: "code-review", workflowStepName: "Code Review" });
  });

  it("answers { target: null } when the store offers no bypass", async () => {
    const { app } = makeHarness("none");
    const res = await REQUEST(app, "GET", "/api/tasks/FN-1/bypass-review-target");
    expect(res.status).toBe(200);
    expect(res.body.target).toBeNull();
  });

  it("degrades to { target: null } when resolution throws", async () => {
    const { app } = makeHarness("throw");
    const res = await REQUEST(app, "GET", "/api/tasks/FN-1/bypass-review-target");
    expect(res.status).toBe(200);
    expect(res.body.target).toBeNull();
  });

  it("degrades to { target: null } for a store without the resolver", async () => {
    const { app } = makeHarness("missing");
    const res = await REQUEST(app, "GET", "/api/tasks/FN-1/bypass-review-target");
    expect(res.status).toBe(200);
    expect(res.body.target).toBeNull();
  });
});
