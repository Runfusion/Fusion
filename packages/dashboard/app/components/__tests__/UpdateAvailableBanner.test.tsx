import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { UpdateAvailableBanner } from "../UpdateAvailableBanner";

describe("UpdateAvailableBanner", () => {
  it("renders version information with release notes and learn more links", () => {
    render(
      <UpdateAvailableBanner latestVersion="0.7.0" currentVersion="0.6.0" onDismiss={vi.fn()} />,
    );

    expect(screen.getByText(/Update available: v0.7.0 \(current: v0.6.0\)/)).toBeInTheDocument();
    expect(screen.getByText("npm i -g @runfusion/fusion")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release notes" })).toHaveAttribute(
      "href",
      "https://github.com/Runfusion/Fusion/releases",
    );
    expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute("href", "https://runfusion.ai");
  });

  it("dismiss button calls onDismiss", () => {
    const onDismiss = vi.fn();

    render(
      <UpdateAvailableBanner latestVersion="0.7.0" currentVersion="0.6.0" onDismiss={onDismiss} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("can be hidden by parent on dismiss", () => {
    function Harness() {
      const [visible, setVisible] = useState(true);
      if (!visible) return null;
      return (
        <UpdateAvailableBanner
          latestVersion="0.7.0"
          currentVersion="0.6.0"
          onDismiss={() => setVisible(false)}
        />
      );
    }

    render(<Harness />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
