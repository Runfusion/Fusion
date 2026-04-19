import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import { mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDefaultMemoryScaffold,
  ensureMemoryFile,
  ensureMemoryFileWithBackend,
  buildTriageMemoryInstructions,
  buildExecutionMemoryInstructions,
  buildReviewerMemoryInstructions,
  readProjectMemory,
  readProjectMemoryWithBackend,
  searchProjectMemory,
  resolveMemoryInstructionContext,
} from "./project-memory.js";

describe("project-memory", () => {
  let testDir: string;
  let memoryPath: string;
  let legacyMemoryPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kb-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    memoryPath = join(testDir, ".fusion", "memory", "MEMORY.md");
    legacyMemoryPath = join(testDir, ".fusion", "memory.md");
    // Create the test directory but not the .fusion subdirectory
    // Individual tests can create .fusion as needed
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up entire test directory
    rmSync(testDir, { recursive: true, force: true });
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

  describe("buildReviewerMemoryInstructions", () => {
    it("gives reviewers read-only project memory guidance", () => {
      const instructions = buildReviewerMemoryInstructions(testDir, { memoryBackendType: "qmd" });

      expect(instructions).toContain("## Project Memory");
      expect(instructions).toContain("memory_search");
      expect(instructions).toContain("memory_get");
      expect(instructions).toContain("review evidence");
      expect(instructions).toContain("Do not update memory during review");
    });

    it("omits reviewer memory guidance when memory is disabled", () => {
      expect(buildReviewerMemoryInstructions(testDir, { memoryEnabled: false })).toBe("");
    });
  });

  // ── ensureMemoryFile ──────────────────────────────────────────────

  describe("ensureMemoryFile", () => {
    it("creates the memory file when it does not exist", async () => {
      const created = await ensureMemoryFile(testDir);
      expect(created).toBe(true);
      expect(existsSync(memoryPath)).toBe(true);
    });

    it("writes the long-term scaffold content", async () => {
      await ensureMemoryFile(testDir);
      const content = await readProjectMemory(testDir);
      expect(content).toContain("# Project Memory");
      expect(content).toContain("## Decisions");
      expect(content).toContain("## Conventions");
    });

    it("creates long-term memory scaffold even when legacy memory.md exists", async () => {
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      await writeFile(legacyMemoryPath, "# Legacy Memory\n\nPreserve me", "utf-8");

      const created = await ensureMemoryFile(testDir);

      expect(created).toBe(true);
      expect(existsSync(memoryPath)).toBe(true);
      const content = await readProjectMemory(testDir);
      expect(content).toContain("# Project Memory");
      expect(content).toContain("## Decisions");
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
      await writeFile(memoryPath, customContent, "utf-8");

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
      expect(content).toContain("# Project Memory");
      expect(content).toContain("## Decisions");
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

    it("returns empty content when only the legacy memory file exists", async () => {
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      await writeFile(legacyMemoryPath, "legacy content", "utf-8");

      const content = await readProjectMemory(testDir);
      expect(content).toBe("");
    });

    it("reads only from .fusion/memory/MEMORY.md, ignoring legacy path", async () => {
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      const legacyContent = "# Legacy Content\n\nOld stuff";
      await writeFile(legacyMemoryPath, legacyContent, "utf-8");

      await mkdir(join(testDir, ".fusion", "memory"), { recursive: true });
      const newContent = "# New Content\n\nNew stuff";
      await writeFile(memoryPath, newContent, "utf-8");

      const content = await readProjectMemory(testDir);
      expect(content).toBe(newContent);
    });
  });

  // ── buildTriageMemoryInstructions ─────────────────────────────────

  describe("buildTriageMemoryInstructions", () => {
    it("returns non-empty string", () => {
      const instructions = buildTriageMemoryInstructions(testDir);
      expect(instructions.length).toBeGreaterThan(0);
    });

    it("does not inject a raw memory file path by default", () => {
      const instructions = buildTriageMemoryInstructions(testDir);
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
    });

    it("instructs agent to search memory first", () => {
      const instructions = buildTriageMemoryInstructions(testDir);
      expect(instructions).toContain("memory_search");
      expect(instructions).toContain("memory_get");
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

    it("does not inject a raw memory file path by default", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
    });

    it("instructs agent to search memory at start", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).toMatch(/start of execution/i);
      expect(instructions).toContain("memory_search");
      expect(instructions).toContain("memory_get");
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

    it("keeps qmd default path-agnostic", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).not.toContain("`.fusion/memory/MEMORY.md`");
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

    it("initializes canonical long-term memory when only legacy file exists", async () => {
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      await writeFile(legacyMemoryPath, "# Legacy\n\nUser content", "utf-8");

      const created = await ensureMemoryFileWithBackend(testDir);

      expect(created).toBe(true);
      expect(existsSync(memoryPath)).toBe(true);
      const content = readFileSync(memoryPath, "utf-8");
      expect(content).toBe(getDefaultMemoryScaffold());
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
      expect(readFileSync(memoryPath, "utf-8")).toBe(getDefaultMemoryScaffold());
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

    it("creates memory file with QMD backend when memory does not exist", async () => {
      // Ensure clean state
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      if (existsSync(memoryPath)) await unlink(memoryPath);
      expect(existsSync(memoryPath)).toBe(false);

      const settings = { memoryBackendType: "qmd" };
      const created = await ensureMemoryFileWithBackend(testDir, settings);

      expect(created).toBe(true);
      expect(existsSync(memoryPath)).toBe(true);
      const content = readFileSync(memoryPath, "utf-8");
      expect(content).toBe(getDefaultMemoryScaffold());
    });

    it("QMD ensureMemoryFileWithBackend is idempotent and does not overwrite", async () => {
      // Create memory via QMD backend
      await mkdir(join(testDir, ".fusion"), { recursive: true });
      if (existsSync(memoryPath)) await unlink(memoryPath);

      const settings = { memoryBackendType: "qmd" };
      const firstCreated = await ensureMemoryFileWithBackend(testDir, settings);
      expect(firstCreated).toBe(true);

      // Manually edit the content
      const customContent = "# Custom Memory\n\nI edited this content";
      await writeFile(memoryPath, customContent, "utf-8");

      // Call ensure again - should NOT overwrite
      const secondCreated = await ensureMemoryFileWithBackend(testDir, settings);
      expect(secondCreated).toBe(false);

      // Content should still be the custom content
      const content = readFileSync(memoryPath, "utf-8");
      expect(content).toBe(customContent);
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

    it("returns memory content when using QMD backend", async () => {
      // Create the memory file directly (simulating prior creation)
      await mkdir(join(testDir, ".fusion", "memory"), { recursive: true });
      await writeFile(memoryPath, "# QMD Memory\n\nSome content", "utf-8");

      const settings = { memoryBackendType: "qmd" };
      const content = await readProjectMemoryWithBackend(testDir, settings);
      expect(content).toBe("# QMD Memory\n\nSome content");
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
      
      const content = readFileSync(memoryPath, "utf-8");
      expect(content).toBe(getDefaultMemoryScaffold());
    });
  });

  // ── resolveMemoryInstructionContext ─────────────────────────────────────

  describe("resolveMemoryInstructionContext", () => {
    it("returns qmd backend context by default", () => {
      const ctx = resolveMemoryInstructionContext();
      expect(ctx.backendType).toBe("qmd");
      expect(ctx.backendName).toBe("QMD (Quantized Memory Distillation)");
      expect(ctx.capabilities.readable).toBe(true);
      expect(ctx.capabilities.writable).toBe(true);
      expect(ctx.instructionPathHint).toBeNull();
    });

    it("returns file backend context when explicitly set", () => {
      const ctx = resolveMemoryInstructionContext({ memoryBackendType: "file" });
      expect(ctx.backendType).toBe("file");
      expect(ctx.instructionPathHint).toBe(".fusion/memory/MEMORY.md");
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

    it("returns qmd backend for unknown backend type", () => {
      const ctx = resolveMemoryInstructionContext({ memoryBackendType: "unknown" });
      expect(ctx.backendType).toBe("qmd");
      expect(ctx.instructionPathHint).toBeNull();
    });
  });

  // ── Backend-aware buildTriageMemoryInstructions ─────────────────────────────────

  describe("buildTriageMemoryInstructions with backend settings", () => {
    it("includes .fusion/memory/MEMORY.md for file backend", () => {
      const settings = { memoryBackendType: "file" };
      const instructions = buildTriageMemoryInstructions(testDir, settings);
      expect(instructions).toContain(".fusion/memory/MEMORY.md");
      expect(instructions).toContain("## Project Memory");
    });

    it("includes read-only wording for readonly backend without write directives", () => {
      const settings = { memoryBackendType: "readonly" };
      const instructions = buildTriageMemoryInstructions(testDir, settings);
      expect(instructions).toContain("## Project Memory");
      // Should NOT contain write/update directives
      expect(instructions).not.toMatch(/write|update/i);
      // Should NOT contain the specific file path
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
      // Should instruct to consult memory
      expect(instructions).toMatch(/consult.*memory|memory.*context/i);
    });

    it("does not include .fusion/memory/MEMORY.md for qmd backend", () => {
      const settings = { memoryBackendType: "qmd" };
      const instructions = buildTriageMemoryInstructions(testDir, settings);
      expect(instructions).toContain("## Project Memory");
      // QMD should NOT unconditionally reference .fusion/memory/MEMORY.md
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
      expect(instructions).toContain("memory_search");
      expect(instructions).toContain("memory_get");
    });

    it("QMD triage instructions completeness - contains consult guidance", () => {
      const settings = { memoryBackendType: "qmd" };
      const instructions = buildTriageMemoryInstructions(testDir, settings);
      expect(instructions).toContain("## Project Memory");
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
      expect(instructions).toContain("memory_search");
    });

    it("does not include .fusion/memory/MEMORY.md for non-file backends without instructionPathHint", () => {
      const settings = { memoryBackendType: "some-custom-backend" };
      const instructions = buildTriageMemoryInstructions(testDir, settings);
      expect(instructions).toContain("memory_search");
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
    });

    it("defaults to qmd guidance when settings are omitted", () => {
      const instructions = buildTriageMemoryInstructions(testDir);
      expect(instructions).toContain("memory_search");
      expect(instructions).toContain("memory_get");
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
    });
  });

  // ── Backend-aware buildExecutionMemoryInstructions ─────────────────────────────────

  describe("buildExecutionMemoryInstructions with backend settings", () => {
    it("includes .fusion/memory/MEMORY.md for file backend", () => {
      const settings = { memoryBackendType: "file" };
      const instructions = buildExecutionMemoryInstructions(testDir, settings);
      expect(instructions).toContain(".fusion/memory/MEMORY.md");
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
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
      // Should instruct to consult memory at start
      expect(instructions).toMatch(/consult.*memory/i);
    });

    it("does not include .fusion/memory/MEMORY.md for qmd backend", () => {
      const settings = { memoryBackendType: "qmd" };
      const instructions = buildExecutionMemoryInstructions(testDir, settings);
      expect(instructions).toContain("## Project Memory");
      // QMD should NOT unconditionally reference .fusion/memory/MEMORY.md
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
      expect(instructions).toContain("memory_search");
      expect(instructions).toContain("memory_get");
    });

    it("QMD execution instructions completeness", () => {
      const settings = { memoryBackendType: "qmd" };
      const instructions = buildExecutionMemoryInstructions(testDir, settings);
      expect(instructions).toContain("## Project Memory");
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
      expect(instructions).toContain("memory_search");
      // Contains "end of execution" write guidance
      expect(instructions).toMatch(/end of execution/i);
      // Contains "skip" wording for when nothing durable learned
      expect(instructions).toMatch(/skip.*memory.*update|nothing durable/i);
      // Contains "avoid" / "trivia" guidance
      expect(instructions).toMatch(/trivia|avoid/i);
    });

    it("defaults to qmd guidance when settings are omitted", () => {
      const instructions = buildExecutionMemoryInstructions(testDir);
      expect(instructions).toContain("memory_search");
      expect(instructions).toContain("memory_get");
      expect(instructions).not.toContain(".fusion/memory/MEMORY.md");
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

  describe("searchProjectMemory", () => {
    it("uses qmd backend by default and searches all memory files", async () => {
      const memoryDir = join(testDir, ".fusion", "memory");
      await mkdir(memoryDir, { recursive: true });
      const token = `qmdindexunique${Date.now()}`;
      await writeFile(join(memoryDir, "DREAMS.md"), `# Dreams\n\n- The scheduler retries ${token} failures.`, "utf-8");
      await writeFile(join(memoryDir, "MEMORY.md"), "# Memory\n\n- Durable API decisions live here.", "utf-8");

      const results = await searchProjectMemory(testDir, { query: token, limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].backend).toBe("qmd");
      expect(results.some((result) => result.path === ".fusion/memory/DREAMS.md")).toBe(true);
    });
  });
});
