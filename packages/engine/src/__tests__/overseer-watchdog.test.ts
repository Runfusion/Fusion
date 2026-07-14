import { describe, expect, it } from "vitest";
import { discoverOverseerWatchdogFiles, formatOverseerWatchdogPromptBlocks } from "../overseer-watchdog.js";

describe("discoverOverseerWatchdogFiles", () => {
  it("returns empty when nothing is readable", () => {
    const items = discoverOverseerWatchdogFiles({
      cwd: "/tmp/project-a",
      repoRoot: "/tmp/project-a",
      readText: () => null,
    });
    expect(items).toEqual([]);
  });

  it("loads user and project files; leaf is last among project", () => {
    const files: Record<string, string> = {
      "/user/agent/WATCHDOG.md": "user watch",
      "/repo/OVERSEER.md": "root overseer",
      "/repo/pkg/WATCHDOG.md": "pkg watch",
    };
    const items = discoverOverseerWatchdogFiles({
      cwd: "/repo/pkg",
      repoRoot: "/repo",
      agentDir: "/user/agent",
      readText: (p) => files[p] ?? null,
    });
    expect(items.map((i) => i.content)).toEqual(["user watch", "root overseer", "pkg watch"]);
    expect(items[0].level).toBe("user");
    expect(items[items.length - 1].content).toBe("pkg watch");
  });

  it("never throws on reader errors", () => {
    const items = discoverOverseerWatchdogFiles({
      cwd: "/x",
      repoRoot: "/x",
      readText: () => {
        throw new Error("boom");
      },
    });
    expect(items).toEqual([]);
  });
});

describe("formatOverseerWatchdogPromptBlocks", () => {
  it("wraps content in attention blocks", () => {
    const blocks = formatOverseerWatchdogPromptBlocks([
      { path: "/r/OVERSEER.md", content: "Watch merge trait", level: "project", depth: 0 },
    ]);
    expect(blocks[0]).toContain("<attention");
    expect(blocks[0]).toContain("Watch merge trait");
  });
});
