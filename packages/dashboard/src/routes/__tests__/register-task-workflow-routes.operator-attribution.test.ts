// @vitest-environment node

/*
FNXC:ApprovalDecisionAuthority 2026-07-26-17:20:
Route-boundary invariants for two operator-only task mutations:

1. POST /tasks/:id/bypass-review — the recorded bypass actor is derived SERVER-SIDE.
   A client-supplied `actor` string used to become `bypassedBy` verbatim, so an agent
   could stamp an arbitrary identity onto a review-gate bypass. Now the attribution is
   always `dashboard-operator`, with a body-supplied name carried only as advisory
   display metadata: `dashboard-operator (as "<name>")`. `reason` stays mandatory.

2. POST /tasks/archive-all-done — the bulk archive sweep now requires an explicit
   `{ confirm: true }` body (400 without it, store untouched), matching the single-task
   reset's confirm gate, so a stray script or agent call cannot silently empty Done.

FNXC:ArchiveConfirmGate 2026-07-26-17:20:
In-memory store fakes only (no DB, no network, no timers) per the AGENTS.md slow-test rule.
*/

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

function makeHarness() {
  const bypassSpy = vi.fn(async (id: string, _input: { reason: string; actor: string }) => ({ id, column: "in-review" }));
  const resumeSpy = vi.fn(async (id: string, _input: { stepId: string; reason: string; actor: string }) => ({ id, column: "in-review" }));
  const archiveAllDoneSpy = vi.fn(async () => ({ archived: [], skipped: [] }));

  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    bypassFailedPreMergeReviewStep: bypassSpy,
    resumeWorkflowStep: resumeSpy,
    archiveAllDone: archiveAllDoneSpy,
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, bypassSpy, resumeSpy, archiveAllDoneSpy };
}

describe("POST /tasks/:id/steps/:stepId/resume — server-derived actor", () => {
  it("uses the path step ID, trims the reason, and ignores a spoofed body actor", async () => {
    const { app, resumeSpy } = makeHarness();
    const res = await REQUEST(app, "POST", "/api/tasks/FN-1/steps/code-review/resume", JSON.stringify({
      stepId: "spoofed-step",
      reason: " callback never returned ",
      actor: "EvilAgent",
    }), { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(resumeSpy).toHaveBeenCalledWith("FN-1", {
      stepId: "code-review",
      reason: "callback never returned",
      actor: "dashboard-operator",
    });
  });

  it("requires a non-empty reason before calling the store", async () => {
    const { app, resumeSpy } = makeHarness();
    const res = await REQUEST(app, "POST", "/api/tasks/FN-1/steps/code-review/resume", JSON.stringify({ reason: "   " }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("maps missing tasks to 404 and eligibility rejections to conflict", async () => {
    const { app, resumeSpy } = makeHarness();
    resumeSpy.mockRejectedValueOnce(new Error("Task FN-missing not found"));
    const missing = await REQUEST(app, "POST", "/api/tasks/FN-missing/steps/code-review/resume", JSON.stringify({ reason: "stuck" }), {
      "content-type": "application/json",
    });
    resumeSpy.mockRejectedValueOnce(new Error("Cannot resume workflow step for FN-1: only pending steps can be resumed"));
    const rejected = await REQUEST(app, "POST", "/api/tasks/FN-1/steps/code-review/resume", JSON.stringify({ reason: "stuck" }), {
      "content-type": "application/json",
    });

    expect(missing.status).toBe(404);
    expect(rejected.status).toBe(409);
  });
});

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

describe("POST /tasks/archive-all-done — confirm gate", () => {
  it("returns 400 and leaves the store untouched without { confirm: true }", async () => {
    const { app, archiveAllDoneSpy } = makeHarness();
    const res = await REQUEST(app, "POST", "/api/tasks/archive-all-done", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(archiveAllDoneSpy).not.toHaveBeenCalled();
  });

  it("rejects a truthy-but-not-true confirm value", async () => {
    const { app, archiveAllDoneSpy } = makeHarness();
    const res = await REQUEST(app, "POST", "/api/tasks/archive-all-done", JSON.stringify({ confirm: "yes" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(archiveAllDoneSpy).not.toHaveBeenCalled();
  });

  it("archives with an explicit { confirm: true }", async () => {
    const { app, archiveAllDoneSpy } = makeHarness();
    const res = await REQUEST(app, "POST", "/api/tasks/archive-all-done", JSON.stringify({ confirm: true }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(archiveAllDoneSpy).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ archived: [], skipped: [] });
  });
});
