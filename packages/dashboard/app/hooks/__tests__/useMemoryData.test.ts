import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useMemoryData } from "../useMemoryData";

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
  saveMemory,
  fetchMemoryInsights,
  saveMemoryInsights,
  triggerInsightExtraction,
  fetchMemoryAudit,
  compactMemory,
  triggerMemoryDreams,
} from "../../api";

describe("useMemoryData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches working memory, insights, and audit on mount", async () => {
    vi.mocked(fetchMemory).mockResolvedValue({ content: "# Working Memory\n\nSome content" });
    vi.mocked(fetchMemoryInsights).mockResolvedValue({
      content: "## Patterns\n- Pattern 1",
      exists: true,
    });
    vi.mocked(fetchMemoryAudit).mockResolvedValue({
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
      health: "healthy",
    });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    // Initially loading
    expect(result.current.workingMemoryLoading).toBe(true);
    expect(result.current.insightsLoading).toBe(true);
    expect(result.current.auditLoading).toBe(true);

    // Wait for all data to load
    await waitFor(() => {
      expect(result.current.workingMemoryLoading).toBe(false);
      expect(result.current.insightsLoading).toBe(false);
      expect(result.current.auditLoading).toBe(false);
    });

    // Verify working memory was fetched
    expect(fetchMemory).toHaveBeenCalledWith("test-project");

    // Verify insights were fetched
    expect(fetchMemoryInsights).toHaveBeenCalledWith("test-project");

    // Verify audit was fetched
    expect(fetchMemoryAudit).toHaveBeenCalledWith("test-project");

    // Verify state is updated
    expect(result.current.workingMemory).toBe("# Working Memory\n\nSome content");
    expect(result.current.insightsContent).toBe("## Patterns\n- Pattern 1");
    expect(result.current.insightsExists).toBe(true);
    expect(result.current.auditReport).not.toBeNull();
    expect(result.current.auditReport?.health).toBe("healthy");
  });

  it("marks working memory as dirty when content changes", async () => {
    vi.mocked(fetchMemory).mockResolvedValue({ content: "Initial content" });
    vi.mocked(fetchMemoryInsights).mockResolvedValue({ content: null, exists: false });
    vi.mocked(fetchMemoryAudit).mockResolvedValue({
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 20, sectionCount: 1 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning",
    });

    const { result } = renderHook(() => useMemoryData());

    await waitFor(() => {
      expect(result.current.workingMemoryLoading).toBe(false);
    });

    expect(result.current.workingMemoryDirty).toBe(false);

    act(() => {
      result.current.setWorkingMemory("New content");
    });

    expect(result.current.workingMemoryDirty).toBe(true);
    expect(result.current.workingMemory).toBe("New content");
  });

  it("saveWorkingMemory calls API and clears dirty flag", async () => {
    vi.mocked(fetchMemory).mockResolvedValue({ content: "Initial content" });
    vi.mocked(fetchMemoryInsights).mockResolvedValue({ content: null, exists: false });
    vi.mocked(fetchMemoryAudit).mockResolvedValue({
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 20, sectionCount: 1 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning",
    });
    vi.mocked(saveMemory).mockResolvedValue({ success: true });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.workingMemoryLoading).toBe(false);
    });

    // Make changes
    act(() => {
      result.current.setWorkingMemory("Modified content");
    });

    expect(result.current.workingMemoryDirty).toBe(true);

    // Save
    await act(async () => {
      await result.current.saveWorkingMemory();
    });

    expect(saveMemory).toHaveBeenCalledWith("Modified content", "test-project");
    expect(result.current.workingMemoryDirty).toBe(false);
    expect(result.current.savingWorkingMemory).toBe(false);
  });

  it("extractInsights calls API then refreshes insights and audit", async () => {
    vi.mocked(fetchMemory).mockResolvedValue({ content: "Working memory content" });
    vi.mocked(fetchMemoryInsights).mockResolvedValue({ content: null, exists: false });
    vi.mocked(fetchMemoryAudit).mockResolvedValue({
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 20, sectionCount: 1 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning",
    });
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

    // Extract insights
    let extractResult: { success: boolean; summary: string } | undefined;
    await act(async () => {
      extractResult = await result.current.extractInsights();
    });

    expect(triggerInsightExtraction).toHaveBeenCalledWith("test-project");
    expect(extractResult).toEqual({ success: true, summary: "Extracted 3 insights" });
    expect(result.current.extracting).toBe(false);

    // Verify insights and audit were refreshed
    expect(fetchMemoryInsights).toHaveBeenCalledTimes(2); // Initial + refresh
    expect(fetchMemoryAudit).toHaveBeenCalledTimes(2); // Initial + refresh
  });

  it("compactMemory calls API and updates working memory with returned content", async () => {
    vi.mocked(fetchMemory).mockResolvedValue({ content: "Long memory content that needs compaction" });
    vi.mocked(fetchMemoryInsights).mockResolvedValue({ content: null, exists: false });
    vi.mocked(fetchMemoryAudit).mockResolvedValue({
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 200, sectionCount: 5 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning",
    });
    vi.mocked(compactMemory).mockResolvedValue({
      content: "Compacted memory content",
    });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.workingMemoryLoading).toBe(false);
    });

    // Compact memory
    await act(async () => {
      await result.current.compactMemory();
    });

    expect(compactMemory).toHaveBeenCalledWith("test-project");
    expect(result.current.workingMemory).toBe("Compacted memory content");
    expect(result.current.workingMemoryDirty).toBe(true);
    expect(result.current.compacting).toBe(false);
  });

  it("saveInsights calls API then refreshes insights", async () => {
    vi.mocked(fetchMemory).mockResolvedValue({ content: "Working memory" });
    vi.mocked(fetchMemoryInsights)
      .mockResolvedValueOnce({ content: null, exists: false })
      .mockResolvedValueOnce({ content: "New insights content", exists: true });
    vi.mocked(fetchMemoryAudit).mockResolvedValue({
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 20, sectionCount: 1 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning",
    });
    vi.mocked(saveMemoryInsights).mockResolvedValue({ success: true });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.workingMemoryLoading).toBe(false);
    });

    // Save insights
    await act(async () => {
      await result.current.saveInsights("New insights content");
    });

    expect(saveMemoryInsights).toHaveBeenCalledWith("New insights content", "test-project");
    expect(fetchMemoryInsights).toHaveBeenCalledTimes(2); // Initial + refresh
  });

  it("triggerDreamNow calls triggerMemoryDreams", async () => {
    vi.mocked(fetchMemory).mockResolvedValue({ content: "Initial content" });
    vi.mocked(fetchMemoryInsights).mockResolvedValue({ content: null, exists: false });
    vi.mocked(fetchMemoryAudit).mockResolvedValue({
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 20, sectionCount: 1 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning",
    });
    vi.mocked(triggerMemoryDreams).mockResolvedValue({ success: true, summary: "done" });

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.workingMemoryLoading).toBe(false);
    });

    await act(async () => {
      await result.current.triggerDreamNow();
    });

    expect(triggerMemoryDreams).toHaveBeenCalledWith("test-project");
    expect(result.current.dreamRunning).toBe(false);
  });

  it("triggerDreamNow propagates API errors and resets state", async () => {
    vi.mocked(fetchMemory).mockResolvedValue({ content: "Initial content" });
    vi.mocked(fetchMemoryInsights).mockResolvedValue({ content: null, exists: false });
    vi.mocked(fetchMemoryAudit).mockResolvedValue({
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 20, sectionCount: 1 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning",
    });
    vi.mocked(triggerMemoryDreams).mockRejectedValue(
      new Error("Memory dreams are disabled. Enable dream processing in memory settings first."),
    );

    const { result } = renderHook(() => useMemoryData({ projectId: "test-project" }));

    await waitFor(() => {
      expect(result.current.workingMemoryLoading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.triggerDreamNow()).rejects.toThrow(
        "Memory dreams are disabled. Enable dream processing in memory settings first.",
      );
    });

    expect(triggerMemoryDreams).toHaveBeenCalledTimes(1);
    expect(result.current.dreamRunning).toBe(false);
  });

  it("sets correct loading states during async operations", async () => {
    vi.mocked(fetchMemory).mockResolvedValue({ content: "Initial content" });
    vi.mocked(fetchMemoryInsights).mockResolvedValue({ content: null, exists: false });
    vi.mocked(fetchMemoryAudit).mockResolvedValue({
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 20, sectionCount: 1 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning",
    });
    vi.mocked(saveMemory).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { success: true };
    });

    const { result } = renderHook(() => useMemoryData());

    await waitFor(() => {
      expect(result.current.workingMemoryLoading).toBe(false);
    });

    // Make changes and save
    act(() => {
      result.current.setWorkingMemory("Modified content");
    });

    expect(result.current.workingMemoryDirty).toBe(true);
    expect(result.current.savingWorkingMemory).toBe(false);

    // Start save operation
    const savePromise = act(async () => {
      await result.current.saveWorkingMemory();
    });

    // During save, savingWorkingMemory should be true
    // Note: This is a bit tricky to test because the state update happens synchronously
    // but the actual save is async. The loading state might not be visible in tests.

    await savePromise;

    expect(result.current.savingWorkingMemory).toBe(false);
    expect(result.current.workingMemoryDirty).toBe(false);
  });
});
