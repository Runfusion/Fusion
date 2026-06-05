/**
 * Drift guard for the intentionally duplicated resolvePluginEntryPath.
 *
 * The CLI keeps a local copy in bundled-plugin-install.ts (so its fs mocks
 * work in tests) while @fusion/core owns the copy used by the dashboard
 * install/enable routes. This test runs both against real on-disk layouts and
 * asserts identical results, so a candidate-list change applied to one copy
 * but not the other fails CI instead of silently diverging.
 *
 * No fs mocks here on purpose — vitest module mocks don't reach the
 * externalized @fusion/core import, so real temp directories are the only
 * seam that exercises both implementations equally.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePluginEntryPath as cliResolve } from "../bundled-plugin-install.js";
import { resolvePluginEntryPath as coreResolve } from "@fusion/core";

describe("resolvePluginEntryPath: CLI copy stays in sync with @fusion/core", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "entry-path-sync-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function touch(relative: string) {
    const full = join(dir, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "// entry\n");
  }

  const layouts: Array<{ name: string; files: string[]; expected: string | null }> = [
    { name: "bundled.js only", files: ["bundled.js"], expected: "bundled.js" },
    { name: "dist/index.js only", files: ["dist/index.js"], expected: "dist/index.js" },
    { name: "src/index.ts only", files: ["src/index.ts"], expected: "src/index.ts" },
    { name: "bundled.js preferred over src", files: ["bundled.js", "src/index.ts"], expected: "bundled.js" },
    { name: "dist preferred over src", files: ["dist/index.js", "src/index.ts"], expected: "dist/index.js" },
    { name: "all three → bundled.js", files: ["bundled.js", "dist/index.js", "src/index.ts"], expected: "bundled.js" },
    { name: "no entry files", files: ["README.md"], expected: null },
  ];

  for (const layout of layouts) {
    it(`resolves identically for: ${layout.name}`, () => {
      for (const f of layout.files) touch(f);
      const expected = layout.expected === null ? null : join(dir, layout.expected);

      expect(cliResolve(dir)).toBe(expected);
      expect(coreResolve(dir)).toBe(expected);
    });
  }
});
