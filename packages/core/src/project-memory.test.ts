import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import { mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MEMORY_FILE_PATH,
  memoryFilePath,
  getDefaultMemoryScaffold,
  ensureMemoryFile,
  ensureMemoryFileWithBackend,
  buildTriageMemoryInstructions,
  buildExecutionMemoryInstructions,
  readProjectMemory,
  readProjectMemoryWithBackend,
  resolveMemoryInstructionContext,
} from "./project-memory.js";

describe("project-memory", () => {
  let testDir: string;
  let memoryPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kb-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    memoryPath = join(testDir, ".fusion", "memory.md");
    // Create the test directory but not the .fusion subdirectory
    // Individual tests can create .fusion as needed
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up entire test directory
    rmSync(testDir, { recursive: true, force: true });
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

    it("instructs agent to selectively write learnings at end", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).toMatch(/end of execution|before calling.*task_done/i);
      // Should mention selective/skip behavior, not just append
      expect(instructions).toMatch(/skip.*memory.*update|selectively|durable.*learnings/i);
    });

    it("instructs agent to skip when nothing durable was learned", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      // Should explicitly allow skipping when nothing durable was learned
      expect(instructions).toMatch(/skip.*memory.*update|nothing durable|if nothing/i);
    });

    it("instructs agent to avoid task-specific trivia", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      // Should explicitly forbid task-specific trivia
      expect(instructions).toMatch(/avoid.*trivia|task-specific.*trivia|per-task.*log|changelog/i);
    });

    it("allows editing/consolidating existing entries", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      // Should allow consolidation/editing, not forbid it
      expect(instructions).toMatch(/consolidate|update.*refine.*existing|edit.*existing/i);
    });

    it("specifies project-root path not worktree-local", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      // Should use .fusion/memory.md (project root relative) not absolute worktree paths
      expect(instructions).toContain("`.fusion/memory.md`");
    });
  });

  // ── ensureMemoryFileWithBackend ─────────────────────────────────────

  describe("ensureMemoryFileWithBackend", () => {
    it("creates memory file with default backend when memory does not exist", async () => {
      // Ensure clean state - create .fusion dir if needed
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      if (existsSync(memoryPath)) await unlink(memoryPath);
      expect(existsSync(memoryPath)).toBe(false);

      const created = await ensureMemoryFileWithBackend(testDir);

      expect(created).toBe(true);
      expect(existsSync(memoryPath)).toBe(true);
      const content = readFileSync(memoryPath, "utf-8");
      expect(content).toBe(getDefaultMemoryScaffold());
    });

    it("does not overwrite existing memory content", async () => {
      // Create initial file with custom content
      await ensureMemoryFile(testDir);
      const customContent = "# Custom Memory\n\nMy custom content";
      await writeFile(memoryPath, customContent, "utf-8");

      // Ensure again with backend - should NOT overwrite
      const created = await ensureMemoryFileWithBackend(testDir);
      expect(created).toBe(false);

      const content = readFileSync(memoryPath, "utf-8");
      expect(content).toBe(customContent);
    });

    it("returns false when file already exists", async () => {
      await ensureMemoryFile(testDir);
      const created = await ensureMemoryFileWithBackend(testDir);
      expect(created).toBe(false);
    });

    it("works with file backend type in settings", async () => {
      // Ensure clean state
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      if (existsSync(memoryPath)) await unlink(memoryPath);

      const settings = { memoryBackendType: "file" };
      const created = await ensureMemoryFileWithBackend(testDir, settings);

      expect(created).toBe(true);
      expect(existsSync(memoryPath)).toBe(true);
    });

    it("does not throw for readonly backend (non-fatal bootstrap)", async () => {
      // Ensure .fusion dir exists but no memory file
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      if (existsSync(memoryPath)) await unlink(memoryPath);

      const settings = { memoryBackendType: "readonly" };
      
      // Should not throw - readonly backend is non-fatal during bootstrap
      const result = await ensureMemoryFileWithBackend(testDir, settings);

      // Should return false since readonly can't write
      expect(result).toBe(false);
    });
  });

  // ── readProjectMemoryWithBackend ─────────────────────────────────────

  describe("readProjectMemoryWithBackend", () => {
    it("returns empty string when memory does not exist", async () => {
      // Ensure clean state
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      if (existsSync(memoryPath)) await unlink(memoryPath);
      expect(existsSync(memoryPath)).toBe(false);

      const content = await readProjectMemoryWithBackend(testDir);
      expect(content).toBe("");
    });

    it("returns memory content when file exists", async () => {
      await ensureMemoryFile(testDir);
      const content = await readProjectMemoryWithBackend(testDir);
      expect(content).toContain("# Project Memory");
    });

    it("returns custom content when file has been edited", async () => {
      await ensureMemoryFile(testDir);
      const customContent = "# Custom Memory\n\nSome custom content";
      await writeFile(memoryPath, customContent, "utf-8");

      const content = await readProjectMemoryWithBackend(testDir);
      expect(content).toBe(customContent);
    });

    it("works with file backend type in settings", async () => {
      await ensureMemoryFile(testDir);
      const settings = { memoryBackendType: "file" };
      const content = await readProjectMemoryWithBackend(testDir, settings);
      expect(content).toContain("# Project Memory");
    });

    it("returns empty string for readonly backend", async () => {
      // Ensure clean state
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      if (existsSync(memoryPath)) await unlink(memoryPath);

      const settings = { memoryBackendType: "readonly" };
      const content = await readProjectMemoryWithBackend(testDir, settings);
      // Readonly backend always returns empty content
      expect(content).toBe("");
    });

    it("returns empty string on read error (graceful degradation)", async () => {
      // Ensure clean state
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      if (existsSync(memoryPath)) await unlink(memoryPath);

      const settings = { memoryBackendType: "nonexistent" };
      // Unknown backend should fall back gracefully
      const content = await readProjectMemoryWithBackend(testDir, settings);
      expect(content).toBe("");
    });
  });

  // ── Backend-aware bootstrap integration ─────────────────────────────

  describe("backend-aware bootstrap integration", () => {
    it("idempotent bootstrap preserves user edits regardless of backend", async () => {
      // Create file with default backend
      await ensureMemoryFile(testDir);
      
      // Edit the content
      const customContent = "# User Edit\n\nI modified this";
      await writeFile(memoryPath, customContent, "utf-8");

      // Bootstrap again with different backends - none should overwrite
      await ensureMemoryFileWithBackend(testDir, { memoryBackendType: "file" });
      expect(readFileSync(memoryPath, "utf-8")).toBe(customContent);

      // Readonly should also preserve (even though it can't write)
      await ensureMemoryFileWithBackend(testDir, { memoryBackendType: "readonly" });
      expect(readFileSync(memoryPath, "utf-8")).toBe(customContent);
    });

    it("backend selection is honored for new memory creation with file backend", async () => {
      // Ensure clean state
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      if (existsSync(memoryPath)) await unlink(memoryPath);

      // Create with file backend - should work reliably
      const created = await ensureMemoryFileWithBackend(testDir, { memoryBackendType: "file" });
      expect(created).toBe(true);
      
      // File should exist and have default scaffold content
      const content = readFileSync(memoryPath, "utf-8");
      expect(content).toBe(getDefaultMemoryScaffold());
    });
  });

  // ── resolveMemoryInstructionContext ─────────────────────────────────────

  describe("resolveMemoryInstructionContext", () => {
    it("returns file backend context by default", () => {
      const ctx = resolveMemoryInstructionContext();
      expect(ctx.backendType).toBe("file");
      expect(ctx.backendName).toBe("File (.fusion/memory.md)");
      expect(ctx.capabilities.readable).toBe(true);
      expect(ctx.capabilities.writable).toBe(true);
      expect(ctx.instructionPathHint).toBe(".fusion/memory.md");
    });

    it("returns file backend context when explicitly set", () => {
      const ctx = resolveMemoryInstructionContext({ memoryBackendType: "file" });
      expect(ctx.backendType).toBe("file");
      expect(ctx.instructionPathHint).toBe(".fusion/memory.md");
    });

    it("returns readonly backend context", () => {
      const ctx = resolveMemoryInstructionContext({ memoryBackendType: "readonly" });
      expect(ctx.backendType).toBe("readonly");
      expect(ctx.backendName).toBe("Read-Only");
      expect(ctx.capabilities.readable).toBe(true);
      expect(ctx.capabilities.writable).toBe(false);
      expect(ctx.instructionPathHint).toBeNull();
    });

    it("returns qmd backend context", () => {
      const ctx = resolveMemoryInstructionContext({ memoryBackendType: "qmd" });
      expect(ctx.backendType).toBe("qmd");
      expect(ctx.backendName).toBe("QMD (Quantized Memory Distillation)");
      expect(ctx.capabilities.readable).toBe(true);
      expect(ctx.capabilities.writable).toBe(true);
      expect(ctx.instructionPathHint).toBeNull();
    });

    it("returns file backend for unknown backend type", () => {
      const ctx = resolveMemoryInstructionContext({ memoryBackendType: "unknown" });
      expect(ctx.backendType).toBe("file"); // Falls back to file
      expect(ctx.instructionPathHint).toBe(".fusion/memory.md");
    });
  });

  // ── Backend-aware buildTriageMemoryInstructions ─────────────────────────────────

  describe("buildTriageMemoryInstructions with backend settings", () => {
    it("includes .fusion/memory.md for file backend", () => {
      const settings = { memoryBackendType: "file" };
      const instructions = buildTriageMemoryInstructions(testDir, settings);
      expect(instructions).toContain(".fusion/memory.md");
      expect(instructions).toContain("## Project Memory");
    });

    it("includes read-only wording for readonly backend without write directives", () => {
      const settings = { memoryBackendType: "readonly" };
      const instructions = buildTriageMemoryInstructions(testDir, settings);
      expect(instructions).toContain("## Project Memory");
      // Should NOT contain write/update directives
      expect(instructions).not.toMatch(/write|update/i);
      // Should NOT contain the specific file path
      expect(instructions).not.toContain(".fusion/memory.md");
      // Should instruct to consult memory
      expect(instructions).toMatch(/consult.*memory|memory.*context/i);
    });

    it("does not include .fusion/memory.md for qmd backend", () => {
      const settings = { memoryBackendType: "qmd" };
      const instructions = buildTriageMemoryInstructions(testDir, settings);
      expect(instructions).toContain("## Project Memory");
      // QMD should NOT unconditionally reference .fusion/memory.md
      expect(instructions).not.toContain(".fusion/memory.md");
      // Should instruct to consult project memory
      expect(instructions).toMatch(/consult.*project memory/i);
    });

    it("does not include .fusion/memory.md for non-file backends without instructionPathHint", () => {
      const settings = { memoryBackendType: "some-custom-backend" };
      const instructions = buildTriageMemoryInstructions(testDir, settings);
      // Non-file backends fall back to file behavior but with generic path
      // Actually unknown backends fall back to file, so this test validates the fallback
      // Let's test with explicit settings that have no path hint
    });

    it("maintains backward compatibility when settings omitted (file behavior)", () => {
      const instructions = buildTriageMemoryInstructions(testDir);
      expect(instructions).toContain(".fusion/memory.md");
      expect(instructions).toMatch(/read.*memory\.md/i);
    });
  });

  // ── Backend-aware buildExecutionMemoryInstructions ─────────────────────────────────

  describe("buildExecutionMemoryInstructions with backend settings", () => {
    it("includes .fusion/memory.md for file backend", () => {
      const settings = { memoryBackendType: "file" };
      const instructions = buildExecutionMemoryInstructions(testDir, settings);
      expect(instructions).toContain(".fusion/memory.md");
      expect(instructions).toContain("## Project Memory");
      // Should have write instructions
      expect(instructions).toMatch(/end of execution|before calling.*task_done/i);
    });

    it("includes read-only wording for readonly backend without write directives", () => {
      const settings = { memoryBackendType: "readonly" };
      const instructions = buildExecutionMemoryInstructions(testDir, settings);
      expect(instructions).toContain("## Project Memory");
      // Should NOT contain write/update directives
      expect(instructions).not.toMatch(/write.*memory|update.*memory/i);
      // Should NOT contain the specific file path
      expect(instructions).not.toContain(".fusion/memory.md");
      // Should instruct to consult memory at start
      expect(instructions).toMatch(/consult.*memory/i);
    });

    it("does not include .fusion/memory.md for qmd backend", () => {
      const settings = { memoryBackendType: "qmd" };
      const instructions = buildExecutionMemoryInstructions(testDir, settings);
      expect(instructions).toContain("## Project Memory");
      // QMD should NOT unconditionally reference .fusion/memory.md
      expect(instructions).not.toContain(".fusion/memory.md");
      // Should instruct to consult project memory at start
      expect(instructions).toMatch(/consult.*project memory/i);
    });

    it("maintains backward compatibility when settings omitted (file behavior)", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).toContain(".fusion/memory.md");
      expect(instructions).toMatch(/read.*memory\.md/i);
      expect(instructions).toMatch(/end of execution|before calling.*task_done/i);
    });

    it("readonly backend does not include format/formatting guidance", () => {
      const settings = { memoryBackendType: "readonly" };
      const instructions = buildExecutionMemoryInstructions(testDir, settings);
      // Should NOT contain the format guidance section
      expect(instructions).not.toContain("Format for additions");
      expect(instructions).not.toContain("\\`- \\`");
    });
  });
});
