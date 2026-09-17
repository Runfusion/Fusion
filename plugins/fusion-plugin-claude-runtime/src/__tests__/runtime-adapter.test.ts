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

it("appends Fusion tool-name guidance when the tool bridge is active", async () => {
  let delegatedPrompt = "";
  const adapter = new ClaudeRuntimeAdapter({
    createAcpAdapter: () => ({
      createSession: async () => ({
        session: {
          model: "claude/default", messages: [], state: { messages: [] },
          lastModelDescription: "claude/default", callbacks: {}, connection: {}, dispose: vi.fn(),
        } as AgentSession,
      }),
      promptWithFallback: async (_session, prompt) => { delegatedPrompt = prompt; return { stopReason: "end_turn" }; },
      describeModel: () => "claude/default",
    }),
    startToolBridge: (async () => ({
      mcpServer: { name: "fusion-custom-tools" },
      dispose: async () => undefined,
      toolCount: 3,
      toolNames: ["fn_task_prompt_write", "fn_task_create-v2", "fn_task_createV2"],
    })) as unknown as typeof import("../tool-bridge.js").startFusionToolBridge,
  });

  const { session } = await adapter.createSession({
    cwd: "/tmp", systemPrompt: "",
    customTools: [
      { name: "fn_task_prompt_write", execute: async () => ({}) },
      { name: "fn_task_create-v2", execute: async () => ({}) },
      { name: "fn_task_createV2", execute: async () => ({}) },
    ],
  });
  const prompt = "Persist with fn_task_prompt_write, fn_task_create-v2, and fn_task_createV2.";
  await adapter.promptWithFallback(session, prompt);

  expect(delegatedPrompt).toContain("fusion-custom-tools");
  expect(delegatedPrompt).toContain("mcp__fusion-custom-tools__fn_task_prompt_write");
  expect(delegatedPrompt).toContain("mcp__fusion-custom-tools__fn_task_create-v2");
  expect(delegatedPrompt).toContain("mcp__fusion-custom-tools__fn_task_createV2");
  // Session history keeps the operator-visible original, not the augmented prompt.
  const userEntry = (session.state.messages as Array<{ role: string; content: string }>).find((m) => m.role === "user");
  expect(userEntry?.content).toBe(prompt);
});

it("leaves prompts unchanged when the bridge has no Fusion tools registered", async () => {
  let delegatedPrompt = "";
  const adapter = new ClaudeRuntimeAdapter({
    createAcpAdapter: () => ({
      createSession: async () => ({
        session: {
          model: "claude/default", messages: [], state: { messages: [] },
          lastModelDescription: "claude/default", callbacks: {}, connection: {}, dispose: vi.fn(),
        } as AgentSession,
      }),
      promptWithFallback: async (_session, prompt) => { delegatedPrompt = prompt; return { stopReason: "end_turn" }; },
      describeModel: () => "claude/default",
    }),
    startToolBridge: (async () => ({
      mcpServer: { name: "fusion-custom-tools" },
      dispose: async () => undefined,
      toolCount: 1,
      toolNames: ["fn_other"],
    })) as unknown as typeof import("../tool-bridge.js").startFusionToolBridge,
  });

  const { session } = await adapter.createSession({
    cwd: "/tmp", systemPrompt: "",
    customTools: [{ name: "fn_other", execute: async () => ({}) }],
  });
  await adapter.promptWithFallback(session, "Persist with fn_task_prompt_write.");

  expect(delegatedPrompt).toBe("Persist with fn_task_prompt_write.");
});
