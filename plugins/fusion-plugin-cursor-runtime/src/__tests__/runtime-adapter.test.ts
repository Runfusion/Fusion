import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorRuntimeAdapter } from "../runtime-adapter.js";
import { toolsToMcpToolDefs } from "../tool-bridge.js";
import * as transport from "../prompt-transport.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const tempWorktree = () => { const dir = mkdtempSync(join(tmpdir(), "fusion-cursor-runtime-")); dirs.push(dir); return dir; };
const schemaFiles = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`fusion-cursor-mcp-schemas-${process.pid}-`)).sort();

describe("CursorRuntimeAdapter", () => {
  it("maps only executable fn_* tools from the engine-scoped set", () => {
    expect(toolsToMcpToolDefs([
      { name: "fn_task_list", execute: vi.fn() },
      { name: "plugin_tool", execute: vi.fn() },
      { name: "fn_missing_execute" },
    ]).map((tool) => tool.name)).toEqual(["fn_task_list"]);
  });

  it("normalizes model and creates a cwd-bound session", async () => {
    const result = await new CursorRuntimeAdapter().createSession({ cwd: "/tmp", systemPrompt: "sys", defaultModelId: "cursor-cli/pro", tools: "readonly" });
    expect(result.session.model).toBe("pro");
    expect(result.session.cwd).toBe("/tmp");
    expect(result.session.tools).toBe("readonly");
    expect(new CursorRuntimeAdapter().describeModel(result.session)).toBe("cursor-cli/pro");
  });
  it("fuses the first prompt and resumes retained Cursor chat", async () => {
    const spy = vi.spyOn(transport, "launchCursorPrompt").mockResolvedValueOnce({ sessionId: "chat-1", text: "first" }).mockResolvedValueOnce({ sessionId: "chat-1", text: "second" });
    const text = vi.fn(); const adapter = new CursorRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "system", onText: text, tools: "readonly" });
    await adapter.promptWithFallback(session, "one"); await adapter.promptWithFallback(session, "two");
    expect(spy.mock.calls[0][0]).toMatchObject({ cwd: "/tmp", tools: "readonly", resumeId: undefined });
    expect(spy.mock.calls[0][0].prompt).toContain("system");
    expect(spy.mock.calls[1][0]).toMatchObject({ prompt: "two", resumeId: "chat-1", tools: "readonly" });
  });
  it("does not publish an arbitrary custom tool merely because its name starts with fn_", async () => {
    const cwd = tempWorktree();
    const { session } = await new CursorRuntimeAdapter().createSession({
      cwd,
      systemPrompt: "system",
      customTools: [{ name: "fn_evil", execute: vi.fn() }],
    });
    expect(session.toolBridge).toBeUndefined();
    expect(() => readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8")).toThrow();
  });

  it("renews an active Cursor MCP lease before the stale threshold", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-15T23:00:00Z"));
    const cwd = tempWorktree();
    const { session } = await new CursorRuntimeAdapter().createSession({ cwd, systemPrompt: "system", fusionTools: [{ name: "fn_task_list", execute: vi.fn() }] });
    const statePath = join(cwd, ".cursor", ".fusion-mcp-state.json");
    const initial = JSON.parse(readFileSync(statePath, "utf8")).leases[session.mcpServerKey!].heartbeatAt;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const renewed = JSON.parse(readFileSync(statePath, "utf8")).leases[session.mcpServerKey!].heartbeatAt;
    expect(renewed).toBeGreaterThan(initial);
    await session.dispose();
  });

  it("disposes a started bridge when malformed operator config prevents lease staging", async () => {
    const cwd = tempWorktree(); const cursor = join(cwd, ".cursor"); mkdirSync(cursor);
    const config = join(cursor, "mcp.json"); const malformed = "{broken"; writeFileSync(config, malformed);
    const before = schemaFiles();
    const { session } = await new CursorRuntimeAdapter().createSession({
      cwd,
      systemPrompt: "system",
      fusionTools: [{ name: "fn_task_list", execute: vi.fn() }],
    });
    expect(session.fusionToolBridgeError).toEqual({ reasonCode: "bridge-start-failed" });
    expect(session.toolBridge).toBeUndefined();
    expect(schemaFiles()).toEqual(before);
    expect(readFileSync(config, "utf8")).toBe(malformed);
  });

  it("restores the session id on transport failure and disposal aborts an active turn exactly once", async () => {
    vi.spyOn(transport, "launchCursorPrompt").mockRejectedValueOnce(new Error("failed"));
    const adapter = new CursorRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "system" }); session.sessionId = "prior";
    await expect(adapter.promptWithFallback(session, "x")).rejects.toThrow("failed"); expect(session.sessionId).toBe("prior");

    let signal: AbortSignal | undefined;
    vi.spyOn(transport, "launchCursorPrompt").mockImplementationOnce((input) => new Promise((_resolve, reject) => {
      signal = input.signal;
      input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const active = adapter.promptWithFallback(session, "active");
    session.dispose(); session.dispose();
    expect(signal?.aborted).toBe(true);
    await expect(active).rejects.toThrow("aborted");
    expect(session.activeAbortController).toBeUndefined();
  });
});
