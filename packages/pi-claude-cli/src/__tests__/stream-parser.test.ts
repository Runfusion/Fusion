import { describe, it, expect, vi } from "vitest";
import { parseLine } from "../stream-parser";
import type {
  ClaudeStreamEventMessage,
  ClaudeResultMessage,
  ClaudeSystemMessage,
} from "../types";

describe("parseLine", () => {
  describe("valid JSON parsing", () => {
    it("parses a valid stream_event message", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { usage: { input_tokens: 10 } },
        },
      });
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("stream_event");
      expect((result as ClaudeStreamEventMessage).event.type).toBe(
        "message_start",
      );
    });

    it("parses a valid result message", () => {
      const line = JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Hello world",
      });
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("result");
      expect((result as ClaudeResultMessage).subtype).toBe("success");
      expect((result as ClaudeResultMessage).result).toBe("Hello world");
    });

    it("parses a valid system message", () => {
      const line = JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session",
      });
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("system");
      expect((result as ClaudeSystemMessage).subtype).toBe("init");
    });

    it("parses a valid control_request message", () => {
      const line = JSON.stringify({
        type: "control_request",
        request_id: "req-001",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          input: { file_path: "/test" },
        },
      });
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("control_request");
    });
  });

  describe("empty and whitespace lines", () => {
    it("returns null for empty string", () => {
      expect(parseLine("")).toBeNull();
    });

    it("returns null for whitespace-only line", () => {
      expect(parseLine("   ")).toBeNull();
    });

    it("returns null for tab-only line", () => {
      expect(parseLine("\t\t")).toBeNull();
    });

    it("returns null for newline-only line", () => {
      expect(parseLine("\n")).toBeNull();
    });
  });

  describe("non-JSON lines (debug noise)", () => {
    it("returns null for SandboxDebug output", () => {
      expect(parseLine("[SandboxDebug] loading config...")).toBeNull();
    });

    it("returns null for plain text", () => {
      expect(parseLine("Some debug message")).toBeNull();
    });

    it("returns null for lines starting with [", () => {
      expect(parseLine("[INFO] starting up")).toBeNull();
    });

    it("returns null for lines starting with #", () => {
      expect(parseLine("# comment")).toBeNull();
    });
  });

  describe("malformed JSON", () => {
    it("returns null for truncated JSON without throwing", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(parseLine('{"type":"stream_event","event":')).toBeNull();
      spy.mockRestore();
    });

    it("returns null for invalid JSON syntax without throwing", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(parseLine("{not valid json}")).toBeNull();
      spy.mockRestore();
    });

    it("returns null for JSON with trailing comma without throwing", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(parseLine('{"type":"test",}')).toBeNull();
      spy.mockRestore();
    });
  });

  describe("non-object JSON", () => {
    it("returns null for JSON array", () => {
      expect(parseLine("[1, 2, 3]")).toBeNull();
    });

    it("returns null for JSON string", () => {
      expect(parseLine('"hello"')).toBeNull();
    });

    it("returns null for JSON number", () => {
      expect(parseLine("42")).toBeNull();
    });

    it("returns null for JSON null", () => {
      expect(parseLine("null")).toBeNull();
    });

    it("returns null for JSON boolean", () => {
      expect(parseLine("true")).toBeNull();
    });
  });

  describe("whitespace handling", () => {
    it("trims leading whitespace before parsing", () => {
      const line = `  ${JSON.stringify({ type: "system", subtype: "init" })}`;
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("system");
    });

    it("trims trailing whitespace before parsing", () => {
      const line = `${JSON.stringify({ type: "system", subtype: "init" })}  `;
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("system");
    });

    it("trims both leading and trailing whitespace", () => {
      const line = `  ${JSON.stringify({ type: "result", subtype: "success" })}  `;
      const result = parseLine(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("result");
    });
  });

  describe("resilience", () => {
    it("never throws regardless of input", () => {
      const inputs = [
        "",
        "   ",
        "garbage",
        "{bad",
        "null",
        "undefined",
        "[1,2]",
        '{"valid": true}',
        "[SandboxDebug] test",
        '{"type":"stream_event","event":{"type":"message_start"}}',
      ];
      for (const input of inputs) {
        expect(() => parseLine(input)).not.toThrow();
      }
    });
  });
});
