import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createChatFusionToolset } from "../chat.js";

const taskStore = () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  listPatchnodeEntries: vi.fn().mockResolvedValue({ entries: [], totalEntries: 0, hasMore: false }),
} as unknown as TaskStore);

const retiredToolName = ["fn", "patchnode", "read"].join("_");

describe("History chat registration", () => {
  it("exposes the read tool without an action gate", async () => {
    const tools = await createChatFusionToolset({ taskStore: taskStore(), rootDir: "/project" });
    expect(tools.map((tool) => tool.name)).toContain("fn_history_read");
    expect(tools.map((tool) => tool.name)).not.toContain(retiredToolName);
  });

  it("keeps the read tool when an action gate is present", async () => {
    const tools = await createChatFusionToolset({ taskStore: taskStore(), rootDir: "/project", actionGateContext: {} as never });
    expect(tools.map((tool) => tool.name)).toContain("fn_history_read");
    expect(tools.map((tool) => tool.name)).not.toContain(retiredToolName);
  });

  it("omits the tool when no task store exists", async () => {
    const tools = await createChatFusionToolset({ rootDir: "/project" });
    expect(tools.map((tool) => tool.name)).not.toContain("fn_history_read");
    expect(tools.map((tool) => tool.name)).not.toContain(retiredToolName);
  });
});
