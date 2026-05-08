import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PluginManager } from "../PluginManager";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../api", () => ({
  fetchPlugins: vi.fn(() => Promise.resolve([])),
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

import { fetchPlugins, disablePlugin } from "../../api";

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
  const MockES = vi.fn(() => esInstance) as unknown as typeof EventSource;
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
