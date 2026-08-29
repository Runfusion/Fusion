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
    vi.useRealTimers();
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
    expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("FN-123", "src/index.ts", undefined);
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

    expect(mockSaveWorkspaceFileContent).toHaveBeenCalledWith("project", "README.md", "changed", undefined);
    expect(result.current.hasChanges).toBe(false);
    expect(result.current.mtime).toBe("2024-01-02T00:00:00Z");
  });

  it("auto-saves changed content once after the debounce", async () => {
    mockFetchWorkspaceFileContent.mockResolvedValueOnce({ content: "original", mtime: "2024-01-01T00:00:00Z", size: 8 });
    mockSaveWorkspaceFileContent.mockResolvedValueOnce({ success: true, mtime: "2024-01-02T00:00:00Z", size: 7 });

    const { result } = renderHook(() => useWorkspaceFileEditor("project", "README.md", true, undefined, true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.useFakeTimers();
    act(() => result.current.setContent("changed"));
    act(() => vi.advanceTimersByTime(799));
    expect(mockSaveWorkspaceFileContent).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(mockSaveWorkspaceFileContent).toHaveBeenCalledTimes(1);
    expect(mockSaveWorkspaceFileContent).toHaveBeenCalledWith("project", "README.md", "changed", undefined);
    vi.useRealTimers();
    await waitFor(() => expect(result.current.hasChanges).toBe(false));
  });

  it("does not auto-save when auto-save is disabled", async () => {
    mockFetchWorkspaceFileContent.mockResolvedValueOnce({ content: "original", mtime: "2024-01-01T00:00:00Z", size: 8 });

    const { result } = renderHook(() => useWorkspaceFileEditor("project", "README.md", true, undefined, false));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.useFakeTimers();
    act(() => result.current.setContent("changed"));
    act(() => vi.advanceTimersByTime(800));

    expect(mockSaveWorkspaceFileContent).not.toHaveBeenCalled();
  });

  it("does not auto-save during or immediately after load", async () => {
    mockFetchWorkspaceFileContent.mockResolvedValueOnce({ content: "loaded", mtime: "2024-01-01T00:00:00Z", size: 6 });

    const { result } = renderHook(() => useWorkspaceFileEditor("project", "README.md", true, undefined, true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(800));

    expect(result.current.content).toBe("loaded");
    expect(result.current.hasChanges).toBe(false);
    expect(mockSaveWorkspaceFileContent).not.toHaveBeenCalled();
  });

  it("cancels a pending auto-save when the selected file changes", async () => {
    mockFetchWorkspaceFileContent
      .mockResolvedValueOnce({ content: "first", mtime: "2024-01-01T00:00:00Z", size: 5 })
      .mockResolvedValueOnce({ content: "second", mtime: "2024-01-01T00:00:00Z", size: 6 });

    const { result, rerender } = renderHook(
      ({ filePath }) => useWorkspaceFileEditor("project", filePath, true, undefined, true),
      { initialProps: { filePath: "first.md" as string | null } },
    );
    await waitFor(() => expect(result.current.content).toBe("first"));

    vi.useFakeTimers();
    act(() => result.current.setContent("first changed"));
    rerender({ filePath: "second.md" });
    act(() => vi.advanceTimersByTime(800));
    expect(mockSaveWorkspaceFileContent).not.toHaveBeenCalled();
    vi.useRealTimers();
    await waitFor(() => expect(result.current.content).toBe("second"));
  });

  it("cancels a pending auto-save on unmount", async () => {
    mockFetchWorkspaceFileContent.mockResolvedValueOnce({ content: "original", mtime: "2024-01-01T00:00:00Z", size: 8 });

    const { result, unmount } = renderHook(() => useWorkspaceFileEditor("project", "README.md", true, undefined, true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.useFakeTimers();
    act(() => result.current.setContent("changed"));
    unmount();
    act(() => vi.advanceTimersByTime(800));

    expect(mockSaveWorkspaceFileContent).not.toHaveBeenCalled();
  });

  it("surfaces an auto-save error without retrying the same content", async () => {
    mockFetchWorkspaceFileContent.mockResolvedValueOnce({ content: "original", mtime: "2024-01-01T00:00:00Z", size: 8 });
    mockSaveWorkspaceFileContent.mockRejectedValueOnce(new Error("disk full"));

    const { result } = renderHook(() => useWorkspaceFileEditor("project", "README.md", true, undefined, true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.useFakeTimers();
    act(() => result.current.setContent("changed"));
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    vi.useRealTimers();
    await waitFor(() => expect(result.current.error).toBe("disk full"));
    expect(mockSaveWorkspaceFileContent).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(1600));
    expect(mockSaveWorkspaceFileContent).toHaveBeenCalledTimes(1);
  });

  it("resets state when disabled or file is cleared", async () => {
    const response: FileContentResponse = {
      content: "hello",
      mtime: "2024-01-01T00:00:00Z",
      size: 5,
    };
    mockFetchWorkspaceFileContent.mockResolvedValueOnce(response);

    const { result, rerender } = renderHook(
      ({ workspace, filePath, enabled }: { workspace: string; filePath: string | null; enabled: boolean }) => useWorkspaceFileEditor(workspace, filePath, enabled),
      { initialProps: { workspace: "FN-123", filePath: "src/index.ts" as string | null, enabled: true } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.content).toBe("hello");

    rerender({ workspace: "FN-123", filePath: null, enabled: true });

    expect(result.current.content).toBe("");
    expect(result.current.originalContent).toBe("");
    expect(result.current.mtime).toBeNull();
  });
});
