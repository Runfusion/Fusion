import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLogger } from "../agent-logger.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe("AgentLogger failed-tool diagnostics (FN-8697)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("persists redacted error detail even when normal tool output persistence is disabled", async () => {
    const appendLog = vi.fn().mockResolvedValue(undefined);
    const logger = new AgentLogger({
      taskId: "FN-8697",
      appendLog,
      persistAgentToolOutput: false,
    });
    const secret = "sk-live-ABCDEFG1234567890abcdef";
    // FNXC:AgentLogDiagnostics 2026-08-01-19:24: Tool diagnostics must honor every shared-redactor match, including low-entropy opaque values, before either log sink persists them.
    const opaqueToken = "a".repeat(40);
    const detail = `Error: edit failed\nAuthorization: Bearer ${secret}\ntoken=${opaqueToken}\n    at edit (tools.ts:12:4)`;

    logger.onToolEnd("edit", true, detail);
    await logger.flush();

    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({
      type: "tool_error",
      text: "edit",
      detail: expect.stringContaining("Error: edit failed"),
    }));
    const persisted = appendLog.mock.calls[0][0].detail as string;
    expect(persisted).toContain("at edit (tools.ts:12:4)");
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(opaqueToken);
  });
});
