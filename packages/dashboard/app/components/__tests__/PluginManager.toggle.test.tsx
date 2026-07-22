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
    addEventListener: vi.fn(),
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
});

afterEach(() => {
  cleanup();
  document.querySelector('[data-test-id="all-app-css"]')?.remove();
  vi.restoreAllMocks();
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
 * FNXC:PluginManager 2026-07-07-00:00:
 * FN-7629 — regression coverage for the durable built-in runtime enable/disable control.
 * Symptom: with no plugin_installs row for Hermes/Paperclip/OpenClaw/Droid (fetchPlugins -> []),
 * the built-in runtime rows dead-ended at a static "Built-in metadata only"/install-only CTA and
 * offered no way to disable the runtime. Assert every runtime built-in exposes an interactive
 * toggle in every data state, and clicking disable on a not-installed runtime persists via
 * installPlugin + disablePlugin (the durable register-then-disable path).
 */
describe("PluginManager built-in runtime enable/disable toggle (FN-7629)", () => {
  const RUNTIME_BUILTINS = BUILTIN_PLUGINS.filter((p) => p.category === "runtime");

  async function builtinSection() {
    return within(await screen.findByLabelText("Built-in plugin recommendations"));
  }

  it("renders an interactive, checked toggle for every runtime built-in when not installed", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([]);

    render(<PluginManager addToast={addToast} />);
    const section = await builtinSection();

    for (const runtime of RUNTIME_BUILTINS) {
      const toggle = await section.findByRole("checkbox", { name: `Disable ${runtime.name}` });
      expect(toggle).toBeChecked();
      expect(toggle.closest("label.toggle-switch")).not.toBeNull();
    }

    // No dead-end "Built-in metadata only" label for any runtime built-in row
    // (the metadata-only dead-end may still legitimately appear for non-runtime
    // built-ins like Agent Browser, which this task does not change).
    for (const runtime of RUNTIME_BUILTINS) {
      const row = section.getByText(runtime.name).closest(".plugin-builtins-item") as HTMLElement;
      expect(within(row).queryByText("Built-in metadata only")).not.toBeInTheDocument();
    }
  });

  it("disabling a not-installed runtime built-in registers it then disables it (durable path)", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([]);
    vi.mocked(installPlugin).mockResolvedValue(builtinPlugin("fusion-plugin-hermes-runtime", true));

    render(<PluginManager addToast={addToast} />);

    const toggle = await (await builtinSection()).findByRole("checkbox", { name: "Disable Hermes Runtime" });
    await userEvent.click(toggle.closest("label.toggle-switch") as HTMLLabelElement);

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith({ path: "./plugins/fusion-plugin-hermes-runtime" }, undefined);
    });
    await waitFor(() => {
      expect(disablePlugin).toHaveBeenCalledWith("fusion-plugin-hermes-runtime", undefined);
    });
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

  it("toggles an installed, disabled runtime built-in back on via the standard enable path", async () => {
    vi.mocked(fetchPlugins).mockResolvedValue([builtinPlugin("fusion-plugin-openclaw-runtime", false)]);

    render(<PluginManager addToast={addToast} />);

    const toggle = await (await builtinSection()).findByRole("checkbox", { name: "Enable OpenClaw Runtime" });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle.closest("label.toggle-switch") as HTMLLabelElement);

    await waitFor(() => {
      expect(enablePlugin).toHaveBeenCalledWith("fusion-plugin-openclaw-runtime", undefined);
    });
  });
});
