import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("FN-5059 core index exports", () => {
  it("prevents duplicate export specifiers across export-from blocks", () => {
    const indexPath = resolve(import.meta.dirname, "..", "index.ts");
    const source = readFileSync(indexPath, "utf8");

    const exportFromBlock = /export\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["'];/g;
    const counts = new Map<string, number>();

    for (const match of source.matchAll(exportFromBlock)) {
      const specifierBlock = match[1] ?? "";
      for (const rawSpecifier of specifierBlock.split(",")) {
        const specifier = rawSpecifier.trim();
        if (!specifier) continue;

        const withoutType = specifier.replace(/^type\s+/, "");
        const exportedName = withoutType.includes(" as ")
          ? withoutType.split(/\s+as\s+/)[1]?.trim() ?? withoutType
          : withoutType;

        counts.set(exportedName, (counts.get(exportedName) ?? 0) + 1);
      }
    }

    const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
    expect(duplicates).toEqual([]);
  });
});
