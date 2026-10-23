import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemoryIndex, buildMemoryHeadingIndex } from "../agents/agent-memory-index.js";

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

describe("buildMemoryHeadingIndex", () => {
  // FNXC:ChatContextBudget 2026-08-20-11:56: bounded heading index for the chat
  // context budget — oversized memory files must be advertised by structure, not
  // inlined in full (user requirement: chat on 64K-context models).
  it("lists headings without body content", () => {
    const content = "# Project Memory\n\n## Architecture\n\nBody A body A body A\n\n## Conventions\n\nBody B body B\n";
    const result = buildMemoryHeadingIndex({
      sectionHeader: "## Project Memory Index (use fn_memory_search / fn_memory_get to read)",
      displayPath: ".fusion/memory/MEMORY.md",
      content,
      maxBytes: 2000,
    });
    expect(result).toContain("## Project Memory Index (use fn_memory_search / fn_memory_get to read)");
    expect(result).toContain(".fusion/memory/MEMORY.md");
    expect(result).toContain('"Architecture"');
    expect(result).toContain('"Conventions"');
    expect(result).not.toContain("Body A");
    expect(result).not.toContain("Body B");
  });

  it("truncates with ellipsis when the heading list exceeds maxBytes", () => {
    const headings = Array.from({ length: 200 }, (_, i) => `## Heading ${String(i).padStart(3, "0")}`).join("\n\nBody text here for padding and size.\n\n");
    const result = buildMemoryHeadingIndex({
      sectionHeader: "## Index",
      displayPath: ".fusion/memory/MEMORY.md",
      content: headings,
      maxBytes: 500,
    });
    // clampUtf8 budget + 3-byte UTF-8 ellipsis + newline; the cap is a soft budget
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(504);
    expect(result).toContain("…");
    expect(result).not.toContain('"Heading 199"');
  });

  it("falls back to a search pointer when the content has no headings", () => {
    const result = buildMemoryHeadingIndex({
      sectionHeader: "## Index",
      displayPath: ".fusion/memory/MEMORY.md",
      content: "plain text without any markdown headings",
      maxBytes: 500,
    });
    expect(result).toContain("no headings; use fn_memory_search / fn_memory_get to read");
  });

  it("honors a maxBytes override above the default index budget", async () => {
    const root = await setupRoot();
    await mkdir(join(root, ".fusion", "memory"), { recursive: true });
    const headings = Array.from({ length: 60 }, (_, i) => `## Section ${i}`).join("\n\n");
    await writeFile(join(root, ".fusion", "memory", "MEMORY.md"), `# Memory\n\n${headings}`);

    const defaultBudget = await buildMemoryIndex({ rootDir: root, agentId: "agent-x" });
    expect(Buffer.byteLength(defaultBudget, "utf8")).toBeLessThanOrEqual(804); // 800 budget + ellipsis + newline

    const largerBudget = await buildMemoryIndex({ rootDir: root, agentId: "agent-x", maxBytes: 4000 });
    expect(largerBudget).toContain('"Section 59"');
  });
});

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
