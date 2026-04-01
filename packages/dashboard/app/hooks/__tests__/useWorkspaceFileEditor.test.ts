import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWorkspaceFileEditor } from "../useWorkspaceFileEditor";
import * as api from "../../api";
import type { FileContentResponse, SaveFileResponse } from "../../api";

vi.mock("../../api", () => ({
  fetchWorkspaceFileContent: vi.fn(),
  saveWorkspaceFileContent: vi.fn(),
}));

const mockFetchWorkspaceFileContent = vi.mocked(api.fetchWorkspaceFileContent);
const mockSaveWorkspaceFileContent = vi.mocked(api.saveWorkspaceFileContent);

describe("useWorkspaceFileEditor", () => {
  beforeEach(() => {
    mockFetchWorkspaceFileContent.mockReset();
    mockSaveWorkspaceFileContent.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads content for the selected workspace file", async () => {
    const response: FileContentResponse = {
      content: "hello",
      mtime: "2024-01-01T00:00:00Z",
      size: 5,
    };
    mockFetchWorkspaceFileContent.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useWorkspaceFileEditor("FN-123", "src/index.ts", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.content).toBe("hello");
    expect(result.current.originalContent).toBe("hello");
    expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("FN-123", "src/index.ts");
  });

  it("saves workspace file changes", async () => {
    const loadResponse: FileContentResponse = {
      content: "original",
      mtime: "2024-01-01T00:00:00Z",
      size: 8,
    };
    const saveResponse: SaveFileResponse = {
      success: true,
      mtime: "2024-01-02T00:00:00Z",
      size: 9,
    };

    mockFetchWorkspaceFileContent.mockResolvedValueOnce(loadResponse);
    mockSaveWorkspaceFileContent.mockResolvedValueOnce(saveResponse);

    const { result } = renderHook(() => useWorkspaceFileEditor("project", "README.md", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setContent("changed");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(mockSaveWorkspaceFileContent).toHaveBeenCalledWith("project", "README.md", "changed");
    expect(result.current.hasChanges).toBe(false);
    expect(result.current.mtime).toBe("2024-01-02T00:00:00Z");
  });

  it("resets state when disabled or file is cleared", async () => {
    const response: FileContentResponse = {
      content: "hello",
      mtime: "2024-01-01T00:00:00Z",
      size: 5,
    };
    mockFetchWorkspaceFileContent.mockResolvedValueOnce(response);

    const { result, rerender } = renderHook(
      ({ workspace, filePath, enabled }) => useWorkspaceFileEditor(workspace, filePath, enabled),
      { initialProps: { workspace: "FN-123", filePath: "src/index.ts", enabled: true } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.content).toBe("hello");

    rerender({ workspace: "FN-123", filePath: null, enabled: true });

    expect(result.current.content).toBe("");
    expect(result.current.originalContent).toBe("");
    expect(result.current.mtime).toBeNull();
  });
});
