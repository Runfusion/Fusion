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
  searchWorkspaceFiles,
  scanMarkdownFiles,
  copyWorkspaceFile,
  moveWorkspaceFile,
  deleteWorkspaceFile,
  renameWorkspaceFile,
  getWorkspaceFileForDownload,
  getWorkspaceFolderForZip,
  MAX_FILE_SIZE,
} from "../file-service.js";
import type { TaskStore } from "@fusion/core";

// Mock node:fs/promises - use vi.hoisted for proper hoisting with ES modules
const { mockReaddir, mockReadFile, mockWriteFile, mockStat, mockCopyFile, mockRename, mockRm, mockMkdir, mockAccess } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockStat: vi.fn(),
  mockCopyFile: vi.fn(),
  mockRename: vi.fn(),
  mockRm: vi.fn(),
  mockMkdir: vi.fn(),
  mockAccess: vi.fn(),
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
      copyFile: mockCopyFile,
      rename: mockRename,
      rm: mockRm,
      mkdir: mockMkdir,
      access: mockAccess,
    },
    readdir: mockReaddir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    stat: mockStat,
    copyFile: mockCopyFile,
    rename: mockRename,
    rm: mockRm,
    mkdir: mockMkdir,
    access: mockAccess,
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
    mockAccess.mockReset();
  });

  describe("getTaskBasePath", () => {
    it("returns worktree path if it exists", async () => {
      const worktreePath = "/worktrees/kb-123";

      mockGetTask.mockResolvedValue({
        id: "FN-123",
        worktree: worktreePath,
      });
      mockAccess.mockResolvedValue(undefined);
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
      mockAccess.mockRejectedValue(new Error("not found"));
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

// ── File Operation Tests (Copy, Move, Delete, Rename) ──────────────

describe("copyWorkspaceFile", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockCopyFile.mockReset();
    mockReaddir.mockReset();
    mockMkdir.mockReset();
  });

  it("copies a file within the workspace", async () => {
    mockGetRootDir.mockReturnValue("/project");
    // stat for source (exists), stat for destination (ENOENT), stat for dest parent (exists)
    mockStat
      .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 100 })  // source
      .mockRejectedValueOnce({ code: "ENOENT" })  // dest doesn't exist
      .mockResolvedValueOnce({ isDirectory: () => true });  // dest parent

    mockCopyFile.mockResolvedValue(undefined);

    const result = await copyWorkspaceFile(mockStore, "project", "src/file.ts", "src/file-copy.ts");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Copied");
    expect(mockCopyFile).toHaveBeenCalledWith("/project/src/file.ts", "/project/src/file-copy.ts");
  });

  it("copies a directory recursively", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true })  // source is dir
      .mockRejectedValueOnce({ code: "ENOENT" })  // dest doesn't exist
      .mockResolvedValueOnce({ isDirectory: () => true });  // dest parent

    // readdir for the source directory
    mockReaddir.mockResolvedValue([
      { name: "sub.ts", isDirectory: () => false },
    ]);
    // copyFile for the file inside
    mockCopyFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);

    const result = await copyWorkspaceFile(mockStore, "project", "src", "src-copy");

    expect(result.success).toBe(true);
    expect(mockMkdir).toHaveBeenCalledWith("/project/src-copy", { recursive: true });
    expect(mockCopyFile).toHaveBeenCalledWith("/project/src/sub.ts", "/project/src-copy/sub.ts");
  });

  it("rejects path traversal in source", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(copyWorkspaceFile(mockStore, "project", "../secret", "dest")).rejects.toThrow("Path traversal");
  });

  it("rejects path traversal in destination", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(copyWorkspaceFile(mockStore, "project", "file.ts", "../outside")).rejects.toThrow("Path traversal");
  });

  it("rejects missing source path", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(copyWorkspaceFile(mockStore, "project", "", "dest")).rejects.toThrow("Source path is required");
  });

  it("rejects missing destination path", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(copyWorkspaceFile(mockStore, "project", "file.ts", "")).rejects.toThrow("Destination path is required");
  });

  it("rejects when source does not exist", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockRejectedValueOnce({ code: "ENOENT" });
    await expect(copyWorkspaceFile(mockStore, "project", "missing.ts", "dest.ts")).rejects.toThrow("Source not found");
  });

  it("rejects when destination already exists", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat
      .mockResolvedValueOnce({ isFile: () => true })  // source exists
      .mockResolvedValueOnce({ isFile: () => true });  // dest exists
    await expect(copyWorkspaceFile(mockStore, "project", "file.ts", "existing.ts")).rejects.toThrow("Destination already exists");
  });

  it("rejects when destination parent does not exist", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat
      .mockResolvedValueOnce({ isFile: () => true })  // source
      .mockRejectedValueOnce({ code: "ENOENT" })  // dest doesn't exist
      .mockRejectedValueOnce({ code: "ENOENT" });  // dest parent doesn't exist
    await expect(copyWorkspaceFile(mockStore, "project", "file.ts", "nonexistent/file.ts")).rejects.toThrow("Destination parent directory does not exist");
  });

  it("rejects operating on workspace root", async () => {
    mockGetRootDir.mockReturnValue("/project");
    // Even though validatePath would resolve "." to the root, the function checks for it
    await expect(copyWorkspaceFile(mockStore, "project", ".", "dest")).rejects.toThrow("Cannot operate on workspace root");
  });
});

describe("moveWorkspaceFile", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockRename.mockReset();
    mockCopyFile.mockReset();
    mockRm.mockReset();
  });

  it("moves a file within the workspace", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat
      .mockResolvedValueOnce({ isFile: () => true })  // source exists
      .mockRejectedValueOnce({ code: "ENOENT" })  // dest doesn't exist
      .mockResolvedValueOnce({ isDirectory: () => true });  // dest parent

    mockRename.mockResolvedValue(undefined);

    const result = await moveWorkspaceFile(mockStore, "project", "old.ts", "new.ts");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Moved");
    expect(mockRename).toHaveBeenCalledWith("/project/old.ts", "/project/new.ts");
  });

  it("rejects path traversal in source", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(moveWorkspaceFile(mockStore, "project", "../secret", "dest")).rejects.toThrow("Path traversal");
  });

  it("rejects path traversal in destination", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(moveWorkspaceFile(mockStore, "project", "file.ts", "../outside")).rejects.toThrow("Path traversal");
  });

  it("rejects when source does not exist", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockRejectedValueOnce({ code: "ENOENT" });
    await expect(moveWorkspaceFile(mockStore, "project", "missing.ts", "dest.ts")).rejects.toThrow("Source not found");
  });

  it("rejects when destination already exists", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat
      .mockResolvedValueOnce({ isFile: () => true })  // source
      .mockResolvedValueOnce({ isFile: () => true });  // dest exists
    await expect(moveWorkspaceFile(mockStore, "project", "file.ts", "existing.ts")).rejects.toThrow("Destination already exists");
  });

  it("rejects missing source path", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(moveWorkspaceFile(mockStore, "project", "", "dest")).rejects.toThrow("Source path is required");
  });
});

describe("deleteWorkspaceFile", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockRm.mockReset();
  });

  it("deletes a file", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false });
    mockRm.mockResolvedValue(undefined);

    const result = await deleteWorkspaceFile(mockStore, "project", "src/old.ts");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Deleted");
    expect(mockRm).toHaveBeenCalledWith("/project/src/old.ts");
  });

  it("deletes a directory recursively", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true });
    mockRm.mockResolvedValue(undefined);

    const result = await deleteWorkspaceFile(mockStore, "project", "src/olddir");

    expect(result.success).toBe(true);
    expect(mockRm).toHaveBeenCalledWith("/project/src/olddir", { recursive: true });
  });

  it("rejects path traversal", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(deleteWorkspaceFile(mockStore, "project", "../secret")).rejects.toThrow("Path traversal");
  });

  it("rejects deleting workspace root", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(deleteWorkspaceFile(mockStore, "project", ".")).rejects.toThrow("Cannot delete workspace root");
  });

  it("rejects missing file path", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(deleteWorkspaceFile(mockStore, "project", "")).rejects.toThrow("File path is required");
  });

  it("rejects when file does not exist", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockRejectedValueOnce({ code: "ENOENT" });
    await expect(deleteWorkspaceFile(mockStore, "project", "missing.ts")).rejects.toThrow("Not found");
  });
});

describe("renameWorkspaceFile", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockRename.mockReset();
  });

  it("renames a file", async () => {
    mockGetRootDir.mockReturnValue("/project");
    // stat: source exists, dest doesn't exist
    mockStat
      .mockResolvedValueOnce({ isFile: () => true })  // source
      .mockRejectedValueOnce({ code: "ENOENT" });  // dest doesn't exist

    mockRename.mockResolvedValue(undefined);

    const result = await renameWorkspaceFile(mockStore, "project", "old.ts", "new.ts");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Renamed");
    expect(mockRename).toHaveBeenCalledWith("/project/old.ts", "/project/new.ts");
  });

  it("renames a directory", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce({ code: "ENOENT" });

    mockRename.mockResolvedValue(undefined);

    const result = await renameWorkspaceFile(mockStore, "project", "src/olddir", "newdir");

    expect(result.success).toBe(true);
    expect(mockRename).toHaveBeenCalledWith("/project/src/olddir", "/project/src/newdir");
  });

  it("rejects path traversal", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(renameWorkspaceFile(mockStore, "project", "../secret", "newname")).rejects.toThrow("Path traversal");
  });

  it("rejects new name with path separator", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(renameWorkspaceFile(mockStore, "project", "file.ts", "sub/name.ts")).rejects.toThrow("path separators");
  });

  it("rejects new name with backslash", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(renameWorkspaceFile(mockStore, "project", "file.ts", "sub\\name.ts")).rejects.toThrow("path separators");
  });

  it("rejects empty new name", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(renameWorkspaceFile(mockStore, "project", "file.ts", "")).rejects.toThrow("New name is required");
  });

  it("rejects when file does not exist", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockRejectedValueOnce({ code: "ENOENT" });
    await expect(renameWorkspaceFile(mockStore, "project", "missing.ts", "new.ts")).rejects.toThrow("Not found");
  });

  it("rejects when a file with the new name already exists", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat
      .mockResolvedValueOnce({ isFile: () => true })  // source exists
      .mockResolvedValueOnce({ isFile: () => true });  // dest exists

    await expect(renameWorkspaceFile(mockStore, "project", "file.ts", "existing.ts")).rejects.toThrow("already exists");
  });

  it("rejects renaming workspace root", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(renameWorkspaceFile(mockStore, "project", ".", "newname")).rejects.toThrow("Cannot rename workspace root");
  });

  it("rejects null bytes in new name", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(renameWorkspaceFile(mockStore, "project", "file.ts", "bad\0name")).rejects.toThrow("path separators");
  });
});

describe("getWorkspaceFileForDownload", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
  });

  it("returns file info for download", async () => {
    const mtime = new Date("2024-01-15");
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 2048,
      mtime,
    });

    const result = await getWorkspaceFileForDownload(mockStore, "project", "src/file.ts");

    expect(result.absolutePath).toBe("/project/src/file.ts");
    expect(result.fileName).toBe("file.ts");
    expect(result.stats.size).toBe(2048);
    expect(result.stats.isFile).toBe(true);
  });

  it("rejects directories", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
    });

    await expect(getWorkspaceFileForDownload(mockStore, "project", "src")).rejects.toThrow("Not a file");
  });

  it("rejects path traversal", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(getWorkspaceFileForDownload(mockStore, "project", "../secret")).rejects.toThrow("Path traversal");
  });

  it("rejects empty path", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(getWorkspaceFileForDownload(mockStore, "project", "")).rejects.toThrow("File path is required");
  });

  it("rejects non-existent file", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockRejectedValue({ code: "ENOENT" });
    await expect(getWorkspaceFileForDownload(mockStore, "project", "missing.ts")).rejects.toThrow("File not found");
  });

  it("rejects downloading workspace root", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(getWorkspaceFileForDownload(mockStore, "project", ".")).rejects.toThrow("Cannot download workspace root");
  });
});

describe("getWorkspaceFolderForZip", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
  });

  it("returns directory info for zip download", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
    });

    const result = await getWorkspaceFolderForZip(mockStore, "project", "src");

    expect(result.absolutePath).toBe("/project/src");
    expect(result.dirName).toBe("src");
  });

  it("rejects files (not directories)", async () => {
    mockGetRootDir.mockReturnValue("/project");
    mockStat.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
    });

    await expect(getWorkspaceFolderForZip(mockStore, "project", "file.ts")).rejects.toThrow("Not a directory");
  });

  it("rejects path traversal", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(getWorkspaceFolderForZip(mockStore, "project", "../secret")).rejects.toThrow("Path traversal");
  });

  it("rejects empty path", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(getWorkspaceFolderForZip(mockStore, "project", "")).rejects.toThrow("Directory path is required");
  });

  it("rejects downloading workspace root as ZIP", async () => {
    mockGetRootDir.mockReturnValue("/project");
    await expect(getWorkspaceFolderForZip(mockStore, "project", ".")).rejects.toThrow("Cannot download workspace root as ZIP");
  });
});

describe("moveWorkspaceFile EXDEV fallback", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockStat.mockReset();
    mockRename.mockReset();
    mockCopyFile.mockReset();
    mockRm.mockReset();
    mockReaddir.mockReset();
    mockMkdir.mockReset();
  });

  it("falls back to copy+delete on cross-device move (EXDEV)", async () => {
    mockGetRootDir.mockReturnValue("/project");
    // Source exists, destination doesn't exist, dest parent exists
    mockStat
      .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false })  // source exists (move check)
      .mockRejectedValueOnce({ code: "ENOENT" })  // dest doesn't exist (move check)
      .mockResolvedValueOnce({ isDirectory: () => true })  // dest parent (move check)
      // copyWorkspaceFile will be called with same paths
      .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false })  // source (copy)
      .mockRejectedValueOnce({ code: "ENOENT" })  // dest doesn't exist (copy)
      .mockResolvedValueOnce({ isDirectory: () => true })  // dest parent (copy)
      // deleteWorkspaceFile will validate
      .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false });  // source exists (delete)

    // rename throws EXDEV
    mockRename.mockRejectedValue({ code: "EXDEV" });
    mockCopyFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);

    const result = await moveWorkspaceFile(mockStore, "project", "file.ts", "moved.ts");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Moved");
    expect(mockCopyFile).toHaveBeenCalledWith("/project/file.ts", "/project/moved.ts");
    expect(mockRm).toHaveBeenCalledWith("/project/file.ts");
  });
});

describe("searchWorkspaceFiles", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockReaddir.mockReset();
  });

  it("returns matching files filtered by query", async () => {
    mockGetRootDir.mockReturnValue("/project");

    // Mock: root has one subdir and one file
    mockReaddir.mockResolvedValueOnce([
      { name: "src", isDirectory: () => true, isFile: () => false },
      { name: "file.ts", isDirectory: () => false, isFile: () => true },
    ] as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    // Mock: src directory has a matching file
    mockReaddir.mockResolvedValueOnce([
      { name: "index.ts", isDirectory: () => false, isFile: () => true },
    ] as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    const result = await searchWorkspaceFiles(mockStore, "project", "index");
    expect(result.files).toContainEqual({ path: "src/index.ts", name: "index.ts" });
    expect(result.files).not.toContainEqual({ path: "file.ts", name: "file.ts" });
  });

  it("excludes common directories (node_modules, .git, etc.)", async () => {
    mockGetRootDir.mockReturnValue("/project");

    // Root has a subdir that will be excluded
    mockReaddir.mockResolvedValueOnce([
      { name: "node_modules", isDirectory: () => true, isFile: () => false },
      { name: ".git", isDirectory: () => true, isFile: () => false },
      { name: "src", isDirectory: () => true, isFile: () => false },
    ] as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    // Only src should be walked
    mockReaddir.mockResolvedValueOnce([
      { name: "app.ts", isDirectory: () => false, isFile: () => true },
    ] as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    const result = await searchWorkspaceFiles(mockStore, "project", "app");
    expect(result.files).toContainEqual({ path: "src/app.ts", name: "app.ts" });
    expect(mockReaddir).toHaveBeenCalledTimes(2); // root + src only
  });

  it("limits results to 50 matches maximum", async () => {
    mockGetRootDir.mockReturnValue("/project");

    // Return 60 files to test the limit
    const manyFiles = Array.from({ length: 60 }, (_, i) => ({
      name: `file${i}.ts`,
      isDirectory: () => false,
      isFile: () => true,
    }));
    mockReaddir.mockResolvedValueOnce(manyFiles as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    const result = await searchWorkspaceFiles(mockStore, "project", "file");
    expect(result.files.length).toBe(50);
  });

  it("does not throw when a subdirectory cannot be read", async () => {
    mockGetRootDir.mockReturnValue("/project");

    // Root has two directories
    mockReaddir.mockResolvedValueOnce([
      { name: "good", isDirectory: () => true, isFile: () => false },
      { name: "bad", isDirectory: () => true, isFile: () => false },
    ] as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    // good/ directory is accessible and has a matching file
    mockReaddir.mockResolvedValueOnce([
      { name: "target.ts", isDirectory: () => false, isFile: () => true },
    ] as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    // bad/ directory throws EACCES
    mockReaddir.mockRejectedValueOnce({ code: "EACCES" });

    // Should complete without throwing
    const result = await searchWorkspaceFiles(mockStore, "project", "target");
    expect(result.files).toContainEqual({ path: "good/target.ts", name: "target.ts" });
  });

  it("returns empty array when no files match", async () => {
    mockGetRootDir.mockReturnValue("/project");

    mockReaddir.mockResolvedValueOnce([
      { name: "src", isDirectory: () => true, isFile: () => false },
    ] as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    // src directory has no matching files
    mockReaddir.mockResolvedValueOnce([
      { name: "other.ts", isDirectory: () => false, isFile: () => true },
    ] as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    const result = await searchWorkspaceFiles(mockStore, "project", "nonexistent");
    expect(result.files).toEqual([]);
  });

  it("supports case-insensitive matching", async () => {
    mockGetRootDir.mockReturnValue("/project");

    mockReaddir.mockResolvedValueOnce([
      { name: "MyComponent.tsx", isDirectory: () => false, isFile: () => true },
      { name: "another.ts", isDirectory: () => false, isFile: () => true },
    ] as Awaited<ReturnType<typeof import("node:fs/promises").readdir>>);

    const result = await searchWorkspaceFiles(mockStore, "project", "mycomp");
    expect(result.files).toContainEqual({ path: "MyComponent.tsx", name: "MyComponent.tsx" });
  });
});

describe("scanMarkdownFiles", () => {
  const mockGetRootDir = vi.fn();
  const mockStore = {
    getRootDir: mockGetRootDir,
  } as unknown as TaskStore;

  function directoryEntry(name: string) {
    return { name, isDirectory: () => true, isFile: () => false };
  }

  function fileEntry(name: string) {
    return { name, isDirectory: () => false, isFile: () => true };
  }

  beforeEach(() => {
    mockGetRootDir.mockReset();
    mockReaddir.mockReset();
    mockStat.mockReset();
    mockReadFile.mockReset();
  });

  it("finds markdown files in project root and nested directories", async () => {
    mockGetRootDir.mockReturnValue("/project");

    mockReaddir.mockImplementation(async (targetPath: string) => {
      if (targetPath === "/project") {
        return [
          fileEntry("README.md"),
          fileEntry("notes.txt"),
          directoryEntry("docs"),
        ];
      }

      if (targetPath === "/project/docs") {
        return [fileEntry("CONTRIBUTING.md")];
      }

      return [];
    });

    mockStat.mockImplementation(async (targetPath: string) => {
      if (targetPath.endsWith("README.md") || targetPath.endsWith("CONTRIBUTING.md")) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: 128,
          mtime: new Date("2024-01-01T00:00:00.000Z"),
        };
      }

      throw { code: "ENOENT" };
    });

    mockReadFile.mockImplementation(async (targetPath: string) => {
      if (targetPath.endsWith("README.md")) {
        return "Root readme";
      }

      if (targetPath.endsWith("CONTRIBUTING.md")) {
        return "Contribution guide";
      }

      throw { code: "ENOENT" };
    });

    const result = await scanMarkdownFiles(mockStore);

    expect(result).toEqual([
      {
        path: "docs/CONTRIBUTING.md",
        name: "CONTRIBUTING.md",
        size: 128,
        mtime: "2024-01-01T00:00:00.000Z",
        contentPreview: "Contribution guide",
      },
      {
        path: "README.md",
        name: "README.md",
        size: 128,
        mtime: "2024-01-01T00:00:00.000Z",
        contentPreview: "Root readme",
      },
    ]);
  });

  it("excludes markdown files in blocked directories", async () => {
    mockGetRootDir.mockReturnValue("/project");

    mockReaddir.mockImplementation(async (targetPath: string) => {
      if (targetPath === "/project") {
        return [
          directoryEntry(".git"),
          directoryEntry("node_modules"),
          directoryEntry(".fusion"),
          directoryEntry("dist"),
          directoryEntry("build"),
          directoryEntry("docs"),
        ];
      }

      if (targetPath === "/project/docs") {
        return [fileEntry("README.md")];
      }

      throw { code: "ENOENT" };
    });

    mockStat.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 32,
      mtime: new Date("2024-01-02T00:00:00.000Z"),
    });
    mockReadFile.mockResolvedValue("Allowed file");

    const result = await scanMarkdownFiles(mockStore);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("docs/README.md");
    expect(mockReaddir).not.toHaveBeenCalledWith("/project/.git", { withFileTypes: true });
    expect(mockReaddir).not.toHaveBeenCalledWith("/project/node_modules", { withFileTypes: true });
    expect(mockReaddir).not.toHaveBeenCalledWith("/project/.fusion", { withFileTypes: true });
    expect(mockReaddir).not.toHaveBeenCalledWith("/project/dist", { withFileTypes: true });
    expect(mockReaddir).not.toHaveBeenCalledWith("/project/build", { withFileTypes: true });
  });

  it("respects maxDepth when scanning nested directories", async () => {
    mockGetRootDir.mockReturnValue("/project");

    mockReaddir.mockImplementation(async (targetPath: string) => {
      if (targetPath === "/project") {
        return [directoryEntry("level-1")];
      }

      if (targetPath === "/project/level-1") {
        return [directoryEntry("level-2")];
      }

      if (targetPath === "/project/level-1/level-2") {
        return [fileEntry("deep.md")];
      }

      return [];
    });

    mockStat.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 42,
      mtime: new Date("2024-01-03T00:00:00.000Z"),
    });
    mockReadFile.mockResolvedValue("Deep file");

    const shallowResult = await scanMarkdownFiles(mockStore, { maxDepth: 1 });
    expect(shallowResult).toEqual([]);

    const deepResult = await scanMarkdownFiles(mockStore, { maxDepth: 2 });
    expect(deepResult).toHaveLength(1);
    expect(deepResult[0].path).toBe("level-1/level-2/deep.md");
  });

  it("skips files that exceed max file size", async () => {
    mockGetRootDir.mockReturnValue("/project");

    mockReaddir.mockResolvedValue([fileEntry("LARGE.md")]);
    mockStat.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 2 * 1024 * 1024,
      mtime: new Date("2024-01-04T00:00:00.000Z"),
    });

    const result = await scanMarkdownFiles(mockStore, { maxFileSize: 1024 * 1024 });
    expect(result).toEqual([]);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("caps content preview to 200 characters", async () => {
    mockGetRootDir.mockReturnValue("/project");

    mockReaddir.mockResolvedValue([fileEntry("README.md")]);
    mockStat.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 200,
      mtime: new Date("2024-01-05T00:00:00.000Z"),
    });
    mockReadFile.mockResolvedValue("a".repeat(250));

    const result = await scanMarkdownFiles(mockStore);

    expect(result).toHaveLength(1);
    expect(result[0].contentPreview).toBe("a".repeat(200));
    expect(result[0].contentPreview.length).toBe(200);
  });

  it("returns files sorted by relative path", async () => {
    mockGetRootDir.mockReturnValue("/project");

    mockReaddir.mockImplementation(async (targetPath: string) => {
      if (targetPath === "/project") {
        return [
          fileEntry("z-last.md"),
          directoryEntry("docs"),
          fileEntry("a-first.md"),
        ];
      }

      if (targetPath === "/project/docs") {
        return [fileEntry("middle.md")];
      }

      return [];
    });

    mockStat.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 90,
      mtime: new Date("2024-01-06T00:00:00.000Z"),
    });
    mockReadFile.mockResolvedValue("content");

    const result = await scanMarkdownFiles(mockStore);
    expect(result.map((entry) => entry.path)).toEqual([
      "a-first.md",
      "docs/middle.md",
      "z-last.md",
    ]);
  });
});
