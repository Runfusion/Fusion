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

async function renderRegistry(entries: RegistryPluginEntry[] = registryEntries) {
  vi.mocked(fetchPlugins).mockResolvedValue([installedPlugin]);
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
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.plugin-registry-action,[\s\S]*\.plugin-registry-retry[\s\S]*min-height: 36px/);
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.plugin-registry-list[\s\S]*overflow-y: auto/);
  });
});
