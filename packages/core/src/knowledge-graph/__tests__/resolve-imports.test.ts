import { describe, expect, it } from "vitest";
import { importCandidates, selectImportTarget } from "../resolve-imports.js";
describe("import resolution", () => {
  it("uses lexical TypeScript candidate priority", () => {
    expect(importCandidates("src/a.ts", "./m")).toEqual(["src/m.ts", "src/m.tsx", "src/m/index.ts", "src/m/index.tsx"]);
    expect(importCandidates("src/a.ts", "./m.js")).toEqual(["src/m.ts", "src/m.tsx"]);
    expect(importCandidates("src/a.ts", "pkg")).toEqual([]);
    expect(selectImportTarget(["a.ts", "a.tsx"], new Set(["a.tsx"]))).toBe("a.tsx");
  });
});
