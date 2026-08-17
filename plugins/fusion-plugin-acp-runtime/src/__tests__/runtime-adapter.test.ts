import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { AcpRuntimeAdapter } from "../runtime-adapter.js";
import { killAllProcesses, activeProcessCount } from "../process-manager.js";
import * as provider from "../provider.js";
import * as toolBridge from "../tool-bridge.js";
import type { AcpSession, AgentRuntimeOptions } from "../types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-agent.mjs", import.meta.url));

afterEach(() => {
  killAllProcesses();
});

function makeAdapter(extra: Record<string, unknown> = {}) {
  return new AcpRuntimeAdapter({
    acpBinaryPath: process.execPath,
    acpArgs: [FIXTURE],
    acpModel: "echo-agent",
    ...extra,
  });
}

function makeOptions(over: Partial<AgentRuntimeOptions> = {}): AgentRuntimeOptions {
  return {
    cwd: process.cwd(),
    systemPrompt: "be helpful",
    ...over,
  };
}

describe("AcpRuntimeAdapter (U3)", () => {
  it("createSession spawns + opens a session with a real sessionId", async () => {
    const adapter = makeAdapter();
    const { session } = await adapter.createSession(makeOptions());
    try {
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect((session as AcpSession).connection).toBeDefined();
      expect(session.lastModelDescription).toBe("acp/echo-agent");
    } finally {
      await adapter.dispose(session);
    }
  });

  it("createSession persists actionGateContext and cwd on the session", async () => {
    const adapter = makeAdapter();
    const gate = { permissionPolicy: { rules: { command_execution: "allow" as const } } };
    // cwd must be a real, spawnable directory (it is the subprocess cwd too).
    const cwd = os.tmpdir();
    const { session } = await adapter.createSession(
      makeOptions({ cwd, actionGateContext: gate }),
    );
    try {
      // Both reachable from the session object for the U5/U7 handlers to read.
      expect((session as AcpSession).gate).toBe(gate);
      expect(session.cwd).toBe(cwd);
    } finally {
      await adapter.dispose(session);
    }
  });

  it("promptWithFallback drives a full turn to completion and surfaces stopReason", async () => {
    const adapter = makeAdapter();
    const { session } = await adapter.createSession(makeOptions());
    try {
      await expect(adapter.promptWithFallback(session, "hello")).resolves.toEqual({ stopReason: "end_turn" });
    } finally {
      await adapter.dispose(session);
    }
  });

  /*
  FNXC:GrokAcp 2026-07-12-07:15:
  Chat image attachments must arrive as ACP image ContentBlocks on session/prompt.
  */
  it("promptWithFallback forwards chat image options into session/prompt", async () => {
    const chunks: string[] = [];
    const adapter = makeAdapter();
    const { session } = await adapter.createSession(
      makeOptions({
        onText: (t) => {
          chunks.push(t);
        },
      }),
    );
    try {
      await expect(
        adapter.promptWithFallback(session, "describe this", {
          images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      expect(chunks.join("")).toContain("images=1");
    } finally {
      await adapter.dispose(session);
    }
  });

  it("dispose tears down the subprocess and is idempotent", async () => {
    const adapter = makeAdapter();
    const { session } = await adapter.createSession(makeOptions());
    expect(activeProcessCount()).toBe(1);
    await adapter.dispose(session);
    expect(activeProcessCount()).toBe(0);
    // second dispose must not throw
    await expect(adapter.dispose(session)).resolves.toBeUndefined();
    expect(activeProcessCount()).toBe(0);
  });

  it("promptWithFallback rejects when the session has no live connection", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.promptWithFallback({ sessionId: "x" } as never, "hi"),
    ).rejects.toThrow(/no live connection/);
  });

  it("describeModel returns the session model description", async () => {
    const adapter = makeAdapter();
    const { session } = await adapter.createSession(makeOptions());
    try {
      expect(adapter.describeModel(session)).toBe("acp/echo-agent");
    } finally {
      await adapter.dispose(session);
    }
  });
});

describe("AcpRuntimeAdapter custom-tools bridge (FNXC:AcpCustomTools)", () => {
  it("keeps the ACP session alive when the custom-tools bridge cannot start", async () => {
    let captured: { mcpServers?: unknown[] } | undefined;
    const onText = vi.fn();
    const adapter = makeAdapter();
    const bridgeSpy = vi.spyOn(toolBridge, "startFusionToolBridge").mockRejectedValue(new Error("bind failed"));
    const providerSpy = vi.spyOn(provider, "newAcpSession").mockImplementation(async (_connection, opts) => {
      captured = opts;
      return { sessionId: "degraded-session" };
    });
    try {
      const { session } = await adapter.createSession(makeOptions({
        onText,
        customTools: [{ name: "fn_task_list", execute: async () => "ok" }],
      }));
      expect(session.sessionId).toBe("degraded-session");
      expect(session.fusionToolBridgeError).toEqual({ reasonCode: "bridge-start-failed" });
      expect(captured?.mcpServers ?? []).toHaveLength(0);
      expect(onText).toHaveBeenCalledWith("FUSION_TOOL_BRIDGE_FAILED: bridge-start-failed");
      await adapter.dispose(session);
    } finally {
      providerSpy.mockRestore();
      bridgeSpy.mockRestore();
    }
  });

  it("registers the tool bridge in session/new mcpServers when customTools are provided", async () => {
    let captured: { mcpServers?: unknown[] } | undefined;
    const spy = vi
      .spyOn(provider, "newAcpSession")
      .mockImplementation(async (_connection, opts) => {
        captured = opts;
        return { sessionId: "bridge-test-session" };
      });
    const adapter = makeAdapter();
    let session: AcpSession | undefined;
    try {
      const created = await adapter.createSession(
        makeOptions({
          customTools: [
            {
              name: "fn_heartbeat_done",
              description: "Finish heartbeat",
              parameters: { type: "object", properties: {} },
              execute: async () => ({ text: "ok" }),
            },
          ],
        }),
      );
      session = created.session;
      expect(captured?.mcpServers).toHaveLength(1);
      expect(captured?.mcpServers?.[0]).toMatchObject({
        name: "fusion-custom-tools",
        command: process.execPath,
      });
      const bridgeUrl = (captured?.mcpServers?.[0] as { env?: Array<{ name: string; value: string }> }).env?.find(
        (entry) => entry.name === "FUSION_ACP_TOOL_BRIDGE_URL",
      )?.value;
      expect(bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      await adapter.dispose(session);
      await expect(fetch(`${bridgeUrl}/tool-call`)).rejects.toThrow();
    } finally {
      // Dispose in finally so a failed assertion cannot leak the bridge/socket.
      if (session) await adapter.dispose(session);
      spy.mockRestore();
    }
  });

  it("direct session.dispose exposes completion of bridge shutdown", async () => {
    let captured: { mcpServers?: unknown[] } | undefined;
    const spy = vi.spyOn(provider, "newAcpSession").mockImplementation(async (_connection, opts) => {
      captured = opts;
      return { sessionId: "direct-dispose-session" };
    });
    let session: AcpSession | undefined;
    try {
      session = (await makeAdapter().createSession(
        makeOptions({ customTools: [{ name: "fn_direct_dispose", execute: async () => "ok" }] }),
      )).session as AcpSession;
      const bridgeUrl = (captured?.mcpServers?.[0] as { env: Array<{ name: string; value: string }> })
        .env.find((entry) => entry.name === "FUSION_ACP_TOOL_BRIDGE_URL")!.value;
      session.dispose();
      await expect(session.disposePromise).resolves.toBeUndefined();
      await expect(fetch(`${bridgeUrl}/tool-call`)).rejects.toThrow();
    } finally {
      session?.dispose();
      await session?.disposePromise;
      spy.mockRestore();
    }
  });

  it("does not add a bridge when no customTools are supplied", async () => {
    let captured: { mcpServers?: unknown[] } | undefined;
    const spy = vi
      .spyOn(provider, "newAcpSession")
      .mockImplementation(async (_connection, opts) => {
        captured = opts;
        return { sessionId: "plain-session" };
      });
    const adapter = makeAdapter();
    try {
      const { session } = await adapter.createSession(makeOptions());
      expect(captured?.mcpServers ?? []).toHaveLength(0);
      await adapter.dispose(session);
    } finally {
      spy.mockRestore();
    }
  });

  it("disposes the bridge when session/new fails", async () => {
    const spy = vi
      .spyOn(provider, "newAcpSession")
      .mockImplementation(async () => {
        throw new Error("session/new failed");
      });
    const adapter = makeAdapter();
    try {
      await expect(
        adapter.createSession(
          makeOptions({
            customTools: [
              {
                name: "fn_task_list",
                description: "List",
                parameters: {},
                execute: async () => ({ text: "ok" }),
              },
            ],
          }),
        ),
      ).rejects.toThrow(/session\/new failed/);
      // The subprocess must be cleaned up even though session/new failed.
      expect(activeProcessCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
