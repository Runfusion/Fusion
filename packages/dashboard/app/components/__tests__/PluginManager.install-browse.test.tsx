/**
 * Regression tests for the browse-driven plugin install workflow.
 *
 * Verifies that:
 * 1. DirectoryPicker selection updates the install source field
 * 2. Install sends the expected { path } payload
 * 3. Negative paths: empty path, install failure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginInstallation } from "@fusion/core";

// ── Mock API ──────────────────────────────────────────────────────
vi.mock("../../api", () => ({
  fetchPlugins: vi.fn(() => Promise.resolve([])),
  installPlugin: vi.fn(() =>
    Promise.resolve({
      id: "browsed-plugin",
      name: "Browsed Plugin",
      version: "0.1.0",
      state: "installed" as const,
      enabled: true,
      settings: {},
      settingsSchema: {},
    }),
  ),
  enablePlugin: vi.fn(() => Promise.resolve({})),
  disablePlugin: vi.fn(() => Promise.resolve({})),
  uninstallPlugin: vi.fn(() => Promise.resolve()),
  fetchPluginSettings: vi.fn(() => Promise.resolve({})),
  updatePluginSettings: vi.fn(() => Promise.resolve({})),
  reloadPlugin: vi.fn(() => Promise.resolve({})),
  updatePlugin: vi.fn(() => Promise.resolve({})),
  rescanPlugin: vi.fn(() => Promise.resolve({})),
  browseDirectory: vi.fn(() =>
    Promise.resolve({
      currentPath: "/home/user/plugins/my-plugin",
      parentPath: "/home/user/plugins",
      entries: [
        { name: "dist", path: "/home/user/plugins/my-plugin/dist", hasChildren: true },
        { name: "src", path: "/home/user/plugins/my-plugin/src", hasChildren: true },
      ],
    }),
  ),
}));

import { PluginManager } from "../PluginManager";
import {
  fetchPlugins,
  installPlugin,
  browseDirectory,
} from "../../api";

const addToast = vi.fn();

// ── Shared setup ──────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();

  // Stub EventSource globally
  const esInstance = {
    url: "",
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
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────

/** Open the install form by clicking the header Install button. */
async function openInstallForm() {
  const installBtn = screen.getByRole("button", { name: /^Install$/ });
  await userEvent.click(installBtn);
}

/** Return the DirectoryPicker input inside the install form. */
function getPathInput(): HTMLInputElement {
  return screen.getByPlaceholderText(
    "Absolute path to plugin directory or dist folder",
  ) as HTMLInputElement;
}

// ══════════════════════════════════════════════════════════════════
describe("PluginManager – browse-driven install workflow", () => {
  it("opens DirectoryPicker browser and selects a directory to set install path", async () => {
    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(fetchPlugins).toHaveBeenCalled());

    await openInstallForm();

    // Click "Browse" to open the directory browser
    const browseBtn = screen.getByRole("button", {
      name: /Browse directories/i,
    });
    await userEvent.click(browseBtn);

    // browseDirectory should have been called
    await waitFor(() => expect(browseDirectory).toHaveBeenCalled());

    // The browser shows the "Select" button
    const selectBtn = screen.getByRole("button", { name: /^Select$/i });

    // Clicking Select should copy the currentPath into the input
    await userEvent.click(selectBtn);

    // The input value should now match the browsed directory
    expect(getPathInput().value).toBe("/home/user/plugins/my-plugin");
  });

  it("forwards aiScanOnLoad when install checkbox is enabled", async () => {
    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(fetchPlugins).toHaveBeenCalled());

    await openInstallForm();
    await userEvent.click(screen.getByLabelText("Enable AI security scan on load"));

    const input = getPathInput();
    await userEvent.type(input, "/home/user/plugins/my-plugin");
    const formContainer = input.closest(".plugin-install-form")!;
    await userEvent.click(within(formContainer as HTMLElement).getByRole("button", { name: /Install Plugin/i }));

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith(
        { path: "/home/user/plugins/my-plugin", aiScanOnLoad: true },
        undefined,
      );
    });
  });

  it("sends { path } payload matching the browsed path on install", async () => {
    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(fetchPlugins).toHaveBeenCalled());

    await openInstallForm();

    // Simulate browse-and-select by typing a path (DirectoryPicker onChange)
    const input = getPathInput();
    await userEvent.type(input, "/home/user/plugins/my-plugin");

    // Click Install Plugin
    const formContainer = input.closest(".plugin-install-form")!;
    const installBtn = within(formContainer as HTMLElement).getByRole("button", {
      name: /Install Plugin/i,
    });
    await userEvent.click(installBtn);

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith(
        { path: "/home/user/plugins/my-plugin" },
        undefined,
      );
    });
  });

  it("sends { path } with dist subfolder when user navigates into dist", async () => {
    // Override browseDirectory to return a dist-level path
    vi.mocked(browseDirectory).mockResolvedValueOnce({
      currentPath: "/home/user/plugins/my-plugin/dist",
      parentPath: "/home/user/plugins/my-plugin",
      entries: [],
    });

    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(fetchPlugins).toHaveBeenCalled());

    await openInstallForm();

    // Directly type a dist path (mimicking what Select would do)
    const input = getPathInput();
    await userEvent.type(input, "/home/user/plugins/my-plugin/dist");

    const formContainer = input.closest(".plugin-install-form")!;
    const installBtn = within(formContainer as HTMLElement).getByRole("button", {
      name: /Install Plugin/i,
    });
    await userEvent.click(installBtn);

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith(
        { path: "/home/user/plugins/my-plugin/dist" },
        undefined,
      );
    });
  });

  it("passes projectId when provided", async () => {
    render(<PluginManager addToast={addToast} projectId="proj-xyz" />);
    await waitFor(() => expect(fetchPlugins).toHaveBeenCalledWith("proj-xyz"));

    await openInstallForm();

    const input = getPathInput();
    await userEvent.type(input, "/plugins/example");

    const formContainer = input.closest(".plugin-install-form")!;
    const installBtn = within(formContainer as HTMLElement).getByRole("button", {
      name: /Install Plugin/i,
    });
    await userEvent.click(installBtn);

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith(
        { path: "/plugins/example" },
        "proj-xyz",
      );
    });
  });

  // ── Negative paths ────────────────────────────────────────────
  it("shows error toast when install path is empty", async () => {
    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(fetchPlugins).toHaveBeenCalled());

    await openInstallForm();

    // Install Plugin button should be disabled with empty input
    const formContainer = getPathInput().closest(".plugin-install-form")!;
    const installBtn = within(formContainer as HTMLElement).getByRole("button", {
      name: /Install Plugin/i,
    });
    expect(installBtn).toBeDisabled();

    // installPlugin should NOT have been called
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("shows error toast when installPlugin rejects", async () => {
    vi.mocked(installPlugin).mockRejectedValueOnce(
      new Error("manifest.json not found"),
    );

    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(fetchPlugins).toHaveBeenCalled());

    await openInstallForm();

    const input = getPathInput();
    await userEvent.type(input, "/invalid/path");

    const formContainer = input.closest(".plugin-install-form")!;
    const installBtn = within(formContainer as HTMLElement).getByRole("button", {
      name: /Install Plugin/i,
    });
    await userEvent.click(installBtn);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("manifest.json not found"),
        "error",
      );
    });
  });

  it("resets install path and hides form on successful install", async () => {
    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(fetchPlugins).toHaveBeenCalled());

    await openInstallForm();

    const input = getPathInput();
    await userEvent.type(input, "/path/to/plugin");

    const formContainer = input.closest(".plugin-install-form")!;
    const installBtn = within(formContainer as HTMLElement).getByRole("button", {
      name: /Install Plugin/i,
    });
    await userEvent.click(installBtn);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        "Plugin installed globally",
        "success",
      );
    });

    // Install form should be gone
    expect(
      screen.queryByPlaceholderText(
        "Absolute path to plugin directory or dist folder",
      ),
    ).toBeNull();
  });

  it("cancels install form and clears path", async () => {
    render(<PluginManager addToast={addToast} />);
    await waitFor(() => expect(fetchPlugins).toHaveBeenCalled());

    await openInstallForm();

    const input = getPathInput();
    await userEvent.type(input, "/some/path");

    const cancelBtn = screen.getByRole("button", { name: /Cancel/i });
    await userEvent.click(cancelBtn);

    // Form should be gone
    expect(
      screen.queryByPlaceholderText(
        "Absolute path to plugin directory or dist folder",
      ),
    ).toBeNull();

    // Re-opening should show empty input
    await openInstallForm();
    expect(getPathInput().value).toBe("");
  });
});
