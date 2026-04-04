import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FileServiceError,
  listFiles,
  readFile,
  writeFile,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  MAX_FILE_SIZE,
} from "../file-service.js";
import type { TaskStore } from "@fusion/core";

// Mock node:fs/promises - use vi.hoisted for proper hoisting with ES modules
const { mockReaddir, mockReadFile, mockWriteFile, mockStat } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockStat: vi.fn(),
}));

// Mock node:fs
const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    default: {
      ...actual,
      readdir: mockReaddir,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      stat: mockStat,
    },
    readdir: mockReaddir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    stat: mockStat,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    default: {
      ...actual,
      existsSync: mockExistsSync,
    },
    existsSync: mockExistsSync,
  };
});

describe("FileServiceError", () => {
  it("constructor sets code and name correctly", () => {
    const error = new FileServiceError("Test message", "ETEST");
    
    expect(error.message).toBe("Test message");
    expect(error.code).toBe("ETEST");
    expect(error.name).toBe("FileServiceError");
  });

  it("is an instance of Error", () => {
    const error = new FileServiceError("Test", "ETEST");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("MAX_FILE_SIZE", () => {
  it("is 1MB (1024 * 1024 bytes)", () => {
    expect(MAX_FILE_SIZE).toBe(1024 * 1024);
    expect(MAX_FILE_SIZE).toBe(1048576);
  });
});

describe("path traversal protection", () => {
  const mockGetTask = vi.fn();
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getTask: mockGetTask,
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetTask.mockReset();
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockReaddir.mockReset();
    mockExistsSync.mockReset();
  });

  describe("via listProjectFiles", () => {
    it("rejects path traversal attacks (../)", async () => {
      mockGetRootDir.mockReturnValue("/test/project");

      await expect(listProjectFiles(mockStore, "../secret.txt")).rejects.toThrow(FileServiceError);
      await expect(listProjectFiles(mockStore, "../secret.txt")).rejects.toThrow("Path traversal detected");
    });

    it("rejects absolute paths", async () => {
      mockGetRootDir.mockReturnValue("/test/project");

      await expect(listProjectFiles(mockStore, "/etc/passwd")).rejects.toThrow(FileServiceError);
      await expect(listProjectFiles(mockStore, "/etc/passwd")).rejects.toThrow("Absolute paths not allowed");
    });

    it("rejects paths with null bytes", async () => {
      mockGetRootDir.mockReturnValue("/test/project");

      await expect(listProjectFiles(mockStore, "file\0.txt")).rejects.toThrow(FileServiceError);
      await expect(listProjectFiles(mockStore, "file\0.txt")).rejects.toThrow("Invalid characters");
    });

    it("rejects URL-encoded path traversal", async () => {
      mockGetRootDir.mockReturnValue("/test/project");

      await expect(listProjectFiles(mockStore, "%2e%2e%2fsecret.txt")).rejects.toThrow(FileServiceError);
      await expect(listProjectFiles(mockStore, "%2e%2e%2fsecret.txt")).rejects.toThrow("Path traversal detected");
    });
  });

  describe("via readProjectFile", () => {
    it("rejects path traversal attacks", async () => {
      mockGetRootDir.mockReturnValue("/test/project");

      await expect(readProjectFile(mockStore, "../.env")).rejects.toThrow(FileServiceError);
      await expect(readProjectFile(mockStore, "../.env")).rejects.toThrow("Path traversal detected");
    });

    it("rejects absolute paths", async () => {
      mockGetRootDir.mockReturnValue("/test/project");

      await expect(readProjectFile(mockStore, "/etc/passwd")).rejects.toThrow(FileServiceError);
      await expect(readProjectFile(mockStore, "/etc/passwd")).rejects.toThrow("Absolute paths not allowed");
    });
  });

  describe("via writeProjectFile", () => {
    it("rejects path traversal attacks", async () => {
      mockGetRootDir.mockReturnValue("/test/project");

      await expect(writeProjectFile(mockStore, "../.env", "evil")).rejects.toThrow(FileServiceError);
      await expect(writeProjectFile(mockStore, "../.env", "evil")).rejects.toThrow("Path traversal detected");
    });

    it("rejects null bytes in path", async () => {
      mockGetRootDir.mockReturnValue("/test/project");

      await expect(writeProjectFile(mockStore, "file\0.txt", "content")).rejects.toThrow(FileServiceError);
      await expect(writeProjectFile(mockStore, "file\0.txt", "content")).rejects.toThrow("Invalid characters");
    });

    it("rejects absolute paths", async () => {
      mockGetRootDir.mockReturnValue("/test/project");

      await expect(writeProjectFile(mockStore, "/etc/crontab", "evil")).rejects.toThrow(FileServiceError);
      await expect(writeProjectFile(mockStore, "/etc/crontab", "evil")).rejects.toThrow("Absolute paths not allowed");
    });
  });

  describe("via listFiles (task)", () => {
    it("rejects path traversal in task context", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockGetTask.mockResolvedValue({ id: "FN-123", worktree: undefined });

      await expect(listFiles(mockStore, "FN-123", "../other-task")).rejects.toThrow(FileServiceError);
      await expect(listFiles(mockStore, "FN-123", "../other-task")).rejects.toThrow("Path traversal detected");
    });

    it("rejects absolute paths in task context", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockGetTask.mockResolvedValue({ id: "FN-123", worktree: undefined });

      await expect(listFiles(mockStore, "FN-123", "/etc/passwd")).rejects.toThrow(FileServiceError);
    });
  });

  describe("via readFile (task)", () => {
    it("rejects path traversal when reading task files", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockGetTask.mockResolvedValue({ id: "FN-123", worktree: undefined });

      await expect(readFile(mockStore, "FN-123", "../../secret.txt")).rejects.toThrow(FileServiceError);
      await expect(readFile(mockStore, "FN-123", "../../secret.txt")).rejects.toThrow("Path traversal detected");
    });
  });

  describe("via writeFile (task)", () => {
    it("rejects path traversal when writing task files", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockGetTask.mockResolvedValue({ id: "FN-123", worktree: undefined });

      await expect(writeFile(mockStore, "FN-123", "../../outside.txt", "data")).rejects.toThrow(FileServiceError);
    });
  });

  describe("via workspace operations", () => {
    it("rejects path traversal in workspace file listing", async () => {
      mockGetRootDir.mockReturnValue("/project");

      await expect(listWorkspaceFiles(mockStore, "project", "../../outside")).rejects.toThrow(FileServiceError);
    });

    it("rejects path traversal in workspace file read", async () => {
      mockGetRootDir.mockReturnValue("/project");

      await expect(readWorkspaceFile(mockStore, "project", "../.env")).rejects.toThrow(FileServiceError);
    });

    it("rejects path traversal in workspace file write", async () => {
      mockGetRootDir.mockReturnValue("/project");

      await expect(writeWorkspaceFile(mockStore, "project", "../.env", "data")).rejects.toThrow(FileServiceError);
    });

    it("rejects absolute paths in workspace file read", async () => {
      mockGetRootDir.mockReturnValue("/project");

      await expect(readWorkspaceFile(mockStore, "project", "/etc/passwd")).rejects.toThrow(FileServiceError);
    });
  });

  describe("complex path traversal patterns", () => {
    it("rejects nested path traversal", async () => {
      mockGetRootDir.mockReturnValue("/project");

      await expect(listProjectFiles(mockStore, "foo/../../secret")).rejects.toThrow(FileServiceError);
    });

    it("rejects parent directory at root", async () => {
      mockGetRootDir.mockReturnValue("/project");

      await expect(listProjectFiles(mockStore, "..")).rejects.toThrow(FileServiceError);
      await expect(listProjectFiles(mockStore, "../")).rejects.toThrow(FileServiceError);
    });

    it("allows valid relative paths with dots", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockStat.mockResolvedValue({
        isDirectory: () => true,
        isFile: () => false,
      });
      mockReaddir.mockResolvedValue([]);

      // Should resolve ./src to src and succeed
      const result = await listProjectFiles(mockStore, "./src");
      expect(result.path).toBe("src");
      expect(result.entries).toEqual([]);
    });

    it("allows paths containing single dots in middle", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockStat.mockResolvedValue({
        isDirectory: () => true,
        isFile: () => false,
      });
      mockReaddir.mockResolvedValue([]);

      // Should resolve src/./components to src/components and succeed
      const result = await listProjectFiles(mockStore, "src/./components");
      expect(result.path).toBe("src/components");
      expect(result.entries).toEqual([]);
    });
  });
});

describe("listProjectFiles", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockReaddir.mockReset();
  });

  it("throws FileServiceError with ENOENT for missing directory", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    mockStat.mockRejectedValue({ code: "ENOENT" });

    await expect(listProjectFiles(mockStore, "missing")).rejects.toThrow(FileServiceError);
    await expect(listProjectFiles(mockStore, "missing")).rejects.toThrow("Directory not found");
  });

  it("throws FileServiceError with ENOTDIR for non-directory", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    mockStat.mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
    });

    await expect(listProjectFiles(mockStore, "file.txt")).rejects.toThrow(FileServiceError);
    await expect(listProjectFiles(mockStore, "file.txt")).rejects.toThrow("Not a directory");
  });
});

describe("readProjectFile", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
  });

  it("enforces max file size limit (1MB)", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    mockStat.mockResolvedValue({
      isFile: () => true,
      size: MAX_FILE_SIZE + 1,
      mtime: new Date(),
    });

    await expect(readProjectFile(mockStore, "large.bin")).rejects.toThrow(FileServiceError);
    await expect(readProjectFile(mockStore, "large.bin")).rejects.toThrow("File too large");
  });

  it("throws FileServiceError with ENOENT for missing file", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    mockStat.mockRejectedValue({ code: "ENOENT" });

    await expect(readProjectFile(mockStore, "missing.txt")).rejects.toThrow(FileServiceError);
    await expect(readProjectFile(mockStore, "missing.txt")).rejects.toThrow("File not found");
  });

  it("throws FileServiceError when path is not a file", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    mockStat.mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
    });

    await expect(readProjectFile(mockStore, "src")).rejects.toThrow(FileServiceError);
    await expect(readProjectFile(mockStore, "src")).rejects.toThrow("Not a file");
  });

  it("requires file path", async () => {
    mockGetRootDir.mockReturnValue("/test/project");

    await expect(readProjectFile(mockStore, "")).rejects.toThrow(FileServiceError);
    await expect(readProjectFile(mockStore, "")).rejects.toThrow("File path is required");
  });
});

describe("writeProjectFile", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockWriteFile.mockReset();
  });

  it("prevents writing to directories", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    mockStat.mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
    });

    await expect(writeProjectFile(mockStore, "src", "content")).rejects.toThrow(FileServiceError);
    await expect(writeProjectFile(mockStore, "src", "content")).rejects.toThrow("Cannot write to directory");
  });

  it("validates parent directory exists", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    mockStat
      .mockRejectedValueOnce({ code: "ENOENT" }) // File doesn't exist
      .mockRejectedValueOnce({ code: "ENOENT" }); // Parent doesn't exist (this should throw)

    await expect(writeProjectFile(mockStore, "missing/file.txt", "content")).rejects.toThrow("Parent directory does not exist");
  });

  it("throws when parent is not a directory", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    mockStat
      .mockRejectedValueOnce({ code: "ENOENT" }) // File doesn't exist
      .mockResolvedValueOnce({
        isDirectory: () => false,
        isFile: () => true,
      }); // Parent is a file

    await expect(writeProjectFile(mockStore, "file.txt/sub.txt", "content")).rejects.toThrow("Parent directory does not exist");
  });

  it("requires file path", async () => {
    mockGetRootDir.mockReturnValue("/test/project");

    await expect(writeProjectFile(mockStore, "", "content")).rejects.toThrow(FileServiceError);
    await expect(writeProjectFile(mockStore, "", "content")).rejects.toThrow("File path is required");
  });

  it("enforces max content size", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    const largeContent = "x".repeat(MAX_FILE_SIZE + 1);

    await expect(writeProjectFile(mockStore, "large.txt", largeContent)).rejects.toThrow(FileServiceError);
    await expect(writeProjectFile(mockStore, "large.txt", largeContent)).rejects.toThrow("Content too large");
  });
});

describe("task file operations", () => {
  const mockGetTask = vi.fn();
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getTask: mockGetTask,
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetTask.mockReset();
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockExistsSync.mockReset();
  });

  describe("getTaskBasePath", () => {
    it("returns worktree path if it exists", async () => {
      const worktreePath = "/worktrees/kb-123";

      mockGetTask.mockResolvedValue({
        id: "FN-123",
        worktree: worktreePath,
      });
      mockExistsSync.mockReturnValue(true);
      mockStat.mockResolvedValue({
        isFile: () => true,
        size: 100,
        mtime: new Date("2024-01-01"),
      });
      mockReadFile.mockResolvedValue("Task content");

      const result = await readFile(mockStore, "FN-123", "PROMPT.md");

      expect(mockReadFile).toHaveBeenCalledWith(
        "/worktrees/kb-123/PROMPT.md",
        "utf-8",
      );
      expect(result.content).toBe("Task content");
    });

    it("falls back to task directory when worktree doesn't exist", async () => {
      mockGetTask.mockResolvedValue({
        id: "FN-123",
        worktree: "/missing/worktree",
      });
      mockGetRootDir.mockReturnValue("/project");
      mockExistsSync.mockReturnValue(false);
      mockStat.mockResolvedValue({
        isFile: () => true,
        size: 100,
        mtime: new Date("2024-01-01"),
      });
      mockReadFile.mockResolvedValue("Task content");

      await readFile(mockStore, "FN-123", "PROMPT.md");

      expect(mockReadFile).toHaveBeenCalledWith(
        "/project/.fusion/tasks/FN-123/PROMPT.md",
        "utf-8",
      );
    });

    it("falls back to task directory when worktree is undefined", async () => {
      mockGetTask.mockResolvedValue({
        id: "FN-123",
        worktree: undefined,
      });
      mockGetRootDir.mockReturnValue("/project");
      mockStat.mockResolvedValue({
        isFile: () => true,
        size: 100,
        mtime: new Date("2024-01-01"),
      });
      mockReadFile.mockResolvedValue("Task content");

      await readFile(mockStore, "FN-123", "PROMPT.md");

      expect(mockReadFile).toHaveBeenCalledWith(
        "/project/.fusion/tasks/FN-123/PROMPT.md",
        "utf-8",
      );
    });

    it("throws ENOTASK for missing task (ENOENT)", async () => {
      mockGetTask.mockRejectedValue({ code: "ENOENT" });

      await expect(readFile(mockStore, "KB-999", "file.txt")).rejects.toThrow(FileServiceError);
    });

    it("throws ENOTASK for task not found error message", async () => {
      mockGetTask.mockRejectedValue(new Error("Task not found"));

      await expect(readFile(mockStore, "KB-999", "file.txt")).rejects.toThrow(FileServiceError);
    });
  });
});

describe("workspace operations", () => {
  const mockGetTask = vi.fn();
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getTask: mockGetTask,
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetTask.mockReset();
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockExistsSync.mockReset();
  });

  describe("listWorkspaceFiles", () => {
    it('"project" workspace resolves to project root', async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockStat.mockResolvedValue({
        isDirectory: () => true,
        isFile: () => false,
      });

      mockReaddir.mockResolvedValue([
        { name: "src", isDirectory: () => true, isFile: () => false },
      ]);

      mockStat.mockResolvedValue({
        isDirectory: () => true,
        isFile: () => false,
        size: 0,
        mtime: new Date(),
      });

      const result = await listWorkspaceFiles(mockStore, "project");

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe("src");
    });

    it("task ID workspace resolves to task path", async () => {
      mockGetTask.mockResolvedValue({ id: "FN-456", worktree: undefined });
      mockGetRootDir.mockReturnValue("/project");
      // First call: stat on the directory
      // Second call: stat on PROMPT.md entry
      mockStat
        .mockResolvedValueOnce({
          isDirectory: () => true,
          isFile: () => false,
          size: 0,
          mtime: new Date(),
        })
        .mockResolvedValueOnce({
          isDirectory: () => false,
          isFile: () => true,
          size: 100,
          mtime: new Date(),
        });

      mockReaddir.mockResolvedValue([
        { name: "PROMPT.md", isDirectory: () => false, isFile: () => true },
      ]);

      const result = await listWorkspaceFiles(mockStore, "FN-456");

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe("PROMPT.md");
    });
  });

  describe("readWorkspaceFile", () => {
    it("reads file from project workspace", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockStat.mockResolvedValue({
        isFile: () => true,
        size: 50,
        mtime: new Date("2024-01-01"),
      });
      mockReadFile.mockResolvedValue("File contents");

      const result = await readWorkspaceFile(mockStore, "project", "README.md");

      expect(result.content).toBe("File contents");
      expect(mockReadFile).toHaveBeenCalledWith(
        "/project/README.md",
        "utf-8",
      );
    });

    it("reads file from task workspace", async () => {
      mockGetTask.mockResolvedValue({ id: "FN-123", worktree: undefined });
      mockGetRootDir.mockReturnValue("/project");
      mockStat.mockResolvedValue({
        isFile: () => true,
        size: 200,
        mtime: new Date("2024-02-01"),
      });
      mockReadFile.mockResolvedValue("Task description");

      const result = await readWorkspaceFile(mockStore, "FN-123", "PROMPT.md");

      expect(result.content).toBe("Task description");
      expect(mockReadFile).toHaveBeenCalledWith(
        "/project/.fusion/tasks/FN-123/PROMPT.md",
        "utf-8",
      );
    });
  });

  describe("writeWorkspaceFile", () => {
    it("writes file to project workspace", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockStat
        .mockRejectedValueOnce({ code: "ENOENT" })
        .mockResolvedValueOnce({ isDirectory: () => true });
      mockWriteFile.mockResolvedValue(undefined);
      mockStat.mockResolvedValue({
        size: 20,
        mtime: new Date("2024-03-01"),
      });

      const result = await writeWorkspaceFile(mockStore, "project", "notes.txt", "My notes");

      expect(result.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/project/notes.txt",
        "My notes",
        "utf-8",
      );
    });

    it("writes file to task workspace", async () => {
      mockGetTask.mockResolvedValue({ id: "FN-123", worktree: undefined });
      mockGetRootDir.mockReturnValue("/project");
      mockStat
        .mockRejectedValueOnce({ code: "ENOENT" })
        .mockResolvedValueOnce({ isDirectory: () => true });
      mockWriteFile.mockResolvedValue(undefined);
      mockStat.mockResolvedValue({
        size: 30,
        mtime: new Date("2024-04-01"),
      });

      const result = await writeWorkspaceFile(mockStore, "FN-123", "output.txt", "Task output");

      expect(result.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/project/.fusion/tasks/FN-123/output.txt",
        "Task output",
        "utf-8",
      );
    });
  });
});

describe("hidden files visibility", () => {
  const mockGetTask = vi.fn();
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getTask: mockGetTask,
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetTask.mockReset();
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockReaddir.mockReset();
    mockExistsSync.mockReset();
  });

  describe("listWorkspaceFiles", () => {
    it("includes hidden files (dotfiles) in workspace listing", async () => {
      mockGetRootDir.mockReturnValue("/project");
      // stat for the directory itself, then for each entry
      mockStat
        .mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date() })
        .mockResolvedValueOnce({ isDirectory: () => false, isFile: () => true, size: 42, mtime: new Date() })
        .mockResolvedValueOnce({ isDirectory: () => false, isFile: () => true, size: 200, mtime: new Date() })
        .mockResolvedValueOnce({ isDirectory: () => false, isFile: () => true, size: 15, mtime: new Date() });

      mockReaddir.mockResolvedValue([
        { name: ".env.example", isDirectory: () => false, isFile: () => true },
        { name: ".gitignore", isDirectory: () => false, isFile: () => true },
        { name: "README.md", isDirectory: () => false, isFile: () => true },
      ]);

      const result = await listWorkspaceFiles(mockStore, "project");

      expect(result.entries).toHaveLength(3);
      const names = result.entries.map((e) => e.name);
      expect(names).toContain(".env.example");
      expect(names).toContain(".gitignore");
      expect(names).toContain("README.md");
    });

    it("includes hidden directories (dot-directories) in workspace listing", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockStat
        .mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date() })
        .mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date() })
        .mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date() })
        .mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date() });

      mockReaddir.mockResolvedValue([
        { name: ".changeset", isDirectory: () => true, isFile: () => false },
        { name: ".github", isDirectory: () => true, isFile: () => false },
        { name: "src", isDirectory: () => true, isFile: () => false },
      ]);

      const result = await listWorkspaceFiles(mockStore, "project");

      expect(result.entries).toHaveLength(3);
      const names = result.entries.map((e) => e.name);
      expect(names).toContain(".changeset");
      expect(names).toContain(".github");
      expect(names).toContain("src");
      // All should be type directory
      expect(result.entries.every((e) => e.type === "directory")).toBe(true);
    });

    it("includes mixed hidden and non-hidden entries with correct sort order", async () => {
      mockGetRootDir.mockReturnValue("/project");
      // Directory stat + 6 entry stats = 7 mock returns
      const dirStat = { isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date() };
      const fileStat = (size: number) => ({ isDirectory: () => false, isFile: () => true, size, mtime: new Date() });
      mockStat
        .mockResolvedValueOnce(dirStat)   // directory itself
        .mockResolvedValueOnce(dirStat)   // .github (dir)
        .mockResolvedValueOnce(dirStat)   // .changeset (dir)
        .mockResolvedValueOnce(dirStat)   // src (dir)
        .mockResolvedValueOnce(fileStat(10))   // .env (file)
        .mockResolvedValueOnce(fileStat(300))  // README.md (file)
        .mockResolvedValueOnce(fileStat(50));  // package.json (file)

      mockReaddir.mockResolvedValue([
        { name: ".env", isDirectory: () => false, isFile: () => true },
        { name: ".github", isDirectory: () => true, isFile: () => false },
        { name: "README.md", isDirectory: () => false, isFile: () => true },
        { name: "src", isDirectory: () => true, isFile: () => false },
        { name: ".changeset", isDirectory: () => true, isFile: () => false },
        { name: "package.json", isDirectory: () => false, isFile: () => true },
      ]);

      const result = await listWorkspaceFiles(mockStore, "project");

      expect(result.entries).toHaveLength(6);
      // Sort order: directories first, then files, both alphabetically
      const types = result.entries.map((e) => e.type);
      const lastDirIdx = types.lastIndexOf("directory");
      const firstFileIdx = types.indexOf("file");
      expect(lastDirIdx).toBeLessThan(firstFileIdx);

      // Hidden entries are present
      const names = result.entries.map((e) => e.name);
      expect(names).toContain(".env");
      expect(names).toContain(".github");
      expect(names).toContain(".changeset");
    });
  });

  describe("listProjectFiles", () => {
    it("includes hidden files and directories in project listing", async () => {
      mockGetRootDir.mockReturnValue("/project");
      mockStat
        .mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date() })
        .mockResolvedValueOnce({ isDirectory: () => false, isFile: () => true, size: 18, mtime: new Date() })
        .mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date() });

      mockReaddir.mockResolvedValue([
        { name: ".editorconfig", isDirectory: () => false, isFile: () => true },
        { name: ".husky", isDirectory: () => true, isFile: () => false },
      ]);

      const result = await listProjectFiles(mockStore);

      expect(result.entries).toHaveLength(2);
      const names = result.entries.map((e) => e.name);
      expect(names).toContain(".editorconfig");
      expect(names).toContain(".husky");
    });
  });
});

describe("URL-encoded characters handling", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
  });

  it("decodes URL-encoded characters safely in file paths", async () => {
    mockGetRootDir.mockReturnValue("/test/project");
    mockStat.mockResolvedValue({
      isFile: () => true,
      size: 100,
      mtime: new Date("2024-01-01"),
    });
    mockReadFile.mockResolvedValue("Content");

    await readProjectFile(mockStore, "file%20name.txt");

    // Should decode %20 to space and look for the file
    expect(mockReadFile).toHaveBeenCalledWith(
      "/test/project/file name.txt",
      "utf-8",
    );
  });
});
