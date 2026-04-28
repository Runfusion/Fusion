import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryView } from "../MemoryView";

const mockUseMemoryData = vi.fn();

vi.mock("../../hooks/useMemoryData", () => ({
  useMemoryData: (...args: unknown[]) => mockUseMemoryData(...args),
}));

vi.mock("../FileEditor", () => ({
  FileEditor: ({ filePath }: { filePath: string }) => <div aria-label={`Editor for ${filePath}`} />,
}));

vi.mock("lucide-react", () => ({
  Loader2: () => <span data-testid="loader-icon" />,
}));

function createMemoryData(overrides: Record<string, unknown> = {}) {
  return {
    insightsContent: null,
    insightsLoading: false,
    insightsExists: false,
    saveInsights: vi.fn(),
    memorySettings: {
      memoryEnabled: true,
      memoryAutoSummarizeEnabled: false,
      memoryAutoSummarizeThresholdChars: 50000,
      memoryAutoSummarizeSchedule: "0 3 * * *",
      memoryDreamsEnabled: false,
      memoryDreamsSchedule: "0 4 * * *",
    },
    settingsLoading: false,
    saveMemorySettings: vi.fn(),
    savingMemorySettings: false,
    backendStatus: {
      currentBackend: "file",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: true,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
      qmdAvailable: true,
      qmdInstallCommand: "bun install -g @tobilu/qmd",
    },
    backendLoading: false,
    extractInsights: vi.fn(),
    extracting: false,
    auditReport: {
      health: "healthy",
      workingMemory: { size: 120, sectionCount: 2 },
      insightsMemory: { size: 80, insightCount: 3 },
      extraction: { success: true, summary: "ok", insightCount: 3 },
      pruning: { applied: false, reason: "" },
      checks: [],
    },
    auditLoading: false,
    refreshAudit: vi.fn(),
    compactMemory: vi.fn(),
    compacting: false,
    installQmdAction: vi.fn(),
    installingQmd: false,
    testRetrieval: vi.fn(),
    memoryFiles: [
      {
        path: ".fusion/memory/MEMORY.md",
        label: "Long-term memory",
        layer: "long-term",
        size: 12,
        updatedAt: "2026-04-17T12:00:00.000Z",
      },
    ],
    memoryFilesLoading: false,
    selectedFilePath: ".fusion/memory/MEMORY.md",
    selectedFileContent: "hello",
    selectedFileLoading: false,
    selectedFileDirty: false,
    setSelectedFileContent: vi.fn(),
    selectFile: vi.fn(),
    saveSelectedFile: vi.fn(),
    savingSelectedFile: false,
    reloadMemoryFiles: vi.fn(),
    triggerDreamNow: vi.fn(),
    dreamRunning: false,
    ...overrides,
  };
}

describe("MemoryView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMemoryData.mockReturnValue(createMemoryData());
  });

  it("does not show read-only warning while backend status is still loading", () => {
    mockUseMemoryData.mockReturnValue(
      createMemoryData({
        backendStatus: null,
        backendLoading: true,
      }),
    );

    render(<MemoryView addToast={vi.fn()} />);

    expect(screen.queryByText("This memory backend is read-only. Changes cannot be saved.")).not.toBeInTheDocument();
  });

  it("shows read-only warning after backend resolves as non-writable", () => {
    mockUseMemoryData.mockReturnValue(
      createMemoryData({
        backendStatus: {
          currentBackend: "readonly",
          capabilities: {
            readable: true,
            writable: false,
            supportsAtomicWrite: false,
            hasConflictResolution: false,
            persistent: false,
          },
          availableBackends: ["file", "readonly", "qmd"],
          qmdAvailable: true,
        },
        backendLoading: false,
      }),
    );

    render(<MemoryView addToast={vi.fn()} />);

    expect(screen.getByText("This memory backend is read-only. Changes cannot be saved.")).toBeInTheDocument();
  });

  it("does not show qmd-missing prompt before backend qmd availability resolves", async () => {
    mockUseMemoryData.mockReturnValue(
      createMemoryData({
        backendStatus: null,
        backendLoading: false,
        auditLoading: false,
      }),
    );

    render(<MemoryView addToast={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "Engines" }));

    expect(screen.queryByText(/qmd is not installed/i)).not.toBeInTheDocument();
    expect(screen.getByText("Checking qmd availability…")).toBeInTheDocument();
  });

  it("shows qmd install prompt only when backend resolves qmd unavailable", async () => {
    mockUseMemoryData.mockReturnValue(
      createMemoryData({
        backendStatus: {
          currentBackend: "file",
          capabilities: {
            readable: true,
            writable: true,
            supportsAtomicWrite: true,
            hasConflictResolution: false,
            persistent: true,
          },
          availableBackends: ["file", "readonly", "qmd"],
          qmdAvailable: false,
          qmdInstallCommand: "bun install -g @tobilu/qmd",
        },
      }),
    );

    render(<MemoryView addToast={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "Engines" }));

    expect(screen.getByText(/qmd is not installed\. Search will use local files\./i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install qmd" })).toBeInTheDocument();
  });

  it("shows qmd installed state when backend resolves qmd as available", async () => {
    render(<MemoryView addToast={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "Engines" }));

    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("qmd is available on PATH.")).toBeInTheDocument();
  });

  it("shows Dream Now button when dreams are enabled", () => {
    mockUseMemoryData.mockReturnValue(
      createMemoryData({
        memorySettings: {
          memoryEnabled: true,
          memoryAutoSummarizeEnabled: false,
          memoryAutoSummarizeThresholdChars: 50000,
          memoryAutoSummarizeSchedule: "0 3 * * *",
          memoryDreamsEnabled: true,
          memoryDreamsSchedule: "0 4 * * *",
        },
      }),
    );

    render(<MemoryView addToast={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Dream Now" })).toBeInTheDocument();
  });

  it("triggers dream processing and refreshes memory files", async () => {
    const triggerDreamNow = vi.fn().mockResolvedValue({});
    const reloadMemoryFiles = vi.fn().mockResolvedValue(undefined);
    const addToast = vi.fn();
    mockUseMemoryData.mockReturnValue(
      createMemoryData({
        triggerDreamNow,
        reloadMemoryFiles,
        memorySettings: {
          memoryEnabled: true,
          memoryAutoSummarizeEnabled: false,
          memoryAutoSummarizeThresholdChars: 50000,
          memoryAutoSummarizeSchedule: "0 3 * * *",
          memoryDreamsEnabled: true,
          memoryDreamsSchedule: "0 4 * * *",
        },
      }),
    );

    render(<MemoryView addToast={addToast} />);

    await userEvent.click(screen.getByRole("button", { name: "Dream Now" }));

    await waitFor(() => {
      expect(triggerDreamNow).toHaveBeenCalledTimes(1);
      expect(reloadMemoryFiles).toHaveBeenCalledTimes(1);
    });
    expect(addToast).toHaveBeenCalledWith("Dream processing completed", "success");
  });

  it("hides Dream Now button when dreams are disabled", () => {
    render(<MemoryView addToast={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Dream Now" })).not.toBeInTheDocument();
  });
});
