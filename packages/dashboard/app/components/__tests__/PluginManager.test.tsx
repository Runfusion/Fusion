import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginInstallation } from "@fusion/core";

// Define mock data outside vi.mock
const mockPlugins: PluginInstallation[] = [
  {
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started",
    enabled: true,
    description: "A test plugin",
    author: "Test Author",
    homepage: "https://example.com",
    settings: { apiKey: "test-key" },
    settingsSchema: {
      apiKey: { type: "string", label: "API Key", description: "The API key", required: true },
    },
  },
  {
    id: "plugin-b",
    name: "Test Plugin B",
    version: "2.0.0",
    state: "stopped",
    enabled: false,
    description: "Another test plugin",
    settings: {},
    settingsSchema: {},
  },
];

// Mock API module - must be defined inline in vi.mock
vi.mock("../../api", () => ({
  fetchPlugins: vi.fn(() => Promise.resolve([])),
  installPlugin: vi.fn(() => Promise.resolve({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started" as const,
    enabled: true,
    settings: {},
    settingsSchema: {},
  })),
  enablePlugin: vi.fn(() => Promise.resolve({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started" as const,
    enabled: true,
    settings: {},
    settingsSchema: {},
  })),
  disablePlugin: vi.fn(() => Promise.resolve({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "stopped" as const,
    enabled: false,
    settings: {},
    settingsSchema: {},
  })),
  uninstallPlugin: vi.fn(() => Promise.resolve()),
  fetchPluginSettings: vi.fn(() => Promise.resolve({ apiKey: "test-key" })),
  updatePluginSettings: vi.fn(() => Promise.resolve({ apiKey: "updated-key" })),
  reloadPlugin: vi.fn(() => Promise.resolve({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started" as const,
    enabled: true,
    settings: {},
    settingsSchema: {},
  })),
  browseDirectory: vi.fn(() => Promise.resolve({
    currentPath: "/home",
    parentPath: "/",
    entries: [{ name: "plugins", path: "/home/plugins", hasChildren: true }],
  })),
}));

// Import after vi.mock so the mock is in place
import { PluginManager, STATE_COLORS } from "../PluginManager";
import {
  fetchPlugins,
  installPlugin,
  enablePlugin,
  disablePlugin,
  uninstallPlugin,
  fetchPluginSettings,
  updatePluginSettings,
} from "../../api";

const addToast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  
  // Default implementations
  vi.mocked(fetchPlugins).mockResolvedValue([]);
  vi.mocked(installPlugin).mockResolvedValue({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started" as const,
    enabled: true,
    settings: {},
    settingsSchema: {},
  });
  vi.mocked(enablePlugin).mockResolvedValue({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started" as const,
    enabled: true,
    settings: {},
    settingsSchema: {},
  });
  vi.mocked(disablePlugin).mockResolvedValue({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "stopped" as const,
    enabled: false,
    settings: {},
    settingsSchema: {},
  });
  vi.mocked(uninstallPlugin).mockResolvedValue();
  vi.mocked(fetchPluginSettings).mockResolvedValue({ apiKey: "test-key" });
  vi.mocked(updatePluginSettings).mockResolvedValue({ apiKey: "updated-key" });
  
  // EventSource mock setup
  const eventSourceInstance = {
    url: "",
    readyState: 1,
    close: vi.fn(),
    addEventListener: vi.fn((event: string, handler: (e: MessageEvent) => void) => {
      (eventSourceInstance as any).handlers = (eventSourceInstance as any).handlers || {};
      (eventSourceInstance as any).handlers[event] = handler;
    }),
    removeEventListener: vi.fn(),
    onerror: null,
    onopen: null,
    onmessage: null,
  };
  
  const MockEventSource = vi.fn(() => eventSourceInstance) as unknown as typeof EventSource;
  MockEventSource.CONNECTING = 0;
  MockEventSource.OPEN = 1;
  MockEventSource.CLOSED = 2;
  vi.stubGlobal("EventSource", MockEventSource);
  
  // Store reference for tests that need to trigger events
  (globalThis as any).__testEventSourceInstance = eventSourceInstance;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as any).__testEventSourceInstance;
});

describe("PluginManager", () => {
  it("renders loading state initially", async () => {
    vi.mocked(fetchPlugins).mockImplementationOnce(
      () => new Promise(() => {}) // Never resolves to keep loading state
    );

    render(<PluginManager addToast={addToast} />);

    expect(screen.getByText("Loading plugins...")).toBeTruthy();
  });

  it("renders empty state when no plugins are installed", async () => {
    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });

    expect(screen.getByText("No plugins installed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Install$/ })).toBeTruthy();
  });

  it("renders plugin list when plugins are available", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Test Plugin A")).toBeTruthy();
    });

    expect(screen.getByText("Test Plugin B")).toBeTruthy();
    expect(screen.getByText("v1.0.0")).toBeTruthy();
    expect(screen.getByText("v2.0.0")).toBeTruthy();
  });

  it("shows install form with directory picker and hint when Install button is clicked", async () => {
    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });

    const installButton = screen.getByRole("button", { name: /^Install$/ });
    await userEvent.click(installButton);

    // Directory picker input is present
    expect(screen.getByPlaceholderText("Absolute path to plugin directory or dist folder")).toBeTruthy();
    // Browse button from DirectoryPicker is present
    expect(screen.getByRole("button", { name: /Browse directories|Close directory browser/i })).toBeTruthy();
    // Hint text about valid selections
    expect(screen.getByText(/manifest\.json/)).toBeTruthy();
    expect(screen.getByText(/dist/)).toBeTruthy();
    // Cancel button
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
  });

  it("calls installPlugin with the provided path", async () => {
    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });

    // Click the header Install button
    const headerInstallButton = screen.getByRole("button", { name: /^Install$/ });
    await userEvent.click(headerInstallButton);

    const input = screen.getByPlaceholderText("Absolute path to plugin directory or dist folder");
    await userEvent.type(input, "/path/to/plugin");

    // Get the form container and find the Install Plugin button within it
    const formContainer = screen.getByPlaceholderText("Absolute path to plugin directory or dist folder").closest(".plugin-install-form");
    expect(formContainer).toBeTruthy();
    const formInstallButton = within(formContainer as HTMLElement).getByRole("button", { name: /Install Plugin/ });
    await userEvent.click(formInstallButton);

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith({ path: "/path/to/plugin" }, undefined);
    });
  });

  it("shows error toast when install fails", async () => {
    vi.mocked(installPlugin).mockRejectedValueOnce(new Error("Install failed"));

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });

    const headerInstallButton = screen.getByRole("button", { name: /^Install$/ });
    await userEvent.click(headerInstallButton);

    const input = screen.getByPlaceholderText("Absolute path to plugin directory or dist folder");
    await userEvent.type(input, "/path/to/plugin");

    const formContainer = screen.getByPlaceholderText("Absolute path to plugin directory or dist folder").closest(".plugin-install-form");
    expect(formContainer).toBeTruthy();
    const formInstallButton = within(formContainer as HTMLElement).getByRole("button", { name: /Install Plugin/ });
    await userEvent.click(formInstallButton);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("Install failed"),
        "error"
      );
    });
  });

  it("enables plugin when toggle is clicked", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce([{ ...mockPlugins[0], enabled: false }]);
    vi.mocked(enablePlugin).mockResolvedValueOnce({ ...mockPlugins[0], enabled: true });

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Test Plugin A")).toBeTruthy();
    });

    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeTruthy();
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(enablePlugin).toHaveBeenCalledWith("plugin-a", undefined);
    });
  });

  it("disables plugin when toggle is clicked", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce([{ ...mockPlugins[0], enabled: true }]);
    vi.mocked(disablePlugin).mockResolvedValueOnce({ ...mockPlugins[0], enabled: false });

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Test Plugin A")).toBeTruthy();
    });

    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeTruthy();
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(disablePlugin).toHaveBeenCalledWith("plugin-a", undefined);
    });
  });

  it("asks for confirmation before uninstalling", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Test Plugin A")).toBeTruthy();
    });

    const uninstallButtons = screen.getAllByTitle("Uninstall");
    await userEvent.click(uninstallButtons[0]);

    expect(confirmSpy).toHaveBeenCalled();
    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it("calls uninstallPlugin when confirmed", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);
    vi.mocked(uninstallPlugin).mockResolvedValueOnce(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Test Plugin A")).toBeTruthy();
    });

    const uninstallButtons = screen.getAllByTitle("Uninstall");
    await userEvent.click(uninstallButtons[0]);

    await waitFor(() => {
      expect(uninstallPlugin).toHaveBeenCalledWith("plugin-a", undefined);
    });
  });

  it("shows plugin detail view when settings button is clicked", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Test Plugin A")).toBeTruthy();
    });

    const settingsButtons = screen.getAllByTitle("Settings");
    await userEvent.click(settingsButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeTruthy();
      expect(screen.getByDisplayValue("test-key")).toBeTruthy();
    });
  });

  it("saves plugin settings", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Test Plugin A")).toBeTruthy();
    });

    const settingsButtons = screen.getAllByTitle("Settings");
    await userEvent.click(settingsButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeTruthy();
    });

    const input = screen.getByDisplayValue("test-key") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "updated-key");

    const saveButton = screen.getByRole("button", { name: /Save Settings/i });
    await userEvent.click(saveButton);

    await waitFor(() => {
      expect(updatePluginSettings).toHaveBeenCalledWith(
        "plugin-a",
        expect.objectContaining({ apiKey: "updated-key" }),
        undefined
      );
      expect(addToast).toHaveBeenCalledWith("Settings saved", "success");
    });
  });

  it("refreshes plugin list when refresh button is clicked", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });

    vi.mocked(fetchPlugins).mockClear();
    vi.mocked(fetchPlugins).mockResolvedValueOnce([mockPlugins[1]]);

    const refreshButton = screen.getByTitle("Refresh");
    await userEvent.click(refreshButton);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });
  });

  it("uses projectId when provided", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce([]);

    render(<PluginManager addToast={addToast} projectId="proj-123" />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalledWith("proj-123");
    });
  });

  describe("SSE Live Updates", () => {
    it("subscribes to plugin:lifecycle SSE events", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(fetchPlugins).toHaveBeenCalled();
      });

      expect(EventSource).toHaveBeenCalled();
    });

    it("subscribes to project-scoped SSE when projectId is provided", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);

      render(<PluginManager addToast={addToast} projectId="proj-456" />);

      await waitFor(() => {
        expect(fetchPlugins).toHaveBeenCalled();
      });

      expect(EventSource).toHaveBeenCalledWith("/api/events?projectId=proj-456");
    });

    it("handles plugin enabled SSE event", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([{ ...mockPlugins[0], enabled: false }]);

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Test Plugin A")).toBeTruthy();
      });

      const eventSourceInstance = (globalThis as any).__testEventSourceInstance;
      const eventHandler = eventSourceInstance?.handlers?.["plugin:lifecycle"];
      expect(eventHandler).toBeTruthy();

      act(() => {
        eventHandler({
          data: JSON.stringify({
            pluginId: "plugin-a",
            transition: "enabled",
            sourceEvent: "plugin:enabled",
            timestamp: new Date().toISOString(),
            enabled: true,
            state: "started",
            version: "1.0.0",
            settings: {},
          }),
        });
      });

      await waitFor(() => {
        const toggle = screen.getByRole("checkbox");
        expect(toggle).toBeChecked();
      });
    });

    it("handles plugin disabled SSE event", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([{ ...mockPlugins[0], enabled: true }]);

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Test Plugin A")).toBeTruthy();
      });

      const eventSourceInstance = (globalThis as any).__testEventSourceInstance;
      const eventHandler = eventSourceInstance?.handlers?.["plugin:lifecycle"];
      
      act(() => {
        eventHandler({
          data: JSON.stringify({
            pluginId: "plugin-a",
            transition: "disabled",
            sourceEvent: "plugin:disabled",
            timestamp: new Date().toISOString(),
            enabled: false,
            state: "stopped",
            version: "1.0.0",
            settings: {},
          }),
        });
      });

      await waitFor(() => {
        const toggle = screen.getByRole("checkbox");
        expect(toggle).not.toBeChecked();
      });
    });

    it("handles plugin uninstalled SSE event", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Test Plugin A")).toBeTruthy();
      });

      const eventSourceInstance = (globalThis as any).__testEventSourceInstance;
      const eventHandler = eventSourceInstance?.handlers?.["plugin:lifecycle"];
      
      act(() => {
        eventHandler({
          data: JSON.stringify({
            pluginId: "plugin-a",
            transition: "uninstalled",
            sourceEvent: "plugin:unregistered",
            timestamp: new Date().toISOString(),
            enabled: false,
            state: "stopped",
            version: "1.0.0",
            settings: {},
          }),
        });
      });

      await waitFor(() => {
        expect(screen.queryByText("Test Plugin A")).toBeNull();
      });
    });

    it("handles plugin settings-updated SSE event", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([{ ...mockPlugins[0], settings: { oldKey: "old" } }]);
      vi.mocked(fetchPluginSettings).mockResolvedValueOnce({ newKey: "new" });

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Test Plugin A")).toBeTruthy();
      });

      const settingsButtons = screen.getAllByTitle("Settings");
      await userEvent.click(settingsButtons[0]);

      await waitFor(() => {
        expect(screen.getByText("Settings")).toBeTruthy();
      });

      const eventSourceInstance = (globalThis as any).__testEventSourceInstance;
      const eventHandler = eventSourceInstance?.handlers?.["plugin:lifecycle"];
      
      act(() => {
        eventHandler({
          data: JSON.stringify({
            pluginId: "plugin-a",
            transition: "settings-updated",
            sourceEvent: "plugin:updated",
            timestamp: new Date().toISOString(),
            enabled: true,
            state: "started",
            version: "1.0.0",
            settings: { newKey: "new" },
          }),
        });
      });

      await waitFor(() => {
        expect(fetchPluginSettings).toHaveBeenCalledWith("plugin-a", undefined);
      });
    });

    it("filters events by projectId in project-scoped mode", async () => {
      // Start with plugin disabled
      vi.mocked(fetchPlugins).mockResolvedValueOnce([{ ...mockPlugins[0], enabled: false }]);

      render(<PluginManager addToast={addToast} projectId="proj-789" />);

      await waitFor(() => {
        expect(fetchPlugins).toHaveBeenCalled();
      });

      // Verify initial state - toggle should NOT be checked
      const toggle = screen.getByRole("checkbox");
      expect(toggle).not.toBeChecked();

      // Now send an SSE event from a DIFFERENT project trying to enable the plugin
      const eventSourceInstance = (globalThis as any).__testEventSourceInstance;
      const eventHandler = eventSourceInstance?.handlers?.["plugin:lifecycle"];
      
      act(() => {
        eventHandler({
          data: JSON.stringify({
            pluginId: "plugin-a",
            transition: "enabled",
            sourceEvent: "plugin:enabled",
            timestamp: new Date().toISOString(),
            projectId: "other-project", // Different project - this event should be filtered
            enabled: true,
            state: "started",
            version: "1.0.0",
            settings: {},
          }),
        });
      });

      // Toggle should STILL NOT be checked since event is from different project (filtered)
      await waitFor(() => {
        const filteredToggle = screen.getByRole("checkbox");
        expect(filteredToggle).not.toBeChecked();
      });
    });

    it("cleans up EventSource on unmount", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);

      const eventSourceInstance = (globalThis as any).__testEventSourceInstance;

      const { unmount } = render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(fetchPlugins).toHaveBeenCalled();
      });

      expect(EventSource).toHaveBeenCalled();

      unmount();

      expect(eventSourceInstance?.close).toHaveBeenCalled();
    });
  });

  describe("new input types", () => {
    const mockPluginWithNewTypes: PluginInstallation = {
      id: "plugin-new-types",
      name: "Plugin With New Types",
      version: "1.0.0",
      state: "started",
      enabled: true,
      description: "A plugin with password, multiline, and array settings",
      settings: {
        apiSecret: "secret123",
        customMessage: "Hello\nWorld",
        tags: ["bug", "feature"],
        counts: [1, 2, 3],
      },
      settingsSchema: {
        apiSecret: { type: "password", label: "API Secret" },
        customMessage: { type: "string", label: "Custom Message", multiline: true },
        tags: { type: "array", label: "Tags", itemType: "string" },
        counts: { type: "array", label: "Counts", itemType: "number" },
      },
    };

    it("renders password input for password type", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([mockPluginWithNewTypes]);
      vi.mocked(fetchPluginSettings).mockResolvedValueOnce({
        apiSecret: "secret123",
      });

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Plugin With New Types")).toBeTruthy();
      });

      const settingsButtons = screen.getAllByTitle("Settings");
      await userEvent.click(settingsButtons[0]);

      await waitFor(() => {
        expect(screen.getByLabelText("API Secret")).toBeTruthy();
      });

      const passwordInput = screen.getByLabelText("API Secret") as HTMLInputElement;
      expect(passwordInput.type).toBe("password");
    });

    it("renders textarea for multiline string", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([mockPluginWithNewTypes]);
      vi.mocked(fetchPluginSettings).mockResolvedValueOnce({
        customMessage: "Hello\nWorld",
      });

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Plugin With New Types")).toBeTruthy();
      });

      const settingsButtons = screen.getAllByTitle("Settings");
      await userEvent.click(settingsButtons[0]);

      await waitFor(() => {
        expect(screen.getByLabelText("Custom Message")).toBeTruthy();
      });

      const textarea = screen.getByLabelText("Custom Message") as HTMLTextAreaElement;
      expect(textarea.rows).toBe(4);
      expect(textarea.value).toBe("Hello\nWorld");
    });

    it("renders array items with input fields", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([mockPluginWithNewTypes]);
      vi.mocked(fetchPluginSettings).mockResolvedValueOnce({
        tags: ["bug", "feature"],
      });

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Plugin With New Types")).toBeTruthy();
      });

      const settingsButtons = screen.getAllByTitle("Settings");
      await userEvent.click(settingsButtons[0]);

      await waitFor(() => {
        expect(screen.getByText("Tags")).toBeTruthy();
        expect(screen.getByDisplayValue("bug")).toBeTruthy();
        expect(screen.getByDisplayValue("feature")).toBeTruthy();
      });

      // Check for "Add Item" buttons (there are two: one for Tags, one for Counts)
      const addButtons = screen.getAllByRole("button", { name: /Add Item/i });
      expect(addButtons.length).toBeGreaterThanOrEqual(1);
    });

    it("adds new item to array when Add Item is clicked", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([mockPluginWithNewTypes]);
      vi.mocked(fetchPluginSettings).mockResolvedValueOnce({
        tags: ["bug"],
      });

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Plugin With New Types")).toBeTruthy();
      });

      const settingsButtons = screen.getAllByTitle("Settings");
      await userEvent.click(settingsButtons[0]);

      await waitFor(() => {
        expect(screen.getByDisplayValue("bug")).toBeTruthy();
      });

      // Click the first Add Item button
      const addButtons = screen.getAllByRole("button", { name: /Add Item/i });
      await userEvent.click(addButtons[0]);

      // Should now have more textboxes
      const inputs = screen.getAllByRole("textbox");
      expect(inputs.length).toBeGreaterThanOrEqual(2);
    });

    it("removes item from array when remove button is clicked", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([mockPluginWithNewTypes]);
      vi.mocked(fetchPluginSettings).mockResolvedValueOnce({
        tags: ["bug", "feature"],
      });
      vi.mocked(updatePluginSettings).mockResolvedValueOnce({
        tags: ["bug"],
      });

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Plugin With New Types")).toBeTruthy();
      });

      const settingsButtons = screen.getAllByTitle("Settings");
      await userEvent.click(settingsButtons[0]);

      await waitFor(() => {
        expect(screen.getByDisplayValue("bug")).toBeTruthy();
        expect(screen.getByDisplayValue("feature")).toBeTruthy();
      });

      // Find and click the first remove button
      const removeButtons = screen.getAllByRole("button", { name: /Remove item/i });
      await userEvent.click(removeButtons[0]);

      // Save settings
      const saveButton = screen.getByRole("button", { name: /Save Settings/i });
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(updatePluginSettings).toHaveBeenCalledWith(
          "plugin-new-types",
          expect.objectContaining({ tags: ["feature"] }),
          undefined
        );
      });
    });

    it("saves array settings with correct values", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([mockPluginWithNewTypes]);
      vi.mocked(fetchPluginSettings).mockResolvedValueOnce({
        tags: ["bug", "feature"],
      });
      vi.mocked(updatePluginSettings).mockResolvedValueOnce({
        tags: ["bug", "feature", "docs"],
      });

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Plugin With New Types")).toBeTruthy();
      });

      const settingsButtons = screen.getAllByTitle("Settings");
      await userEvent.click(settingsButtons[0]);

      await waitFor(() => {
        expect(screen.getByDisplayValue("bug")).toBeTruthy();
      });

      // Add a new item (click the first Add Item button which is for Tags)
      const addButtons = screen.getAllByRole("button", { name: /Add Item/i });
      await userEvent.click(addButtons[0]);

      // Type the new value in the last textbox
      const textboxes = screen.getAllByRole("textbox");
      const lastInput = textboxes[textboxes.length - 1];
      await userEvent.clear(lastInput);
      await userEvent.type(lastInput, "docs");

      // Save settings
      const saveButton = screen.getByRole("button", { name: /Save Settings/i });
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(updatePluginSettings).toHaveBeenCalledWith(
          "plugin-new-types",
          expect.objectContaining({ tags: expect.arrayContaining(["bug", "feature", "docs"]) }),
          undefined
        );
      });
    });

    it("renders number inputs for number array", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([mockPluginWithNewTypes]);
      vi.mocked(fetchPluginSettings).mockResolvedValueOnce({
        counts: [10, 20, 30],
      });

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Plugin With New Types")).toBeTruthy();
      });

      const settingsButtons = screen.getAllByTitle("Settings");
      await userEvent.click(settingsButtons[0]);

      await waitFor(() => {
        expect(screen.getByText("Counts")).toBeTruthy();
      });

      // Check for number inputs
      const numberInputs = screen.getAllByRole("spinbutton");
      expect(numberInputs.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("toggle switch rendering", () => {
    it("renders enabled toggle switch inside .toggle-switch label", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([{ ...mockPlugins[0], enabled: true }]);

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Test Plugin A")).toBeTruthy();
      });

      // Find the toggle-switch label
      const toggleSwitch = screen.getByText("Test Plugin A").closest(".plugin-item")?.querySelector(".toggle-switch");
      expect(toggleSwitch).toBeTruthy();

      // Find the checkbox inside
      const checkbox = toggleSwitch?.querySelector('input[type="checkbox"]');
      expect(checkbox).toBeTruthy();
      expect(checkbox?.checked).toBe(true);
    });

    it("renders disabled toggle switch inside .toggle-switch label", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([{ ...mockPlugins[0], enabled: false }]);

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Test Plugin A")).toBeTruthy();
      });

      // Find the toggle-switch label
      const toggleSwitch = screen.getByText("Test Plugin A").closest(".plugin-item")?.querySelector(".toggle-switch");
      expect(toggleSwitch).toBeTruthy();

      // Find the checkbox inside
      const checkbox = toggleSwitch?.querySelector('input[type="checkbox"]');
      expect(checkbox).toBeTruthy();
      expect(checkbox?.checked).toBe(false);
    });
  });

  describe("STATE_COLORS", () => {
    it("contains only CSS variable references with no hardcoded hex values", () => {
      const values = Object.values(STATE_COLORS);
      const allUseCssVars = values.every((v) => /^var\(--[a-z-]+\)$/.test(v));
      expect(allUseCssVars).toBe(true);
    });
  });

  describe("style conventions", () => {
    it("renders empty state with settings-empty-state class for consistency", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([]);

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(fetchPlugins).toHaveBeenCalled();
      });

      const emptyState = screen.getByText("No plugins installed.").closest(".settings-empty-state");
      expect(emptyState).toBeTruthy();
    });

    it("renders loading state with settings-empty-state class for consistency", async () => {
      vi.mocked(fetchPlugins).mockImplementationOnce(
        () => new Promise(() => {}) // Never resolves to keep loading state
      );

      render(<PluginManager addToast={addToast} />);

      const loadingState = screen.getByText("Loading plugins...").closest(".settings-empty-state");
      expect(loadingState).toBeTruthy();
    });

    it("renders plugin manager header without redundant h3 (heading provided by SettingsModal)", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce([]);

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(fetchPlugins).toHaveBeenCalled();
      });

      // Header should exist
      const header = screen.getByTestId("plugin-manager").querySelector(".plugin-manager-header");
      expect(header).toBeTruthy();

      // But should not contain an h3 (heading is provided by SettingsModal's settings-section-heading)
      expect(header?.querySelector("h3")).toBeNull();
    });
  });
});
