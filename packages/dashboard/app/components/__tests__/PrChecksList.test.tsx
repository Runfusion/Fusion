import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PrChecksList } from "../PrChecksList";
import { loadAllAppCss } from "../../test/cssFixture";

describe("PrChecksList", () => {
  it("orders failing checks first", () => {
    render(
      <PrChecksList
        checks={[
          { name: "pass", required: true, state: "success" },
          { name: "pending", required: true, state: "pending" },
          { name: "fail", required: true, state: "failure" },
        ]}
        rollup="failure"
        loading={false}
        onRefresh={() => {}}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("fail");
  });

  it("FN-5012: no mobile .btn overrides; failing details link uses component classes", () => {
    const css = loadAllAppCss();
    const mediaBlocks = Array.from(css.matchAll(/@media[^{]*\(max-width: 768px\)[^{]*\{([\s\S]*?)\n\}/g), (match) => match[1]);
    const prChecksMobileBlock = mediaBlocks.find((block) => block.includes(".pr-checks__item"));
    expect(prChecksMobileBlock).toBeTruthy();
    expect(prChecksMobileBlock).not.toMatch(/\.(btn|btn-sm|btn-icon|btn-primary|btn-danger|btn-warning|modal-close)\b/);

    render(
      <PrChecksList
        checks={[{ name: "fail", required: true, state: "failure", detailsUrl: "https://example.com/details" }]}
        rollup="failure"
        loading={false}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText("0 passing, 1 failing, 0 pending")).toBeInTheDocument();
    const detailsLink = screen.getByRole("link", { name: /View details/i });
    expect(detailsLink).toHaveAttribute("href", "https://example.com/details");
    expect(detailsLink).toHaveClass("pr-checks__details-link", "pr-checks__details-link--failing");
    expect(detailsLink).not.toHaveClass("btn", "btn-sm");
  });

  it("FN-5024: wires focus-visible ring token to refresh/retry/details controls", () => {
    const css = loadAllAppCss();
    expect(css).toContain(".pr-checks__header-actions .btn:focus-visible");
    expect(css).toContain(".pr-checks__error .btn:focus-visible");
    expect(css).toContain(".pr-checks__details-link:focus-visible");
    expect(css).toContain("box-shadow: var(--focus-ring-strong);");
  });

  it("shows empty state", () => {
    render(<PrChecksList checks={[]} rollup="unknown" loading={false} onRefresh={() => {}} />);
    expect(screen.getByText("No checks reported yet")).toBeInTheDocument();
  });

  it("shows error state and retry", () => {
    const onRefresh = vi.fn();
    render(<PrChecksList checks={[]} rollup="unknown" loading={false} error="nope" onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("refresh button triggers onRefresh", () => {
    const onRefresh = vi.fn();
    render(<PrChecksList checks={[]} rollup="unknown" loading={false} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh checks" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
