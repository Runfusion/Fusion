import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DASHBOARD_ENTRY_FILES = ["../CeFlow.tsx", "../CompoundEngineeringView.tsx"];

describe("Compound Engineering dashboard browser boundary", () => {
  it("does not import server-only plugin modules into browser entry files", () => {
    /*
    FNXC:CompoundEngineeringUI 2026-07-10-23:10:
    Dashboard entry modules must stay browser-safe. Importing the server reconciler pulls node:crypto through pipeline-store and crashes the live plugin view even when TypeScript and jsdom tests pass.
    */
    for (const relativePath of DASHBOARD_ENTRY_FILES) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+["']\.\.\/sync\//);
      expect(source).not.toMatch(/from\s+["']node:/);
    }
  });
});
