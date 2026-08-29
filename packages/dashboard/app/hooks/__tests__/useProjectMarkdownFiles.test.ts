import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useProjectMarkdownFiles } from "../useProjectMarkdownFiles";
import { fetchProjectMarkdownFiles } from "../../api";

vi.mock("../../api", () => ({
  fetchProjectMarkdownFiles: vi.fn(),
}));

const mockFetchProjectMarkdownFiles = vi.mocked(fetchProjectMarkdownFiles);

describe("useProjectMarkdownFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses hidden files off by default", async () => {
    mockFetchProjectMarkdownFiles.mockResolvedValue({ files: [] });

    renderHook(() => useProjectMarkdownFiles("proj-1"));

    await waitFor(() => {
      expect(mockFetchProjectMarkdownFiles).toHaveBeenCalledWith("proj-1", { showHidden: false });
    });
  });

  it("refetches when showHidden option changes", async () => {
    mockFetchProjectMarkdownFiles.mockResolvedValue({ files: [] });

    const { rerender } = renderHook(
      ({ showHidden }) => useProjectMarkdownFiles("proj-1", { showHidden }),
      { initialProps: { showHidden: false } },
    );

    await waitFor(() => {
      expect(mockFetchProjectMarkdownFiles).toHaveBeenCalledWith("proj-1", { showHidden: false });
    });

    rerender({ showHidden: true });

    await waitFor(() => {
      expect(mockFetchProjectMarkdownFiles).toHaveBeenCalledWith("proj-1", { showHidden: true });
    });
  });

  it("allows refresh override to fetch with explicit visibility", async () => {
    mockFetchProjectMarkdownFiles.mockResolvedValue({ files: [] });

    const { result } = renderHook(() => useProjectMarkdownFiles("proj-1", { showHidden: false }));

    await waitFor(() => {
      expect(mockFetchProjectMarkdownFiles).toHaveBeenCalledWith("proj-1", { showHidden: false });
    });

    await act(async () => {
      await result.current.refresh({ showHidden: true });
    });

    expect(mockFetchProjectMarkdownFiles).toHaveBeenLastCalledWith("proj-1", { showHidden: true });
  });
});
