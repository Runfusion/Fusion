import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProjectFileEditor } from "../useProjectFileEditor";
import * as api from "../../api";
import type { FileContentResponse, SaveFileResponse } from "../../api";

// Mock the api module
vi.mock("../../api", () => ({
  fetchWorkspaceFileContent: vi.fn(),
  saveWorkspaceFileContent: vi.fn(),
}));

const mockFetchWorkspaceFileContent = vi.mocked(api.fetchWorkspaceFileContent);
const mockSaveWorkspaceFileContent = vi.mocked(api.saveWorkspaceFileContent);

describe("useProjectFileEditor", () => {
  beforeEach(() => {
    mockFetchWorkspaceFileContent.mockReset();
    mockSaveWorkspaceFileContent.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with empty content when no file is selected", () => {
    const { result } = renderHook(() => useProjectFileEditor("/project", null, true));

    expect(result.current.content).toBe("");
    expect(result.current.originalContent).toBe("");
    expect(result.current.loading).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.hasChanges).toBe(false);
    expect(result.current.mtime).toBeNull();
  });

  it("loads file content when file is selected", async () => {
    const mockResponse: FileContentResponse = {
      content: "console.log('hello');",
      mtime: "2024-01-01T00:00:00Z",
      size: 21,
    };
    mockFetchWorkspaceFileContent.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useProjectFileEditor("/project", "src/index.ts", true));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.content).toBe("console.log('hello');");
    expect(result.current.originalContent).toBe("console.log('hello');");
    expect(result.current.mtime).toBe("2024-01-01T00:00:00Z");
    expect(result.current.hasChanges).toBe(false);
    expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("project", "src/index.ts");
  });

  it("tracks content changes", async () => {
    const mockResponse: FileContentResponse = {
      content: "original content",
      mtime: "2024-01-01T00:00:00Z",
      size: 16,
    };
    mockFetchWorkspaceFileContent.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useProjectFileEditor("/project", "file.txt", true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasChanges).toBe(false);

    act(() => {
      result.current.setContent("modified content");
    });

    expect(result.current.content).toBe("modified content");
    expect(result.current.hasChanges).toBe(true);
  });

  it("saves changes successfully", async () => {
    const loadResponse: FileContentResponse = {
      content: "original",
      mtime: "2024-01-01T00:00:00Z",
      size: 8,
    };
    const saveResponse: SaveFileResponse = {
      success: true,
      mtime: "2024-01-02T00:00:00Z",
      size: 16,
    };

    mockFetchWorkspaceFileContent.mockResolvedValueOnce(loadResponse);
    mockSaveWorkspaceFileContent.mockResolvedValueOnce(saveResponse);

    const { result } = renderHook(() => useProjectFileEditor("/project", "file.txt", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setContent("modified content");
    });

    expect(result.current.hasChanges).toBe(true);

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.originalContent).toBe("modified content");
    expect(result.current.mtime).toBe("2024-01-02T00:00:00Z");
    expect(result.current.hasChanges).toBe(false);
    expect(mockSaveWorkspaceFileContent).toHaveBeenCalledWith("project", "file.txt", "modified content");
  });

  it("handles load errors", async () => {
    mockFetchWorkspaceFileContent.mockRejectedValueOnce(new Error("Failed to load file"));

    const { result } = renderHook(() => useProjectFileEditor("/project", "missing.txt", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Failed to load file");
    expect(result.current.content).toBe("");
    expect(result.current.originalContent).toBe("");
    expect(result.current.mtime).toBeNull();
  });

  it("handles save errors", async () => {
    const loadResponse: FileContentResponse = {
      content: "original",
      mtime: "2024-01-01T00:00:00Z",
      size: 8,
    };
    mockFetchWorkspaceFileContent.mockResolvedValueOnce(loadResponse);
    mockSaveWorkspaceFileContent.mockRejectedValueOnce(new Error("Failed to save file"));

    const { result } = renderHook(() => useProjectFileEditor("/project", "file.txt", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setContent("modified");
    });

    await act(async () => {
      await expect(result.current.save()).rejects.toThrow("Failed to save file");
    });
    // Wait for React state update after the catch block sets error
    await waitFor(() => expect(result.current.error).toBe("Failed to save file"));
    expect(result.current.hasChanges).toBe(true);
  });

  it("does not load when disabled", async () => {
    renderHook(() => useProjectFileEditor("/project", "file.txt", false));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetchWorkspaceFileContent).not.toHaveBeenCalled();
  });

  it("does not save when there are no changes", async () => {
    const loadResponse: FileContentResponse = {
      content: "original",
      mtime: "2024-01-01T00:00:00Z",
      size: 8,
    };
    mockFetchWorkspaceFileContent.mockResolvedValueOnce(loadResponse);

    const { result } = renderHook(() => useProjectFileEditor("/project", "file.txt", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save();
    });

    expect(mockSaveWorkspaceFileContent).not.toHaveBeenCalled();
  });

  it("clears error when content changes", async () => {
    const loadResponse: FileContentResponse = {
      content: "original",
      mtime: "2024-01-01T00:00:00Z",
      size: 8,
    };
    mockFetchWorkspaceFileContent.mockResolvedValueOnce(loadResponse);
    mockSaveWorkspaceFileContent.mockRejectedValueOnce(new Error("Save failed"));

    const { result } = renderHook(() => useProjectFileEditor("/project", "file.txt", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setContent("modified");
    });

    await act(async () => {
      await expect(result.current.save()).rejects.toThrow("Save failed");
    });
    // Wait for React state update after the catch block sets error
    await waitFor(() => expect(result.current.error).toBe("Save failed"));

    act(() => {
      result.current.setContent("modified again");
    });

    expect(result.current.error).toBeNull();
  });

  it("resets state when filePath becomes null", async () => {
    const loadResponse: FileContentResponse = {
      content: "content",
      mtime: "2024-01-01T00:00:00Z",
      size: 7,
    };
    mockFetchWorkspaceFileContent.mockResolvedValueOnce(loadResponse);

    const { result, rerender } = renderHook(
      ({ filePath }: { filePath: string | null }) => useProjectFileEditor("/project", filePath, true),
      { initialProps: { filePath: "file.txt" as string | null } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.content).toBe("content");

    rerender({ filePath: null });

    expect(result.current.content).toBe("");
    expect(result.current.originalContent).toBe("");
    expect(result.current.mtime).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
