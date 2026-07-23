import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PluginManager } from "../PluginManager";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../api", () => ({
  fetchPlugins: vi.fn(() => Promise.resolve([])),
  fetchPluginRegistry: vi.fn(() => Promise.resolve([])),
  installPlugin: vi.fn(() => Promise.resolve({})),
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
  browseDirectory: vi.fn(() => Promise.resolve({ currentPath: "/", parentPath: null, entries: [] })),
}));

import { fetchPlugins, disablePlugin, enablePlugin, installPlugin } from "../../api";
import { BUILTIN_PLUGINS } from "../PluginManager";

const addToast = vi.fn();

function plugin(enabled: boolean) {
  return {
    id: "plugin-a",
    name: "Test Plugin A",
    version: "1.0.0",
    state: "started" as const,
    enabled,
    path: "/plugins/plugin-a",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-test-id", "all-app-css");
  styleEl.textContent = loadAllAppCss();
  document.head.appendChild(styleEl);

  const esInstance = {
    readyState: 1,
    close: vi.fn(),
    addEventListener: vi.fn((event: string, handler: (event: MessageEvent) => void) => {
      (esInstance as { handlers?: Record<string, (event: MessageEvent) => void> }).handlers ??= {};
      (esInstance as { handlers: Record<string, (event: MessageEvent) => void> }).handlers[event] = handler;
    }),
    removeEventListener: vi.fn(),
    onerror: null,
    onopen: null,
    onmessage: null,
  };
  const MockES = vi.fn(function MockEventSource() {
    return esInstance;
  }) as unknown as typeof EventSource;
  (MockES as unknown as { CONNECTING: number; OPEN: number; CLOSED: number }).CONNECTING = 0;
  (MockES as unknown as { CONNECTING: number; OPEN: number; CLOSED: number }).OPEN = 1;
  (MockES as unknown as { CONNECTING: number; OPEN: number; CLOSED: number }).CLOSED = 2;
  vi.stubGlobal("EventSource", MockES);
  (globalThis as { __testEventSourceInstance?: typeof esInstance }).__testEventSourceInstance = esInstance;
});

afterEach(() => {
  cleanup();
  document.querySelector('[data-test-id="all-app-css"]')?.remove();
  vi.restoreAllMocks();
  delete (globalThis as { __testEventSourceInstance?: unknown }).__testEventSourceInstance;
});

function builtinPlugin(id: string, enabled: boolean) {
  const builtin = BUILTIN_PLUGINS.find((p) => p.id === id)!;
  return {
    id: builtin.id,
    name: builtin.name,
    version: "1.0.0",
    state: "started" as const,
    enabled,
    path: builtin.path ?? "/plugins/unknown",
    settings: {},
    settingsSchema: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("PluginManager toggle switch", () => {
  it("keeps checkbox focusable but visually hidden", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([plugin(true)]);

    render(<PluginManager addToast={addToast} />);

    const checkbox = await screen.findByRole("checkbox", { name: "Disable Test Plugin A" });
    const styles = getComputedStyle(checkbox);

    expect(styles.position).toBe("absolute");
    expect(styles.opacity).toBe("0");
    expect(styles.pointerEvents).toBe("none");
  });

  it("toggles by clicking the label/slider control", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([plugin(true)]);

    render(<PluginManager addToast={addToast} />);

    const checkbox = await screen.findByRole("checkbox", { name: "Disable Test Plugin A" });
    const label = checkbox.closest("label.toggle-switch") as HTMLLabelElement;
    await userEvent.click(label);

    await waitFor(() => {
      expect(disablePlugin).toHaveBeenCalledWith("plugin-a", undefined);
    });
  });

  it("preserves the scoped enable response after a stale background refresh resolves", async () => {
    vi.mocked(fetchPlugins)
      .mockResolvedValueOnce([plugin(false)])
      // The confirmation request can return the original host-scoped false value.
      .mockResolvedValueOnce([plugin(false)]);
    vi.mocked(enablePlugin).mockResolvedValueOnce(plugin(true));

    render(<PluginManager addToast={addToast} projectId="project-p" />);

    const checkbox = await screen.findByRole("checkbox", { name: "Enable Test Plugin A" });
    await userEvent.click(checkbox.closest("label.toggle-switch") as HTMLLabelElement);

    await waitFor(() => {
      expect(enablePlugin).toHaveBeenCalledWith("plugin-a", "project-p");
      expect(fetchPlugins).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("checkbox", { name: "Disable Test Plugin A" })).toBeChecked();
    });
  });

  it("preserves the scoped disable response after a stale background refresh resolves", async () => {
    vi.mocked(fetchPlugins)
      .mockResolvedValueOnce([plugin(true)])
      // The reciprocal stale response must not re-enable a plugin just disabled for P.
      .mockResolvedValueOnce([plugin(true)]);
    vi.mocked(disablePlugin).mockResolvedValueOnce(plugin(false));

    render(<PluginManager addToast={addToast} projectId="project-p" />);

    const checkbox = await screen.findByRole("checkbox", { name: "Disable Test Plugin A" });
    await userEvent.click(checkbox.closest("label.toggle-switch") as HTMLLabelElement);

    await waitFor(() => {
      expect(disablePlugin).toHaveBeenCalledWith("plugin-a", "project-p");
      expect(fetchPlugins).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("checkbox", { name: "Enable Test Plugin A" })).not.toBeChecked();
    });
  });

  it("renders slider next to input and reflects enabled state", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([plugin(true)]);
    const first = render(<PluginManager addToast={addToast} />);

    const enabled = await screen.findByRole("checkbox", { name: "Disable Test Plugin A" });
    expect(enabled).toBeChecked();
    expect(enabled.nextElementSibling).toHaveClass("toggle-slider");

    first.unmount();

    vi.mocked(fetchPlugins).mockResolvedValue([plugin(false)]);
    render(<PluginManager addToast={addToast} />);

    const disabled = await screen.findByRole("checkbox", { name: "Enable Test Plugin A" });
    expect(disabled).not.toBeChecked();
    expect(disabled.nextElementSibling).toHaveClass("toggle-slider");
  });
});

/*
 * FNXC:PluginManager 2026-07-22-20:41:
 * FN-8521 prevents the post-uninstall toggle from re-registering a runtime. A missing
 * PluginInstallation has exactly one action (Install); only installed records expose toggles.
 */
describe("PluginManager built-in runtime install and enable controls (FN-8521)", () => {
  const RUNTIME_BUILTINS = BUILTIN_PLUGINS.filter((p) => p.category === "runtime");

  async function builtinSection() {
    return within(await screen.findByLabelText("Built-in plugin recommendations"));
  }

  it("shows every uninstalled runtime's Install action without a toggle or orphaned toggle shell", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([]);

    render(<PluginManager addToast={addToast} />);
    const section = await builtinSection();

    for (const runtime of RUNTIME_BUILTINS) {
      const row = section.getByText(runtime.name).closest(".plugin-builtins-item") as HTMLElement;
      expect(within(row).getByRole("button", { name: `Install ${runtime.name}` })).toBeVisible();
      expect(within(row).queryByRole("checkbox")).not.toBeInTheDocument();
      expect(row.querySelector("label.toggle-switch")).toBeNull();
      expect(row.querySelector(".toggle-slider")).toBeNull();
    }
  });

  it("uses Install as the only transition from an uninstalled runtime", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([]);

    render(<PluginManager addToast={addToast} />);
    const hermes = (await builtinSection()).getByText("Hermes Runtime").closest(".plugin-builtins-item") as HTMLElement;
    await userEvent.click(within(hermes).getByRole("button", { name: "Install Hermes Runtime" }));

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith({ path: "./plugins/fusion-plugin-hermes-runtime" }, undefined);
    });
    expect(disablePlugin).not.toHaveBeenCalled();
    expect(enablePlugin).not.toHaveBeenCalled();
  });

  it("toggles an installed, enabled runtime built-in via the standard disable path (no re-install)", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([builtinPlugin("fusion-plugin-paperclip-runtime", true)]);

    render(<PluginManager addToast={addToast} />);

    const toggle = await (await builtinSection()).findByRole("checkbox", { name: "Disable Paperclip Runtime" });
    await userEvent.click(toggle.closest("label.toggle-switch") as HTMLLabelElement);

    await waitFor(() => {
      expect(disablePlugin).toHaveBeenCalledWith("fusion-plugin-paperclip-runtime", undefined);
    });
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("toggles an installed, disabled runtime built-in back on via the standard enable path without installing", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([builtinPlugin("fusion-plugin-openclaw-runtime", false)]);

    render(<PluginManager addToast={addToast} />);

    const toggle = await (await builtinSection()).findByRole("checkbox", { name: "Enable OpenClaw Runtime" });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle.closest("label.toggle-switch") as HTMLLabelElement);

    await waitFor(() => {
      expect(enablePlugin).toHaveBeenCalledWith("fusion-plugin-openclaw-runtime", undefined);
    });
    expect(installPlugin).not.toHaveBeenCalled();
  });
});
