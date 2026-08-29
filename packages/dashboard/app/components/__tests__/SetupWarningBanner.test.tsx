import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("omits GitHub warning and empty shell when the grace period has not elapsed", () => {
    const { container } = render(<SetupWarningBanner hasAiProvider hasGithub={false} showGithubWarning={false} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("GitHub not connected")).toBeNull();
  });

  it("preserves the AI warning while GitHub is hidden by the grace period", () => {
    render(<SetupWarningBanner hasAiProvider={false} hasGithub={false} showGithubWarning={false} />);

    expect(screen.getByText("No AI provider connected")).toBeInTheDocument();
    expect(screen.queryByText("GitHub not connected")).toBeNull();
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

  it("does not render dismiss button when onDismiss is not provided", () => {
    render(<SetupWarningBanner hasAiProvider={false} hasGithub />);

    expect(
      screen.queryByRole("button", { name: "Dismiss setup warning" }),
    ).toBeNull();
  });

  it("renders dismiss button when onDismiss is provided (full mode)", () => {
    const onDismiss = vi.fn();

    render(
      <SetupWarningBanner
        hasAiProvider={false}
        hasGithub
        onDismiss={onDismiss}
      />,
    );

    const dismissButton = screen.getByRole("button", {
      name: "Dismiss setup warning",
    });
    expect(dismissButton).toBeInTheDocument();

    fireEvent.click(dismissButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders dismiss button when onDismiss is provided (compact mode)", () => {
    const onDismiss = vi.fn();

    render(
      <SetupWarningBanner
        hasAiProvider={false}
        hasGithub
        compact
        onDismiss={onDismiss}
      />,
    );

    const dismissButton = screen.getByRole("button", {
      name: "Dismiss setup warning",
    });
    expect(dismissButton).toBeInTheDocument();

    fireEvent.click(dismissButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders a GitHub connect button only when GitHub warning is visible and action is available", () => {
    const onConnectGithub = vi.fn();

    render(<SetupWarningBanner hasAiProvider hasGithub={false} onConnectGithub={onConnectGithub} />);

    const connectButton = screen.getByRole("button", { name: "Connect GitHub" });
    expect(connectButton).toHaveAttribute("type", "button");

    fireEvent.click(connectButton);
    expect(onConnectGithub).toHaveBeenCalledTimes(1);
  });

  it("does not render an empty GitHub connect shell when action is unavailable", () => {
    const { container } = render(<SetupWarningBanner hasAiProvider hasGithub={false} />);

    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
    expect(container.querySelector(".setup-warning-banner__actions")).toBeNull();
  });

  it("does not render hidden GitHub connect controls during the grace period", () => {
    render(<SetupWarningBanner hasAiProvider={false} hasGithub={false} showGithubWarning={false} onConnectGithub={vi.fn()} />);

    expect(screen.queryByText("GitHub not connected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
  });

  it("clicking dismiss button calls onDismiss", () => {
    const onDismiss = vi.fn();

    render(
      <SetupWarningBanner
        hasAiProvider={false}
        hasGithub={false}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss setup warning" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
