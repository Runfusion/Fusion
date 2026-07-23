import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemoryIndex } from "../agents/agent-memory-index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function setupRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fn-memory-index-"));
  tempDirs.push(dir);
  return dir;
}

describe("buildMemoryIndex", () => {
  it("includes both agent and project sections when both files exist", async () => {
    const root = await setupRoot();
    await mkdir(join(root, ".fusion", "agent-memory", "agent-1"), { recursive: true });
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    await writeFile(join(root, ".fusion", "agent-memory", "agent-1", "MEMORY.md"), "## Habits\n\nAlways test first\n");
    await writeFile(join(root, ".fusion", "memory", "MEMORY.md"), "## Conventions\n\nUse pnpm\n");

    const result = await buildMemoryIndex({ rootDir: root, agentId: "agent-1" });
    expect(result).toContain("## Agent Memory Index");
    expect(result).toContain(".fusion/agent-memory/agent-1/MEMORY.md");
    expect(result).toContain("\"Habits\" — Always test first");
    expect(result).toContain("## Project Memory Index");
    expect(result).toContain("\"Conventions\" — Use pnpm");
  });

  it("includes only agent section when project memory is missing", async () => {
    const root = await setupRoot();
    await mkdir(join(root, ".fusion", "agent-memory", "agent-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "agent-memory", "agent-1", "MEMORY.md"), "## Preferences\n\nCompact output\n");

    const result = await buildMemoryIndex({ rootDir: root, agentId: "agent-1" });
    expect(result).toContain("## Agent Memory Index");
    expect(result).not.toContain("## Project Memory Index");
  });

  it("returns empty string when files are missing", async () => {
    const root = await setupRoot();
    const result = await buildMemoryIndex({ rootDir: root, agentId: "agent-1" });
    expect(result).toBe("");
  });

  it("truncates oversized output with ellipsis", async () => {
    const root = await setupRoot();
    await mkdir(join(root, ".fusion", "agent-memory", "agent-1"), { recursive: true });
    await writeFile(
      join(root, ".fusion", "agent-memory", "agent-1", "MEMORY.md"),
      Array.from({ length: 200 }, (_, i) => `## Heading ${i}\n\nSummary ${i}\n`).join("\n"),
    );

    const result = await buildMemoryIndex({ rootDir: root, agentId: "agent-1" });
    expect(result.endsWith("…")).toBe(true);
  });

  it("keeps heading without descriptor when body is missing", async () => {
    const root = await setupRoot();
    await mkdir(join(root, ".fusion", "agent-memory", "agent-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "agent-memory", "agent-1", "MEMORY.md"), "## Empty Heading\n\n## Next\n\nline\n");

    const result = await buildMemoryIndex({ rootDir: root, agentId: "agent-1" });
    expect(result).toContain('  - "Empty Heading"');
  });
});
