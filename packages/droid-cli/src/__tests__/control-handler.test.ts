import { describe, it, expect, vi } from "vitest";
import type { ClaudeControlRequest } from "../types";
import {
  handleControlRequest,
  TOOL_EXECUTION_DENIED_MESSAGE,
  MCP_PREFIX,
} from "../control-handler";

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
    it("denies mcp__custom-tools__weather", () => {
      const msg = makeControlRequest("mcp__custom-tools__weather");

      const result = handleControlRequest(msg);

      expect(result.allowed).toBe(false);
      expect(result.response.response.response.behavior).toBe("deny");
      expect(result.response.response.response.message).toBe(
        TOOL_EXECUTION_DENIED_MESSAGE,
      );
    });

    it("denies mcp__custom-tools__deploy", () => {
      const msg = makeControlRequest("mcp__custom-tools__deploy");

      const result = handleControlRequest(msg);

      expect(result.allowed).toBe(false);
      expect(result.response.response.response.behavior).toBe("deny");
    });
  });

  describe("allows user MCP tools and other tools", () => {
    it("allows user MCP tool mcp__database__query", () => {
      const msg = makeControlRequest("mcp__database__query");

      const result = handleControlRequest(msg);

      expect(result.allowed).toBe(true);
      expect(result.response.response.response.behavior).toBe("allow");
    });

    it("allows built-in tool Read", () => {
      const msg = makeControlRequest("Read");

      const result = handleControlRequest(msg);

      expect(result.allowed).toBe(true);
      expect(result.response.response.response.behavior).toBe("allow");
    });

    it("allows internal tools like ToolSearch", () => {
      const msg = makeControlRequest("ToolSearch");

      const result = handleControlRequest(msg);

      expect(result.allowed).toBe(true);
      expect(result.response.response.response.behavior).toBe("allow");
    });

    it("allows unknown tools", () => {
      const msg = makeControlRequest("SomeUnknownTool");

      const result = handleControlRequest(msg);

      expect(result.allowed).toBe(true);
      expect(result.response.response.response.behavior).toBe("allow");
    });
  });

  describe("response format", () => {
    it("includes matching request_id", () => {
      const msg = makeControlRequest("Read", "custom-req-id-42");

      const result = handleControlRequest(msg);

      expect(result.response.request_id).toBe("custom-req-id-42");
    });

    it("returns a JSON-serializable response object", () => {
      const msg = makeControlRequest("Read");

      const result = handleControlRequest(msg);
      const serialized = JSON.stringify(result.response);

      expect(() => JSON.parse(serialized)).not.toThrow();
    });

    it("deny response includes message field", () => {
      const msg = makeControlRequest("mcp__custom-tools__foo");

      const result = handleControlRequest(msg);

      expect(result.response.response.response.message).toBe(
        TOOL_EXECUTION_DENIED_MESSAGE,
      );
    });

    it("allow response does not include a message field", () => {
      const msg = makeControlRequest("mcp__database__query");

      const result = handleControlRequest(msg);

      expect(result.response.response.response.message).toBeUndefined();
    });
  });

  describe("malformed input", () => {
    it("returns denied decision object for missing request_id", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const msg = {
        type: "control_request",
      } as unknown as ClaudeControlRequest;
      const result = handleControlRequest(msg);

      expect(result.allowed).toBe(false);
      expect(result.response.response.response.behavior).toBe("deny");
      spy.mockRestore();
    });

    it("returns denied decision object for missing request object", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const msg = {
        type: "control_request",
        request_id: "req-001",
      } as unknown as ClaudeControlRequest;
      const result = handleControlRequest(msg);

      expect(result.allowed).toBe(false);
      expect(result.response.response.response.behavior).toBe("deny");
      spy.mockRestore();
    });
  });
});
