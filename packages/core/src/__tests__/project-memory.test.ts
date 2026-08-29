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
  getProjectMemory,
  resolveMemoryInstructionContext,
  buildProactiveMemoryCueBlock,
} from "../memory/project-memory.js";
import {
  registerMemoryBackend,
  captureMemory,
  type MemoryCaptureEvent,
} from "../memory/memory-backend.js";

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
    it("injects full steering for its readable backend and honors inclusion mode", () => {
      expect(buildReviewerMemoryInstructions(testDir, { memoryBackendType: "qmd" })).toContain("query memory before re-reading");
      expect(buildReviewerMemoryInstructions(testDir, { memoryBackendType: "qmd" }, undefined, "index")).toContain("Memory-first:");
      expect(buildReviewerMemoryInstructions(testDir, { memoryBackendType: "qmd" }, undefined, "off")).not.toContain("query memory before re-reading");
    });

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

    it("includes explicit agent-vs-project memory scope guidance", () => {
      const instructions = buildExecutionMemoryInstructions(testDir, { memoryBackendType: "file" });
      expect(instructions).toContain('fn_memory_append(scope="agent")');
      expect(instructions).toContain('fn_memory_append(scope="project")');
      expect(instructions).toMatch(/private\/ephemeral|private operating context/i);
    });

    it("includes layer guidance for long-term vs daily memory", () => {
      const instructions = buildExecutionMemoryInstructions(testDir, { memoryBackendType: "qmd" });
      expect(instructions).toContain('layer="long-term"');
      expect(instructions).toContain('layer="daily"');
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
      expect(instructions).toContain("fn_memory_append");
      expect(instructions).toContain("Do **not** write");
      expect(instructions).toContain("or any other memory files directly");
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
      expect(instructions).toContain("fn_memory_append");
      expect(instructions).toContain("Do **not** write memory files directly");
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

  describe("pre-steering coverage for project-memory builders", () => {
    const builders = [buildTriageMemoryInstructions, buildExecutionMemoryInstructions] as const;
    const readableBackends = ["readonly", "file", "qmd"] as const;

    it.each(builders.flatMap((builder) => readableBackends.map((memoryBackendType) => [builder.name, builder, memoryBackendType] as const)))("injects full steering into %s %s backend", (_name, builder, memoryBackendType) => {
      expect(builder(testDir, { memoryBackendType })).toContain("query memory before re-reading");
    });

    it("uses the terse index nudge and suppresses it when off", () => {
      for (const builder of builders) {
        expect(builder(testDir, { memoryBackendType: "qmd" }, undefined, "index")).toContain("Memory-first:");
        expect(builder(testDir, { memoryBackendType: "qmd" }, undefined, "off")).not.toContain("query memory before re-reading");
      }
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

  describe("getProjectMemory", () => {
    it("reads bounded memory window via file backend", async () => {
      const memoryDir = join(testDir, ".fusion", "memory");
      await mkdir(memoryDir, { recursive: true });
      await writeFile(
        join(memoryDir, "MEMORY.md"),
        "# Memory\nline-a\nline-b\nline-c\nline-d\n",
        "utf-8",
      );

      const result = await getProjectMemory(
        testDir,
        { path: ".fusion/memory/MEMORY.md", startLine: 2, lineCount: 2 },
        { memoryBackendType: "file" },
      );

      expect(result.path).toBe(".fusion/memory/MEMORY.md");
      expect(result.content).toBe("line-a\nline-b");
      expect(result.startLine).toBe(2);
      expect(result.endLine).toBe(3);
      expect(result.totalLines).toBeGreaterThanOrEqual(5);
      expect(result.backend).toBe("file");
    });

    it("returns qmd backend marker for memory_get contract", async () => {
      const memoryDir = join(testDir, ".fusion", "memory");
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, "MEMORY.md"), "# Memory\nqmd-line\n", "utf-8");

      const result = await getProjectMemory(
        testDir,
        { path: ".fusion/memory/MEMORY.md", startLine: 1, lineCount: 5 },
        { memoryBackendType: "qmd" },
      );

      expect(result.path).toBe(".fusion/memory/MEMORY.md");
      expect(result.content).toContain("qmd-line");
      expect(result.backend).toBe("qmd");
    });
  });

  // ── RUFU-068 Step 3: Stash fail-closed reads, capture helper, topic plumbing ─

  describe("searchProjectMemory topic scoping + fail-closed", () => {
    const stashHandlers = {
      read: vi.fn(async () => ({ content: "", exists: false })),
      exists: vi.fn(async () => false),
      write: vi.fn(async () => ({ success: true, backend: "stash-test" })),
      get: vi.fn(async () => ({ path: "x", content: "", startLine: 1, endLine: 1, totalLines: 0, backend: "stash-test" })),
    };

    it("passes a trimmed real topic into the backend for search", async () => {
      const search = vi.fn(async () => [{ path: "hit", snippet: "s", score: 1, backend: "stash-test" }]);
      try {
        registerMemoryBackend({
          type: "stash-topic",
          capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
          ...stashHandlers,
          search,
        });
      } catch {
        /* registry allows the same type only once in a suite; ignore */
      }
      const results = await searchProjectMemory(
        testDir,
        { query: "routing", limit: 5 },
        { memoryBackendType: "stash-topic" },
        "  sticky   ",
      );
      expect(results.length).toBe(1);
      expect(search).toHaveBeenCalledTimes(1);
      expect(search.mock.calls[0][1].topic).toBe("sticky");
    });

    it("treats 'all'/'*'/empty topic as whole-project scope (no topic param)", async () => {
      const search = vi.fn(async () => []);
      try {
        registerMemoryBackend({
          type: "stash-nofilter",
          capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
          ...stashHandlers,
          search,
        });
      } catch {
        /* ignore duplicate registration */
      }
      for (const topic of [undefined, "", "  ", "all", "*"]) {
        await searchProjectMemory(testDir, { query: "q", limit: 5 }, { memoryBackendType: "stash-nofilter" }, topic);
      }
      for (const call of search.mock.calls) {
        expect(call[1].topic).toBeUndefined();
      }
    });

    it("fails closed to empty when a stash search throws", async () => {
      try {
        registerMemoryBackend({
          type: "stash-boom",
          capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
          ...stashHandlers,
          search: vi.fn(async () => {
            throw new Error("stash unreachable");
          }),
        });
      } catch {
        /* ignore duplicate registration */
      }
      await expect(searchProjectMemory(testDir, { query: "q", limit: 5 }, { memoryBackendType: "stash-boom" })).resolves.toEqual([]);
    });
  });

  describe("getProjectMemory fail-closed", () => {
    it("degrades to an empty window when the backend throws", async () => {
      try {
        registerMemoryBackend({
          type: "stash-get-boom",
          capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
          read: vi.fn(async () => ({ content: "", exists: false })),
          exists: vi.fn(async () => false),
          search: vi.fn(async () => []),
          get: vi.fn(async () => {
            throw new Error("stash down");
          }),
        });
      } catch {
        /* ignore duplicate registration */
      }
      const result = await getProjectMemory(
        testDir,
        { path: ".fusion/memory/MEMORY.md", startLine: 1, lineCount: 5 },
        { memoryBackendType: "stash-get-boom" },
      );
      expect(result.content).toBe("");
      expect(result.totalLines).toBe(0);
      expect(result.backend).toBe("stash-get-boom");
    });

    it("still throws for a backend with no get()", async () => {
      try {
        registerMemoryBackend({
          type: "stash-no-get",
          capabilities: { readable: true, writable: false, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
          read: vi.fn(async () => ({ content: "", exists: false })),
          exists: vi.fn(async () => false),
          search: vi.fn(async () => []),
        });
      } catch {
        /* ignore duplicate registration */
      }
      await expect(
        getProjectMemory(testDir, { path: "x", startLine: 1, lineCount: 1 }, { memoryBackendType: "stash-no-get" }),
      ).rejects.toThrow("does not support memory_get");
    });
  });

  describe("captureMemory helper", () => {
    it("no-ops for a backend without the capture seam and resolves false", async () => {
      // qmd backend has no capture/endSession seam -> no-op result.
      const result = await captureMemory(
        testDir,
        { memoryBackendType: "qmd" },
        "sess-1",
        [{ event_type: "message", agent_name: "agent", content: "hi" }],
      );
      expect(result.ok).toBe(false);
    });

    it("resolves (does not throw) when the capture backend throws", async () => {
      try {
        registerMemoryBackend({
          type: "stash-capture-boom",
          capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
          read: vi.fn(async () => ({ content: "", exists: false })),
          exists: vi.fn(async () => false),
          search: vi.fn(async () => []),
          get: vi.fn(async () => ({ path: "x", content: "", startLine: 1, endLine: 1, totalLines: 0, backend: "t" })),
          endSession: vi.fn(async () => {}),
          capture: vi.fn(async () => {
            throw new Error("gateway exploded");
          }),
        });
      } catch {
        /* ignore duplicate registration */
      }
      const events: MemoryCaptureEvent[] = [{ event_type: "message", agent_name: "agent", content: "x" }];
      await expect(
        captureMemory(
          testDir,
          { memoryBackendType: "stash-capture-boom" },
          "sess-2",
          events,
        ),
      ).resolves.toMatchObject({ ok: false });
    });
  });

  describe("buildProactiveMemoryCueBlock", () => {
    it("returns empty when memory is disabled", async () => {
      const block = await buildProactiveMemoryCueBlock(testDir, "query", { memoryEnabled: false, memoryBackendType: "qmd" });
      expect(block).toBe("");
    });

    it("injects a topic-scoped cue and scopes the search query to the topic", async () => {
      const search = vi.fn(async () => [
        { path: ".fusion/memory/MEMORY.md", snippet: "scheduler retries on failure", score: 0.9, backend: "stash-cue" },
      ]);
      try {
        registerMemoryBackend({
          type: "stash-cue",
          capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
          read: vi.fn(async () => ({ content: "", exists: false })),
          exists: vi.fn(async () => false),
          search,
          get: vi.fn(async () => ({ path: "x", content: "", startLine: 1, endLine: 1, totalLines: 0, backend: "t" })),
        });
      } catch {
        /* ignore duplicate registration */
      }
      const block = await buildProactiveMemoryCueBlock(
        testDir,
        "scheduler",
        { memoryBackendType: "stash-cue" },
        { limit: 3, topic: "scheduler" },
      );
      expect(block).toContain("Relevant Prior Context");
      expect(block).toContain("scheduler retries");
      expect(search.mock.calls[0][1].topic).toBe("scheduler");
    });

    it("collapses a whole-project topic (all/*/empty) to no topic filter", async () => {
      const search = vi.fn(async () => []);
      try {
        registerMemoryBackend({
          type: "stash-cue-all",
          capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
          read: vi.fn(async () => ({ content: "", exists: false })),
          exists: vi.fn(async () => false),
          search,
          get: vi.fn(async () => ({ path: "x", content: "", startLine: 1, endLine: 1, totalLines: 0, backend: "t" })),
        });
      } catch {
        /* ignore duplicate registration */
      }
      for (const topic of [undefined, "", "all", "*"]) {
        await buildProactiveMemoryCueBlock(testDir, "q", { memoryBackendType: "stash-cue-all" }, { topic });
      }
      for (const call of search.mock.calls) {
        expect(call[1].topic).toBeUndefined();
      }
    });
  });
});
