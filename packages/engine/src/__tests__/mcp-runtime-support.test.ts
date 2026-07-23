import { describe, expect, it, vi } from "vitest";
import { logMcpForwardingSkipped, runtimeSupportsMcp } from "../mcp/mcp-runtime-support.js";

describe("runtimeSupportsMcp", () => {
  it("allows the default pi runtime for non-mock providers", () => {
    expect(runtimeSupportsMcp("pi", "anthropic")).toBe(true);
    expect(runtimeSupportsMcp("default-pi", undefined)).toBe(true);
  });

  it("allows Claude/ACP runtime identifiers", () => {
    expect(runtimeSupportsMcp("claude-code", "anthropic")).toBe(true);
    expect(runtimeSupportsMcp("vendor-acp-runtime", "anthropic")).toBe(true);
    // FNXC:OmpAcp 2026-07-11-23:35: Oh My Pi ACP runtime forwards mcpServers on session/new.
    expect(runtimeSupportsMcp("omp", "anthropic")).toBe(true);
  });

  it("rejects mock provider even on an otherwise supported runtime", () => {
    expect(runtimeSupportsMcp("pi", "mock")).toBe(false);
  });

  it("rejects unknown, undefined, or empty runtime identifiers", () => {
    expect(runtimeSupportsMcp(undefined, "anthropic")).toBe(false);
    expect(runtimeSupportsMcp("", "anthropic")).toBe(false);
    expect(runtimeSupportsMcp("paperclip", "anthropic")).toBe(false);
  });
});

describe("logMcpForwardingSkipped", () => {
  it("logs only metadata and server count", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logMcpForwardingSkipped({ runtimeId: "mock", provider: "mock", skippedCount: 2, lane: "executor" });
    const output = String(spy.mock.calls[0]?.[0] ?? "");
    spy.mockRestore();
    expect(output).toContain("mcp.forwarding.skipped");
    expect(output).toContain("skippedCount");
    expect(output).not.toContain("command");
    expect(output).not.toContain("SECRET");
  });

  it("does not log when no servers were skipped", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logMcpForwardingSkipped({ runtimeId: "mock", provider: "mock", skippedCount: 0 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
