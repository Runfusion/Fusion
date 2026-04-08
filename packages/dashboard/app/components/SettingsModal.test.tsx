import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "./SettingsModal";
import type { SettingsExportData } from "../api";

// --- API mocks ---
const mockFetchSettings = vi.fn();
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
const mockFetchMemory = vi.fn();
const mockSaveMemory = vi.fn();

vi.mock("../api", () => ({
  fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
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
  fetchMemory: (...args: unknown[]) => mockFetchMemory(...args),
  saveMemory: (...args: unknown[]) => mockSaveMemory(...args),
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
    mockFetchAuthStatus.mockResolvedValue({ providers: [] });
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
    mockFetchBackups.mockResolvedValue({ backups: [], totalSize: 0 });
    mockFetchMemory.mockResolvedValue({ content: "## Existing memory\n- Learned pattern" });
    mockSaveMemory.mockResolvedValue({ success: true });

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

      expect(mockFetchMemory).not.toHaveBeenCalled();

      await userEvent.click(screen.getByText("Memory"));

      await waitFor(() => {
        expect(mockFetchMemory).toHaveBeenCalledWith(undefined);
      });

      const editor = await screen.findByLabelText("Editor for .fusion/memory.md") as HTMLTextAreaElement;
      expect(editor.value).toContain("Existing memory");
    });

    it("shows loading state while memory is being fetched", async () => {
      let resolveMemory: ((value: { content: string }) => void) | undefined;
      mockFetchMemory.mockReturnValueOnce(
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
        expect(screen.getByLabelText("Editor for .fusion/memory.md")).toBeDefined();
      });
    });

    it("supports editing and saving memory content", async () => {
      const addToast = vi.fn();
      renderModal({ addToast });

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Memory"));

      const editor = await screen.findByLabelText("Editor for .fusion/memory.md");
      fireEvent.change(editor, { target: { value: "# Updated memory\n- Reusable learning" } });

      const saveButton = await screen.findByRole("button", { name: "Save Memory" });
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(mockSaveMemory).toHaveBeenCalledWith("# Updated memory\n- Reusable learning", undefined);
      });
      expect(addToast).toHaveBeenCalledWith("Memory saved", "success");
    });

    it("handles empty memory content from API", async () => {
      mockFetchMemory.mockResolvedValueOnce({ content: "" });
      renderModal();

      await waitFor(() => {
        expect(mockFetchSettings).toHaveBeenCalled();
      });

      await userEvent.click(screen.getByText("Memory"));

      const editor = await screen.findByLabelText("Editor for .fusion/memory.md") as HTMLTextAreaElement;
      expect(editor.value).toBe("");
    });
  });
});
