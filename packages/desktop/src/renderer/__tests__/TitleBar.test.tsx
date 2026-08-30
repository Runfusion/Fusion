// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopWrapper } from "../components/DesktopWrapper";
import { TitleBar } from "../components/TitleBar";

const titleBarCss = readFileSync(resolve(import.meta.dirname, "../components/TitleBar.css"), "utf8");

describe("TitleBar", () => {
  beforeEach(() => {
    (globalThis.window as Window & { electronAPI?: unknown }).electronAPI = {
      windowControl: vi.fn(async (action: string) => action === "isMaximized" ? false : undefined),
      getPlatform: vi.fn().mockResolvedValue("win32"),
    };
  });

  afterEach(() => {
    cleanup();
    (globalThis.window as Window & { electronAPI?: unknown }).electronAPI = undefined;
    vi.clearAllMocks();
  });

  it("renders the Fusion title", () => {
    render(<TitleBar />);

    expect(screen.getByText("Fusion")).toBeTruthy();
  });

  it("calls window controls through electronAPI", () => {
    render(<TitleBar />);

    const api = (globalThis.window as Window & {
      electronAPI: { windowControl: ReturnType<typeof vi.fn> };
    }).electronAPI;

    fireEvent.click(screen.getByTestId("titlebar-minimize"));
    fireEvent.click(screen.getByTestId("titlebar-maximize"));
    fireEvent.click(screen.getByTestId("titlebar-close"));

    expect(api.windowControl).toHaveBeenCalledWith("minimize");
    expect(api.windowControl).toHaveBeenCalledWith("maximize");
    expect(api.windowControl).toHaveBeenCalledWith("close");
  });

  it("applies drag region on the title bar", () => {
    render(<TitleBar />);

    const titlebar = screen.getByTestId("desktop-titlebar");
    expect(titlebar.className).toContain("desktop-titlebar--drag");
  });

  it("keeps dashboard content outside the native drag region at narrow widths", () => {
    render(
      <DesktopWrapper>
        <button type="button">Dashboard action</button>
      </DesktopWrapper>,
    );

    expect(screen.getByRole("button", { name: "Dashboard action" }).closest(".desktop-app-content")).not.toBeNull();
    expect(titleBarCss).toMatch(/\.desktop-app-content\s*\{[^}]*-webkit-app-region:\s*no-drag;/s);
  });

  it("double-click toggles maximize", () => {
    render(<TitleBar />);

    const titlebar = screen.getByTestId("desktop-titlebar");
    const api = (globalThis.window as Window & {
      electronAPI: { windowControl: ReturnType<typeof vi.fn> };
    }).electronAPI;

    fireEvent.doubleClick(titlebar);

    expect(api.windowControl).toHaveBeenCalledWith("maximize");
  });
});
