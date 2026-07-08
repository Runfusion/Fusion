import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveFileReferences } from "../chat.js";

// Use vi.hoisted for proper hoisting with ES modules
const { mockReadFile, mockStat } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
}));

// Mock node:fs/promises - must provide both default and named exports
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    default: {
      ...actual,
      readdir: vi.fn(),
      readFile: mockReadFile,
      stat: mockStat,
    },
    readdir: vi.fn(),
    readFile: mockReadFile,
    stat: mockStat,
  };
});

// Mock @fusion/core to prevent cascade loading of real fs modules
vi.mock("@fusion/core", () => ({
  summarizeTitle: vi.fn(),
  // FNXC:DashboardChatTests 2026-07-08-12:00: FN-7675 added FUSION_RUNTIME_SELF_AWARENESS to chat.ts's @fusion/core imports (CHAT_SYSTEM_PROMPT embeds it). The hand-written core mock must stub it so chat.js loads; importOriginal is intentionally avoided to prevent the real fs cascade this mock exists to block.
  FUSION_RUNTIME_SELF_AWARENESS: "",
  AgentStore: vi.fn(),
  ChatStore: vi.fn(),
  registerTraitHookImpl: vi.fn(),
}));

describe("resolveFileReferences", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockStat.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns original content when no file mentions are present", async () => {
    const content = "Hello, how are you?";
    const result = await resolveFileReferences(content, "/project");
    expect(result).toBe(content);
  });

  it("returns original content for # without file extension", async () => {
    const content = "I want to mention #something but no extension";
    const result = await resolveFileReferences(content, "/project");
    expect(result).toBe(content);
  });

  it("resolves a single file mention and appends content", async () => {
    const content = "Can you look at #src/index.ts?";
    mockStat.mockResolvedValueOnce({ isFile: () => true, size: 500 });
    mockReadFile.mockResolvedValueOnce("export function test() {}");

    const result = await resolveFileReferences(content, "/project");

    expect(result).toContain(content);
    expect(result).toContain("[Referenced File: src/index.ts]");
    expect(result).toContain("export function test() {}");
    expect(result).toContain("[/Referenced File: src/index.ts]");
  });

  it("resolves multiple file mentions", async () => {
    const content = "Check #src/a.ts and #src/b.ts";
    mockStat
      .mockResolvedValueOnce({ isFile: () => true, size: 100 })
      .mockResolvedValueOnce({ isFile: () => true, size: 200 });
    mockReadFile
      .mockResolvedValueOnce("// file a")
      .mockResolvedValueOnce("// file b");

    const result = await resolveFileReferences(content, "/project");

    expect(result).toContain("[Referenced File: src/a.ts]");
    expect(result).toContain("[Referenced File: src/b.ts]");
    expect(result).toContain("// file a");
    expect(result).toContain("// file b");
  });

  it("skips files that do not exist", async () => {
    const content = "Missing #nonexistent.ts";
    mockStat.mockRejectedValueOnce({ code: "ENOENT" });

    const result = await resolveFileReferences(content, "/project");

    expect(result).toBe(content); // No file context appended
  });

  it("skips files larger than 50KB", async () => {
    const content = "Large #big.ts";
    mockStat.mockResolvedValueOnce({ isFile: () => true, size: 60 * 1024 });

    const result = await resolveFileReferences(content, "/project");

    expect(result).toBe(content); // No file context appended
  });

  it("skips directories (non-files)", async () => {
    const content = "Dir #src";
    mockStat.mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true });

    const result = await resolveFileReferences(content, "/project");

    expect(result).toBe(content);
  });

  it("blocks path traversal attacks (e.g., ../../../etc/passwd)", async () => {
    const content = "Traversal #../../../etc/passwd";
    mockStat.mockRejectedValueOnce(new Error("Access denied: Path traversal detected"));

    const result = await resolveFileReferences(content, "/project");

    expect(result).toBe(content); // Blocked, no file context
  });

  it("blocks absolute path references", async () => {
    const content = "Absolute #/etc/passwd";
    mockStat.mockRejectedValueOnce(new Error("Access denied: Absolute paths not allowed"));

    const result = await resolveFileReferences(content, "/project");

    expect(result).toBe(content); // Blocked
  });

  it("blocks null byte injection", async () => {
    const content = "Null byte #file\u0000.txt";
    mockStat.mockRejectedValueOnce(new Error("Access denied: Invalid characters in path"));

    const result = await resolveFileReferences(content, "/project");

    expect(result).toBe(content); // Blocked
  });

  it("deduplicates same file mentioned multiple times", async () => {
    const content = "#src/a.ts and again #src/a.ts";
    mockStat.mockResolvedValueOnce({ isFile: () => true, size: 100 });
    mockReadFile.mockResolvedValueOnce("// content");

    const result = await resolveFileReferences(content, "/project");

    // Should only appear once in output
    const occurrences = (result.match(/\[Referenced File: src\/a\.ts\]/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("handles mixed valid and invalid file references", async () => {
    const content = "Valid #src/valid.ts and invalid #nonexistent.ts";
    mockStat
      .mockResolvedValueOnce({ isFile: () => true, size: 100 })
      .mockRejectedValueOnce({ code: "ENOENT" });
    mockReadFile.mockResolvedValueOnce("// valid");

    const result = await resolveFileReferences(content, "/project");

    expect(result).toContain("[Referenced File: src/valid.ts]");
    expect(result).toContain("// valid");
    // No referenced file block for nonexistent.ts
    expect(result).not.toContain("[/Referenced File: nonexistent.ts]");
  });

  it("handles file with path containing hyphens and underscores", async () => {
    const content = "Check #my-app/my-file_2.ts";
    mockStat.mockResolvedValueOnce({ isFile: () => true, size: 50 });
    mockReadFile.mockResolvedValueOnce("// code");

    const result = await resolveFileReferences(content, "/project");

    expect(result).toContain("[Referenced File: my-app/my-file_2.ts]");
  });

  it("returns original content when all files are invalid", async () => {
    const content = "#a.ts and #b.ts";
    mockStat
      .mockRejectedValueOnce({ code: "ENOENT" })
      .mockRejectedValueOnce({ code: "ENOENT" });

    const result = await resolveFileReferences(content, "/project");

    expect(result).toBe(content);
  });
});