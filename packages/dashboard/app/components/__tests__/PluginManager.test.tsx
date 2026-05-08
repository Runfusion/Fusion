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
    path: "/plugins/plugin-a",
    settings: { apiKey: "test-key" },
    settingsSchema: {
      apiKey: { type: "string", label: "API Key", description: "The API key", required: true },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "plugin-b",
    name: "Test Plugin B",
    version: "2.0.0",
    state: "stopped",
    enabled: false,
    description: "Another test plugin",
    path: "/plugins/plugin-b",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    path: "/plugins/plugin-a",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
  enablePlugin: vi.fn(() => Promise.resolve({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started" as const,
    enabled: true,
    path: "/plugins/plugin-a",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
  disablePlugin: vi.fn(() => Promise.resolve({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "stopped" as const,
    enabled: false,
    path: "/plugins/plugin-a",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    path: "/plugins/plugin-a",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
  fetchPluginSetupStatus: vi.fn(() => Promise.resolve({ hasSetup: false })),
  installPluginSetup: vi.fn(() => Promise.resolve({ success: true })),
  updatePlugin: vi.fn(() => Promise.resolve({})),
  rescanPlugin: vi.fn(() => Promise.resolve({})),
  browseDirectory: vi.fn(() => Promise.resolve({
    currentPath: "/home",
    parentPath: "/",
    entries: [{ name: "plugins", path: "/home/plugins", hasChildren: true }],
  })),
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

// Import after vi.mock so the mock is in place
import {
  AGENT_BROWSER_SETTINGS_SCHEMA,
  BUILTIN_AGENT_BROWSER_PLUGIN_ID,
  PluginManager,
  STATE_COLORS,
} from "../PluginManager";
import {
  fetchPlugins,
  installPlugin,
  enablePlugin,
  disablePlugin,
  uninstallPlugin,
  fetchPluginSettings,
  updatePluginSettings,
  fetchPluginSetupStatus,
  installPluginSetup,
  updatePlugin,
  rescanPlugin,
} from "../../api";

const addToast = vi.fn();

function expectEventsUrl(url: string, projectId?: string) {
  const parsed = new URL(url, "http://localhost");
  expect(parsed.pathname).toBe("/api/events");
  expect(parsed.searchParams.get("projectId")).toBe(projectId ?? null);
  expect(parsed.searchParams.get("clientId")).toBeTruthy();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  window.sessionStorage.clear();
  
  // Default implementations
  vi.mocked(fetchPlugins).mockResolvedValue([]);
  vi.mocked(installPlugin).mockResolvedValue({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started" as const,
    enabled: true,
    path: "/plugins/plugin-a",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  vi.mocked(enablePlugin).mockResolvedValue({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started" as const,
    enabled: true,
    path: "/plugins/plugin-a",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  vi.mocked(disablePlugin).mockResolvedValue({
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "stopped" as const,
    enabled: false,
    path: "/plugins/plugin-a",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  vi.mocked(uninstallPlugin).mockResolvedValue();
  vi.mocked(fetchPluginSettings).mockResolvedValue({ apiKey: "test-key" });
  vi.mocked(updatePluginSettings).mockResolvedValue({ apiKey: "updated-key" });
  vi.mocked(fetchPluginSetupStatus).mockResolvedValue({ hasSetup: false });
  vi.mocked(installPluginSetup).mockResolvedValue({ success: true });
  vi.mocked(updatePlugin).mockResolvedValue({} as never);
  vi.mocked(rescanPlugin).mockResolvedValue({} as never);
  
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
  
  const MockEventSource = vi.fn((url: string) => {
    eventSourceInstance.url = url;
    return eventSourceInstance;
  }) as unknown as typeof EventSource;
  (MockEventSource as unknown as { CONNECTING: number; OPEN: number; CLOSED: number }).CONNECTING = 0;
  (MockEventSource as unknown as { CONNECTING: number; OPEN: number; CLOSED: number }).OPEN = 1;
  (MockEventSource as unknown as { CONNECTING: number; OPEN: number; CLOSED: number }).CLOSED = 2;
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

  it("exports AGENT_BROWSER_SETTINGS_SCHEMA with expected grouped keys", () => {
    expect(Object.keys(AGENT_BROWSER_SETTINGS_SCHEMA)).toEqual([
      "enabled",
      "installChannel",
      "commandTimeoutMs",
      "headlessMode",
      "allowedDomains",
      "promptExecutorSystem",
      "promptExecutorTask",
      "promptTriage",
      "promptReviewer",
      "promptHeartbeat",
      "skillExposure",
    ]);
    expect(AGENT_BROWSER_SETTINGS_SCHEMA.promptExecutorSystem?.group).toBe("Prompt Contributions");
    expect(AGENT_BROWSER_SETTINGS_SCHEMA.skillExposure?.group).toBe("Skills");
  });

  it("renders empty state when no plugins are installed", async () => {
    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });

    expect(screen.getByText("No plugins installed.")).toBeTruthy();
    expect(screen.getByText("Agent Browser")).toBeTruthy();
    expect(screen.getByText("Hermes Runtime")).toBeTruthy();
    expect(screen.getByText("Paperclip Runtime")).toBeTruthy();
    expect(screen.getByText("OpenClaw Runtime")).toBeTruthy();
    expect(screen.getByText("Droid Runtime")).toBeTruthy();
    expect(screen.getByText("Dependency Graph")).toBeTruthy();
    expect(screen.getByText("WhatsApp Chat")).toBeTruthy();
    expect(screen.getByText(/Pairs to WhatsApp Web \(multi-device\) with QR or pairing code/i)).toBeTruthy();
  });

  it("renders built-in agent browser metadata-only entry when uninstalled", async () => {
    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });

    const builtInCard = screen.getAllByText("Agent Browser").find((node) => node.closest(".plugin-builtins-item"))?.closest(".plugin-builtins-item");
    expect(builtInCard).toBeTruthy();
    expect(within(builtInCard as HTMLElement).getByText("Built-in metadata only")).toBeTruthy();
  });

  it("shows setup-required action for installed built-in agent browser", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce([
      {
        ...mockPlugins[0],
        id: BUILTIN_AGENT_BROWSER_PLUGIN_ID,
        name: "Agent Browser",
      },
    ]);
    vi.mocked(fetchPluginSetupStatus).mockResolvedValueOnce({ hasSetup: true, status: "not-installed" });

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Setup required")).toBeTruthy();
    });

    const builtInCard = screen.getAllByText("Agent Browser").find((node) => node.closest(".plugin-builtins-item"))?.closest(".plugin-builtins-item");
    expect(builtInCard).toBeTruthy();
    const setupButton = within(builtInCard as HTMLElement).getByRole("button", { name: /Install Setup/i });
    await userEvent.click(setupButton);

    await waitFor(() => {
      expect(installPluginSetup).toHaveBeenCalledWith(BUILTIN_AGENT_BROWSER_PLUGIN_ID, undefined);
    });
  });

  it("shows manage action when installed built-in agent browser setup is ready", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce([
      {
        ...mockPlugins[0],
        id: BUILTIN_AGENT_BROWSER_PLUGIN_ID,
        name: "Agent Browser",
        settingsSchema: {},
      },
    ]);
    vi.mocked(fetchPluginSetupStatus).mockResolvedValueOnce({ hasSetup: true, status: "installed", version: "1.0.0" });

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Setup ready")).toBeTruthy();
    });

    const builtInCard = screen.getAllByText("Agent Browser").find((node) => node.closest(".plugin-builtins-item"))?.closest(".plugin-builtins-item");
    expect(builtInCard).toBeTruthy();
    const manageButton = within(builtInCard as HTMLElement).getByRole("button", { name: /^Manage$/i });
    await userEvent.click(manageButton);

    await waitFor(() => {
      expect(fetchPluginSettings).toHaveBeenCalledWith(BUILTIN_AGENT_BROWSER_PLUGIN_ID, undefined);
    });
    expect(screen.getByText("Enable Agent Browser")).toBeTruthy();
    expect(screen.getByLabelText("Install Channel")).toBeTruthy();
    expect(screen.getByLabelText("Command Timeout (ms)")).toBeTruthy();
  });

  it("does not show setup-required state when built-in setup check is deferred for non-started plugin", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce([
      {
        ...mockPlugins[0],
        id: BUILTIN_AGENT_BROWSER_PLUGIN_ID,
        name: "Agent Browser",
        state: "installed",
      },
    ]);
    vi.mocked(fetchPluginSetupStatus).mockResolvedValueOnce({
      hasSetup: true,
      setupCheckDeferred: true,
      deferredReason: "plugin-not-started",
      pluginState: "installed",
    });

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Start plugin to check setup")).toBeTruthy();
    });
    expect(screen.queryByText("Setup required")).toBeNull();
  });

  it("keeps setup-required state for true setup errors on started built-in plugins", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce([
      {
        ...mockPlugins[0],
        id: BUILTIN_AGENT_BROWSER_PLUGIN_ID,
        name: "Agent Browser",
        state: "started",
      },
    ]);
    vi.mocked(fetchPluginSetupStatus).mockResolvedValueOnce({
      hasSetup: true,
      status: "error",
      error: "Binary missing",
    });

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Setup required")).toBeTruthy();
    });
  });

  it("installs built-in runtime plugins from the built-in section", async () => {
    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });

    const hermesLabel = await screen.findByText("Hermes Runtime");
    const hermesCard = hermesLabel.closest(".plugin-builtins-item");
    expect(hermesCard).toBeTruthy();

    const installButton = within(hermesCard as HTMLElement).getByRole("button", { name: /Install Hermes Runtime/i });
    await userEvent.click(installButton);

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith({ path: "./plugins/fusion-plugin-hermes-runtime" }, undefined);
      expect(addToast).toHaveBeenCalledWith("Hermes Runtime installed globally", "success");
    });
  });

  it("installs dependency graph from the built-in section", async () => {
    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(fetchPlugins).toHaveBeenCalled();
    });

    const graphLabel = await screen.findByText("Dependency Graph");
    const graphCard = graphLabel.closest(".plugin-builtins-item");
    expect(graphCard).toBeTruthy();

    const installButton = within(graphCard as HTMLElement).getByRole("button", { name: /Install Dependency Graph/i });
    await userEvent.click(installButton);

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith({ path: "./plugins/fusion-plugin-dependency-graph" }, undefined);
      expect(addToast).toHaveBeenCalledWith("Dependency Graph installed globally", "success");
    });
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
    expect(screen.getByText("Dependency Graph")).toBeTruthy();
    expect(screen.getAllByText("Not installed").length).toBeGreaterThan(0);
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
    mockConfirm.mockResolvedValueOnce(false);

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Test Plugin A")).toBeTruthy();
    });

    const uninstallButtons = screen.getAllByTitle("Uninstall");
    await userEvent.click(uninstallButtons[0]);

    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Uninstall Plugin Globally",
      message: 'Are you sure you want to uninstall "Test Plugin A" globally (all projects)?',
      danger: true,
    });
    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it("calls uninstallPlugin when confirmed", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);
    vi.mocked(uninstallPlugin).mockResolvedValueOnce(undefined);

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

  it("calls updatePlugin when AI scan toggle is changed", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([{ ...mockPlugins[0], aiScanOnLoad: false } as PluginInstallation]);

    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(screen.getByText("Test Plugin A")).toBeTruthy());
    await userEvent.click(screen.getAllByTitle("Settings")[0]);

    const checkbox = await screen.findByLabelText("Enable AI scan before load/reload");
    await userEvent.click(checkbox);

    await waitFor(() => {
      expect(updatePlugin).toHaveBeenCalledWith("plugin-a", { aiScanOnLoad: true }, undefined);
    });
  });

  it("calls rescanPlugin from security card action", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([{ ...mockPlugins[0], aiScanOnLoad: true } as PluginInstallation]);

    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(screen.getByText("Test Plugin A")).toBeTruthy());
    await userEvent.click(screen.getAllByTitle("Settings")[0]);

    await userEvent.click(await screen.findByRole("button", { name: /Rescan and Reload/i }));

    await waitFor(() => {
      expect(rescanPlugin).toHaveBeenCalledWith("plugin-a", undefined);
    });
  });

  it("renders persisted security scan verdict and findings", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([{ ...mockPlugins[0], lastSecurityScan: { verdict: "warning", summary: "Suspicious eval usage", findings: [{ category: "exec", severity: "high", file: "src/index.ts", excerpt: "eval(x)", reason: "dynamic execution" }], scannedAt: "2026-05-01T00:00:00.000Z", scannedFiles: ["src/index.ts"] } } as PluginInstallation]);

    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(screen.getByText("Test Plugin A")).toBeTruthy());
    await userEvent.click(screen.getAllByTitle("Settings")[0]);

    expect(await screen.findByText("warning")).toBeTruthy();
    expect(screen.getByText("Suspicious eval usage")).toBeTruthy();
    await userEvent.click(screen.getByText(/Findings \(1\)/));
    expect(screen.getByText(/dynamic execution/)).toBeTruthy();
  });

  it("renders blocked verdict in security scan card", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([{ ...mockPlugins[0], lastSecurityScan: { verdict: "blocked", summary: "Blocked by scan", findings: [], scannedAt: "2026-05-01T00:00:00.000Z", scannedFiles: [] } } as PluginInstallation]);

    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(screen.getByText("Test Plugin A")).toBeTruthy());
    await userEvent.click(screen.getAllByTitle("Settings")[0]);

    expect(await screen.findByText("blocked")).toBeTruthy();
    expect(screen.getByText("Blocked by scan")).toBeTruthy();
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

  it("shows built-in metadata only state for agent browser when not installed", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce([]);
    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Agent Browser")).toBeTruthy();
    });

    const agentBrowserCard = screen.getByText("Agent Browser").closest(".plugin-builtins-item");
    expect(agentBrowserCard).toBeTruthy();
    expect(within(agentBrowserCard as HTMLElement).getByText("Built-in metadata only")).toBeTruthy();
  });

  it("shows Manage for installed dependency graph in built-in section", async () => {
    vi.mocked(fetchPlugins).mockResolvedValueOnce([
      {
        ...mockPlugins[0],
        id: "fusion-plugin-dependency-graph",
        name: "Dependency Graph",
      },
    ]);

    render(<PluginManager addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getAllByText("Dependency Graph").length).toBeGreaterThanOrEqual(2);
    });

    const graphCard = screen.getAllByText("Dependency Graph")[1]?.closest(".plugin-builtins-item");
    expect(graphCard).toBeTruthy();

    const manageButton = within(graphCard as HTMLElement).getByRole("button", { name: /^Manage$/i });
    expect(manageButton).not.toBeDisabled();
    expect(within(graphCard as HTMLElement).getAllByText("Installed").length).toBeGreaterThanOrEqual(1);

    await userEvent.click(manageButton);

    await waitFor(() => {
      expect(fetchPluginSettings).toHaveBeenCalledWith("fusion-plugin-dependency-graph", undefined);
    });

    expect(screen.getByTestId("plugin-manager-detail")).toBeTruthy();
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

      const url = (globalThis as any).__testEventSourceInstance?.url;
      expect(typeof url).toBe("string");
      expectEventsUrl(url, "proj-456");
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
      vi.mocked(fetchPlugins).mockResolvedValue([{ ...mockPlugins[0], enabled: false }]);

      render(<PluginManager addToast={addToast} projectId="proj-789" />);

      await waitFor(() => {
        expect(screen.getByText("Test Plugin A")).toBeTruthy();
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

  describe("grouped settings rendering", () => {
    it("renders grouped headings and preserves ungrouped settings", async () => {
      const groupedPlugin: PluginInstallation = {
        ...mockPlugins[0],
        id: "plugin-grouped",
        name: "Grouped Plugin",
        settingsSchema: {
          enabled: { type: "boolean", label: "Enabled", group: "General" },
          prompt: { type: "string", label: "Prompt", multiline: true, group: "Prompt Contributions" },
          legacySetting: { type: "string", label: "Legacy Setting" },
        },
      };
      vi.mocked(fetchPlugins).mockResolvedValueOnce([groupedPlugin]);
      vi.mocked(fetchPluginSettings).mockResolvedValueOnce({ enabled: true, prompt: "x", legacySetting: "y" });

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Grouped Plugin")).toBeTruthy();
      });

      await userEvent.click(screen.getAllByTitle("Settings")[0]);

      expect(await screen.findByRole("heading", { name: "General", level: 6 })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Prompt Contributions", level: 6 })).toBeTruthy();
      expect(screen.getByLabelText("Legacy Setting")).toBeTruthy();
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
      path: "/plugins/plugin-new-types",
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
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
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
      const checkbox = toggleSwitch?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
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
      const checkbox = toggleSwitch?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
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

    it("keeps plugin detail heading hierarchy with plugin title above settings section", async () => {
      vi.mocked(fetchPlugins).mockResolvedValueOnce(mockPlugins);

      render(<PluginManager addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Test Plugin A")).toBeTruthy();
      });

      const settingsButtons = screen.getAllByTitle("Settings");
      await userEvent.click(settingsButtons[0]);

      const pluginTitle = await screen.findByRole("heading", { name: "Test Plugin A", level: 4 });
      const settingsHeading = screen.getByRole("heading", { name: "Settings", level: 5 });

      expect(pluginTitle).toBeTruthy();
      expect(settingsHeading).toBeTruthy();
    });
  });
});
