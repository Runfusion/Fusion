import { describe, expect, it, vi } from "vitest";

const fetchWebContentMock = vi.hoisted(() => vi.fn());

vi.mock("@fusion/dashboard", () => ({
  registerGithubTrackingHook: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  createFnAgent: vi.fn(),
  fetchWebContent: fetchWebContentMock,
  emitGoalRetrievalAudit: vi.fn(),
  createWorkflowAuthoringTools: vi.fn(() => ({})),
  workflowListParams: {},
  workflowGetParams: {},
  workflowSelectParams: {},
  workflowCreateParams: {},
  workflowUpdateParams: {},
  workflowDeleteParams: {},
  workflowSettingsParams: {},
  traitListParams: {},
}));

import kbExtension from "../extension.js";

describe("extension fn_web_fetch", () => {
  it("registers and executes fn_web_fetch", async () => {
    const tools = new Map<string, any>();
    const api = {
      registerTool(def: any) {
        tools.set(def.name, def);
      },
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      registerFlag: vi.fn(),
      on: vi.fn(),
    } as any;

    fetchWebContentMock.mockResolvedValue({
      finalUrl: "https://example.com/final",
      status: 200,
      contentType: "text/plain",
      title: "Example",
      content: "hello world",
      truncated: false,
      bytesRead: 11,
    });

    kbExtension(api);
    const tool = tools.get("fn_web_fetch");
    expect(tool).toBeTruthy();

    const result = await tool.execute("id", { url: "https://example.com" }, undefined, undefined, { cwd: process.cwd() });
    expect(fetchWebContentMock).toHaveBeenCalledWith("https://example.com", { timeoutMs: undefined, maxBytes: undefined });
    expect(result.content[0].text).toContain("https://example.com/final");
    expect(result.details.status).toBe(200);
  });
});
