import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataBoundary } from "../DataBoundary";

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="alert-icon">⚠</span>,
  Bot: () => <span data-testid="bot-icon">🤖</span>,
  Folder: () => <span data-testid="folder-icon">📁</span>,
  Activity: () => <span data-testid="activity-icon">📊</span>,
  CheckCircle: () => <span data-testid="check-icon">✓</span>,
}));

describe("DataBoundary", () => {
  it("renders the loading fallback before the first fetch completes", () => {
    render(
      <DataBoundary
        isEmpty={false}
        hasFetched={false}
        isLoading={false}
        loadingFallback={<div data-testid="loading-fallback">Loading</div>}
      >
        <div>Loaded content</div>
      </DataBoundary>
    );

    expect(screen.getByTestId("loading-fallback")).toBeDefined();
    expect(screen.queryByText("Loaded content")).toBeNull();
  });

  it("renders an empty state after fetch completion instead of an infinite skeleton", () => {
    render(
      <DataBoundary isEmpty hasFetched isLoading={false}>
        <div>Loaded content</div>
      </DataBoundary>
    );

    expect(screen.getByText("No data available")).toBeDefined();
    expect(screen.queryByText("Loaded content")).toBeNull();
  });

  it("renders an error state when error is set", () => {
    render(
      <DataBoundary isEmpty hasFetched={false} error={new Error("Boom")}>
        <div>Loaded content</div>
      </DataBoundary>
    );

    expect(screen.getByTestId("data-boundary-error")).toBeDefined();
    expect(screen.getByText("Boom")).toBeDefined();
  });

  it("renders children when data is present", () => {
    render(
      <DataBoundary isEmpty={false} hasFetched>
        <div>Loaded content</div>
      </DataBoundary>
    );

    expect(screen.getByText("Loaded content")).toBeDefined();
    expect(screen.queryByText("No data available")).toBeNull();
  });
});
