import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useMemoryData } from "../useMemoryData";

/*
FNXC:MemoryView 2026-07-10-23:00:
The legacy single-file working-memory surface (fetchMemory/saveMemory) and the unused
fetchMemoryStats call were removed from useMemoryData — MemoryView is a multi-file editor
(fetchMemoryFiles/fetchMemoryFile/saveMemoryFile) and the Engines card uses the audit
report. These tests cover the multi-file flow, and assert the removed endpoints are no
longer called on mount.
*/

// Mock API functions
vi.mock("../../api", () => ({
  fetchMemory: vi.fn(),
  saveMemory: vi.fn(),
  fetchMemoryInsights: vi.fn(),
  saveMemoryInsights: vi.fn(),
  triggerInsightExtraction: vi.fn(),
  fetchMemoryAudit: vi.fn(),
  fetchMemoryStats: vi.fn(),
  compactMemory: vi.fn(),
  fetchMemoryBackendStatus: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchMemoryFiles: vi.fn(),
  fetchMemoryFile: vi.fn(),
  saveMemoryFile: vi.fn(),
  installQmd: vi.fn(),
  testMemoryRetrieval: vi.fn(),
  triggerMemoryDreams: vi.fn(),
}));

// Mock useMemoryBackendStatus hook
vi.mock("../useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: vi.fn(() => ({
    status: {
      currentBackend: "file",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: true,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
    },
    loading: false,
  })),
}));

// Import mocked functions
import {
  fetchMemory,
  fetchMemoryStats,
  fetchMemoryInsights,
  saveMemoryInsights,
  triggerInsightExtraction,
  fetchMemoryAudit,
  compactMemory,
  fetchMemoryFiles,
  fetchMemoryFile,
  saveMemoryFile,
  fetchSettings,
  triggerMemoryDreams,
} from "../../api";

const MEMORY_FILES = [
  {
    path: ".fusion/memory/MEMORY.md",
    label: "Long-term memory",
    layer: "long-term" as const,
    size: 100,
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    path: ".fusion/memory/2024-01-01.md",
    label: "Daily memory",
    layer: "daily" as const,
    size: 40,
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
];

const AUDIT_REPORT = {
  generatedAt: "2024-01-01T00:00:00.000Z",
  workingMemory: { exists: true, size: 100, sectionCount: 2 },
  insightsMemory: { exists: true, size: 50, insightCount: 5, categories: { pattern: 3 } },
  extraction: {
    runAt: "2024-01-01T00:00:00.000Z",
    success: true,
    insightCount: 5,
    duplicateCount: 0,
    skippedCount: 0,
    summary: "Extracted 5 insights",
  },
  pruning: { applied: false, reason: "No pruning needed", sizeDelta: 0, originalSize: 50, newSize: 50 },
  checks: [],
  health: "healthy" as const,
};

function mockDefaults(): void {
  vi.mocked(fetchMemoryInsights).mockResolvedValue({ content: "## Patterns\n- Pattern 1", exists: true });
  vi.mocked(fetchMemoryAudit).mockResolvedValue(AUDIT_REPORT);
  vi.mocked(fetchMemoryFiles).mockResolvedValue({ files: MEMORY_FILES });
  vi.mocked(fetchMemoryFile).mockResolvedValue({ path: ".fusion/memory/MEMORY.md", content: "# Long-term" });
  vi.mocked(fetchSettings).mockResolvedValue({ memoryEnabled: true } as Awaited<ReturnType<typeof fetchSettings>>);
}

describe("useMemoryData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaults();
  });

  it("fetches memory files, insights, and audit on mount — and does NOT call the removed legacy endpoints", async () => {
    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    expect(result.current.insightsLoading).toBe(true);
    expect(result.current.auditLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.insightsLoading).toBe(false);
      expect(result.current.auditLoading).toBe(false);
      expect(result.current.memoryFilesLoading).toBe(false);
    });

    expect(fetchMemoryFiles).toHaveBeenCalledWith("test-project");
    expect(fetchMemoryFile).toHaveBeenCalledWith(".fusion/memory/MEMORY.md", "test-project");
    expect(fetchMemoryInsights).toHaveBeenCalledWith("test-project");
    expect(fetchMemoryAudit).toHaveBeenCalledWith("test-project");

    // Removed legacy surface: no single-file working-memory or stats fetch on mount
    expect(fetchMemory).not.toHaveBeenCalled();
    expect(fetchMemoryStats).not.toHaveBeenCalled();

    expect(result.current.memoryFiles).toHaveLength(2);
    expect(result.current.selectedFilePath).toBe(".fusion/memory/MEMORY.md");
    expect(result.current.selectedFileContent).toBe("# Long-term");
    expect(result.current.insightsContent).toBe("## Patterns\n- Pattern 1");
    expect(result.current.insightsExists).toBe(true);
    expect(result.current.auditReport?.health).toBe("healthy");
  });

  it("selectFile loads the new file without refetching the whole file list", async () => {
    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.memoryFilesLoading).toBe(false);
    });

    expect(fetchMemoryFiles).toHaveBeenCalledTimes(1);

    vi.mocked(fetchMemoryFile).mockResolvedValue({ path: ".fusion/memory/2024-01-01.md", content: "daily notes" });

    await act(async () => {
      await result.current.selectFile(".fusion/memory/2024-01-01.md");
    });

    expect(result.current.selectedFilePath).toBe(".fusion/memory/2024-01-01.md");
    expect(result.current.selectedFileContent).toBe("daily notes");
    expect(result.current.selectedFileDirty).toBe(false);
    // Selection changes must not re-trigger the mount-time file list fetch
    expect(fetchMemoryFiles).toHaveBeenCalledTimes(1);
  });

  it("marks the selected file dirty on edit and saveSelectedFile persists it", async () => {
    vi.mocked(saveMemoryFile).mockResolvedValue({ success: true });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.memoryFilesLoading).toBe(false);
    });

    act(() => {
      result.current.setSelectedFileContent("# Long-term (edited)");
    });

    expect(result.current.selectedFileDirty).toBe(true);

    await act(async () => {
      await result.current.saveSelectedFile();
    });

    expect(saveMemoryFile).toHaveBeenCalledWith(".fusion/memory/MEMORY.md", "# Long-term (edited)", "test-project");
    expect(result.current.selectedFileDirty).toBe(false);
    expect(result.current.savingSelectedFile).toBe(false);
  });

  it("extractInsights calls API then refreshes insights and audit", async () => {
    vi.mocked(fetchMemoryInsights).mockResolvedValue({ content: null, exists: false });
    vi.mocked(triggerInsightExtraction).mockResolvedValue({
      success: true,
      summary: "Extracted 3 insights",
      insightCount: 3,
      pruned: false,
    });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.auditLoading).toBe(false);
    });

    let extractResult: { success: boolean; summary: string } | undefined;
    await act(async () => {
      extractResult = await result.current.extractInsights();
    });

    expect(triggerInsightExtraction).toHaveBeenCalledWith("test-project");
    expect(extractResult).toEqual({ success: true, summary: "Extracted 3 insights" });
    expect(result.current.extracting).toBe(false);

    expect(fetchMemoryInsights).toHaveBeenCalledTimes(2); // Initial + refresh
    expect(fetchMemoryAudit).toHaveBeenCalledTimes(2); // Initial + refresh
  });

  it("compactMemory compacts the selected file in place and reloads the file list", async () => {
    vi.mocked(compactMemory).mockResolvedValue({
      path: ".fusion/memory/MEMORY.md",
      content: "Compacted memory content",
    });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.memoryFilesLoading).toBe(false);
    });

    await act(async () => {
      await result.current.compactMemory(".fusion/memory/MEMORY.md");
    });

    expect(compactMemory).toHaveBeenCalledWith(".fusion/memory/MEMORY.md", "test-project");
    expect(result.current.selectedFileContent).toBe("Compacted memory content");
    expect(result.current.selectedFileDirty).toBe(false);
    expect(result.current.compacting).toBe(false);
    expect(fetchMemoryFiles).toHaveBeenCalledTimes(2); // Initial + reload after compaction
  });

  it("saveInsights calls API then refreshes insights", async () => {
    vi.mocked(fetchMemoryInsights)
      .mockResolvedValueOnce({ content: null, exists: false })
      .mockResolvedValueOnce({ content: "New insights content", exists: true });
    vi.mocked(saveMemoryInsights).mockResolvedValue({ success: true });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.insightsLoading).toBe(false);
    });

    await act(async () => {
      await result.current.saveInsights("New insights content");
    });

    expect(saveMemoryInsights).toHaveBeenCalledWith("New insights content", "test-project");
    expect(fetchMemoryInsights).toHaveBeenCalledTimes(2); // Initial + refresh
    expect(result.current.insightsContent).toBe("New insights content");
  });

  it("triggerDreamNow calls triggerMemoryDreams", async () => {
    vi.mocked(triggerMemoryDreams).mockResolvedValue({ success: true, summary: "done" });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.memoryFilesLoading).toBe(false);
    });

    await act(async () => {
      await result.current.triggerDreamNow();
    });

    expect(triggerMemoryDreams).toHaveBeenCalledWith("test-project");
    expect(result.current.dreamRunning).toBe(false);
  });

  it("triggerDreamNow propagates API errors and resets state", async () => {
    vi.mocked(triggerMemoryDreams).mockRejectedValue(
      new Error("Memory dreams are disabled. Enable dream processing in memory settings first."),
    );

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.memoryFilesLoading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.triggerDreamNow()).rejects.toThrow(
        "Memory dreams are disabled. Enable dream processing in memory settings first.",
      );
    });

    expect(triggerMemoryDreams).toHaveBeenCalledTimes(1);
    expect(result.current.dreamRunning).toBe(false);
  });
});
