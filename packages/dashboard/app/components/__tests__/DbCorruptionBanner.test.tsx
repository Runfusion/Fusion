import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DbCorruptionBanner } from "../DbCorruptionBanner";

describe("DbCorruptionBanner", () => {
  it("renders errors and last-checked timestamp", () => {
    render(
      <DbCorruptionBanner
        errors={["bad row", "bad index"]}
        lastCheckedAt="2026-05-20T00:05:00.000Z"
        onRefresh={() => undefined}
        refreshing={false}
        refreshError={null}
      />,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Database health check failed")).toBeInTheDocument();
    expect(screen.getByText(/Last checked:/)).toBeInTheDocument();
    expect(screen.getByText("bad row")).toBeInTheDocument();
    expect(screen.getByText("bad index")).toBeInTheDocument();
    expect(screen.getByText(/PostgreSQL health check reported a failure/)).toBeInTheDocument();
    expect(screen.getByText("database logs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "docs/storage.md" })).toHaveAttribute("href", "docs/storage.md");
    expect(screen.queryByText(/\[object Object\]|\{\{link\}\}/)).not.toBeInTheDocument();
  });

  it("calls onRefresh when the button is clicked", () => {
    const onRefresh = vi.fn();
    render(
      <DbCorruptionBanner
        errors={["bad row"]}
        lastCheckedAt={null}
        onRefresh={onRefresh}
        refreshing={false}
        refreshError={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh health" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when there are no errors", () => {
    const { container } = render(
      <DbCorruptionBanner
        errors={[]}
        lastCheckedAt={null}
        onRefresh={() => undefined}
        refreshing={false}
        refreshError={null}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
