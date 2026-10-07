import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createTaskArchiveTool } from "../agent-tools.js";

/*
FNXC:ArchiveLogAttribution 2026-09-23-23:01:
A chat archive must attribute the CALLER and never claim the mutation target as its caller task. The
factory used to hardcode `agentId: "chat"` and set `taskId` to the archive target — but
`TaskDeleteAuditContext.taskId` is the CALLER's task (the self-delete guard's input), so archives
lost the bound agent's identity and recorded the target as its own caller. These cases pin the
factory contract: the caller identity reaches the archive audit context, a caller task is recorded
only when one genuinely exists, and the caller-less factory keeps its legacy `chat` attribution.
*/

function stubStore() {
  const archiveTask = vi.fn(async (...args: unknown[]) => ({ id: String(args[0]), column: "archived" }));
  const store = { archiveTask } as unknown as TaskStore;
  return { store, archiveTask };
}

type ArchiveCallAudit = {
  agentId: string;
  runId: string;
  taskId?: string;
  callerKind?: string;
};

const auditOf = (archiveTask: ReturnType<typeof stubStore>["archiveTask"]): ArchiveCallAudit =>
  (archiveTask.mock.calls[0] as [string, { auditContext: ArchiveCallAudit }])[1].auditContext;

describe("createTaskArchiveTool", () => {
  it("attributes the archive to the calling agent and never claims the target as caller task", async () => {
    const { store, archiveTask } = stubStore();
    const tool = createTaskArchiveTool(store, { agentId: "agent-42" });

    await tool.execute("run", { id: "FN-9001" }, undefined as never, undefined as never, undefined as never);

    const audit = auditOf(archiveTask);
    expect(audit.agentId).toBe("agent-42");
    expect(audit.callerKind).toBe("agent-tool");
    // The mutation target is NOT the caller's task. Pre-fix this was `params.id`.
    expect(audit.taskId).toBeUndefined();
    expect(audit.runId).toContain("FN-9001");
  });

  it("records a genuine caller task id — which is not the mutation target", async () => {
    const { store, archiveTask } = stubStore();
    const tool = createTaskArchiveTool(store, { agentId: "agent-42", taskId: "FN-0007" });

    await tool.execute("run", { id: "FN-9001" }, undefined as never, undefined as never, undefined as never);

    expect(auditOf(archiveTask).taskId).toBe("FN-0007");
  });

  it("keeps the legacy chat attribution for a caller-less factory", async () => {
    const { store, archiveTask } = stubStore();
    const tool = createTaskArchiveTool(store);

    await tool.execute("run", { id: "FN-9001" }, undefined as never, undefined as never, undefined as never);

    const audit = auditOf(archiveTask);
    expect(audit.agentId).toBe("chat");
    expect(audit.callerKind).toBe("agent-tool");
  });
});
