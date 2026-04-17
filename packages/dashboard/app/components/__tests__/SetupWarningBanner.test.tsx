import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SetupWarningBanner } from "../SetupWarningBanner";

describe("SetupWarningBanner", () => {
  it("returns null when both hasAiProvider and hasGithub are true", () => {
    const { container } = render(
      <SetupWarningBanner hasAiProvider hasGithub />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("shows AI provider warning when hasAiProvider is false and hasGithub is true", () => {
    render(<SetupWarningBanner hasAiProvider={false} hasGithub />);

    expect(screen.getByText("No AI provider connected")).toBeInTheDocument();
    expect(
      screen.getByText(
        "AI agents won't be able to work on tasks until you connect a provider. Set one up in Settings → AI Setup.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("GitHub not connected")).toBeNull();
  });

  it("shows GitHub warning when hasGithub is false and hasAiProvider is true", () => {
    render(<SetupWarningBanner hasAiProvider hasGithub={false} />);

    expect(screen.getByText("GitHub not connected")).toBeInTheDocument();
    expect(
      screen.getByText(
        "You won't be able to import issues from GitHub, but you can still create tasks manually.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No AI provider connected")).toBeNull();
  });

  it("shows both warnings when both providers are missing", () => {
    render(<SetupWarningBanner hasAiProvider={false} hasGithub={false} />);

    expect(screen.getByText("No AI provider connected")).toBeInTheDocument();
    expect(screen.getByText("GitHub not connected")).toBeInTheDocument();
  });

  it("compact mode renders a single-line summary", () => {
    render(
      <SetupWarningBanner hasAiProvider={false} hasGithub compact />,
    );

    expect(
      screen.getByText("⚠ Setup incomplete — AI and/or GitHub features will be limited."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No AI provider connected")).toBeNull();
  });

  it("full mode renders setup-warning-banner class with expected structure", () => {
    const { container } = render(
      <SetupWarningBanner hasAiProvider={false} hasGithub={false} />,
    );

    const banner = container.querySelector(".setup-warning-banner");
    const items = container.querySelectorAll(".setup-warning-banner__item");

    expect(banner).toBeTruthy();
    expect(items).toHaveLength(2);
  });

  it("has role=status and aria-live=polite for accessibility", () => {
    render(<SetupWarningBanner hasAiProvider={false} hasGithub />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
  });
});
