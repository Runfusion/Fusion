import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Spy on both transports so we can assert which one streamSimple dispatches to.
const { streamViaCli, streamViaAcp } = vi.hoisted(() => ({
  streamViaCli: vi.fn(() => ({ kind: "cli" })),
  streamViaAcp: vi.fn(() => ({ kind: "acp" })),
}));
vi.mock("../provider.js", () => ({ streamViaCli }));
vi.mock("../acp-driver.js", () => ({ streamViaAcp }));
// Registering the provider kicks off async CLI presence/auth probes; stub them
// so the test doesn't trip the "real CLI launch blocked" guard.
vi.mock("../process-manager.js", () => ({
  validateCliPresenceAsync: vi.fn(async () => ({ ok: true })),
  validateCliAuthAsync: vi.fn(async () => ({ ok: true })),
  killAllProcesses: vi.fn(),
}));
// Belt-and-suspenders: no real CLI spawn even if a probe slips through.
vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, stdin: { write: vi.fn(), end: vi.fn() }, kill: vi.fn() })), execSync: vi.fn(() => Buffer.from("")) }));

vi.mock("@earendil-works/pi-ai", () => ({
  getModels: vi.fn(() => []),
  AssistantMessageEventStream: vi.fn(),
  calculateCost: vi.fn(),
}));

import register from "../../index.js";

function registerAndGetStreamSimple() {
  const calls: Array<[string, { streamSimple: (...a: unknown[]) => unknown }]> = [];
  const pi = {
    registerProvider: (name: string, cfg: { streamSimple: (...a: unknown[]) => unknown }) => calls.push([name, cfg]),
    on: vi.fn(),
    getAllTools: () => [],
    setActiveTools: vi.fn(),
  } as never;
  register(pi);
  return calls[0][1].streamSimple;
}

const MODEL = { id: "claude-sonnet-4-5" } as never;
const CTX = { messages: [{ role: "user", content: "hi" }], tools: [] } as never;

describe("streamSimple kill-switch dispatch (U11/R9/R14)", () => {
  const saved = { flag: process.env.FUSION_CLAUDE_ACP, bridge: process.env.FUSION_CLAUDE_ACP_BRIDGE };
  beforeEach(() => { streamViaCli.mockClear(); streamViaAcp.mockClear(); });
  afterEach(() => {
    process.env.FUSION_CLAUDE_ACP = saved.flag;
    process.env.FUSION_CLAUDE_ACP_BRIDGE = saved.bridge;
  });

  it("defaults to the -p path (streamViaCli) when the kill-switch is OFF", () => {
    delete process.env.FUSION_CLAUDE_ACP;
    const streamSimple = registerAndGetStreamSimple();
    streamSimple(MODEL, CTX, {});
    expect(streamViaCli).toHaveBeenCalledTimes(1);
    expect(streamViaAcp).not.toHaveBeenCalled();
  });

  it("stays on -p when the flag is set but NO bridge path is provided", () => {
    process.env.FUSION_CLAUDE_ACP = "1";
    delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
    const streamSimple = registerAndGetStreamSimple();
    streamSimple(MODEL, CTX, {});
    expect(streamViaCli).toHaveBeenCalledTimes(1);
    expect(streamViaAcp).not.toHaveBeenCalled();
  });

  it("dispatches to the ACP bridge when the flag AND a bridge path are set", () => {
    process.env.FUSION_CLAUDE_ACP = "1";
    process.env.FUSION_CLAUDE_ACP_BRIDGE = "/abs/claude-code-cli-acp";
    const streamSimple = registerAndGetStreamSimple();
    streamSimple(MODEL, CTX, {});
    expect(streamViaAcp).toHaveBeenCalledTimes(1);
    expect(streamViaCli).not.toHaveBeenCalled();
    // bridgePath forwarded; env restricted to the allow-list at spawn (driver).
    const opts = (streamViaAcp.mock.calls[0] as unknown[])[2] as { bridgePath?: string; bridgeEnv?: Record<string, unknown> };
    expect(opts.bridgePath).toBe("/abs/claude-code-cli-acp");
    expect(opts.bridgeEnv).toBeDefined();
  });
});
