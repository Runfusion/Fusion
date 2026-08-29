import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { probeAcpReadiness } from "../probe.js";
import { killAllProcesses, activeProcessCount } from "../process-manager.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-agent.mjs", import.meta.url));

afterEach(() => {
  killAllProcesses();
});

function baseOpts(extraEnv: Record<string, string> = {}, timeoutMs = 10_000) {
  return {
    binaryPath: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    env: extraEnv as NodeJS.ProcessEnv,
    timeoutMs,
  };
}

describe("probeAcpReadiness", () => {
  it("reports ok against the echo fixture and tears the process down", async () => {
    const status = await probeAcpReadiness(baseOpts());
    expect(status).toMatchObject({ ok: true, reason: "ok", authRequired: false });
    expect(activeProcessCount()).toBe(0);
  });

  it("reports ok with authRequired when the agent advertises authMethods", async () => {
    const status = await probeAcpReadiness(baseOpts({ ACP_FIXTURE_REQUIRE_AUTH: "1" }));
    expect(status.ok).toBe(true);
    expect(status.reason).toBe("ok");
    expect(status.authRequired).toBe(true);
  });

  it("maps a nonexistent binary to missing_binary without throwing", async () => {
    const status = await probeAcpReadiness({
      binaryPath: "/nonexistent/acp-agent-xyz",
      args: [],
      cwd: process.cwd(),
      env: {} as NodeJS.ProcessEnv,
      timeoutMs: 2000,
    });
    expect(status).toMatchObject({ ok: false, reason: "missing_binary" });
    expect(activeProcessCount()).toBe(0);
  });

  it("maps a version mismatch to incompatible_protocol", async () => {
    const status = await probeAcpReadiness(baseOpts({ ACP_FIXTURE_PROTOCOL_VERSION: "999" }));
    expect(status).toMatchObject({ ok: false, reason: "incompatible_protocol", protocolVersion: 999 });
    expect(activeProcessCount()).toBe(0);
  });

  it("maps a stalled handshake to handshake_timeout and kills the process", async () => {
    const status = await probeAcpReadiness(baseOpts({ ACP_FIXTURE_HANG_INITIALIZE: "1" }, 300));
    expect(status).toMatchObject({ ok: false, reason: "handshake_timeout" });
    expect(activeProcessCount()).toBe(0);
  });
});
