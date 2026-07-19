import { describe, expect, it, vi } from "vitest";
import type { AgentLogEntry, TaskStore } from "@fusion/core";
import {
  createChatTaskLogsReadTool,
  createTaskLogsReadTool,
  normalizeAgentLogPaging,
} from "../agent-tools.js";

const TASK_ID = "FN-8058";

function entry(text: string, type: AgentLogEntry["type"], detail?: string): AgentLogEntry {
  return { taskId: TASK_ID, timestamp: "2026-07-16T00:00:00.000Z", text, type, agent: "executor", detail };
}

function storeWith(entries: AgentLogEntry[]) {
  const getAgentLogs = vi.fn(async (_taskId: string, options?: { limit?: number; offset?: number; type?: AgentLogEntry["type"] }) => {
    const filtered = options?.type ? entries.filter((item) => item.type === options.type) : entries;
    const end = filtered.length - (options?.offset ?? 0);
    return filtered.slice(Math.max(0, end - (options?.limit ?? filtered.length)), Math.max(0, end));
  });
  const getAgentLogCount = vi.fn(async (_taskId: string, options?: { type?: AgentLogEntry["type"] }) => (
    options?.type ? entries.filter((item) => item.type === options.type).length : entries.length
  ));
  return { store: { getAgentLogs, getAgentLogCount } as unknown as TaskStore, getAgentLogs, getAgentLogCount };
}

async function run(tool: ReturnType<typeof createTaskLogsReadTool> | ReturnType<typeof createChatTaskLogsReadTool>, params: Record<string, unknown>) {
  return tool.execute("call", params as never, undefined, undefined, undefined);
}

describe("fn_task_logs_read", () => {
  it("normalizes paging rather than relying on schema defaults", () => {
    expect(normalizeAgentLogPaging()).toEqual({ limit: 100, offset: 0 });
    expect(normalizeAgentLogPaging(-1, -1)).toEqual({ limit: 100, offset: 0 });
    expect(normalizeAgentLogPaging(0, Number.NaN)).toEqual({ limit: 100, offset: 0 });
    expect(normalizeAgentLogPaging(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toEqual({ limit: 100, offset: 0 });
    expect(normalizeAgentLogPaging(3.9, 2.9)).toEqual({ limit: 3, offset: 2 });
  });

  it("filters before pagination, reports the filtered total, and renders detail", async () => {
    const { store, getAgentLogs, getAgentLogCount } = storeWith([
      entry("old", "text"), entry("tool output", "tool_result", "persisted result"), entry("new", "text"),
    ]);
    const result = await run(createTaskLogsReadTool(store, TASK_ID), { limit: 1, type: "text" });
    const text = result.content[0].text;
    expect(getAgentLogs).toHaveBeenCalledWith(TASK_ID, { limit: 1, offset: 0, type: "text" });
    expect(getAgentLogCount).toHaveBeenCalledWith(TASK_ID, { type: "text" });
    expect(text).toContain("1/2 entries");
    const detailResult = await run(createTaskLogsReadTool(store, TASK_ID), { type: "tool_result" });
    expect(detailResult.content[0].text).toContain("persisted result");
  });

  it("preserves adjacent streamed rows and status blocks without a persisted run boundary", async () => {
    const { store } = storeWith([
      entry("Done.", "text"), entry("Starting review", "text"), entry("complete status", "status"), entry("next", "text"),
    ]);
    const result = await run(createTaskLogsReadTool(store, TASK_ID), {});
    const text = result.content[0].text;
    expect(text).toContain("text (executor)\nDone.\n\n[2026-07-16T00:00:00.000Z] text (executor)\nStarting review");
    expect(text).not.toContain("Done.Starting review");
    expect(text).toContain("status (executor)\ncomplete status");
    expect(text).toContain("\n\n[");
  });

  it("requires task_id in chat and reads the named task", async () => {
    const { store, getAgentLogs } = storeWith([entry("chat", "status")]);
    const tool = createChatTaskLogsReadTool(store);
    await run(tool, { task_id: "FN-other" });
    expect(getAgentLogs).toHaveBeenCalledWith("FN-other", expect.any(Object));
    expect((tool.parameters as { required?: string[] }).required).toContain("task_id");
  });
});
