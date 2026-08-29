import { describe, it, expect } from "vitest";
import {
  TOOL_MAPPINGS,
  CUSTOM_TOOLS_MCP_PREFIX,
  mapDroidToolNameToPi,
  mapPiToolNameToDroid,
  translateDroidArgsToPi,
  translatePiArgsToDroid,
  isCustomToolName,
} from "../tool-mapping";

describe("tool-mapping", () => {
  describe("TOOL_MAPPINGS", () => {
    it("exports 6 tool mappings", () => {
      expect(TOOL_MAPPINGS).toHaveLength(6);
    });
  });

  describe("mapDroidToolNameToPi", () => {
    it("maps Read to read", () => {
      expect(mapDroidToolNameToPi("Read")).toBe("read");
    });

    it("maps Write to write", () => {
      expect(mapDroidToolNameToPi("Write")).toBe("write");
    });

    it("maps Edit to edit", () => {
      expect(mapDroidToolNameToPi("Edit")).toBe("edit");
    });

    it("maps Bash to bash", () => {
      expect(mapDroidToolNameToPi("Bash")).toBe("bash");
    });

    it("maps Grep to grep", () => {
      expect(mapDroidToolNameToPi("Grep")).toBe("grep");
    });

    it("maps Glob to find", () => {
      expect(mapDroidToolNameToPi("Glob")).toBe("find");
    });

    it("passes through unknown tool names unchanged", () => {
      expect(mapDroidToolNameToPi("UnknownTool")).toBe("UnknownTool");
    });

    it("is case-insensitive for Claude tool names", () => {
      expect(mapDroidToolNameToPi("read")).toBe("read");
      expect(mapDroidToolNameToPi("READ")).toBe("read");
    });
  });

  describe("mapPiToolNameToDroid", () => {
    it("maps read to Read", () => {
      expect(mapPiToolNameToDroid("read")).toBe("Read");
    });

    it("maps write to Write", () => {
      expect(mapPiToolNameToDroid("write")).toBe("Write");
    });

    it("maps edit to Edit", () => {
      expect(mapPiToolNameToDroid("edit")).toBe("Edit");
    });

    it("maps bash to Bash", () => {
      expect(mapPiToolNameToDroid("bash")).toBe("Bash");
    });

    it("maps grep to Grep", () => {
      expect(mapPiToolNameToDroid("grep")).toBe("Grep");
    });

    it("maps find to Glob", () => {
      expect(mapPiToolNameToDroid("find")).toBe("Glob");
    });

    it("maps glob to Glob (asymmetry: both find and glob map to Glob)", () => {
      expect(mapPiToolNameToDroid("glob")).toBe("Glob");
    });

    it("passes through unknown tool names unchanged", () => {
      expect(mapPiToolNameToDroid("unknownTool")).toBe("unknownTool");
    });
  });

  describe("translateDroidArgsToPi", () => {
    it("renames file_path to path for Read", () => {
      const result = translateDroidArgsToPi("Read", {
        file_path: "/foo",
        offset: 10,
      });
      expect(result).toEqual({ path: "/foo", offset: 10 });
    });

    it("renames file_path to path for Write", () => {
      const result = translateDroidArgsToPi("Write", {
        file_path: "/bar",
        content: "hello",
      });
      expect(result).toEqual({ path: "/bar", content: "hello" });
    });

    it("renames file_path, old_string, new_string for Edit", () => {
      const result = translateDroidArgsToPi("Edit", {
        file_path: "/f",
        old_string: "a",
        new_string: "b",
      });
      expect(result).toEqual({ path: "/f", oldText: "a", newText: "b" });
    });

    it("passes through Bash args unchanged (no renames)", () => {
      const result = translateDroidArgsToPi("Bash", { command: "ls" });
      expect(result).toEqual({ command: "ls" });
    });

    it("renames head_limit to limit for Grep", () => {
      const result = translateDroidArgsToPi("Grep", {
        pattern: "x",
        head_limit: 5,
      });
      expect(result).toEqual({ pattern: "x", limit: 5 });
    });

    it("passes through Glob args unchanged (no renames)", () => {
      const result = translateDroidArgsToPi("Glob", { pattern: "*.ts" });
      expect(result).toEqual({ pattern: "*.ts" });
    });

    it("passes through args for unknown tools unchanged", () => {
      const result = translateDroidArgsToPi("UnknownTool", {
        foo: 1,
        bar: "baz",
      });
      expect(result).toEqual({ foo: 1, bar: "baz" });
    });

    it("preserves unknown args alongside renamed args", () => {
      const result = translateDroidArgsToPi("Read", {
        file_path: "/foo",
        offset: 10,
        limit: 50,
        extra_arg: true,
      });
      expect(result).toEqual({
        path: "/foo",
        offset: 10,
        limit: 50,
        extra_arg: true,
      });
    });
  });

  describe("translatePiArgsToDroid", () => {
    it("renames path to file_path for read", () => {
      const result = translatePiArgsToDroid("read", { path: "/foo" });
      expect(result).toEqual({ file_path: "/foo" });
    });

    it("renames path, oldText, newText for edit", () => {
      const result = translatePiArgsToDroid("edit", {
        path: "/f",
        oldText: "a",
        newText: "b",
      });
      expect(result).toEqual({
        file_path: "/f",
        old_string: "a",
        new_string: "b",
      });
    });

    it("renames limit to head_limit for grep", () => {
      const result = translatePiArgsToDroid("grep", {
        pattern: "x",
        limit: 5,
      });
      expect(result).toEqual({ pattern: "x", head_limit: 5 });
    });

    it("passes through unknown args alongside renamed args", () => {
      const result = translatePiArgsToDroid("read", {
        path: "/foo",
        offset: 10,
        extra: "val",
      });
      expect(result).toEqual({ file_path: "/foo", offset: 10, extra: "val" });
    });

    it("passes through args for unknown tools unchanged", () => {
      const result = translatePiArgsToDroid("unknownTool", { foo: 1 });
      expect(result).toEqual({ foo: 1 });
    });
  });

  describe("MCP prefix stripping", () => {
    it("strips mcp__custom-tools__ prefix from myTool", () => {
      expect(mapDroidToolNameToPi("mcp__custom-tools__myTool")).toBe("myTool");
    });

    it("strips mcp__custom-tools__ prefix from deploy", () => {
      expect(mapDroidToolNameToPi("mcp__custom-tools__deploy")).toBe("deploy");
    });

    it("handles empty name after prefix", () => {
      expect(mapDroidToolNameToPi("mcp__custom-tools__")).toBe("");
    });

    it("does NOT strip other MCP server prefixes", () => {
      expect(mapDroidToolNameToPi("mcp__other-server__foo")).toBe(
        "mcp__other-server__foo",
      );
    });

    it("built-in mappings still work alongside MCP prefix stripping", () => {
      expect(mapDroidToolNameToPi("Read")).toBe("read");
      expect(mapDroidToolNameToPi("Glob")).toBe("find");
    });

    it("CUSTOM_TOOLS_MCP_PREFIX is the correct string", () => {
      expect(CUSTOM_TOOLS_MCP_PREFIX).toBe("mcp__custom-tools__");
    });
  });

  describe("isCustomToolName", () => {
    it("returns true for custom tool names", () => {
      expect(isCustomToolName("myTool")).toBe(true);
      expect(isCustomToolName("deploy")).toBe(true);
      expect(isCustomToolName("ls")).toBe(true);
    });

    it("returns false for all 6 built-in tool names", () => {
      expect(isCustomToolName("read")).toBe(false);
      expect(isCustomToolName("write")).toBe(false);
      expect(isCustomToolName("edit")).toBe(false);
      expect(isCustomToolName("bash")).toBe(false);
      expect(isCustomToolName("grep")).toBe(false);
      expect(isCustomToolName("find")).toBe(false);
    });
  });

  describe("translateDroidArgsToPi with MCP prefix", () => {
    it("MCP-prefixed custom tool args pass through unchanged", () => {
      const result = translateDroidArgsToPi("mcp__custom-tools__myTool", {
        foo: 1,
        bar: "baz",
      });
      expect(result).toEqual({ foo: 1, bar: "baz" });
    });
  });
});
