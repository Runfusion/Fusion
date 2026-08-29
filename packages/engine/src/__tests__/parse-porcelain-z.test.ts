import { describe, expect, it } from "vitest";
import { parsePorcelainZ } from "../merger.js";

describe("parsePorcelainZ", () => {
  it("returns empty set for empty input", () => {
    expect(parsePorcelainZ("")).toEqual(new Set());
  });

  it("parses single modified file", () => {
    expect(parsePorcelainZ(" M src/foo.ts\0")).toEqual(new Set(["src/foo.ts"]));
  });

  it("parses staged + unstaged modifications", () => {
    expect(parsePorcelainZ("M  src/a.ts\0 M src/b.ts\0")).toEqual(
      new Set(["src/a.ts", "src/b.ts"]),
    );
  });

  it("parses untracked files", () => {
    expect(parsePorcelainZ("?? new.ts\0")).toEqual(new Set(["new.ts"]));
  });

  it("treats a rename as a single path (the new name), not two", () => {
    // Format: `R  <new>\0<old>\0`
    const raw = "R  src/new.ts\0src/old.ts\0";
    const result = parsePorcelainZ(raw);
    expect(result).toEqual(new Set(["src/new.ts"]));
    expect(result.has("src/old.ts")).toBe(false);
  });

  it("treats a copy the same way (single new path, skip old)", () => {
    const raw = "C  src/copy.ts\0src/original.ts\0";
    expect(parsePorcelainZ(raw)).toEqual(new Set(["src/copy.ts"]));
  });

  it("handles a rename interleaved with regular modifications", () => {
    // Three logical changes: M src/a.ts, R src/old → src/new, M src/b.ts
    const raw = " M src/a.ts\0R  src/new.ts\0src/old.ts\0 M src/b.ts\0";
    expect(parsePorcelainZ(raw)).toEqual(
      new Set(["src/a.ts", "src/new.ts", "src/b.ts"]),
    );
  });

  it("handles paths with spaces", () => {
    expect(parsePorcelainZ(" M src/file with spaces.ts\0")).toEqual(
      new Set(["src/file with spaces.ts"]),
    );
  });
});
