import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { IssueMentionPopup } from "../IssueMentionPopup";
import type { IssueMentionItem } from "../../api";

describe("IssueMentionPopup", () => {
  const defaultProps = {
    visible: true,
    position: { top: 100, left: 20 },
    issues: [] as IssueMentionItem[],
    selectedIndex: 0,
    onSelect: vi.fn(),
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders rows and selected state", () => {
    const issues: IssueMentionItem[] = [
      { number: 42, title: "Fix bug", state: "open", htmlUrl: "https://x/42", repository: "o/r" },
      { number: 7, title: "Closed item", state: "closed", htmlUrl: "https://x/7", repository: "o/r" },
    ];

    render(<IssueMentionPopup {...defaultProps} issues={issues} selectedIndex={1} />);

    const items = screen.getAllByRole("option");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveClass("issue-mention-popup-item--selected");
  });

  it("calls onSelect on click", () => {
    const issue: IssueMentionItem = {
      number: 42,
      title: "Fix bug",
      state: "open",
      htmlUrl: "https://x/42",
      repository: "o/r",
    };

    const onSelect = vi.fn();
    render(<IssueMentionPopup {...defaultProps} issues={[issue]} onSelect={onSelect} />);

    screen.getByRole("option").click();
    expect(onSelect).toHaveBeenCalledWith(issue);
  });

  it("renders loading and empty states", () => {
    const { rerender } = render(<IssueMentionPopup {...defaultProps} loading />);
    expect(screen.getByTestId("issue-mention-loading")).toBeInTheDocument();

    rerender(<IssueMentionPopup {...defaultProps} loading={false} issues={[]} />);
    expect(screen.getByTestId("issue-mention-empty")).toBeInTheDocument();
  });
});
