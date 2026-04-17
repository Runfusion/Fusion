import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryBackendError,
  FileMemoryBackend,
  ReadOnlyMemoryBackend,
  QmdMemoryBackend,
  registerMemoryBackend,
  getMemoryBackend,
  listMemoryBackendTypes,
  resolveMemoryBackend,
  getMemoryBackendCapabilities,
  readMemory,
  writeMemory,
  memoryExists,
  MEMORY_BACKEND_SETTINGS_KEYS,
  DEFAULT_MEMORY_BACKEND,
  buildQmdSearchArgs,
  qmdMemoryCollectionName,
} from "./memory-backend.js";
import type { MemoryBackend } from "./memory-backend.js";

describe("memory-backend", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-memory-backend-test-"));
    await mkdir(join(tempDir, ".fusion"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── MemoryBackendError ────────────────────────────────────────────

  describe("MemoryBackendError", () => {
    it("should create error with correct properties", () => {
      const error = new MemoryBackendError("READ_FAILED", "Test error", "file");
      expect(error.name).toBe("MemoryBackendError");
      expect(error.code).toBe("READ_FAILED");
      expect(error.backend).toBe("file");
      expect(error.message).toBe("Test error");
    });

    it("should be instance of Error", () => {
      const error = new MemoryBackendError("WRITE_FAILED", "Test", "file");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(MemoryBackendError);
    });

    it("should serialize to string correctly", () => {
      const error = new MemoryBackendError("NOT_FOUND", "Memory not found", "file");
      expect(error.toString()).toContain("MemoryBackendError");
      expect(error.toString()).toContain("Memory not found");
    });
  });

  // ── FileMemoryBackend ─────────────────────────────────────────────

  describe("FileMemoryBackend", () => {
    describe("type and name", () => {
      it("should have correct type", () => {
        const backend = new FileMemoryBackend();
        expect(backend.type).toBe("file");
      });

      it("should have human-readable name", () => {
        const backend = new FileMemoryBackend();
        expect(backend.name).toBe("File (.fusion/memory.md)");
      });
    });

    describe("capabilities", () => {
      it("should support read, write, and persistence", () => {
        const backend = new FileMemoryBackend();
        expect(backend.capabilities.readable).toBe(true);
        expect(backend.capabilities.writable).toBe(true);
        expect(backend.capabilities.persistent).toBe(true);
      });

      it("should support atomic writes", () => {
        const backend = new FileMemoryBackend();
        expect(backend.capabilities.supportsAtomicWrite).toBe(true);
      });

      it("should not have built-in conflict resolution", () => {
        const backend = new FileMemoryBackend();
        expect(backend.capabilities.hasConflictResolution).toBe(false);
      });
    });

    describe("read", () => {
      it("should return empty content when file does not exist", async () => {
        const backend = new FileMemoryBackend();
        const result = await backend.read(tempDir);

        expect(result.content).toBe("");
        expect(result.exists).toBe(false);
        expect(result.backend).toBe("file");
      });

      it("should return content when file exists", async () => {
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        writeFileSync(memoryPath, "# Project Memory\n\nTest content", "utf-8");

        const backend = new FileMemoryBackend();
        const result = await backend.read(tempDir);

        expect(result.content).toBe("# Project Memory\n\nTest content");
        expect(result.exists).toBe(true);
        expect(result.backend).toBe("file");
      });

      // Note: Testing read failure is complex in ESM because we can't easily mock
      // the fs/promises module. The error handling is tested through integration tests
      // and the MemoryBackendError class tests above.
      it.todo("should throw MemoryBackendError on read failure");
    });

    describe("write", () => {
      it("should create memory file with content", async () => {
        const backend = new FileMemoryBackend();
        const result = await backend.write(tempDir, "# Project Memory\n\nNew content");

        expect(result.success).toBe(true);
        expect(result.backend).toBe("file");

        const memoryPath = join(tempDir, ".fusion", "memory.md");
        expect(existsSync(memoryPath)).toBe(true);
        expect(readFileSync(memoryPath, "utf-8")).toBe("# Project Memory\n\nNew content");
      });

      it("should create .fusion directory if missing", async () => {
        const newDir = join(tempDir, "new-project");
        await mkdir(newDir, { recursive: true });

        const backend = new FileMemoryBackend();
        await backend.write(newDir, "# Memory");

        const memoryPath = join(newDir, ".fusion", "memory.md");
        expect(existsSync(memoryPath)).toBe(true);
      });

      it("should overwrite existing content", async () => {
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        writeFileSync(memoryPath, "Original content", "utf-8");

        const backend = new FileMemoryBackend();
        await backend.write(tempDir, "Updated content");

        expect(readFileSync(memoryPath, "utf-8")).toBe("Updated content");
      });

      it("should not leave temp files on error", async () => {
        // This test verifies atomic write behavior
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        writeFileSync(memoryPath, "Original", "utf-8");

        const backend = new FileMemoryBackend();
        
        // Write should succeed, temp file should be cleaned up
        await backend.write(tempDir, "Updated");
        
        // No temp files should exist
        const fusionDir = join(tempDir, ".fusion");
        const files = require("node:fs").readdirSync(fusionDir);
        expect(files.filter((f: string) => f.endsWith(".tmp"))).toHaveLength(0);
      });
    });

    describe("exists", () => {
      it("should return false when file does not exist", async () => {
        const backend = new FileMemoryBackend();
        const result = await backend.exists(tempDir);
        expect(result).toBe(false);
      });

      it("should return true when file exists", async () => {
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        writeFileSync(memoryPath, "Content", "utf-8");

        const backend = new FileMemoryBackend();
        const result = await backend.exists(tempDir);
        expect(result).toBe(true);
      });
    });
  });

  // ── ReadOnlyMemoryBackend ─────────────────────────────────────────

  describe("ReadOnlyMemoryBackend", () => {
    describe("type and name", () => {
      it("should have correct type", () => {
        const backend = new ReadOnlyMemoryBackend();
        expect(backend.type).toBe("readonly");
      });

      it("should have human-readable name", () => {
        const backend = new ReadOnlyMemoryBackend();
        expect(backend.name).toBe("Read-Only");
      });
    });

    describe("capabilities", () => {
      it("should support read but not write", () => {
        const backend = new ReadOnlyMemoryBackend();
        expect(backend.capabilities.readable).toBe(true);
        expect(backend.capabilities.writable).toBe(false);
      });

      it("should not be persistent", () => {
        const backend = new ReadOnlyMemoryBackend();
        expect(backend.capabilities.persistent).toBe(false);
      });
    });

    describe("read", () => {
      it("should always return empty content", async () => {
        const backend = new ReadOnlyMemoryBackend();
        const result = await backend.read(tempDir);

        expect(result.content).toBe("");
        expect(result.exists).toBe(false);
        expect(result.backend).toBe("readonly");
      });
    });

    describe("write", () => {
      it("should throw MemoryBackendError", async () => {
        const backend = new ReadOnlyMemoryBackend();
        
        await expect(backend.write(tempDir, "Content")).rejects.toThrow(MemoryBackendError);
        
        try {
          await backend.write(tempDir, "Content");
        } catch (err) {
          expect(err).toBeInstanceOf(MemoryBackendError);
          expect((err as MemoryBackendError).code).toBe("READ_ONLY");
          expect((err as MemoryBackendError).backend).toBe("readonly");
        }
      });
    });
  });

  // ── QmdMemoryBackend ─────────────────────────────────────────────

  describe("QmdMemoryBackend", () => {
    describe("type and name", () => {
      it("should have correct type", () => {
        const backend = new QmdMemoryBackend();
        expect(backend.type).toBe("qmd");
      });

      it("should have human-readable name", () => {
        const backend = new QmdMemoryBackend();
        expect(backend.name).toBe("QMD (qmd index/query integration)");
      });
    });

    describe("capabilities", () => {
      it("should support read and write", () => {
        const backend = new QmdMemoryBackend();
        expect(backend.capabilities.readable).toBe(true);
        expect(backend.capabilities.writable).toBe(true);
      });

      it("should not support atomic writes", () => {
        const backend = new QmdMemoryBackend();
        expect(backend.capabilities.supportsAtomicWrite).toBe(false);
      });

      it("should not have built-in conflict resolution", () => {
        const backend = new QmdMemoryBackend();
        expect(backend.capabilities.hasConflictResolution).toBe(false);
      });

      it("should be persistent", () => {
        const backend = new QmdMemoryBackend();
        expect(backend.capabilities.persistent).toBe(true);
      });
    });

    describe("read", () => {
      it("should read memory from filesystem and return qmd backend identifier", async () => {
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        writeFileSync(memoryPath, "# Project Memory\n\nTest content", "utf-8");

        const backend = new QmdMemoryBackend();
        const result = await backend.read(tempDir);

        expect(result.content).toBe("# Project Memory\n\nTest content");
        expect(result.exists).toBe(true);
        expect(result.backend).toBe("qmd");
      });

      it("should return empty content when file does not exist", async () => {
        const backend = new QmdMemoryBackend();
        const result = await backend.read(tempDir);

        expect(result.content).toBe("");
        expect(result.exists).toBe(false);
        expect(result.backend).toBe("qmd");
      });

      it("should return empty content for empty file", async () => {
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        writeFileSync(memoryPath, "", "utf-8");

        const backend = new QmdMemoryBackend();
        const result = await backend.read(tempDir);

        expect(result.content).toBe("");
        expect(result.exists).toBe(true); // File exists, just empty
        expect(result.backend).toBe("qmd");
      });
    });

    describe("write", () => {
      it("should write memory to filesystem and return qmd backend identifier", async () => {
        const backend = new QmdMemoryBackend();
        const result = await backend.write(tempDir, "# Memory\n\nContent");

        expect(result.success).toBe(true);
        expect(result.backend).toBe("qmd");

        // Verify file was actually written
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        expect(existsSync(memoryPath)).toBe(true);
        expect(readFileSync(memoryPath, "utf-8")).toBe("# Memory\n\nContent");
      });

      it("should overwrite existing content", async () => {
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        writeFileSync(memoryPath, "Original content", "utf-8");

        const backend = new QmdMemoryBackend();
        await backend.write(tempDir, "Updated content");

        expect(readFileSync(memoryPath, "utf-8")).toBe("Updated content");
      });

      it("should create .fusion directory if missing", async () => {
        const newDir = join(tempDir, "new-project");
        await mkdir(newDir, { recursive: true });

        const backend = new QmdMemoryBackend();
        await backend.write(newDir, "# Memory");

        const memoryPath = join(newDir, ".fusion", "memory.md");
        expect(existsSync(memoryPath)).toBe(true);
      });

      it("should handle unicode content", async () => {
        const backend = new QmdMemoryBackend();
        const unicodeContent = "# プロジェクトメモリ\n\n日本語のテスト 🎉";
        
        await backend.write(tempDir, unicodeContent);
        
        const result = await backend.read(tempDir);
        expect(result.content).toBe(unicodeContent);
      });
    });

    describe("exists", () => {
      it("should return true when memory file exists", async () => {
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        writeFileSync(memoryPath, "Content", "utf-8");

        const backend = new QmdMemoryBackend();
        const result = await backend.exists(tempDir);

        expect(result).toBe(true);
      });

      it("should return false when memory file does not exist", async () => {
        const backend = new QmdMemoryBackend();
        const result = await backend.exists(tempDir);

        expect(result).toBe(false);
      });

      it("should return true for empty file", async () => {
        const memoryPath = join(tempDir, ".fusion", "memory.md");
        writeFileSync(memoryPath, "", "utf-8");

        const backend = new QmdMemoryBackend();
        const result = await backend.exists(tempDir);

        expect(result).toBe(true);
      });
    });

    describe("qmd collection scoping", () => {
      it("uses a stable project-scoped collection name", () => {
        const collectionName = qmdMemoryCollectionName(tempDir);

        expect(collectionName).toMatch(/^fusion-memory-kb-memory-backend-test-[a-z0-9_-]+-[a-f0-9]{12}$/);
        expect(qmdMemoryCollectionName(tempDir)).toBe(collectionName);
      });

      it("builds qmd search args with the project collection filter", () => {
        const args = buildQmdSearchArgs(tempDir, { query: "agent memory", limit: 7 });
        const collectionName = qmdMemoryCollectionName(tempDir);

        expect(args).toEqual([
          "search",
          "agent memory",
          "--json",
          "--collection",
          collectionName,
          "-n",
          "7",
        ]);
      });

      it("clamps qmd result limits", () => {
        expect(buildQmdSearchArgs(tempDir, { query: "memory", limit: 999 })).toContain("20");
        expect(buildQmdSearchArgs(tempDir, { query: "memory", limit: 0 })).toContain("1");
      });
    });
  });

  // ── Backend Registry ──────────────────────────────────────────────

  // Store original backends for cleanup
  const originalFileBackend = new FileMemoryBackend();

  describe("backend registry", () => {
    afterEach(() => {
      // Restore original backends after each test to prevent cross-test pollution
      registerMemoryBackend(new FileMemoryBackend());
      registerMemoryBackend(new ReadOnlyMemoryBackend());
    });

    describe("listMemoryBackendTypes", () => {
      it("should list all registered backends including qmd", () => {
        const types = listMemoryBackendTypes();
        expect(types).toContain("file");
        expect(types).toContain("readonly");
        expect(types).toContain("qmd");
      });
    });

    describe("getMemoryBackend", () => {
      it("should return backend by type", () => {
        const fileBackend = getMemoryBackend("file");
        expect(fileBackend).toBeInstanceOf(FileMemoryBackend);

        const readonlyBackend = getMemoryBackend("readonly");
        expect(readonlyBackend).toBeInstanceOf(ReadOnlyMemoryBackend);

        const qmdBackend = getMemoryBackend("qmd");
        expect(qmdBackend).toBeInstanceOf(QmdMemoryBackend);
      });

      it("should return undefined for unknown type", () => {
        const unknown = getMemoryBackend("unknown-backend");
        expect(unknown).toBeUndefined();
      });
    });

    describe("registerMemoryBackend", () => {
      it("should register custom backend", () => {
        const customBackend: MemoryBackend = {
          type: "custom",
          name: "Custom Backend",
          capabilities: {
            readable: true,
            writable: true,
            supportsAtomicWrite: false,
            hasConflictResolution: false,
            persistent: true,
          },
          async read(rootDir: string) {
            return { content: "custom", exists: true, backend: "custom" };
          },
          async write(rootDir: string, content: string) {
            return { success: true, backend: "custom" };
          },
        };

        registerMemoryBackend(customBackend);

        const retrieved = getMemoryBackend("custom");
        expect(retrieved).toBe(customBackend);

        const types = listMemoryBackendTypes();
        expect(types).toContain("custom");

        // Clean up custom backend
        // Note: We can't easily remove a backend, but subsequent tests use explicit settings
      });

      it("should allow overriding existing backend", () => {
        const overrideBackend: MemoryBackend = {
          type: "file",
          name: "Custom File Backend",
          capabilities: {
            readable: true,
            writable: true,
            supportsAtomicWrite: true,
            hasConflictResolution: false,
            persistent: true,
          },
          async read(rootDir: string) {
            return { content: "overridden", exists: true, backend: "file" };
          },
          async write(rootDir: string, content: string) {
            return { success: true, backend: "file" };
          },
        };

        registerMemoryBackend(overrideBackend);

        const retrieved = getMemoryBackend("file");
        expect(retrieved).toBe(overrideBackend);
      });
    });
  });

  // ── Settings Keys ─────────────────────────────────────────────────

  describe("settings keys", () => {
    it("should export correct settings key", () => {
      expect(MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE).toBe("memoryBackendType");
    });

    it("should export default backend type", () => {
      expect(DEFAULT_MEMORY_BACKEND).toBe("qmd");
    });
  });

  // ── Resolution Functions ──────────────────────────────────────────

  describe("resolveMemoryBackend", () => {
    it("should resolve qmd backend by default", () => {
      const backend = resolveMemoryBackend();
      expect(backend.type).toBe("qmd");
    });

    it("should resolve file backend when explicitly set", () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "file" };
      const backend = resolveMemoryBackend(settings);
      expect(backend.type).toBe("file");
    });

    it("should resolve readonly backend when set", () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "readonly" };
      const backend = resolveMemoryBackend(settings);
      expect(backend.type).toBe("readonly");
    });

    it("should resolve qmd backend when set", () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "qmd" };
      const backend = resolveMemoryBackend(settings);
      expect(backend.type).toBe("qmd");
    });

    it("should fall back to qmd backend for unknown type", () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "unknown" };
      const backend = resolveMemoryBackend(settings);
      expect(backend.type).toBe("qmd");
    });
  });

  describe("getMemoryBackendCapabilities", () => {
    it("should return qmd backend capabilities by default", () => {
      const caps = getMemoryBackendCapabilities();
      expect(caps.readable).toBe(true);
      expect(caps.writable).toBe(true);
      expect(caps.supportsAtomicWrite).toBe(false);
    });

    it("should return readonly capabilities when configured", () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "readonly" };
      const caps = getMemoryBackendCapabilities(settings);
      expect(caps.readable).toBe(true);
      expect(caps.writable).toBe(false);
    });

    it("should return qmd capabilities when configured", () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "qmd" };
      const caps = getMemoryBackendCapabilities(settings);
      expect(caps.readable).toBe(true);
      expect(caps.writable).toBe(true);
      expect(caps.supportsAtomicWrite).toBe(false);
      expect(caps.persistent).toBe(true);
    });
  });

  // ── Convenience Functions ────────────────────────────────────────

  describe("readMemory", () => {
    it("should read using qmd backend by default", async () => {
      const memoryPath = join(tempDir, ".fusion", "memory.md");
      writeFileSync(memoryPath, "Test memory content", "utf-8");

      const result = await readMemory(tempDir);
      expect(result.content).toBe("Test memory content");
      expect(result.exists).toBe(true);
      expect(result.backend).toBe("qmd");
    });

    it("should return empty content when file does not exist", async () => {
      const result = await readMemory(tempDir);
      expect(result.content).toBe("");
      expect(result.exists).toBe(false);
    });

    it("should use configured backend", async () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "readonly" };
      const result = await readMemory(tempDir, settings);
      expect(result.content).toBe("");
      expect(result.backend).toBe("readonly");
    });
  });

  describe("writeMemory", () => {
    it("should write using qmd backend by default", async () => {
      const result = await writeMemory(tempDir, "# Memory\n\nContent");
      
      expect(result.success).toBe(true);
      expect(result.backend).toBe("qmd");

      const memoryPath = join(tempDir, ".fusion", "memory.md");
      expect(readFileSync(memoryPath, "utf-8")).toBe("# Memory\n\nContent");
    });

    it("should throw when backend is read-only", async () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "readonly" };
      
      await expect(writeMemory(tempDir, "Content", settings)).rejects.toThrow(MemoryBackendError);
    });

    it("should throw with correct error code for read-only", async () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "readonly" };
      
      try {
        await writeMemory(tempDir, "Content", settings);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MemoryBackendError);
        expect((err as MemoryBackendError).code).toBe("READ_ONLY");
      }
    });
  });

  describe("memoryExists", () => {
    it("should return false when file does not exist", async () => {
      const result = await memoryExists(tempDir);
      expect(result).toBe(false);
    });

    it("should return true when file exists", async () => {
      const memoryPath = join(tempDir, ".fusion", "memory.md");
      writeFileSync(memoryPath, "Content", "utf-8");

      const result = await memoryExists(tempDir);
      expect(result).toBe(true);
    });

    it("should use configured backend", async () => {
      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "readonly" };
      const result = await memoryExists(tempDir, settings);
      // Read-only backend always returns false (no file check)
      expect(result).toBe(false);
    });
  });

  // ── Integration Tests ──────────────────────────────────────────────

  describe("integration scenarios", () => {
    it("should handle backend switching via settings", async () => {
      // First, write with file backend
      await writeMemory(tempDir, "Initial content");
      expect(existsSync(join(tempDir, ".fusion", "memory.md"))).toBe(true);

      // Read with readonly backend (should still find the file even though it's read-only)
      // Note: readMemory doesn't check file existence for readonly - it just returns empty
      const readonlySettings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "readonly" };
      const readResult = await readMemory(tempDir, readonlySettings);
      expect(readResult.backend).toBe("readonly");
    });

    it("should maintain data across backend switches", async () => {
      // Write with file backend
      await writeMemory(tempDir, "Persistent content");

      // File should exist
      expect(existsSync(join(tempDir, ".fusion", "memory.md"))).toBe(true);

      // Read back with file backend
      const fileSettings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "file" };
      const readResult = await readMemory(tempDir, fileSettings);
      expect(readResult.content).toBe("Persistent content");
    });

    it("should handle custom registered backend", async () => {
      const testBackend: MemoryBackend = {
        type: "test-backend",
        name: "Test Backend",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: true,
          hasConflictResolution: false,
          persistent: true,
        },
        async read(_rootDir) {
          return { content: "test-content", exists: true, backend: "test-backend" };
        },
        async write(_rootDir, _content) {
          return { success: true, backend: "test-backend" };
        },
      };

      registerMemoryBackend(testBackend);

      const settings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "test-backend" };
      
      const backend = resolveMemoryBackend(settings);
      expect(backend.type).toBe("test-backend");

      const readResult = await readMemory(tempDir, settings);
      expect(readResult.content).toBe("test-content");
      expect(readResult.backend).toBe("test-backend");

      const writeResult = await writeMemory(tempDir, "new content", settings);
      expect(writeResult.success).toBe(true);
      expect(writeResult.backend).toBe("test-backend");
    });

    it("should handle QMD write-then-read round-trip via convenience functions", async () => {
      const qmdSettings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "qmd" };
      const testContent = "QMD test content for round-trip verification";

      // Write using QMD convenience function
      const writeResult = await writeMemory(tempDir, testContent, qmdSettings);
      expect(writeResult.success).toBe(true);
      expect(writeResult.backend).toBe("qmd");

      // Read using QMD convenience function
      const readResult = await readMemory(tempDir, qmdSettings);
      expect(readResult.content).toBe(testContent);
      expect(readResult.exists).toBe(true);
      expect(readResult.backend).toBe("qmd");
    });

    it("should handle QMD persistence cross-verification (QMD write, FileMemoryBackend read)", async () => {
      const qmdSettings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "qmd" };
      const testContent = "QMD persistence cross-verification content";

      // Write via QMD convenience function
      await writeMemory(tempDir, testContent, qmdSettings);

      // Read via direct FileMemoryBackend instance to verify filesystem delegation
      const fileBackend = new FileMemoryBackend();
      const fileResult = await fileBackend.read(tempDir);
      expect(fileResult.content).toBe(testContent);
      expect(fileResult.exists).toBe(true);
      expect(fileResult.backend).toBe("file"); // FileBackend reports "file"
    });

    it("should preserve content across backend switching (file to QMD)", async () => {
      const fileSettings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "file" };
      const qmdSettings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "qmd" };
      const testContent = "Shared storage content across backends";

      // Write via file backend
      await writeMemory(tempDir, testContent, fileSettings);

      // Read via QMD backend
      const qmdReadResult = await readMemory(tempDir, qmdSettings);
      expect(qmdReadResult.content).toBe(testContent);
      expect(qmdReadResult.backend).toBe("qmd");

      // Read back via file backend to verify consistency
      const fileReadResult = await readMemory(tempDir, fileSettings);
      expect(fileReadResult.content).toBe(testContent);
    });

    it("should correctly report memoryExists for QMD backend", async () => {
      const qmdSettings = { [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: "qmd" };

      // Initially should not exist
      const existsBefore = await memoryExists(tempDir, qmdSettings);
      expect(existsBefore).toBe(false);

      // Write via QMD
      await writeMemory(tempDir, "QMD exists test content", qmdSettings);

      // Now should exist
      const existsAfter = await memoryExists(tempDir, qmdSettings);
      expect(existsAfter).toBe(true);
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle empty content", async () => {
      await writeMemory(tempDir, "");
      const result = await readMemory(tempDir);
      expect(result.content).toBe("");
      expect(result.exists).toBe(true); // File exists, just empty
    });

    it("should handle unicode content", async () => {
      const unicodeContent = "# プロジェクトメモリ\n\n日本語のテスト content 🎉";
      await writeMemory(tempDir, unicodeContent);
      
      const result = await readMemory(tempDir);
      expect(result.content).toBe(unicodeContent);
    });

    it("should handle large content", async () => {
      const largeContent = "x".repeat(100000);
      await writeMemory(tempDir, largeContent);
      
      const result = await readMemory(tempDir);
      expect(result.content).toBe(largeContent);
    });

    it("should handle nested paths correctly", async () => {
      const nestedDir = join(tempDir, "sub", "project");
      await mkdir(nestedDir, { recursive: true });

      await writeMemory(nestedDir, "Nested content");
      
      const result = await readMemory(nestedDir);
      expect(result.content).toBe("Nested content");
      expect(existsSync(join(nestedDir, ".fusion", "memory.md"))).toBe(true);
    });
  });
});
