import { describe, expect, it, vi } from "vitest";
import { OmpRuntimeAdapter } from "../runtime-adapter.js";
import { createEventBridge } from "../acp/event-bridge.js";
import type { AgentRuntimeOptions, AgentSession, AgentSessionResult } from "../types.js";

function makeFakeSession(partial?: Partial<AgentSession>): AgentSession {
  const messages: unknown[] = [];
  return {
    model: "omp/default",
    messages,
    state: { messages },
    lastModelDescription: "omp/default",
    callbacks: {},
    connection: { live: true },
    dispose: () => undefined,
    ...partial,
  };
}

describe("OmpRuntimeAdapter", () => {
  it("forwards Fusion systemPrompt via sessionMeta.systemPromptOverride", async () => {
    let seenOptions: AgentRuntimeOptions | undefined;
    const liveSession = makeFakeSession();
    const adapter = new OmpRuntimeAdapter({
      createAcpAdapter: () => ({
        createSession: async (options) => {
          seenOptions = options;
          return { session: liveSession };
        },
        promptWithFallback: async () => undefined,
        describeModel: () => "omp/default",
      }),
    });

    await adapter.createSession({
      cwd: process.cwd(),
      systemPrompt: "Fusion system context",
    });

    expect(seenOptions?.sessionMeta).toEqual(
      expect.objectContaining({
        systemPromptOverride: expect.stringContaining("Fusion system context"),
      }),
    );
  });

  it("forwards Fusion fn_* tools via fusion-custom-tools MCP server", async () => {
    let seenOptions: AgentRuntimeOptions | undefined;
    const liveSession = makeFakeSession();
    const adapter = new OmpRuntimeAdapter({
      createAcpAdapter: () => ({
        createSession: async (options) => {
          seenOptions = options;
          return { session: liveSession };
        },
        promptWithFallback: async () => undefined,
        describeModel: () => "omp/default",
      }),
    });

    const { session } = await adapter.createSession({
      cwd: process.cwd(),
      systemPrompt: "sys",
      customTools: [
        {
          name: "fn_task_list",
          description: "List tasks",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ text: "ok" }),
        },
      ],
    });

    try {
      const mcp = seenOptions?.mcpServers as Array<{ name?: string }> | undefined;
      expect(mcp?.some((s) => s.name === "fusion-custom-tools")).toBe(true);
      expect(String(seenOptions?.sessionMeta?.systemPromptOverride ?? "")).toContain(
        "fusion-custom-tools",
      );
    } finally {
      await adapter.dispose(session);
    }
  });

  it("surfaces create failures as onText diagnostics without throwing", async () => {
    const onText = vi.fn();
    const adapter = new OmpRuntimeAdapter({
      createAcpAdapter: () => ({
        createSession: async () => {
          throw new Error("spawn ENOENT");
        },
        promptWithFallback: async () => undefined,
        describeModel: () => "omp/default",
      }),
    });

    const { session } = await adapter.createSession({
      cwd: process.cwd(),
      systemPrompt: "",
      onText,
    });

    expect(onText).toHaveBeenCalled();
    expect(String(onText.mock.calls[0]?.[0])).toMatch(/OMP ACP failed to start/);
    expect(session.state.errorMessage).toMatch(/OMP ACP failed to start/);
  });

  it("forwards prompts to the ACP adapter when connection is live", async () => {
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
    const liveSession = makeFakeSession();
    const adapter = new OmpRuntimeAdapter({
      createAcpAdapter: () => ({
        createSession: async (): Promise<AgentSessionResult> => ({
          session: liveSession,
        }),
        promptWithFallback: prompt,
        describeModel: () => "omp/default",
      }),
    });

    const { session } = await adapter.createSession({
      cwd: process.cwd(),
      systemPrompt: "sys",
      onText: (t) => {
        liveSession.callbacks.onText?.(t);
      },
    });

    // Simulate streamed text during the turn
    liveSession.callbacks.onText = (t: string) => {
      // turn accum is wired on create; call session path via adapter
      void t;
    };

    await adapter.promptWithFallback(session, "hello");
    expect(prompt).toHaveBeenCalledWith(session, "hello", undefined);
  });

  it("re-surfaces diagnostics when the session has no live connection", async () => {
    const onText = vi.fn();
    const dead = makeFakeSession({ connection: undefined, callbacks: { onText } });
    const adapter = new OmpRuntimeAdapter({
      createAcpAdapter: () => ({
        createSession: async () => ({ session: dead }),
        promptWithFallback: async () => undefined,
        describeModel: () => "omp/default",
      }),
    });

    // Manually set adapters map by creating then killing connection semantics:
    // createSession without connection still stores adapter, but hasConnection checks connection field.
    const createOnly = new OmpRuntimeAdapter({
      createAcpAdapter: () => ({
        createSession: async () => ({
          session: makeFakeSession({
            connection: undefined,
            callbacks: { onText },
            state: { messages: [], errorMessage: "boom" },
          }),
        }),
        promptWithFallback: async () => undefined,
        describeModel: () => "omp/default",
      }),
    });

    const { session } = await createOnly.createSession({
      cwd: process.cwd(),
      systemPrompt: "",
      onText,
    });
    // Force no connection for follow-up
    (session as { connection?: unknown }).connection = undefined;
    onText.mockClear();
    await createOnly.promptWithFallback(session, "again");
    expect(onText).toHaveBeenCalled();
    expect(String(onText.mock.calls[0]?.[0])).toMatch(/no live connection/);
  });

  it("describeModel uses lastModelDescription", async () => {
    const adapter = new OmpRuntimeAdapter({
      createAcpAdapter: () => ({
        createSession: async () => ({
          session: makeFakeSession({ lastModelDescription: "omp/claude-sonnet-4", model: "claude-sonnet-4" }),
        }),
        promptWithFallback: async () => undefined,
        describeModel: () => "omp/claude-sonnet-4",
      }),
    });
    const { session } = await adapter.createSession({ cwd: process.cwd(), systemPrompt: "" });
    expect(adapter.describeModel(session)).toMatch(/^omp\//);
  });
});

/*
FNXC:ChatStreaming 2026-08-19-13:52:
The OMP ACP bridge normalizes before callbacks append output, preserving numeric model versions and URL path segments in both Chat text and independent thinking streams.
*/
describe("OMP ACP stream numeric token preservation", () => {
  it("keeps dotted source links and thinking versions intact", () => {
    const onText = vi.fn<(text: string) => void>();
    const onThinking = vi.fn<(text: string) => void>();
    const bridge = createEventBridge({ onText, onThinking });
    for (const text of [
      "[GPT‑5.",
      "6 Luna](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-luna) [GPT‑5.",
      "6 Sol](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-sol) [GPT‑5.",
      "6 Terra](https://developers.openai.com/api/docs/models/gpt-5.",
      "6-terra)",
    ]) {
      bridge.handleSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as any);
    }
    bridge.handleSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Version 5." } } as any);
    bridge.handleSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "6" } } as any);

    const output = onText.mock.calls.map(([text]) => text).join("");
    expect(output).not.toContain("5. 6");
    expect(output).toContain("GPT‑5.6 Luna");
    expect(output).toContain("/gpt-5.6-luna");
    expect(output).toContain("/gpt-5.6-sol");
    expect(output).toContain("/gpt-5.6-terra");
    expect(onThinking.mock.calls.map(([text]) => text).join("")).toBe("Version 5.6");
  });
});

it("appends Fusion tool-name guidance when the tool bridge is active", async () => {
  let delegatedPrompt = "";
  const adapter = new OmpRuntimeAdapter({
    createAcpAdapter: () => ({
      createSession: async () => ({
        session: {
          model: "omp/default", messages: [], state: { messages: [] },
          lastModelDescription: "omp/default", callbacks: {}, connection: {}, dispose: vi.fn(),
        } as AgentSession,
      }),
      promptWithFallback: async (_session, prompt) => { delegatedPrompt = prompt; return { stopReason: "end_turn" }; },
      describeModel: () => "omp/default",
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
  const userEntry = (session.state.messages as Array<{ role: string; content: string }>).find((m) => m.role === "user");
  expect(userEntry?.content).toBe(prompt);
});

it("leaves prompts unchanged when the bridge has no matching Fusion tools", async () => {
  let delegatedPrompt = "";
  const adapter = new OmpRuntimeAdapter({
    createAcpAdapter: () => ({
      createSession: async () => ({
        session: {
          model: "omp/default", messages: [], state: { messages: [] },
          lastModelDescription: "omp/default", callbacks: {}, connection: {}, dispose: vi.fn(),
        } as AgentSession,
      }),
      promptWithFallback: async (_session, prompt) => { delegatedPrompt = prompt; return { stopReason: "end_turn" }; },
      describeModel: () => "omp/default",
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
