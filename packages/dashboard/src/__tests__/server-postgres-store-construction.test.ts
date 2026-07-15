import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

describe("dashboard PostgreSQL-only store construction", () => {
  /**
   * FNXC:PostgresSseAgentStore 2026-07-14-19:35:
   * Both default and project-scoped SSE fallbacks must receive their owning
   * TaskStore's AsyncDataLayer; a rootDir-only AgentStore silently reads SQLite.
   */
  it.each([
    ["default", "asyncLayer: requireAsyncLayer(store, \"Default SSE AgentStore\")"],
    ["project", "asyncLayer: requireAsyncLayer(scopedStore, \"Project SSE AgentStore\")"],
  ])("binds the %s SSE fallback AgentStore to PostgreSQL", (_scope, construction) => {
    expect(serverSource).toContain(construction);
  });

  it("contains no rootDir-only AgentStore fallback", () => {
    expect(serverSource).not.toMatch(/new AgentStoreClass\(\{ rootDir: (?:scopedStore|store)\.getFusionDir\(\) \}\)/);
  });
});
