import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { ClaudeControlRequest } from "../types";
import {
  handleControlRequest,
  TOOL_EXECUTION_DENIED_MESSAGE,
  MCP_PREFIX,
} from "../control-handler";

function createMockStdin() {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (data: Buffer) => chunks.push(data.toString()));
  return { stream, chunks };
}

function makeControlRequest(
  toolName: string,
  requestId = "req-test-001",
  input: Record<string, unknown> = {},
): ClaudeControlRequest {
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      input,
    },
  };
}

describe("control-handler", () => {
  describe("exported constants", () => {
    it("exports TOOL_EXECUTION_DENIED_MESSAGE", () => {
      expect(TOOL_EXECUTION_DENIED_MESSAGE).toBe(
        "Tool execution is unavailable in this environment.",
      );
    });

    it("exports MCP_PREFIX", () => {
      expect(MCP_PREFIX).toBe("mcp__");
    });
  });

  describe("denies custom MCP tools (mcp__custom-tools__*)", () => {
    it("denies mcp__custom-tools__weather and returns false", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("mcp__custom-tools__weather");

      const result = handleControlRequest(msg, stream);

      expect(result).toBe(false);
      const response = JSON.parse(chunks[0].trim());
      expect(response.response.response.behavior).toBe("deny");
      expect(response.response.response.message).toBe(
        TOOL_EXECUTION_DENIED_MESSAGE,
      );
    });

    it("denies mcp__custom-tools__deploy", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("mcp__custom-tools__deploy");

      const result = handleControlRequest(msg, stream);

      expect(result).toBe(false);
      const response = JSON.parse(chunks[0].trim());
      expect(response.response.response.behavior).toBe("deny");
    });
  });

  describe("allows user MCP tools and other tools", () => {
    it("allows user MCP tool mcp__database__query and returns true", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("mcp__database__query");

      const result = handleControlRequest(msg, stream);

      expect(result).toBe(true);
      const response = JSON.parse(chunks[0].trim());
      expect(response.response.response.behavior).toBe("allow");
    });

    it("allows built-in tool Read", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("Read");

      const result = handleControlRequest(msg, stream);

      expect(result).toBe(true);
      const response = JSON.parse(chunks[0].trim());
      expect(response.response.response.behavior).toBe("allow");
    });

    it("allows internal tools like ToolSearch", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("ToolSearch");

      const result = handleControlRequest(msg, stream);

      expect(result).toBe(true);
      const response = JSON.parse(chunks[0].trim());
      expect(response.response.response.behavior).toBe("allow");
    });

    it("allows unknown tools", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("SomeUnknownTool");

      const result = handleControlRequest(msg, stream);

      expect(result).toBe(true);
      const response = JSON.parse(chunks[0].trim());
      expect(response.response.response.behavior).toBe("allow");
    });
  });

  describe("response format", () => {
    it("includes matching request_id", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("Read", "custom-req-id-42");

      handleControlRequest(msg, stream);

      const response = JSON.parse(chunks[0].trim());
      expect(response.request_id).toBe("custom-req-id-42");
    });

    it("writes response as NDJSON (JSON + newline)", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("Read");

      handleControlRequest(msg, stream);

      expect(chunks[0].endsWith("\n")).toBe(true);
      expect(() => JSON.parse(chunks[0].trim())).not.toThrow();
    });

    it("deny response includes message field", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("mcp__custom-tools__foo");

      handleControlRequest(msg, stream);

      const response = JSON.parse(chunks[0].trim());
      expect(response.response.response.message).toBe(
        TOOL_EXECUTION_DENIED_MESSAGE,
      );
    });

    it("allow response does not include a message field", () => {
      const { stream, chunks } = createMockStdin();
      const msg = makeControlRequest("mcp__database__query");

      handleControlRequest(msg, stream);

      const response = JSON.parse(chunks[0].trim());
      expect(response.response.response.message).toBeUndefined();
    });
  });

  describe("malformed input", () => {
    it("returns false for missing request_id", () => {
      const { stream } = createMockStdin();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const msg = {
        type: "control_request",
      } as unknown as ClaudeControlRequest;
      const result = handleControlRequest(msg, stream);

      expect(result).toBe(false);
      spy.mockRestore();
    });

    it("returns false for missing request object", () => {
      const { stream } = createMockStdin();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const msg = {
        type: "control_request",
        request_id: "req-001",
      } as unknown as ClaudeControlRequest;
      const result = handleControlRequest(msg, stream);

      expect(result).toBe(false);
      spy.mockRestore();
    });
  });
});
