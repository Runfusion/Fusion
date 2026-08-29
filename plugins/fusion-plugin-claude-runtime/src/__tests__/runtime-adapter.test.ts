import { describe, expect, it, vi } from "vitest";
import { ClaudeRuntimeAdapter } from "../runtime-adapter.js";
import type { AgentSession } from "../types.js";
const options={cwd:"/tmp",systemPrompt:"",onText:vi.fn()};
describe("ClaudeRuntimeAdapter", () => {
 it("returns a visible diagnostic instead of rejecting on ACP create failure", async () => { const adapter=new ClaudeRuntimeAdapter({createAcpAdapter:()=>({createSession:async()=>{throw new Error("bridge unavailable")},promptWithFallback:async()=>undefined,describeModel:()=>"claude/default"})}); const result=await adapter.createSession(options); expect(result.session.state.errorMessage).toContain("Claude ACP failed"); expect(options.onText).toHaveBeenCalled(); });
 it("returns a visible diagnostic for follow-up prompts without a live connection", async () => { const adapter=new ClaudeRuntimeAdapter({createAcpAdapter:()=>({createSession:async()=>{throw new Error("bridge unavailable")},promptWithFallback:async()=>undefined,describeModel:()=>"claude/default"})}); const {session}=await adapter.createSession(options); await adapter.promptWithFallback(session,"again"); expect(options.onText).toHaveBeenLastCalledWith(expect.stringContaining("no live connection")); });
});


it("surfaces a fixed diagnostic and omits the broken MCP entry when the tool bridge fails", async () => {
  let captured: Record<string, unknown> | undefined;
  const onText = vi.fn();
  const adapter = new ClaudeRuntimeAdapter({
    createAcpAdapter: () => ({
      createSession: async (sessionOptions) => {
        captured = sessionOptions as Record<string, unknown>;
        return { session: {
          model: "claude/default", messages: [], state: { messages: [] },
          lastModelDescription: "claude/default", callbacks: {}, connection: {}, dispose: vi.fn(),
        } as AgentSession };
      },
      promptWithFallback: async () => undefined,
      describeModel: () => "claude/default",
    }),
    startToolBridge: async () => { throw new Error("bind failed"); },
  });

  const { session } = await adapter.createSession({
    cwd: "/tmp", systemPrompt: "", onText,
    customTools: [{ name: "fn_task_list", execute: async () => ({}) }],
  });

  expect(onText).toHaveBeenCalledWith("FUSION_TOOL_BRIDGE_FAILED: bridge-start-failed");
  expect(session.fusionToolBridgeError).toEqual({ reasonCode: "bridge-start-failed" });
  expect((captured?.mcpServers as Array<{ name: string }>).some((server) => server.name === "fusion-custom-tools")).toBe(false);
});
