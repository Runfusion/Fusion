// @vitest-environment node

/*
FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-18:35 (RUFU-384):
`POST /api/tasks/:id/reconcile-landed-review` decides operator-visible success or refusal from ONE
`outcome` membership test. RUFU-365's card — zero-commit delivery authorized, Code Review approved over the
canonical empty review input, no branch anywhere — was refused there as `not-landed`, a 409 on a card that can
never produce a commit. These tests pin that the commit-free discharge reads as success and, critically, that
the ordinary refusals still read as refusals: the discharge must be ADDED to the 200 list, never become a
default that swallows them. RUFU-357's workspace discharge case stays exactly as it was and sits beside these.

The fence itself is stubbed at its existing injectable seam (`resolveSelfHealingManager`), so the route's own
decision is the only subject — no git, no store beyond a task row.
*/

import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerTaskWorkflowRoutes } from "../register-task-workflow-routes.js";
import { request } from "../../test-request.js";

const reconcileLandedReviewTask = vi.fn();
const getTask = vi.fn();

function appFor() {
  const router = express.Router();
  registerTaskWorkflowRoutes(
    {
      router,
      store: {} as never,
      options: {} as never,
      getProjectContext: async () => ({
        store: { getTask },
        projectId: "project-1",
        projectPath: process.cwd(),
      }),
      rethrowAsApiError: (error: unknown) => {
        throw error;
      },
    } as never,
    {
      runtimeLogger: { child: () => ({ warn: vi.fn() }), warn: vi.fn() },
      // The registrar mounts an attachment route at construction, so multer's `upload` must exist;
      // no test here touches it.
      upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
      resolveSelfHealingManager: () => ({ reconcileLandedReviewTask }),
    } as never,
  );
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

async function reconcile(id = "RUFU-365") {
  getTask.mockResolvedValue({ id, column: "in-review", status: "failed", branch: null });
  // The in-memory harness (no real socket), the same one every other route test in this folder uses.
  return request(appFor(), "POST", `/api/tasks/${id}/reconcile-landed-review`, "", {});
}

describe("reconcile-landed-review route reports the commit-free discharge", () => {
  it("answers 200 for the singular commit-free discharge", async () => {
    reconcileLandedReviewTask.mockResolvedValue({
      outcome: "zero-commit-discharged",
      baseBranch: "main",
      basis: "empty-input-approval",
    });

    const response = await reconcile();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "zero-commit-discharged", basis: "empty-input-approval" });
    // The route adds no decision logic: the body is the fence's own result, sha-free by construction.
    expect(response.body).not.toHaveProperty("commitSha");
    expect(response.body).not.toHaveProperty("sha");
  });

  it("still answers 409 for the ordinary not-landed refusal", async () => {
    // The guard rail: the discharge joins the success list, it does not replace the refusals.
    reconcileLandedReviewTask.mockResolvedValue({ outcome: "not-landed", baseBranch: "main" });

    const response = await reconcile();

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ outcome: "not-landed" });
  });

  it("keeps reporting RUFU-357's workspace discharge as success beside the new case", async () => {
    reconcileLandedReviewTask.mockResolvedValue({
      outcome: "workspace-discharged",
      repoCount: 1,
      dischargedCount: 1,
      repos: [{ repo: ".", basis: "zero-ahead", baseBranch: "main" }],
    });

    const response = await reconcile("RUFU-357");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "workspace-discharged" });
  });

  it("still answers 409 for a card the fence refuses as foreign", async () => {
    reconcileLandedReviewTask.mockResolvedValue({ outcome: "ineligible", reason: "foreign-ownership" });

    const response = await reconcile();

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ outcome: "ineligible", reason: "foreign-ownership" });
  });
});
