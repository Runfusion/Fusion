/**
 * Live smoke against an operator-installed `omp` binary.
 * Skips automatically when `omp` is not on PATH (CI without omp).
 *
 * FNXC:OmpAcp 2026-07-11-23:45:
 * Verify the plugin's ACP client can initialize + open a session against real
 * `omp acp` (not the echo fixture). Handshake + session/new is the acceptance bar.
 *
 * FNXC:OmpAcp 2026-07-13-22:50:
 * Probe at module load so it.skipIf sees a stable flag (beforeAll is too late for skipIf).
 */
import { afterEach, describe, expect, it } from "vitest";
import { connect, killAllProcesses, newAcpSession } from "../acp/index.js";
import { buildOmpAcpArgs, buildOmpAcpRuntimeSettings, OMP_ACP_ENV_ALLOWLIST } from "../acp-settings.js";
import { buildSpawnEnv } from "../acp/process-manager.js";
import { probeOmpBinary } from "../probe.js";
import { OmpRuntimeAdapter } from "../runtime-adapter.js";

const ompProbe = await probeOmpBinary({ timeoutMs: 5000 });
const ompAvailable = ompProbe.available;
const ompBinary = ompProbe.binaryPath ?? ompProbe.binaryName ?? "omp";

afterEach(() => {
  killAllProcesses();
});

describe("omp acp live", () => {
  it("probes the local omp binary", async () => {
    const status = await probeOmpBinary({ timeoutMs: 5000 });
    if (!status.available) {
      expect(status.available).toBe(false);
      return;
    }
    expect(status.authenticated).toBe(true);
    expect(status.version).toMatch(/omp|pi|\d/i);
  });

  it.skipIf(!ompAvailable)("handshakes initialize + session/new against omp acp", async () => {
    const settings = buildOmpAcpRuntimeSettings({ binary: ompBinary });
    const env = buildSpawnEnv([...OMP_ACP_ENV_ALLOWLIST], { required: [] });

    const connection = await connect({
      binaryPath: ompBinary,
      args: buildOmpAcpArgs(),
      cwd: process.cwd(),
      env,
      advertiseFs: { read: false, write: false },
      initializeTimeoutMs: 30_000,
      authenticate: settings.acpAuthenticate as {
        preferMethods?: string[];
        methodId?: string;
        meta?: Record<string, unknown>;
        require?: boolean;
      },
    });

    try {
      expect(connection.child.pid).toBeGreaterThan(0);
      expect(connection.conn).toBeDefined();
      expect(Array.isArray(connection.authMethods)).toBe(true);

      const session = await newAcpSession(connection, {
        cwd: process.cwd(),
        mcpServers: [],
      });
      expect(session.sessionId).toBeTruthy();
      expect(typeof session.sessionId).toBe("string");
    } finally {
      connection.dispose();
    }
  }, 60_000);

  it.skipIf(!ompAvailable)("OmpRuntimeAdapter createSession opens a live connection", async () => {
    const texts: string[] = [];
    const adapter = new OmpRuntimeAdapter({ binary: ompBinary });
    const { session } = await adapter.createSession({
      cwd: process.cwd(),
      systemPrompt: "You are a test harness. Reply briefly.",
      onText: (t) => texts.push(t),
    });

    try {
      expect(session.connection).toBeTruthy();
      expect(session.sessionId).toBeTruthy();
      expect(adapter.describeModel(session)).toMatch(/^omp\//);

      const result = await adapter.promptWithFallback(session, "Reply with exactly: OK");
      const combined = texts.join("");
      const hasOutput = combined.trim().length > 0;
      const hasStop =
        result && typeof result === "object" && "stopReason" in result && Boolean(result.stopReason);
      expect(hasOutput || hasStop || Boolean(session.state.errorMessage)).toBe(true);
    } finally {
      await adapter.dispose(session);
    }
  }, 120_000);
});
