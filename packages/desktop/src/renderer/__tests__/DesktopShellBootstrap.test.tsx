// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopShellBootstrap } from "../components/DesktopShellBootstrap";

function TestDashboardApp() {
  return <div data-testid="dashboard-app">Dashboard</div>;
}

describe("DesktopShellBootstrap", () => {
  beforeEach(() => {
    (globalThis.window as Window & { fusionShell?: unknown; electronAPI?: unknown }).electronAPI = {};
  });

  afterEach(() => {
    cleanup();
  });

  it("renders chooser on first run", async () => {
    (globalThis.window as Window & { fusionShell?: unknown }).fusionShell = {
      getDesktopModeState: vi.fn(async () => ({ isFirstRun: true, desktopMode: null })),
      setDesktopMode: vi.fn(async () => undefined),
    };

    render(<DesktopShellBootstrap DashboardApp={TestDashboardApp} />);

    await waitFor(() => {
      expect(screen.getByTestId("desktop-mode-chooser")).toBeTruthy();
    });
  });

  it("promotes first-run local selection into dashboard mount", async () => {
    const setDesktopMode = vi.fn(async () => undefined);
    (globalThis.window as Window & { fusionShell?: unknown }).fusionShell = {
      getDesktopModeState: vi.fn(async () => ({ isFirstRun: true, desktopMode: null })),
      setDesktopMode,
    };

    render(<DesktopShellBootstrap DashboardApp={TestDashboardApp} />);

    await waitFor(() => {
      expect(screen.getByTestId("desktop-mode-chooser")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Continue with Local Fusion"));

    await waitFor(() => {
      expect(setDesktopMode).toHaveBeenCalledWith("local");
      expect(screen.getByTestId("dashboard-app")).toBeTruthy();
    });
  });

  it("renders dashboard in local mode", async () => {
    (globalThis.window as Window & { fusionShell?: unknown }).fusionShell = {
      getDesktopModeState: vi.fn(async () => ({ isFirstRun: false, desktopMode: "local" })),
      setDesktopMode: vi.fn(async () => undefined),
    };

    render(<DesktopShellBootstrap DashboardApp={TestDashboardApp} />);

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-app")).toBeTruthy();
    });
  });

  it("renders dashboard app in remote mode so shell onboarding can open", async () => {
    (globalThis.window as Window & { fusionShell?: unknown }).fusionShell = {
      getDesktopModeState: vi.fn(async () => ({ isFirstRun: false, desktopMode: "remote" })),
      setDesktopMode: vi.fn(async () => undefined),
    };

    render(<DesktopShellBootstrap DashboardApp={TestDashboardApp} />);

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-app")).toBeTruthy();
    });
  });
});
