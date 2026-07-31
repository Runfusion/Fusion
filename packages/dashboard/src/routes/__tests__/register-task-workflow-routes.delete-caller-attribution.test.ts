// @vitest-environment node

/*
FNXC:TaskDeleteAttribution 2026-07-26-14:30:
Requirement under test: `DELETE /api/tasks/:id` must record WHICH KIND of client asked.

Original symptom: the handler hardcoded `auditContext: { agentId: "system", runId: "synthetic-
dashboard-delete-..." }`, so an operator clicking Delete in the dashboard and any script or agent
hitting the same endpoint produced byte-identical run-audit rows. In a four-delete incident the
audit could not say which deletion was the human's.

Trust model asserted here explicitly: `x-fusion-client` is SELF-REPORTED. The route may only
distinguish "the client identified itself as the dashboard UI" from "nothing identified itself".
The unrecognized-value case below is the guard that an unknown caller is never upgraded to
`operator-ui` — and it is deliberately NOT a security test, because the header proves nothing.
*/

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { FUSION_CLIENT_HEADER, FUSION_DASHBOARD_UI_CLIENT } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const TARGET_ID = "FN-8600";

type DeleteOptions = { auditContext?: { agentId?: string; callerKind?: string; taskId?: string } };

const createHarness = () => {
  const deleteTask = vi.fn(async (id: string, _options?: DeleteOptions) => ({ id, column: "archived" }));

  const store: TaskStore = {
    getRootDir: vi.fn(() => process.cwd()),
    deleteTask,
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, deleteTask };
};

async function callerKindFor(headers: Record<string, string>): Promise<string | undefined> {
  const { app, deleteTask } = createHarness();
  const res = await REQUEST(app, "DELETE", `/api/tasks/${TARGET_ID}`, undefined, headers);
  expect(res.status).toBe(200);
  const options = deleteTask.mock.calls[0]?.[1] as DeleteOptions | undefined;
  return options?.auditContext?.callerKind;
}

describe("DELETE /api/tasks/:id caller attribution", () => {
  it("labels a request that identifies itself as the dashboard UI as operator-ui", async () => {
    expect(await callerKindFor({ [FUSION_CLIENT_HEADER]: FUSION_DASHBOARD_UI_CLIENT })).toBe("operator-ui");
  });

  it("labels a request with no client header as api-unattributed", async () => {
    expect(await callerKindFor({})).toBe("api-unattributed");
  });

  it("labels a request with an unrecognized client header as api-unattributed", async () => {
    expect(await callerKindFor({ [FUSION_CLIENT_HEADER]: "curl-script" })).toBe("api-unattributed");
  });

  /*
  FNXC:TaskDeleteAttribution 2026-07-26-14:30:
  Observability only — this change adds no delete-blocking, gating, or permission logic. An
  unattributed caller must still be allowed to delete exactly as before; only the audit row differs.
  */
  it("does not block an unattributed delete", async () => {
    const { app, deleteTask } = createHarness();
    const res = await REQUEST(app, "DELETE", `/api/tasks/${TARGET_ID}`);
    expect(res.status).toBe(200);
    expect(deleteTask).toHaveBeenCalledTimes(1);
  });
});
