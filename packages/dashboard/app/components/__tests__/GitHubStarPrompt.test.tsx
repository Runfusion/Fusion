import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GITHUB_REPO_URL, GitHubStarPrompt } from "../GitHubStarPrompt";

describe("GitHubStarPrompt", () => {
  it("renders copy and handles star plus dismiss actions", () => {
    const onStar = vi.fn();
    const onDismiss = vi.fn();

    render(<GitHubStarPrompt onStar={onStar} onDismiss={onDismiss} />);

    expect(screen.getByText("Enjoying Fusion?")).toBeInTheDocument();
    expect(
      screen.getByText(
        /If Fusion has saved you time, a GitHub star goes a long way\. It helps other developers discover the project and keeps the team motivated to ship improvements\./,
      ),
    ).toBeInTheDocument();

    const starLink = screen.getByRole("link", { name: /star on github/i });
    expect(starLink).toHaveAttribute("href", GITHUB_REPO_URL);
    expect(starLink).toHaveAttribute("target", "_blank");
    expect(starLink).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.click(starLink);
    expect(onStar).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /dismiss github star prompt/i }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("dismisses even when no onStar callback is provided", () => {
    const onDismiss = vi.fn();

    render(<GitHubStarPrompt onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("link", { name: /star on github/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
