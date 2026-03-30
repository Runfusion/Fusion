import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProviderIcon } from "../ProviderIcon";

// Mock lucide-react to avoid rendering actual SVGs in tests
vi.mock("lucide-react", () => ({
  Brain: ({ size }: { size?: number }) => <span data-testid="brain-icon" data-size={size} />,
  Sparkles: ({ size }: { size?: number }) => <span data-testid="sparkles-icon" data-size={size} />,
  Search: ({ size }: { size?: number }) => <span data-testid="search-icon" data-size={size} />,
  Terminal: ({ size }: { size?: number }) => <span data-testid="terminal-icon" data-size={size} />,
  Cpu: ({ size }: { size?: number }) => <span data-testid="cpu-icon" data-size={size} />,
}));

describe("ProviderIcon", () => {
  it("renders Brain icon for anthropic provider", () => {
    render(<ProviderIcon provider="anthropic" />);
    expect(screen.getByTestId("brain-icon")).toBeInTheDocument();
  });

  it("renders Sparkles icon for openai provider", () => {
    render(<ProviderIcon provider="openai" />);
    expect(screen.getByTestId("sparkles-icon")).toBeInTheDocument();
  });

  it("renders Search icon for google provider", () => {
    render(<ProviderIcon provider="google" />);
    expect(screen.getByTestId("search-icon")).toBeInTheDocument();
  });

  it("renders Search icon for gemini provider", () => {
    render(<ProviderIcon provider="gemini" />);
    expect(screen.getByTestId("search-icon")).toBeInTheDocument();
  });

  it("renders Terminal icon for ollama provider", () => {
    render(<ProviderIcon provider="ollama" />);
    expect(screen.getByTestId("terminal-icon")).toBeInTheDocument();
  });

  it("renders Cpu icon as fallback for unknown providers", () => {
    render(<ProviderIcon provider="unknown" />);
    expect(screen.getByTestId("cpu-icon")).toBeInTheDocument();
  });

  it("renders Cpu icon as fallback for empty provider", () => {
    render(<ProviderIcon provider="" />);
    expect(screen.getByTestId("cpu-icon")).toBeInTheDocument();
  });

  it("normalizes provider name to lowercase", () => {
    render(<ProviderIcon provider="Anthropic" />);
    expect(screen.getByTestId("brain-icon")).toBeInTheDocument();
  });

  it("applies provider-specific color for anthropic", () => {
    render(<ProviderIcon provider="anthropic" />);
    const icon = screen.getByTestId("brain-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#d4a27f" });
  });

  it("applies provider-specific color for openai", () => {
    render(<ProviderIcon provider="openai" />);
    const icon = screen.getByTestId("sparkles-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#10a37f" });
  });

  it("applies provider-specific color for google", () => {
    render(<ProviderIcon provider="google" />);
    const icon = screen.getByTestId("search-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#4285f4" });
  });

  it("applies provider-specific color for ollama", () => {
    render(<ProviderIcon provider="ollama" />);
    const icon = screen.getByTestId("terminal-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#fff" });
  });

  it("applies default color for unknown providers", () => {
    render(<ProviderIcon provider="unknown" />);
    const icon = screen.getByTestId("cpu-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--text-muted)" });
  });

  it("sets data-provider attribute with normalized provider name", () => {
    render(<ProviderIcon provider="Anthropic" />);
    const icon = screen.getByTestId("brain-icon").parentElement;
    expect(icon).toHaveAttribute("data-provider", "anthropic");
  });

  it("uses sm size (16px) by default", () => {
    render(<ProviderIcon provider="anthropic" />);
    expect(screen.getByTestId("brain-icon")).toHaveAttribute("data-size", "16");
  });

  it("uses sm size when explicitly specified", () => {
    render(<ProviderIcon provider="anthropic" size="sm" />);
    expect(screen.getByTestId("brain-icon")).toHaveAttribute("data-size", "16");
  });

  it("uses md size (20px) when specified", () => {
    render(<ProviderIcon provider="anthropic" size="md" />);
    expect(screen.getByTestId("brain-icon")).toHaveAttribute("data-size", "20");
  });

  it("uses lg size (24px) when specified", () => {
    render(<ProviderIcon provider="anthropic" size="lg" />);
    expect(screen.getByTestId("brain-icon")).toHaveAttribute("data-size", "24");
  });

  it("renders with className provider-icon", () => {
    render(<ProviderIcon provider="anthropic" />);
    const icon = screen.getByTestId("brain-icon").parentElement;
    expect(icon).toHaveClass("provider-icon");
  });
});
