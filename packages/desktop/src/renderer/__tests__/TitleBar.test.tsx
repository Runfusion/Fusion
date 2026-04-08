// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "../components/TitleBar";

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
