// @vitest-environment node
//
/*
FNXC:CompleteColumnGateEvidence 2026-10-11-20:48 (RUFU-406):
Transport-level coverage for the complete-column gate-EVIDENCE refusal. The store seam
(`complete-column-gate-move-guard.pg.test.ts`) proves the verdict; this file proves the two things only
the HTTP surface can:

1. The rejection reaches the board as the structured 409 the transition-rejection contract defines
   (`code: "gate-evidence-missing"` + a `messageKey`), with a message that NAMES the outstanding
   gates. A refusal the client cannot render is how RUFU-389's shape stayed invisible: the board needs
   the same copy the CLI prints, not a bare 500.
2. The transport declares ITSELF. The route hardcodes `moveCallerSurface: "dashboard-http"` next to the
   hardcoded `moveSource: "user"`, so a refusal recorded from a board drag can never be confused with an
   agent's shell — and a request body cannot relabel it. That attribution is what makes "the agent
   hand-completed a card" distinguishable from an operator's identical drag, which the aggregate
   evidence count cannot do on its own.
*/

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { CompleteColumnGateEvidenceRejectionError, describeCompleteColumnGateFindings, makeTransitionRejection } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

function buildStore(moveTask: ReturnType<typeof vi.fn>): TaskStore {
  const current = {
    id: "FN-001", title: "reviewed", description: "reviewed", column: "in-review", status: null, executionMode: "fast",
    dependencies: [], steps: [], currentStep: 0,
    prompt: '# Planned\n\n## Plan Premises\n\n- {"kind":"file-exists","path":"package.json"}\n',
  } as never;
  return {
    getRootDir: vi.fn(() => process.cwd()),
    // Marks the mock runtime-owned so FN-8491's project-scoped plugin-MCP binder short-circuits.
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTask: vi.fn(async () => current),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getSettings: vi.fn(async () => ({})),
    moveTask,
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

/**
 * The store-side refusal for a card with no approving `code-review` row, assembled from the SAME
 * production helpers the move seam uses (`moves.ts` builds the rejection exactly this way), so the copy
 * asserted below is the shipped sentence rather than a fixture that merely resembles it.
 */
function gateEvidenceRejection(): CompleteColumnGateEvidenceRejectionError {
  const findings = [{ gateId: "code-review", lane: "pre-merge", state: "missing" }] as const;
  return new CompleteColumnGateEvidenceRejectionError(
    makeTransitionRejection("gate-evidence-missing", "transition.rejected.gateEvidenceMissing", true),
    describeCompleteColumnGateFindings(findings, { taskId: "FN-001", toColumn: "done" }),
    findings,
  );
}

async function postMove(store: TaskStore, body: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return REQUEST(app, "POST", "/api/tasks/FN-001/move", JSON.stringify(body), {
    "content-type": "application/json",
  });
}

describe("task move route — the complete-column gate-evidence refusal reaches the client", () => {
  it("answers a gateless completion with a structured 409 that names the outstanding gate", async () => {
    const moveTask = vi.fn(async () => {
      throw gateEvidenceRejection();
    });

    const res = await postMove(buildStore(moveTask), { column: "done" });

    // Structured rejection, not a 500: the board resolves `messageKey` and snaps the card back.
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({
      code: "gate-evidence-missing",
      messageKey: "transition.rejected.gateEvidenceMissing",
      retryable: true,
    });
    // The copy names the gate, its lane, and states the remedy, so an operator can act from the toast
    // alone — and it is the store's sentence, forwarded intact rather than flattened to a status code.
    expect(String(res.body.error)).toContain("code-review (pre-merge) has no result recorded");
    expect(String(res.body.error)).toContain("POST /tasks/FN-001/bypass-review");
  });

  it("declares its own transport on the move, so a board drag is never mistaken for an agent shell", async () => {
    const moveTask = vi.fn(async (_id: string, column: string, options?: Record<string, unknown>) => ({
      id: "FN-001",
      column,
      dependencies: [],
      steps: [],
      currentStep: 0,
      ...options,
    }));

    const res = await postMove(buildStore(moveTask), { column: "done" });

    expect(res.status).toBe(200);
    expect(moveTask).toHaveBeenCalledTimes(1);
    const passedOptions = moveTask.mock.calls[0][2] as Record<string, unknown>;
    expect(passedOptions.moveSource).toBe("user");
    expect(passedOptions.moveCallerSurface).toBe("dashboard-http");
  });

  it("cannot have its caller surface relabelled by the request body", async () => {
    /*
    The attribution is provenance the transport owns. A body that injects `store-direct` — the value a
    bare programmatic write records — would launder an HTTP move into looking like an unattributed
    internal write, which is the confusion this task exists to remove. The route constructs its options
    from scratch, so the injected field must never reach the store (same posture as `bypassGuards`).
    */
    const moveTask = vi.fn(async (_id: string, column: string) => ({
      id: "FN-001", column, dependencies: [], steps: [], currentStep: 0,
    }));

    const res = await postMove(buildStore(moveTask), {
      column: "done",
      moveCallerSurface: "store-direct",
      moveSource: "engine",
    });

    expect(res.status).toBe(200);
    const passedOptions = moveTask.mock.calls[0][2] as Record<string, unknown>;
    expect(passedOptions.moveCallerSurface).toBe("dashboard-http");
    expect(passedOptions.moveSource).toBe("user");
  });
});
