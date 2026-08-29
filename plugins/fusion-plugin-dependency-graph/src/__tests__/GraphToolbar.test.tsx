import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GraphToolbar } from "../GraphToolbar";

describe("GraphToolbar", () => {
  afterEach(() => {
    cleanup();
  });
  it("renders controls and zoom percent", () => {
    render(
      <GraphToolbar
        zoom={1.25}
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
        onFitToGraph={vi.fn()}
        onResetView={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fit to graph" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset view" })).toBeTruthy();
    expect(screen.getByText("125%")).toBeTruthy();
  });

  it("fires callbacks", () => {
    const onZoomIn = vi.fn();
    const onZoomOut = vi.fn();
    const onFitToGraph = vi.fn();
    const onResetView = vi.fn();

    render(
      <GraphToolbar
        zoom={1}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onFitToGraph={onFitToGraph}
        onResetView={onResetView}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit to graph" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));

    expect(onZoomIn).toHaveBeenCalledOnce();
    expect(onZoomOut).toHaveBeenCalledOnce();
    expect(onFitToGraph).toHaveBeenCalledOnce();
    expect(onResetView).toHaveBeenCalledOnce();
  });

  it("applies toolbar class", () => {
    render(
      <GraphToolbar zoom={1} onZoomIn={vi.fn()} onZoomOut={vi.fn()} onFitToGraph={vi.fn()} onResetView={vi.fn()} />,
    );
    expect(screen.getByTestId("graph-toolbar").className).toContain("graph-toolbar");
  });
});
