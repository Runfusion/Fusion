import { describe, expect, it } from "vitest";
import { parseCursorStreamLine } from "../stream-parser.js";
describe("parseCursorStreamLine", () => {
  it("parses verified Cursor events", () => {
    expect(parseCursorStreamLine('{"type":"system","subtype":"init","session_id":"s","cwd":"/tmp"}')).toEqual({ kind: "system-init", sessionId: "s", cwd: "/tmp", model: undefined });
    expect(parseCursorStreamLine('{"type":"thinking","subtype":"delta","text":"thought"}')).toEqual({ kind: "thinking-delta", text: "thought" });
    expect(parseCursorStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}')).toEqual({ kind: "assistant-text", text: "ok" });
    expect(parseCursorStreamLine('{"type":"tool_call","subtype":"started","call_id":"id\\nnext","tool_call":{"readToolCall":{"args":{"path":"x"}}}}')).toMatchObject({ kind: "tool-call-started", name: "read", callId: "id\nnext" });
    expect(parseCursorStreamLine('{"type":"result","is_error":false,"result":"ok","session_id":"s"}')).toMatchObject({ kind: "result", text: "ok", sessionId: "s" });
  });
  it("does not throw for incomplete or unknown lines", () => { expect(parseCursorStreamLine("{")).toEqual({ kind: "unknown" }); expect(parseCursorStreamLine("")).toEqual({ kind: "unknown" }); expect(parseCursorStreamLine('{"type":"new"}')).toEqual({ kind: "unknown" }); });
});
