import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import {
  connect,
  IncompatibleProtocolError,
  HandshakeTimeoutError,
  createDefaultClientHandler,
} from "../provider.js";
import { killAllProcesses, activeProcessCount } from "../process-manager.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-agent.mjs", import.meta.url));

afterEach(() => {
  killAllProcesses();
});

function baseOpts(extraEnv: Record<string, string> = {}) {
  return {
    binaryPath: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    env: extraEnv as NodeJS.ProcessEnv,
    advertiseFs: { read: false, write: false },
    initializeTimeoutMs: 10_000,
  };
}

describe("connect() handshake", () => {
  it("completes initialize against the echo fixture and exposes conn", async () => {
    const conn = await connect(baseOpts());
    try {
      expect(conn.conn).toBeDefined();
      expect(typeof conn.conn.newSession).toBe("function");
      expect(conn.authMethods).toEqual([]);
      expect(conn.agentCapabilities).toMatchObject({ loadSession: false });
      expect(conn.child.pid).toBeGreaterThan(0);
    } finally {
      conn.dispose();
    }
  });

  it("surfaces non-empty authMethods when the agent requires auth", async () => {
    const conn = await connect(baseOpts({ ACP_FIXTURE_REQUIRE_AUTH: "1" }));
    try {
      expect(conn.authMethods.length).toBeGreaterThan(0);
      expect(conn.authMethods[0]).toHaveProperty("id");
    } finally {
      conn.dispose();
    }
  });

  it("throws IncompatibleProtocolError on a version mismatch and kills the child", async () => {
    await expect(
      connect(baseOpts({ ACP_FIXTURE_PROTOCOL_VERSION: "999" })),
    ).rejects.toBeInstanceOf(IncompatibleProtocolError);
    // child must have been disposed; nothing left in the registry
    expect(activeProcessCount()).toBe(0);
  });

  it("rejects with HandshakeTimeoutError when the agent never responds, and kills the child", async () => {
    await expect(
      connect({ ...baseOpts({ ACP_FIXTURE_HANG_INITIALIZE: "1" }), initializeTimeoutMs: 300 }),
    ).rejects.toBeInstanceOf(HandshakeTimeoutError);
    expect(activeProcessCount()).toBe(0);
  });

  it("rejects with a missing-binary (ENOENT) error for a nonexistent binary", async () => {
    await expect(
      connect({
        binaryPath: "/nonexistent/acp-agent-does-not-exist",
        args: [],
        cwd: process.cwd(),
        env: {} as NodeJS.ProcessEnv,
        advertiseFs: { read: false, write: false },
        initializeTimeoutMs: 2000,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(activeProcessCount()).toBe(0);
  });

  it("dispose() removes the registry entry and kills the child", async () => {
    const conn = await connect(baseOpts());
    expect(activeProcessCount()).toBe(1);
    conn.dispose();
    expect(activeProcessCount()).toBe(0);
    // idempotent
    expect(() => conn.dispose()).not.toThrow();
  });

  it("default client handler cancels permission requests and no-ops updates", async () => {
    const handler = createDefaultClientHandler();
    await expect(handler.sessionUpdate({} as never)).resolves.toBeUndefined();
    const res = await handler.requestPermission({} as never);
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
