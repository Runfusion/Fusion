import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useMemoryBackendStatus } from "../useMemoryBackendStatus";
import * as api from "../../api";

describe("useMemoryBackendStatus", () => {
  const mockFetchMemoryBackendStatus = vi.spyOn(api, "fetchMemoryBackendStatus");

  const mockFileBackendStatus: api.MemoryBackendStatus = {
    currentBackend: "file",
    capabilities: {
      readable: true,
      writable: true,
      supportsAtomicWrite: true,
      hasConflictResolution: false,
      persistent: true,
    },
    availableBackends: ["file", "readonly", "qmd"],
  };

  const mockReadonlyBackendStatus: api.MemoryBackendStatus = {
    currentBackend: "readonly",
    capabilities: {
      readable: true,
      writable: false,
      supportsAtomicWrite: false,
      hasConflictResolution: false,
      persistent: false,
    },
    availableBackends: ["file", "readonly", "qmd"],
  };

  const mockQmdBackendStatus: api.MemoryBackendStatus = {
    currentBackend: "qmd",
    capabilities: {
      readable: true,
      writable: true,
      supportsAtomicWrite: false,
      hasConflictResolution: false,
      persistent: true,
    },
    availableBackends: ["file", "readonly", "qmd"],
  };

  beforeEach(() => {
    mockFetchMemoryBackendStatus.mockClear();
  });

  it("fetches status on initial mount", async () => {
    mockFetchMemoryBackendStatus.mockResolvedValue(mockFileBackendStatus);

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    expect(result.current.loading).toBe(true);
    expect(result.current.status).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toEqual(mockFileBackendStatus);
    expect(result.current.currentBackend).toBe("file");
    expect(result.current.capabilities).toEqual(mockFileBackendStatus.capabilities);
    expect(result.current.availableBackends).toEqual(["file", "readonly", "qmd"]);
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdated).toBeInstanceOf(Date);
  });

  it("handles fetch errors", async () => {
    mockFetchMemoryBackendStatus.mockRejectedValue(new Error("Failed to connect"));

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Failed to connect");
    expect(result.current.status).toBeNull();
  });

  it("provides correct capability flags for file backend", async () => {
    mockFetchMemoryBackendStatus.mockResolvedValue(mockFileBackendStatus);

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isReadable).toBe(true);
    expect(result.current.isWritable).toBe(true);
    expect(result.current.supportsAtomicWrite).toBe(true);
  });

  it("provides correct capability flags for readonly backend", async () => {
    mockFetchMemoryBackendStatus.mockResolvedValue(mockReadonlyBackendStatus);

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isReadable).toBe(true);
    expect(result.current.isWritable).toBe(false);
    expect(result.current.supportsAtomicWrite).toBe(false);
  });

  it("provides correct capability flags for qmd backend", async () => {
    mockFetchMemoryBackendStatus.mockResolvedValue(mockQmdBackendStatus);

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isReadable).toBe(true);
    expect(result.current.isWritable).toBe(true);
    expect(result.current.supportsAtomicWrite).toBe(false);
  });

  it("refreshes data manually", async () => {
    mockFetchMemoryBackendStatus
      .mockResolvedValueOnce(mockFileBackendStatus)
      .mockResolvedValueOnce(mockQmdBackendStatus);

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentBackend).toBe("file");

    // Manual refresh
    await result.current.refresh();

    await waitFor(() => expect(result.current.currentBackend).toBe("qmd"));
  });

  it("clears error on successful refresh after error", async () => {
    mockFetchMemoryBackendStatus
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(mockFileBackendStatus);

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("Network error");

    // Manual refresh
    await result.current.refresh();

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.status).toEqual(mockFileBackendStatus);
  });

  it("passes projectId to API", async () => {
    mockFetchMemoryBackendStatus.mockResolvedValue(mockFileBackendStatus);

    const { result } = renderHook(() =>
      useMemoryBackendStatus({ projectId: "proj_abc", autoRefresh: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchMemoryBackendStatus).toHaveBeenCalledWith("proj_abc");
  });

  it("returns expected default values before first fetch", () => {
    mockFetchMemoryBackendStatus.mockImplementation(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    expect(result.current.status).toBeNull();
    expect(result.current.currentBackend).toBeNull();
    expect(result.current.capabilities).toBeNull();
    expect(result.current.availableBackends).toEqual([]);
    expect(result.current.isReadable).toBe(false);
    expect(result.current.isWritable).toBe(false);
    expect(result.current.supportsAtomicWrite).toBe(false);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdated).toBeNull();
    expect(typeof result.current.refresh).toBe("function");
  });

  it("exports the correct interface", () => {
    expect(typeof useMemoryBackendStatus).toBe("function");
  });

  it("handles null error messages", async () => {
    mockFetchMemoryBackendStatus.mockRejectedValue(new Error());

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Error with no message results in empty string
    expect(result.current.error).toBe("");
  });

  it("handles non-Error rejections", async () => {
    mockFetchMemoryBackendStatus.mockRejectedValue("string error");

    const { result } = renderHook(() => useMemoryBackendStatus({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Failed to fetch memory backend status");
  });
});
