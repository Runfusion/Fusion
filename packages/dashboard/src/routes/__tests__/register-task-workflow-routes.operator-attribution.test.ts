// @vitest-environment node

/*
FNXC:ApprovalDecisionAuthority 2026-07-26-17:20:
Route-boundary invariants for the operator-only POST /tasks/:id/bypass-review mutation:

The recorded bypass actor is derived SERVER-SIDE.
   A client-supplied `actor` string used to become `bypassedBy` verbatim, so an agent
   could stamp an arbitrary identity onto a review-gate bypass. Now the attribution is
   always `dashboard-operator`, with a body-supplied name carried only as advisory
   display metadata: `dashboard-operator (as "<name>")`. `reason` stays mandatory.

In-memory store fakes only (no DB, no network, no timers) per the AGENTS.md slow-test rule.
*/

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

function makeHarness() {
  const bypassSpy = vi.fn(async (id: string, _input: { reason: string; actor: string }) => ({ id, column: "in-review" }));

  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    bypassFailedPreMergeReviewStep: bypassSpy,
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, bypassSpy };
}

describe("POST /tasks/:id/bypass-review — server-derived actor", () => {
  it("records dashboard-operator when the body carries no actor", async () => {
    const { app, bypassSpy } = makeHarness();
    const res = await REQUEST(app, "POST", "/api/tasks/FN-1/bypass-review", JSON.stringify({ reason: "stuck gate" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(bypassSpy).toHaveBeenCalledWith("FN-1", { reason: "stuck gate", actor: "dashboard-operator" });
  });

  it("keeps a body-supplied actor as advisory display metadata, never the attribution", async () => {
    const { app, bypassSpy } = makeHarness();
    const res = await REQUEST(app, "POST", "/api/tasks/FN-1/bypass-review", JSON.stringify({ reason: "stuck gate", actor: "EvilAgent" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(bypassSpy).toHaveBeenCalledWith("FN-1", { reason: "stuck gate", actor: 'dashboard-operator (as "EvilAgent")' });
  });

  it("still requires a non-empty reason (400)", async () => {
    const { app, bypassSpy } = makeHarness();
    const res = await REQUEST(app, "POST", "/api/tasks/FN-1/bypass-review", JSON.stringify({ reason: "   " }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(bypassSpy).not.toHaveBeenCalled();
  });
});
