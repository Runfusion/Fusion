import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, SVGProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { DevServerLogViewer } from "../DevServerLogViewer";
import type { DevServerLogEntry } from "../../hooks/useDevServerLogs";

vi.mock("lucide-react", () => ({
  Maximize2: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-maximize" {...props} />,
  Minimize2: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-minimize" {...props} />,
  Loader2: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-loader" {...props} />,
  Search: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-search" {...props} />,
  ChevronDown: (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon-chevrondown" {...props} />,
}));

function createEntry(overrides: Partial<DevServerLogEntry>): DevServerLogEntry {
  return {
    id: 1,
    text: "line",
    stream: "stdout",
    timestamp: "2026-04-19T10:30:00Z",
    ...overrides,
  };
}

function renderViewer(overrides: Partial<ComponentProps<typeof DevServerLogViewer>> = {}) {
  const onLoadMore = vi.fn();

  const result = render(
    <DevServerLogViewer
      entries={[]}
      loading={false}
      loadingMore={false}
      hasMore={false}
      total={0}
      onLoadMore={onLoadMore}
      isRunning={false}
      {...overrides}
    />,
  );

  return {
    ...result,
    onLoadMore,
  };
}

describe("DevServerLogViewer", () => {
  it("renders log entries with text content", () => {
    renderViewer({
      entries: [
        createEntry({ id: 1, text: "line 1" }),
        createEntry({ id: 2, text: "line 2" }),
        createEntry({ id: 3, text: "line 3" }),
      ],
      total: 3,
    });

    expect(screen.getByText("line 1")).toBeInTheDocument();
    expect(screen.getByText("line 2")).toBeInTheDocument();
    expect(screen.getByText("line 3")).toBeInTheDocument();
  });

  it("renders timestamps", () => {
    renderViewer({
      entries: [createEntry({ id: 1, timestamp: "2026-04-19T10:30:00Z" })],
      total: 1,
    });

    const timestamp = screen.getByTestId("devserver-log-timestamp");
    expect(timestamp.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("renders stderr badge for stderr entries", () => {
    renderViewer({
      entries: [
        createEntry({ id: 1, text: "stdout line", stream: "stdout" }),
        createEntry({ id: 2, text: "stderr line", stream: "stderr" }),
      ],
      total: 2,
    });

    expect(screen.getByText("stderr line")).toBeInTheDocument();
    expect(screen.getByTestId("devserver-log-stderr-badge")).toBeInTheDocument();
    expect(screen.getAllByText("ERR")).toHaveLength(1);
  });

  it("shows loading spinner when loading and empty", () => {
    renderViewer({ loading: true, entries: [] });

    expect(screen.getByTestId("devserver-log-loading")).toBeInTheDocument();
    expect(screen.getByTestId("icon-loader")).toBeInTheDocument();
  });

  it("shows empty state when not loading and no entries", () => {
    renderViewer({ loading: false, entries: [] });

    expect(screen.getByText("No logs yet. Start the dev server to see output.")).toBeInTheDocument();
  });

  it("strips ANSI escape codes from display", () => {
    renderViewer({
      entries: [createEntry({ id: 1, text: "\u001b[32mSuccess\u001b[0m done" })],
      total: 1,
    });

    expect(screen.getByText("Success done")).toBeInTheDocument();
    expect(screen.queryByText("\u001b[32mSuccess\u001b[0m done")).not.toBeInTheDocument();
  });

  it("calls onLoadMore when clicking Load older logs", () => {
    const { onLoadMore } = renderViewer({
      entries: [createEntry({ id: 1, text: "line" })],
      hasMore: true,
      total: 100,
    });

    fireEvent.click(screen.getByRole("button", { name: "Load older logs" }));

    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("toggles fullscreen class", () => {
    renderViewer({ entries: [createEntry({ id: 1, text: "line" })], total: 1 });

    const container = screen.getByTestId("devserver-log-viewer");

    fireEvent.click(screen.getByTestId("devserver-log-fullscreen-toggle"));
    expect(container).toHaveClass("devserver-log-viewer--fullscreen");

    fireEvent.click(screen.getByTestId("devserver-log-fullscreen-toggle"));
    expect(container).not.toHaveClass("devserver-log-viewer--fullscreen");
  });

  it("auto-scrolls when new entries arrive while running", async () => {
    const { rerender } = renderViewer({
      entries: [createEntry({ id: 1, text: "line 1" })],
      isRunning: true,
      total: 1,
    });

    const content = screen.getByTestId("devserver-log-content");

    let scrollTopValue = 0;
    const scrollTopSetter = vi.fn((value: number) => {
      scrollTopValue = value;
    });

    Object.defineProperty(content, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: scrollTopSetter,
    });
    Object.defineProperty(content, "scrollHeight", {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(content, "clientHeight", {
      configurable: true,
      get: () => 200,
    });

    rerender(
      <DevServerLogViewer
        entries={[
          createEntry({ id: 1, text: "line 1" }),
          createEntry({ id: 2, text: "line 2" }),
        ]}
        loading={false}
        loadingMore={false}
        hasMore={false}
        total={2}
        onLoadMore={vi.fn()}
        isRunning
      />,
    );

    await waitFor(() => {
      expect(scrollTopSetter).toHaveBeenCalled();
    });
  });
});
