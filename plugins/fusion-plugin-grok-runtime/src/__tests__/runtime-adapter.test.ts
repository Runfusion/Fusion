import { describe, expect, it, vi } from "vitest";
import { GrokRuntimeAdapter, type AcpAdapterFactory } from "../runtime-adapter.js";
import type { AgentSession, AgentSessionResult } from "../types.js";

/*
FNXC:GrokAcp 2026-07-11-12:00:
Adapter tests pin the Grok ACP composition seam (settings + resolve-never-reject
diagnostics + message accumulation). They inject a fake AcpRuntimeAdapter so CI
does not require a live `grok` binary; live ACP handshake is covered by the ACP
plugin suite and manual smoke against `grok agent stdio`.
*/

function makeFakeAcpAdapter(overrides?: {
  createSession?: ReturnType<AcpAdapterFactory>["createSession"];
  promptWithFallback?: (
    session: AgentSession,
    prompt: string,
    options?: unknown,
  ) => Promise<void | { stopReason?: string }>;
  settingsOut?: Record<string, unknown>[];
}): AcpAdapterFactory {
  const settingsOut = overrides?.settingsOut ?? [];
  return (settings) => {
    settingsOut.push(settings);
    const sessionShell: AgentSession & { connection?: { id: string }; dispose: () => void } = {
      model: String(settings.acpModel ?? "grok/default"),
      messages: [],
      state: { messages: [] },
      lastModelDescription: `acp/${settings.acpModel ?? "default"}`,
      callbacks: {},
      connection: { id: "conn-1" },
      sessionId: "acp-session-1",
      dispose: vi.fn(),
    };

    return {
      createSession:
        overrides?.createSession ??
        (async (options): Promise<AgentSessionResult> => {
          sessionShell.callbacks = {
            onText: options.onText,
            onThinking: options.onThinking,
            onToolStart: options.onToolStart,
            onToolEnd: options.onToolEnd,
          };
          return { session: sessionShell };
        }),
      promptWithFallback:
        overrides?.promptWithFallback ??
        (async (session, _prompt) => {
          // Simulate ACP bridge streaming through the callbacks captured at create.
          const s = session as AgentSession & { callbacks?: { onText?: (t: string) => void; onThinking?: (t: string) => void } };
          s.callbacks?.onThinking?.("thinking");
          s.callbacks?.onText?.("Hello");
          s.callbacks?.onText?.("!");
          return { stopReason: "end_turn" };
        }),
      describeModel: (session) => `acp/${(session as AgentSession).model}`,
      dispose: async (session) => {
        (session as { dispose?: () => void }).dispose?.();
      },
    };
  };
}

describe("GrokRuntimeAdapter (ACP)", () => {
  it("creates a session with default model fallback", async () => {
    const settingsOut: Record<string, unknown>[] = [];
    const adapter = new GrokRuntimeAdapter({ createAcpAdapter: makeFakeAcpAdapter({ settingsOut }) });
    const result = await adapter.createSession({ systemPrompt: "sys" });
    expect(result.session.model).toBe("grok/default");
    expect(result.session.systemPrompt).toBe("sys");
    const args = settingsOut[0]?.acpArgs as string[];
    expect(args).toContain("--no-auto-update");
    expect(args).toContain("agent");
    expect(args).toContain("--plugin-dir");
    expect(args.at(-1)).toBe("stdio");
  });

  it("passes the normalized selected model as grok agent -m before stdio and injects plugin-dir", async () => {
    const settingsOut: Record<string, unknown>[] = [];
    const adapter = new GrokRuntimeAdapter({ createAcpAdapter: makeFakeAcpAdapter({ settingsOut }) });
    const { session } = await adapter.createSession({ defaultModelId: "grok-cli/grok-4.5" });

    expect(session.model).toBe("grok-4.5");
    expect(settingsOut[0]?.acpBinaryPath).toBe("grok");
    const args = settingsOut[0]?.acpArgs as string[];
    expect(args).toContain("--no-auto-update");
    expect(args).toContain("--plugin-dir");
    expect(args).toEqual(expect.arrayContaining(["-m", "grok-4.5", "stdio"]));
    // plugin-dir precedes model flag; no-auto-update precedes agent
    expect(args.indexOf("--no-auto-update")).toBeLessThan(args.indexOf("agent"));
    expect(args.indexOf("--plugin-dir")).toBeLessThan(args.indexOf("-m"));
  });

  it("forwards operator MCP servers and Fusion custom tools into createSession", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new GrokRuntimeAdapter({
      createAcpAdapter: (settings) => {
        const base = makeFakeAcpAdapter()(settings);
        return {
          ...base,
          createSession: async (options) => {
            captured = options as Record<string, unknown>;
            return base.createSession(options);
          },
        };
      },
    });

    const { session } = await adapter.createSession({
      mcpServers: [
        {
          name: "local-tools",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "x" },
        },
      ],
      customTools: [
        {
          name: "fn_task_list",
          description: "List tasks",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ text: "ok" }),
        },
      ],
      skills: ["fusion"],
    });

    const mcpServers = captured?.mcpServers as Array<Record<string, unknown>>;
    expect(mcpServers.some((s) => s.name === "local-tools")).toBe(true);
    expect(mcpServers.some((s) => s.name === "fusion-custom-tools")).toBe(true);
    const meta = captured?.sessionMeta as { pluginDirs?: string[]; rules?: string };
    expect(meta.pluginDirs?.[0]).toBeTruthy();
    expect(meta.rules).toContain("fusion");
    expect(String(captured?.systemPrompt ?? "")).toContain("Fusion runtime context");
    await adapter.dispose(session);
  });

  it("omits -m for the no-model grok/default fallback but still injects plugin-dir", async () => {
    const settingsOut: Record<string, unknown>[] = [];
    const adapter = new GrokRuntimeAdapter({ createAcpAdapter: makeFakeAcpAdapter({ settingsOut }) });
    await adapter.createSession({});
    const args = settingsOut[0]?.acpArgs as string[];
    expect(args).toContain("--plugin-dir");
    expect(args.at(-1)).toBe("stdio");
    expect(args).not.toContain("-m");
  });

  it("streams ACP text/thinking through engine callbacks and persists assistant content", async () => {
    const adapter = new GrokRuntimeAdapter({ createAcpAdapter: makeFakeAcpAdapter() });
    const onText = vi.fn();
    const onThinking = vi.fn();
    const { session } = await adapter.createSession({ onText, onThinking });

    await adapter.promptWithFallback(session, "hello grok");

    expect(onThinking).toHaveBeenCalledWith("thinking");
    expect(onText.mock.calls.map((c) => c[0])).toEqual(["Hello", "!"]);
    expect(session.sessionId).toBe("acp-session-1");
    expect(session.state.messages).toContainEqual({ role: "user", content: "hello grok" });
    expect(session.state.messages).toContainEqual({ role: "assistant", content: "Hello!" });
  });

  it("surfaces abnormal stopReason with no text as a diagnostic", async () => {
    const adapter = new GrokRuntimeAdapter({
      createAcpAdapter: makeFakeAcpAdapter({
        promptWithFallback: async () => ({ stopReason: "cancelled" }),
      }),
    });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    await adapter.promptWithFallback(session, "say hello");

    expect(session.state.errorMessage).toBe(
      "Grok ACP ended with stopReason cancelled and produced no assistant text.",
    );
    expect(onText).toHaveBeenCalledWith(session.state.errorMessage);
  });

  it("keeps a clean end_turn with no assistant text silent", async () => {
    const adapter = new GrokRuntimeAdapter({
      createAcpAdapter: makeFakeAcpAdapter({
        promptWithFallback: async () => ({ stopReason: "end_turn" }),
      }),
    });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    await adapter.promptWithFallback(session, "hi");

    expect(onText).not.toHaveBeenCalled();
    expect(session.state.errorMessage).toBeUndefined();
  });

  it("resolves (never rejects) when ACP prompt throws and surfaces the diagnostic", async () => {
    const adapter = new GrokRuntimeAdapter({
      createAcpAdapter: makeFakeAcpAdapter({
        promptWithFallback: async () => {
          throw new Error("bridge hung up");
        },
      }),
    });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    await expect(adapter.promptWithFallback(session, "hi")).resolves.toBeUndefined();
    expect(session.state.errorMessage).toContain("bridge hung up");
    expect(onText).toHaveBeenCalledWith(expect.stringContaining("bridge hung up"));
  });

  it("resolves createSession when ACP create throws and surfaces a start diagnostic", async () => {
    const adapter = new GrokRuntimeAdapter({
      createAcpAdapter: makeFakeAcpAdapter({
        createSession: async () => {
          throw new Error("ENOENT grok");
        },
      }),
    });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    expect(session.state.errorMessage).toContain("ENOENT grok");
    expect(onText).toHaveBeenCalledWith(expect.stringContaining("ENOENT grok"));

    // Second prompt must not duplicate the diagnostic bubble.
    onText.mockClear();
    await adapter.promptWithFallback(session, "hi");
    expect(onText).not.toHaveBeenCalled();
  });

  it("describeModel formats grok prefix", async () => {
    const adapter = new GrokRuntimeAdapter({ createAcpAdapter: makeFakeAcpAdapter() });
    const { session } = await adapter.createSession({ defaultModelId: "grok-4.5" });
    expect(adapter.describeModel(session)).toBe("grok/grok-4.5");
  });

  it("disposes via the composed ACP adapter", async () => {
    const dispose = vi.fn(async () => undefined);
    const adapter = new GrokRuntimeAdapter({
      createAcpAdapter: (settings) => {
        const base = makeFakeAcpAdapter()(settings);
        return { ...base, dispose };
      },
    });
    const { session } = await adapter.createSession({});
    await adapter.dispose(session);
    expect(dispose).toHaveBeenCalledWith(session);
  });
});
