import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("shared Vitest setup PostgreSQL inertness", () => {
  it("guards any optional PostgreSQL setup import behind participation", () => {
    const source = readFileSync(new URL("../__test-utils__/vitest-setup.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:postgres|\.\/pg-test-harness)/);
    expect(source).not.toMatch(/FUSION_PG_TEST_PREADMISSION_PROBE/);
  });
});
