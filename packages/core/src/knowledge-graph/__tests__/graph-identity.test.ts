import { describe, expect, it } from "vitest";
import { edgeId, escapeIdSegment, normalizeRelPath, symbolNodeId } from "../graph-types.js";

describe("knowledge graph identity", () => {
  it("normalizes paths and escapes reserved identity separators", () => {
    expect(normalizeRelPath("src\\a.ts")).toBe("src/a.ts");
    expect(escapeIdSegment("a#b@c~d|e")).toBe("a%23b%40c%7Ed%7Ce");
    expect(symbolNodeId("src/a.ts", "x#y")).toBe("symbol:src/a.ts#x%23y");
    expect(edgeId("contains", "file:a", "symbol:a#x%7Cy")).toBe("contains|file:a|symbol:a#x%7Cy");
  });
});
