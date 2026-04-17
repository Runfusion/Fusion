import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "./SettingsModal";
import type { SettingsExportData } from "../api";

// --- API mocks ---
const mockFetchSettings = vi.fn();
const mockFetchSettingsByScope = vi.fn();
const mockExportSettings = vi.fn();
const mockUpdateSettings = vi.fn();
const mockUpdateGlobalSettings = vi.fn();
const mockFetchAuthStatus = vi.fn();
const mockLoginProvider = vi.fn();
const mockLogoutProvider = vi.fn();
const mockFetchModels = vi.fn();
const mockTestNtfyNotification = vi.fn();
const mockFetchBackups = vi.fn();
const mockCreateBackup = vi.fn();
const mockImportSettings = vi.fn();
const mockFetchMemoryFiles = vi.fn();
const mockFetchMemoryFile = vi.fn();
const mockSaveMemoryFile = vi.fn();
const mockCompactMemory = vi.fn();
const mockFetchGlobalConcurrency = vi.fn();
const mockUpdateGlobalConcurrency = vi.fn();
const mockFetchMemoryBackendStatus = vi.fn();

vi.mock("../api", () => ({
  fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
  fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
  exportSettings: (...args: unknown[]) => mockExportSettings(...args),
  importSettings: (...args: unknown[]) => mockImportSettings(...args),
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  loginProvider: (...args: unknown[]) => mockLoginProvider(...args),
  logoutProvider: (...args: unknown[]) => mockLogoutProvider(...args),
  fetchModels: (...args: unknown[]) => mockFetchModels(...args),
  testNtfyNotification: (...args: unknown[]) => mockTestNtfyNotification(...args),
  fetchBackups: (...args: unknown[]) => mockFetchBackups(...args),
  createBackup: (...args: unknown[]) => mockCreateBackup(...args),
  fetchMemoryFiles: (...args: unknown[]) => mockFetchMemoryFiles(...args),
  fetchMemoryFile: (...args: unknown[]) => mockFetchMemoryFile(...args),
  saveMemoryFile: (...args: unknown[]) => mockSaveMemoryFile(...args),
  compactMemory: (...args: unknown[]) => mockCompactMemory(...args),
  fetchGlobalConcurrency: (...args: unknown[]) => mockFetchGlobalConcurrency(...args),
  updateGlobalConcurrency: (...args: unknown[]) => mockUpdateGlobalConcurrency(...args),
  fetchMemoryBackendStatus: (...args: unknown[]) => mockFetchMemoryBackendStatus(...args),
}));

// Mock the hook
const mockUseMemoryBackendStatus = vi.fn();
vi.mock("../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: (...args: unknown[]) => mockUseMemoryBackendStatus(...args),
}));

const noop = () => {};

const defaultSettings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: true,
  autoMerge: true,
  mergeStrategy: "direct",
  recycleWorktrees: false,
  worktreeNaming: "random",
  includeTaskIdInCommit: true,
  worktreeInitCommand: "",
  ntfyEnabled: false,
  ntfyTopic: undefined,
};

function renderModal(props = {}) {
  return render(
    <SettingsModal
      onClose={noop}
      addToast={noop}
      {...props}
    />
  );
}

describe("SettingsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue(defaultSettings);
    mockFetchSettingsByScope.mockResolvedValue({ global: defaultSettings, project: {} });
    mockFetchAuthStatus.mockResolvedValue({ providers: [] });
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
    mockFetchBackups.mockResolvedValue({ backups: [], totalSize: 0 });
    mockFetchMemoryFiles.mockResolvedValue({
      files: [
        {
          path: ".fusion/memory/MEMORY.md",
          label: "Long-term memory",
          layer: "long-term",
          size: 42,
          updatedAt: "2026-04-17T12:00:00.000Z",
        },
        {
          path: ".fusion/memory/DREAMS.md",
          label: "Dreams",
          layer: "dreams",
          size: 21,
          updatedAt: "2026-04-17T12:00:00.000Z",
        },
      ],
    });
    mockFetchMemoryFile.mockResolvedValue({ path: ".fusion/memory/MEMORY.md", content: "## Existing memory\n- Learned pattern" });
    mockSaveMemoryFile.mockResolvedValue({ success: true });
    mockCompactMemory.mockResolvedValue({ content: "# Compacted Memory\n\nImportant content." });
    mockImportSettings.mockResolvedValue({ success: true, globalCount: 0, projectCount: 0 });
    mockFetchGlobalConcurrency.mockResolvedValue({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, projectsActive: {} });
    mockUpdateGlobalConcurrency.mockResolvedValue({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, projectsActive: {} });
    mockFetchMemoryBackendStatus.mockResolvedValue({
      currentBackend: "file",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: true,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
    });
    mockUseMemoryBackendStatus.mockReturnValue({
      currentBackend: "file",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: true,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    // jsdom doesn't provide URL.createObjectURL — polyfill it
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => "blob:http://localhost/mock") as any;
    }
    if (!URL.revokeObjectURL) {
      URL.revokeObjectURL = vi.fn() as any;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("settings export filename", () => {
    it("uses fusion-settings- prefix for exported filename", async () => {
      const mockExportData: SettingsExportData = {
        version: 1,
        exportedAt: "2026-04-04T12:00:00.000Z",
        global: undefined,
        project: { maxConcurrent: 2 },
      };
      mockExportSettings.mockResolvedValue(mockExportData);

      // Spy on createElement to capture the download link's filename
      const originalCreateElement = document.createElement.bind(document);
      const createdElements: { tagName: string; download: string; href: string }[] = [];
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        const el = originalCreateElement(tagName);
        if (tagName.toLowerCase() === "a") {
          // Capture the download attribute when set
          const origDownloadDescriptor = Object.getOwnPropertyDescriptor(
            HTMLAnchorElement.prototype,
            "download"
          );
          Object.defineProperty(el, "download", {
            set(v: string) {
              createdElements.push({ tagName, download: v, href: (el as HTMLAnchorElement).href });
              origDownloadDescriptor?.set?.call(el, v);
            },
            get() {
              return origDownloadDescriptor?.get?.call(el) ?? "";
            },
            configurable: true,
          });
        }
        return el;
      });

      // Mock URL.createObjectURL and revokeObjectURL
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/mock");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

      renderModal();

      // Wait for settings to load
      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      // Find and click the Export button
      const exportButton = screen.getByTitle("Export settings to JSON file");
      expect(exportButton).toBeDefined();

      fireEvent.click(exportButton);

      await waitFor(() => {
        expect(mockExportSettings).toHaveBeenCalled();
      });

      // Assert the filename uses fusion-settings- prefix
      expect(createdElements.length).toBeGreaterThanOrEqual(1);
      const anchorElement = createdElements[0];
      expect(anchorElement.download).toMatch(/^fusion-settings-/);
      expect(anchorElement.download).toMatch(/^fusion-settings-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
    });

    it("does not use kb-settings- prefix for exported filename", async () => {
      const mockExportData: SettingsExportData = {
        version: 1,
        exportedAt: "2026-04-04T12:00:00.000Z",
        global: undefined,
        project: { maxConcurrent: 2 },
      };
      mockExportSettings.mockResolvedValue(mockExportData);

      // Capture filenames set on dynamically-created anchor elements
      const capturedFilenames: string[] = [];
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        const el = originalCreateElement(tagName);
        if (tagName.toLowerCase() === "a") {
          const origDownloadDescriptor = Object.getOwnPropertyDescriptor(
            HTMLAnchorElement.prototype,
            "download"
          );
          Object.defineProperty(el, "download", {
            set(v: string) {
              capturedFilenames.push(v);
              origDownloadDescriptor?.set?.call(el, v);
            },
            get() {
              return origDownloadDescriptor?.get?.call(el) ?? "";
            },
            configurable: true,
          });
        }
        return el;
      });

      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/mock");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByTitle("Export settings to JSON file"));

      await waitFor(() => {
        expect(mockExportSettings).toHaveBeenCalled();
      });

      // Negative assertion: filename must NOT use the old kb- prefix
      expect(capturedFilenames.length).toBeGreaterThanOrEqual(1);
      for (const filename of capturedFilenames) {
        expect(filename).not.toMatch(/^kb-settings-/);
      }
    });
  });

  describe("Number input clearing", () => {
    it("allows clearing maxConcurrent without leaving a stuck zero", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      // Open Scheduling section
      fireEvent.click(screen.getByText("Scheduling"));

      const input = screen.getByLabelText("Max Concurrent Tasks") as HTMLInputElement;
      expect(input).toBeDefined();

      // Clear the input - the input should be empty, not show "0"
      await userEvent.clear(input);
      expect(input.value).toBe("");
    });

    it("allows clearing globalMaxConcurrent without leaving a stuck zero", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      // Open Scheduling section
      fireEvent.click(screen.getByText("Scheduling"));

      const input = screen.getByLabelText("Global Max Concurrent") as HTMLInputElement;
      expect(input).toBeDefined();

      // Clear the input - the input should be empty, not show "0"
      await userEvent.clear(input);
      expect(input.value).toBe("");
    });

    it("allows clearing pollIntervalMs without leaving a stuck zero", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      // Open Scheduling section
      fireEvent.click(screen.getByText("Scheduling"));

      const input = screen.getByLabelText("Poll Interval (ms)") as HTMLInputElement;
      expect(input).toBeDefined();

      // Clear the input - the input should be empty, not show "0"
      await userEvent.clear(input);
      expect(input.value).toBe("");
    });

    it("allows clearing maxWorktrees without leaving a stuck zero", async () => {
      renderModal();
      await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

      // Open Worktrees section
      fireEvent.click(screen.getByText("Worktrees"));

      const input = screen.getByLabelText("Max Worktrees") as HTMLInputElement;
      expect(input).toBeDefined();

      // Clear the input - the input should be empty, not show "0"
      await userEvent.clear(input);
      expect(input.value).toBe("");
    });
  });

  describe("Memory section", () => {
    it("renders the Memory section in the sidebar", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      expect(screen.getByText("Memory")).toBeDefined();
    });

    it("shows the memory toggle with default enabled", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      // Click the Memory section in the sidebar
      await userEvent.click(screen.getByText("Memory"));

      const checkbox = screen.getByRole("checkbox", { name: /enable project memory/i });
      expect(checkbox).toBeDefined();
      // Default is enabled, so checkbox should be checked
      expect(checkbox).toBeChecked();
    });

    it("shows memory toggle unchecked when memoryEnabled is false", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        memoryEnabled: false,
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      // Click the Memory section in the sidebar
      await userEvent.click(screen.getByText("Memory"));

      const checkbox = screen.getByRole("checkbox", { name: /enable project memory/i });
      expect(checkbox).toBeDefined();
      expect(checkbox).not.toBeChecked();
    });

    it("toggles the memory setting when checkbox is clicked", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      // Click the Memory section in the sidebar
      await userEvent.click(screen.getByText("Memory"));

      const checkbox = screen.getByRole("checkbox", { name: /enable project memory/i });
      expect(checkbox).toBeChecked();

      // Uncheck it
      await userEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();

      // Check it again
      await userEvent.click(checkbox);
      expect(checkbox).toBeChecked();
    });

    it("loads and shows memory editor content when navigating to Memory", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      expect(mockFetchMemoryFiles).not.toHaveBeenCalled();

      await userEvent.click(screen.getByText("Memory"));

      await waitFor(() => {
        expect(mockFetchMemoryFiles).toHaveBeenCalledWith(undefined);
        expect(mockFetchMemoryFile).toHaveBeenCalledWith(".fusion/memory/MEMORY.md", undefined);
      });

      const editor = await screen.findByLabelText("Editor for .fusion/memory/MEMORY.md") as HTMLTextAreaElement;
      expect(editor.value).toContain("Existing memory");
    });

    it("shows loading state while memory is being fetched", async () => {
      let resolveMemory: ((value: { content: string }) => void) | undefined;
      mockFetchMemoryFile.mockReturnValueOnce(
        new Promise<{ content: string }>((resolve) => {
          resolveMemory = resolve;
        })
      );

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Memory"));

      expect(screen.getByText("Loading memory…")).toBeDefined();

      resolveMemory?.({ content: "# Loaded" });

      await waitFor(() => {
        expect(screen.getByLabelText("Editor for .fusion/memory/MEMORY.md")).toBeDefined();
      });
    });

    it("supports editing and saving memory content", async () => {
      const addToast = vi.fn();
      renderModal({ addToast });

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Memory"));

      const editor = await screen.findByLabelText("Editor for .fusion/memory/MEMORY.md");
      fireEvent.change(editor, { target: { value: "# Updated memory\n- Reusable learning" } });

      const saveButton = await screen.findByRole("button", { name: "Save Memory" });
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(mockSaveMemoryFile).toHaveBeenCalledWith(
          ".fusion/memory/MEMORY.md",
          "# Updated memory\n- Reusable learning",
          undefined,
        );
      });
      expect(addToast).toHaveBeenCalledWith("Memory saved", "success");
    });

    it("handles empty memory content from API", async () => {
      mockFetchMemoryFile.mockResolvedValueOnce({ path: ".fusion/memory/MEMORY.md", content: "" });
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Memory"));

      const editor = await screen.findByLabelText("Editor for .fusion/memory/MEMORY.md") as HTMLTextAreaElement;
      expect(editor.value).toBe("");
    });

    it("switches between memory files in the editor", async () => {
      mockFetchMemoryFile.mockImplementation((path: string) =>
        Promise.resolve({
          path,
          content: path.endsWith("DREAMS.md") ? "# Dreams\n\n- Pattern" : "# Memory\n\n- Durable",
        }),
      );

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Memory"));

      const select = await screen.findByLabelText("Memory File");
      await userEvent.selectOptions(select, ".fusion/memory/DREAMS.md");

      await waitFor(() => {
        expect(mockFetchMemoryFile).toHaveBeenCalledWith(".fusion/memory/DREAMS.md", undefined);
      });

      const editor = await screen.findByLabelText("Editor for .fusion/memory/DREAMS.md") as HTMLTextAreaElement;
      expect(editor.value).toContain("Dreams");
    });
  });

  describe("Experimental Features section", () => {
    it("renders the Experimental Features section in the sidebar", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      expect(screen.getByText("Experimental Features")).toBeDefined();
    });

    it("shows empty state message when no experimental features are configured", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Experimental Features"));

      expect(screen.getByText(/No experimental features configured/i)).toBeInTheDocument();
    });

    it("shows feature flags when experimentalFeatures is set", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": true, "another-feature": false },
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Experimental Features"));

      expect(screen.getByText("my-feature")).toBeInTheDocument();
      expect(screen.getByText("another-feature")).toBeInTheDocument();
    });

    it("feature flags are unchecked when value is false", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": false },
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Experimental Features"));

      const checkbox = screen.getByLabelText("my-feature") as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });

    it("feature flags are checked when value is true", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": true },
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Experimental Features"));

      const checkbox = screen.getByLabelText("my-feature") as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });

    it("toggling a feature flag updates the form state", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": false },
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Experimental Features"));

      const checkbox = screen.getByLabelText("my-feature") as HTMLInputElement;
      expect(checkbox.checked).toBe(false);

      // Toggle it
      await userEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
    });

    it("saving with toggled feature flag includes experimentalFeatures in payload", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "my-feature": false },
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Experimental Features"));

      // Toggle the feature
      const checkbox = screen.getByLabelText("my-feature") as HTMLInputElement;
      await userEvent.click(checkbox);

      // Save
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ "my-feature": true });
    });

    it("shows project scope banner in Experimental Features section", async () => {
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Experimental Features"));

      // Should show project scope indicator
      expect(screen.getByText(/only affect this project/i)).toBeInTheDocument();
    });

    it("handles undefined experimentalFeatures (falls back to empty)", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: undefined,
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Experimental Features"));

      // Should show empty state since undefined falls back to {}
      expect(screen.getByText(/No experimental features configured/i)).toBeInTheDocument();
    });

    it("saves experimentalFeatures with multiple toggled flags", async () => {
      mockFetchSettings.mockResolvedValue({
        ...defaultSettings,
        experimentalFeatures: { "feature-a": true, "feature-b": false },
      });

      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Experimental Features"));

      // Toggle feature-b to true
      const checkboxB = screen.getByLabelText("feature-b") as HTMLInputElement;
      await userEvent.click(checkboxB);

      // Save
      await userEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
      });

      const payload = mockUpdateSettings.mock.calls[0][0];
      expect(payload.experimentalFeatures).toEqual({ "feature-a": true, "feature-b": true });
    });
  });
});
