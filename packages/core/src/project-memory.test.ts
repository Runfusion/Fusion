import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MEMORY_FILE_PATH,
  memoryFilePath,
  getDefaultMemoryScaffold,
  ensureMemoryFile,
  buildTriageMemoryInstructions,
  buildExecutionMemoryInstructions,
  readProjectMemory,
} from "./project-memory.js";

describe("project-memory", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kb-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ── Constants ────────────────────────────────────────────────────

  describe("MEMORY_FILE_PATH", () => {
    it("is a relative path under .fusion", () => {
      expect(MEMORY_FILE_PATH).toBe(".fusion/memory.md");
    });
  });

  describe("memoryFilePath", () => {
    it("returns absolute path joining root and relative path", () => {
      expect(memoryFilePath("/project")).toBe("/project/.fusion/memory.md");
    });
  });

  // ── Default Scaffold ──────────────────────────────────────────────

  describe("getDefaultMemoryScaffold", () => {
    it("returns non-empty markdown content", () => {
      const scaffold = getDefaultMemoryScaffold();
      expect(scaffold.length).toBeGreaterThan(0);
    });

    it("contains expected section headings", () => {
      const scaffold = getDefaultMemoryScaffold();
      expect(scaffold).toContain("## Architecture");
      expect(scaffold).toContain("## Conventions");
      expect(scaffold).toContain("## Pitfalls");
      expect(scaffold).toContain("## Context");
    });

    it("starts with a top-level heading", () => {
      const scaffold = getDefaultMemoryScaffold();
      expect(scaffold).toMatch(/^# Project Memory/);
    });
  });

  // ── ensureMemoryFile ──────────────────────────────────────────────

  describe("ensureMemoryFile", () => {
    it("creates the memory file when it does not exist", async () => {
      const created = await ensureMemoryFile(testDir);
      expect(created).toBe(true);
      expect(existsSync(memoryFilePath(testDir))).toBe(true);
    });

    it("writes the default scaffold content", async () => {
      await ensureMemoryFile(testDir);
      const content = await readProjectMemory(testDir);
      expect(content).toBe(getDefaultMemoryScaffold());
    });

    it("creates the .fusion directory if missing", async () => {
      expect(existsSync(join(testDir, ".fusion"))).toBe(false);
      await ensureMemoryFile(testDir);
      expect(existsSync(join(testDir, ".fusion"))).toBe(true);
    });

    it("does not overwrite existing content", async () => {
      // Create initial file
      await ensureMemoryFile(testDir);

      // Manually edit the content
      const { writeFile } = await import("node:fs/promises");
      const customContent = "# Custom Memory\n\nMy custom content";
      await writeFile(memoryFilePath(testDir), customContent, "utf-8");

      // Ensure again — should NOT overwrite
      const created = await ensureMemoryFile(testDir);
      expect(created).toBe(false);

      const content = await readProjectMemory(testDir);
      expect(content).toBe(customContent);
    });

    it("returns false when file already exists with scaffold", async () => {
      await ensureMemoryFile(testDir);
      const created = await ensureMemoryFile(testDir);
      expect(created).toBe(false);
    });

    it("is idempotent — multiple calls produce same result", async () => {
      await ensureMemoryFile(testDir);
      await ensureMemoryFile(testDir);
      await ensureMemoryFile(testDir);

      const content = await readProjectMemory(testDir);
      expect(content).toBe(getDefaultMemoryScaffold());
    });
  });

  // ── readProjectMemory ─────────────────────────────────────────────

  describe("readProjectMemory", () => {
    it("returns empty string when file does not exist", async () => {
      const content = await readProjectMemory(testDir);
      expect(content).toBe("");
    });

    it("returns file content when file exists", async () => {
      await ensureMemoryFile(testDir);
      const content = await readProjectMemory(testDir);
      expect(content).toContain("# Project Memory");
    });
  });

  // ── buildTriageMemoryInstructions ─────────────────────────────────

  describe("buildTriageMemoryInstructions", () => {
    it("returns non-empty string", () => {
      const instructions = buildTriageMemoryInstructions(testDir);
      expect(instructions.length).toBeGreaterThan(0);
    });

    it("contains the memory file path", () => {
      const instructions = buildTriageMemoryInstructions(testDir);
      expect(instructions).toContain(".fusion/memory.md");
    });

    it("instructs agent to read the memory file", () => {
      const instructions = buildTriageMemoryInstructions(testDir);
      expect(instructions).toMatch(/read.*memory\.md/i);
    });

    it("instructs agent to incorporate learnings", () => {
      const instructions = buildTriageMemoryInstructions(testDir);
      expect(instructions).toMatch(/incorporate.*learning|reference.*pattern/i);
    });
  });

  // ── buildExecutionMemoryInstructions ──────────────────────────────

  describe("buildExecutionMemoryInstructions", () => {
    it("returns non-empty string", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions.length).toBeGreaterThan(0);
    });

    it("contains the memory file path", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).toContain(".fusion/memory.md");
    });

    it("instructs agent to read memory at start", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).toMatch(/start of execution/i);
      expect(instructions).toMatch(/read.*memory\.md/i);
    });

    it("instructs agent to append learnings at end", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).toMatch(/end of execution|before calling.*task_done/i);
      expect(instructions).toMatch(/append/i);
    });

    it("specifies project-root path not worktree-local", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      // Should use .fusion/memory.md (project root relative) not absolute worktree paths
      expect(instructions).toContain("`.fusion/memory.md`");
    });

    it("warns against deleting existing content", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).toMatch(/do not delete|only append/i);
    });
  });
});
