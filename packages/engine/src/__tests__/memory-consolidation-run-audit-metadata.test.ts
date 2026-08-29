import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The audit declaration is the closed contract consumed by every heartbeat emission. */
describe("memory consolidation run-audit metadata contract", () => {
  it("declares only fixed outcome fields and forbids prose-bearing fields", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../util/run-audit.ts"), "utf8");
    const completed = source.indexOf("memory:consolidation-completed");
    const block = source.slice(Math.max(0, completed - 1000), completed + 1000);
    expect(block).toContain("memory:consolidation-completed");
    expect(block).toContain("memory:consolidation-skipped");
    expect(block).toContain("memory:consolidation-failed");
    expect(block).toContain("closed graphRecoveryReason enum");
    expect(block).toContain("skipped reasons and failure stages are closed enums");
    expect(block).toMatch(/No memory content, paths,[\s\S]*node ids, error class\/message/);
    expect(block).not.toMatch(/errorClass:\s*string/);
  });
});
