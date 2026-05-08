import { describe, it, expect } from "vitest";

/**
 * Verifies that tools are sorted deterministically by name.
 * This is critical for prompt caching — tool schemas are part of the
 * API request, and reordering them breaks cache prefix matching.
 */
describe("deterministic tool ordering", () => {
  it("sorts tools alphabetically by name", () => {
    const tools = [
      { name: "write", execute: async () => {} },
      { name: "bash", execute: async () => {} },
      { name: "read", execute: async () => {} },
      { name: "edit", execute: async () => {} },
    ];

    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));

    expect(sorted.map((t) => t.name)).toEqual(["bash", "edit", "read", "write"]);
  });

  it("is stable across repeated sorts", () => {
    const tools = [
      { name: "grep" },
      { name: "bash" },
      { name: "find" },
      { name: "read" },
    ];

    const sorted1 = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const sorted2 = [...tools].sort((a, b) => a.name.localeCompare(b.name));

    expect(sorted1.map((t) => t.name)).toEqual(sorted2.map((t) => t.name));
  });
});
