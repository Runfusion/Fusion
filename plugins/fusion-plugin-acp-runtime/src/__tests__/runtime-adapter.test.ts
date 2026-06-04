import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { AcpRuntimeAdapter } from "../runtime-adapter.js";
import { killAllProcesses, activeProcessCount } from "../process-manager.js";
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

  it("promptWithFallback drives a full turn to completion", async () => {
    const adapter = makeAdapter();
    const { session } = await adapter.createSession(makeOptions());
    try {
      await expect(adapter.promptWithFallback(session, "hello")).resolves.toBeUndefined();
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
