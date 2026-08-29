// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopModeChooser } from "../components/DesktopModeChooser";

describe("DesktopModeChooser", () => {
  afterEach(() => {
    cleanup();
  });
  it("submits local selection", async () => {
    const onSelectMode = vi.fn(async () => undefined);
    render(<DesktopModeChooser onSelectMode={onSelectMode} />);

    fireEvent.click(screen.getByText("Continue with Local Fusion"));

    await waitFor(() => {
      expect(onSelectMode).toHaveBeenCalledWith("local");
    });
  });

  it("submits remote selection", async () => {
    const onSelectMode = vi.fn(async () => undefined);
    render(<DesktopModeChooser onSelectMode={onSelectMode} />);

    fireEvent.click(screen.getByText("Continue to Remote Connection"));

    await waitFor(() => {
      expect(onSelectMode).toHaveBeenCalledWith("remote");
    });
  });
});
