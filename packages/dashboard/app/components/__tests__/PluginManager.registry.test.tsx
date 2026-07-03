import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PluginInstallation } from "@fusion/core";
import type { RegistryPluginEntry } from "../../api";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";

vi.mock("../../api", () => ({
  fetchPlugins: vi.fn(() => Promise.resolve([])),
  fetchPluginRegistry: vi.fn(() => Promise.resolve([])),
  installPlugin: vi.fn(() => Promise.resolve({ id: "registry-installable", name: "Installable Registry", version: "1.0.0", state: "started", enabled: true, settings: {} })),
  enablePlugin: vi.fn(() => Promise.resolve({})),
  disablePlugin: vi.fn(() => Promise.resolve({})),
  uninstallPlugin: vi.fn(() => Promise.resolve()),
  fetchPluginSettings: vi.fn(() => Promise.resolve({})),
  updatePluginSettings: vi.fn(() => Promise.resolve({})),
  reloadPlugin: vi.fn(() => Promise.resolve({})),
  fetchPluginSetupStatus: vi.fn(() => Promise.resolve({ hasSetup: false })),
  installPluginSetup: vi.fn(() => Promise.resolve({ success: true })),
  updatePlugin: vi.fn(() => Promise.resolve({})),
  rescanPlugin: vi.fn(() => Promise.resolve({})),
  browseDirectory: vi.fn(() => Promise.resolve({ currentPath: "/home", parentPath: null, entries: [] })),
}));

import { PluginManager } from "../PluginManager";
import { fetchPluginRegistry, fetchPlugins, fetchPluginSettings, installPlugin } from "../../api";

const addToast = vi.fn();

const installedPlugin: PluginInstallation = {
  id: "registry-installed",
  name: "Installed Registry",
  version: "2.0.0",
  state: "started",
  enabled: true,
  description: "Already installed plugin",
  author: "Registry Team",
  path: "/plugins/registry-installed",
  settings: {},
  settingsSchema: {},
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

const registryEntries: RegistryPluginEntry[] = [
  {
    id: "registry-installable",
    name: "Installable Registry",
    description: "Adds installable registry capabilities.",
    version: "1.0.0",
    author: "Fusion Labs",
    category: "integration",
    path: "./plugins/registry-installable",
    tags: ["registry"],
    installed: false,
    canInstall: true,
  },
  {
    id: "registry-installed",
    name: "Installed Registry",
    description: "Already available in this workspace.",
    version: "2.0.0",
    author: "Fusion Core",
    category: "runtime",
    installed: true,
    installedVersion: "2.0.0",
    state: "started",
    canInstall: true,
  },
  {
    id: "registry-coming-soon",
    name: "Coming Soon Registry",
    description: "Listed before it is locally installable.",
    version: "0.1.0",
    author: "Fusion Labs",
    category: "integration",
    installed: false,
    canInstall: false,
  },
];

function stubEventSource() {
  const esInstance = {
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    readyState: 1,
    onerror: null,
    onopen: null,
    onmessage: null,
  };
  const MockEventSource = vi.fn(function MockEventSource() {
    return esInstance;
  }) as unknown as typeof EventSource;
  (MockEventSource as unknown as { CONNECTING: number; OPEN: number; CLOSED: number }).CONNECTING = 0;
  (MockEventSource as unknown as { CONNECTING: number; OPEN: number; CLOSED: number }).OPEN = 1;
  (MockEventSource as unknown as { CONNECTING: number; OPEN: number; CLOSED: number }).CLOSED = 2;
  vi.stubGlobal("EventSource", MockEventSource);
}

async function renderRegistry(entries: RegistryPluginEntry[] = registryEntries, installed: PluginInstallation[] = [installedPlugin]) {
  vi.mocked(fetchPlugins).mockResolvedValue(installed);
  vi.mocked(fetchPluginRegistry).mockResolvedValue(entries);
  render(<PluginManager addToast={addToast} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(fetchPluginRegistry).toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  stubEventSource();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PluginManager registry browsing", () => {
  it("renders registry entries with metadata", async () => {
    await renderRegistry();

    const section = screen.getByRole("region", { name: "Browse Registry" });
    expect(within(section).getByText("Installable Registry")).toBeInTheDocument();
    expect(within(section).getByText("Adds installable registry capabilities.")).toBeInTheDocument();
    expect(within(section).getByText("v1.0.0")).toBeInTheDocument();
    expect(within(section).getAllByText("By Fusion Labs").length).toBeGreaterThan(0);
    expect(within(section).getAllByText("integration").length).toBeGreaterThan(0);
  });

  it("shows action states for installable, installed, and unavailable entries", async () => {
    await renderRegistry();

    const section = screen.getByRole("region", { name: "Browse Registry" });
    const installable = within(section).getByText("Installable Registry").closest(".plugin-registry-item") as HTMLElement;
    expect(within(installable).getByRole("button", { name: "Install" })).toBeInTheDocument();

    const installed = within(section).getByText("Installed Registry").closest(".plugin-registry-item") as HTMLElement;
    expect(within(installed).getByRole("button", { name: "Manage" })).toBeInTheDocument();

    const comingSoon = screen.getByText("Coming Soon Registry").closest(".plugin-registry-item") as HTMLElement;
    expect(within(comingSoon).getByText("Coming Soon")).toBeInTheDocument();
  });

  it.each([
    {
      state: "not-installed" as const,
      entry: {
        id: "fusion-plugin-linear-import",
        name: "Linear Import",
        description: "Browse Linear issues and import selected issues as Fusion triage tasks through plugin-owned settings.",
        version: "0.1.0",
        author: "Fusion",
        category: "integration" as const,
        path: "./plugins/fusion-plugin-linear-import",
        tags: ["linear", "import", "issues", "dashboard"],
        installed: false,
        canInstall: true,
      },
      installed: [] as PluginInstallation[],
      action: "Install",
    },
    {
      state: "installed-error" as const,
      entry: {
        id: "fusion-plugin-linear-import",
        name: "Linear Import",
        description: "Browse Linear issues and import selected issues as Fusion triage tasks through plugin-owned settings.",
        version: "0.1.0",
        author: "Fusion",
        category: "integration" as const,
        path: "./plugins/fusion-plugin-linear-import",
        tags: ["linear", "import", "issues", "dashboard"],
        installed: true,
        installedVersion: "0.1.0",
        state: "error" as const,
        canInstall: true,
      },
      installed: [{ ...installedPlugin, id: "fusion-plugin-linear-import", name: "Linear Import", state: "error" as const, enabled: true, error: "Linear plugin failed" }],
      action: "Manage",
    },
    {
      state: "installed-started" as const,
      entry: {
        id: "fusion-plugin-linear-import",
        name: "Linear Import",
        description: "Browse Linear issues and import selected issues as Fusion triage tasks through plugin-owned settings.",
        version: "0.1.0",
        author: "Fusion",
        category: "integration" as const,
        path: "./plugins/fusion-plugin-linear-import",
        tags: ["linear", "import", "issues", "dashboard"],
        installed: true,
        installedVersion: "0.1.0",
        state: "started" as const,
        canInstall: true,
      },
      installed: [{ ...installedPlugin, id: "fusion-plugin-linear-import", name: "Linear Import", state: "started" as const, enabled: true }],
      action: "Manage",
    },
  ])("shows Linear Import registry action for $state", async ({ entry, installed, action }) => {
    await renderRegistry([entry], installed);

    const section = screen.getByRole("region", { name: "Browse Registry" });
    const linear = within(section).getByText("Linear Import").closest(".plugin-registry-item") as HTMLElement;
    expect(linear).toBeInTheDocument();
    expect(within(linear).getByText("Browse Linear issues and import selected issues as Fusion triage tasks through plugin-owned settings.")).toBeInTheDocument();
    expect(within(linear).getByText("integration")).toBeInTheDocument();
    expect(within(linear).getByRole("button", { name: action })).toBeInTheDocument();
    expect(within(section).getAllByText("Linear Import")).toHaveLength(1);
  });

  it("installs registry plugins with their manifest path and refreshes installed plugins", async () => {
    await renderRegistry();
    expect(fetchPlugins).toHaveBeenCalledTimes(1);

    const installable = screen.getByText("Installable Registry").closest(".plugin-registry-item") as HTMLElement;
    fireEvent.click(within(installable).getByRole("button", { name: "Install" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(installPlugin).toHaveBeenCalledWith({ path: "./plugins/registry-installable" }, undefined);
    expect(fetchPlugins).toHaveBeenCalledTimes(2);
  });

  it("surfaces install rejection without unmounting registry results", async () => {
    vi.mocked(installPlugin).mockRejectedValueOnce(new Error("install rejected"));
    await renderRegistry();

    const installable = screen.getByText("Installable Registry").closest(".plugin-registry-item") as HTMLElement;
    const installButton = within(installable).getByRole("button", { name: "Install" });
    fireEvent.click(installButton);
    expect(within(installable).getByRole("button", { name: "Installing..." })).toBeDisabled();

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(addToast).toHaveBeenCalledWith(expect.stringContaining("install rejected"), "error");
    expect(screen.getByRole("region", { name: "Browse Registry" })).toBeInTheDocument();
    expect(screen.getByText("Installable Registry")).toBeInTheDocument();
    expect(within(installable).getByRole("button", { name: "Install" })).toBeEnabled();

    const searchInput = screen.getByPlaceholderText("Search registry plugins");
    fireEvent.change(searchInput, { target: { value: "still interactive" } });
    expect(searchInput).toHaveValue("still interactive");
  });

  it("opens detail management for installed entries", async () => {
    await renderRegistry();

    const section = screen.getByRole("region", { name: "Browse Registry" });
    const installed = within(section).getByText("Installed Registry").closest(".plugin-registry-item") as HTMLElement;
    fireEvent.click(within(installed).getByRole("button", { name: "Manage" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchPluginSettings).toHaveBeenCalledWith("registry-installed", undefined);
  });

  it("debounces search before fetching registry results", async () => {
    await renderRegistry();
    vi.mocked(fetchPluginRegistry).mockClear();

    fireEvent.change(screen.getByPlaceholderText("Search registry plugins"), { target: { value: "slack" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(fetchPluginRegistry).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchPluginRegistry).toHaveBeenCalledWith("slack", undefined, undefined);
  });

  it("filters registry results by selected category", async () => {
    await renderRegistry();
    vi.mocked(fetchPluginRegistry).mockImplementation(async (_query, category) => (
      category ? registryEntries.filter((entry) => entry.category === category) : registryEntries
    ));
    vi.mocked(fetchPluginRegistry).mockClear();

    fireEvent.change(screen.getByLabelText("Registry category"), { target: { value: "runtime" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const section = screen.getByRole("region", { name: "Browse Registry" });
    expect(fetchPluginRegistry).toHaveBeenLastCalledWith("", "runtime", undefined);
    expect(within(section).getByText("Installed Registry")).toBeInTheDocument();
    expect(within(section).queryByText("Installable Registry")).not.toBeInTheDocument();
    expect(within(section).queryByText("Coming Soon Registry")).not.toBeInTheDocument();
  });

  it("clears category filtering when All Categories is selected", async () => {
    await renderRegistry();
    vi.mocked(fetchPluginRegistry).mockImplementation(async (_query, category) => (
      category ? registryEntries.filter((entry) => entry.category === category) : registryEntries
    ));
    vi.mocked(fetchPluginRegistry).mockClear();

    const categorySelect = screen.getByLabelText("Registry category");
    fireEvent.change(categorySelect, { target: { value: "runtime" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.change(categorySelect, { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const section = screen.getByRole("region", { name: "Browse Registry" });
    expect(fetchPluginRegistry).toHaveBeenLastCalledWith("", undefined, undefined);
    expect(within(section).getByText("Installable Registry")).toBeInTheDocument();
    expect(within(section).getByText("Installed Registry")).toBeInTheDocument();
    expect(within(section).getByText("Coming Soon Registry")).toBeInTheDocument();
  });

  it("combines category filtering with the registry search query", async () => {
    await renderRegistry();
    vi.mocked(fetchPluginRegistry).mockClear();

    const searchInput = screen.getByPlaceholderText("Search registry plugins");
    const categorySelect = screen.getByLabelText("Registry category");

    fireEvent.change(searchInput, { target: { value: "whatsapp" } });
    fireEvent.change(categorySelect, { target: { value: "integration" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchPluginRegistry).toHaveBeenLastCalledWith("whatsapp", "integration", undefined);

    fireEvent.change(categorySelect, { target: { value: "runtime" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchPluginRegistry).toHaveBeenLastCalledWith("whatsapp", "runtime", undefined);
  });

  it("debounces category changes before fetching registry results", async () => {
    await renderRegistry();
    vi.mocked(fetchPluginRegistry).mockClear();

    fireEvent.change(screen.getByLabelText("Registry category"), { target: { value: "integration" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(fetchPluginRegistry).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchPluginRegistry).toHaveBeenLastCalledWith("", "integration", undefined);
  });

  it("shows loading state while registry fetch is pending", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([]);
    vi.mocked(fetchPluginRegistry).mockReturnValue(new Promise(() => undefined));

    render(<PluginManager addToast={addToast} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Loading registry...")).toBeInTheDocument();
  });

  it("shows error state with retry action", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([]);
    vi.mocked(fetchPluginRegistry)
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce(registryEntries);

    render(<PluginManager addToast={addToast} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("registry unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchPluginRegistry).toHaveBeenCalledTimes(2);
  });

  it("renders very long registry metadata inside the registry item container", async () => {
    const longName = `Very Long Registry Plugin ${"Name".repeat(140)}`;
    const longDescription = `Description ${"with lengthy details ".repeat(40)}`;
    await renderRegistry([
      {
        id: "registry-long-metadata",
        name: longName,
        description: longDescription,
        version: "9.9.9",
        author: "Fusion Labs",
        category: "integration",
        path: "./plugins/registry-long-metadata",
        installed: false,
        canInstall: true,
      },
    ]);

    const item = screen.getByText(longName).closest(".plugin-registry-item") as HTMLElement;
    expect(item).toBeInTheDocument();
    expect(item).toHaveClass("plugin-registry-item");
    expect(within(item).getByText(longName)).toBeInTheDocument();
    expect(item).toHaveTextContent(longDescription.trim());
  });

  it("renders registry browsing controls at narrow viewport widths", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    window.dispatchEvent(new Event("resize"));

    await renderRegistry();

    const section = screen.getByRole("region", { name: "Browse Registry" });
    expect(within(section).getByLabelText("Registry category")).toBeInTheDocument();
    expect(within(section).getByPlaceholderText("Search registry plugins")).toBeInTheDocument();
    expect(within(section).getByLabelText("Registry plugin results")).toBeInTheDocument();
    expect(within(section).getByText("Installable Registry")).toBeInTheDocument();
  });

  it("shows empty state when no registry entries match", async () => {
    await renderRegistry([]);

    expect(screen.getByText("No registry plugins are available.")).toBeInTheDocument();
  });
});

describe("PluginManager registry CSS", () => {
  it("defines base registry rules with design tokens", () => {
    const css = loadAllAppCssBaseOnly();
    expect(css).toContain(".plugin-registry-section");
    expect(css).toContain(".plugin-registry-item");
    expect(css).toContain(".plugin-registry-search-input:focus-visible");
    expect(css).toContain("var(--focus-ring-strong)");

    const registryCss = Array.from(css.matchAll(/\.plugin-registry[^{}]*\{[^}]*\}/g))
      .map((match) => match[0])
      .join("\n");
    expect(registryCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(registryCss).not.toMatch(/rgba?\(/);
    expect(registryCss).not.toMatch(/\b(?!0\b)\d+px\b/);
  });

  it("defines responsive registry overrides", () => {
    const css = loadAllAppCss();
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.plugin-registry-item[\s\S]*flex-direction: column/);
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.plugin-registry-controls[\s\S]*flex-direction: column/);
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.plugin-registry-action,[\s\S]*\.plugin-registry-retry[\s\S]*min-height: 36px/);
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.plugin-registry-list[\s\S]*overflow-y: auto/);
  });
});
