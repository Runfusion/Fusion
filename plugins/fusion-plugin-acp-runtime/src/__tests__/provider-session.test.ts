import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  connect,
  newAcpSession,
  promptAcpSession,
  cancelAcpSession,
  loadAcpSession,
  createBridgingClientHandler,
  type AcpConnection,
} from "../provider.js";
import { buildPromptBlocks } from "../prompt-builder.js";
import { killAllProcesses } from "../process-manager.js";

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

async function open(extraEnv: Record<string, string> = {}): Promise<AcpConnection> {
  return connect(baseOpts(extraEnv));
}

describe("session driving helpers", () => {
  it("newAcpSession opens a session and returns a sessionId", async () => {
    const conn = await open();
    try {
      const { sessionId } = await newAcpSession(conn, { cwd: process.cwd() });
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);
    } finally {
      conn.dispose();
    }
  });

  it("newAcpSession forwards non-empty mcpServers to session/new (U10 — Route A)", async () => {
    const newSession = vi.fn(async () => ({ sessionId: "s1", modes: undefined }));
    const fakeConn = { conn: { newSession } } as unknown as AcpConnection;
    const servers = [
      { name: "custom-tools", command: "node", args: ["server.cjs"], env: [] as { name: string; value: string }[] },
    ];
    await newAcpSession(fakeConn, { cwd: "/tmp/work", mcpServers: servers });
    expect(newSession).toHaveBeenCalledWith({ cwd: "/tmp/work", mcpServers: servers });
  });

  it("newAcpSession defaults mcpServers to [] when absent (Route B read-only posture)", async () => {
    const newSession = vi.fn(async () => ({ sessionId: "s1", modes: undefined }));
    const fakeConn = { conn: { newSession } } as unknown as AcpConnection;
    await newAcpSession(fakeConn, { cwd: "/tmp/work" });
    expect(newSession).toHaveBeenCalledWith({ cwd: "/tmp/work", mcpServers: [] });
  });

  it("promptAcpSession resolves with end_turn for a normal turn", async () => {
    const conn = await open();
    try {
      const { sessionId } = await newAcpSession(conn, { cwd: process.cwd() });
      const stopReason = await promptAcpSession(conn, sessionId, buildPromptBlocks("hello"));
      expect(stopReason).toBe("end_turn");
    } finally {
      conn.dispose();
    }
  });

  it("cancelAcpSession releases a mid-turn prompt with the cancelled stop reason", async () => {
    const conn = await open({ ACP_FIXTURE_HANG_PROMPT: "1" });
    try {
      const { sessionId } = await newAcpSession(conn, { cwd: process.cwd() });
      const promptPromise = promptAcpSession(conn, sessionId, buildPromptBlocks("hello"));
      // Give the turn a tick to register the hang before cancelling.
      await new Promise((r) => setImmediate(r));
      await cancelAcpSession(conn, sessionId);
      const stopReason = await promptPromise;
      expect(stopReason).toBe("cancelled");
    } finally {
      conn.dispose();
    }
  });

  it("cancelAcpSession swallows errors (fire-and-forget)", async () => {
    const conn = await open();
    try {
      const { sessionId } = await newAcpSession(conn, { cwd: process.cwd() });
      conn.dispose(); // kill the child so cancel cannot round-trip
      await expect(cancelAcpSession(conn, sessionId)).resolves.toBeUndefined();
    } finally {
      conn.dispose();
    }
  });

  it("loadAcpSession uses session/load when the agent advertises loadSession", async () => {
    const conn = await open({ ACP_FIXTURE_LOAD_SESSION: "1" });
    try {
      expect(conn.agentCapabilities).toMatchObject({ loadSession: true });
      const result = await loadAcpSession(conn, {
        sessionId: "prior-session-id",
        cwd: process.cwd(),
      });
      // session/load echoes back the requested id (no fresh id minted).
      expect(result.sessionId).toBe("prior-session-id");
    } finally {
      conn.dispose();
    }
  });

  it("bridging client handler surfaces a rich prompt turn's updates onto callbacks (U4)", async () => {
    const onText = vi.fn<(t: string) => void>();
    const onThinking = vi.fn<(t: string) => void>();
    const onToolStart = vi.fn<(name: string, args?: unknown) => void>();
    const onToolEnd = vi.fn<(name: string, isError: boolean, result?: unknown) => void>();

    const conn = await connect({
      ...baseOpts({ ACP_FIXTURE_RICH_PROMPT: "1" }),
      clientHandler: createBridgingClientHandler({ onText, onThinking, onToolStart, onToolEnd }).handler,
    });
    try {
      const { sessionId } = await newAcpSession(conn, { cwd: process.cwd() });
      const stopReason = await promptAcpSession(conn, sessionId, buildPromptBlocks("go"));
      expect(stopReason).toBe("end_turn");

      // The SDK prompt promise resolves only after all updates are delivered.
      expect(onText.mock.calls.map((c) => c[0]).join("")).toBe("Working on it.");
      expect(onThinking).toHaveBeenCalledWith("Let me think about this.");
      expect(onToolStart).toHaveBeenCalledWith("Run tests", { command: "pnpm test" });
      expect(onToolEnd).toHaveBeenCalledWith("Run tests", false, { exitCode: 0 });
      // The plan surfaces as a thinking line.
      expect(onThinking.mock.calls.some((c) => String(c[0]).includes("Fix the bug"))).toBe(true);
    } finally {
      conn.dispose();
    }
  });

  it("loadAcpSession falls back to newSession when loadSession is not advertised", async () => {
    const conn = await open(); // loadSession defaults false
    try {
      expect(conn.agentCapabilities).toMatchObject({ loadSession: false });
      const result = await loadAcpSession(conn, {
        sessionId: "prior-session-id",
        cwd: process.cwd(),
      });
      // Fresh session: a new id is minted, not the prior one.
      expect(result.sessionId).not.toBe("prior-session-id");
      expect(result.sessionId.length).toBeGreaterThan(0);
    } finally {
      conn.dispose();
    }
  });
});

describe("sessionId untrusted-input bounding (U6 / Risk S7)", () => {
  // A fake connection that returns a malicious agent-supplied sessionId so we can
  // assert the helper normalizes it before it is ever stored / path-joined —
  // without spawning a real agent.
  function fakeConn(sessionId: string, opts?: { loadSession?: boolean }): AcpConnection {
    const conn = {
      newSession: vi.fn(async () => ({ sessionId, modes: undefined })),
      loadSession: vi.fn(async () => ({ modes: undefined })),
    };
    return {
      conn: conn as unknown as AcpConnection["conn"],
      child: {} as AcpConnection["child"],
      agentCapabilities: { loadSession: opts?.loadSession === true },
      authMethods: [],
      stderr: () => "",
      dispose: () => {},
    };
  }

  it("normalizes a sessionId containing path separators from session/new", async () => {
    const conn = fakeConn("../../etc/passwd");
    const { sessionId } = await newAcpSession(conn, { cwd: process.cwd() });
    expect(sessionId).not.toContain("/");
    expect(sessionId).not.toContain("..");
  });

  it("bounds an absurdly long agent sessionId", async () => {
    const conn = fakeConn("s".repeat(100_000));
    const { sessionId } = await newAcpSession(conn, { cwd: process.cwd() });
    expect(sessionId.length).toBeLessThanOrEqual(256);
  });

  it("normalizes the resume id passed to loadAcpSession", async () => {
    const conn = fakeConn("ignored", { loadSession: true });
    const { sessionId } = await loadAcpSession(conn, {
      sessionId: "../../../root/.ssh/id_rsa",
      cwd: process.cwd(),
    });
    expect(sessionId).not.toContain("/");
    expect(sessionId).not.toContain("..");
    // The normalized id must also be what is forwarded over the wire to
    // loadSession() — not the raw traversal string.
    const loadSessionMock = conn.conn.loadSession as unknown as ReturnType<typeof vi.fn>;
    expect(loadSessionMock).toHaveBeenCalledTimes(1);
    const sentId = loadSessionMock.mock.calls[0][0].sessionId as string;
    expect(sentId).toBe(sessionId);
    expect(sentId).not.toContain("/");
    expect(sentId).not.toContain("..");
  });
});
