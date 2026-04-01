import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProviderIcon } from "../ProviderIcon";

describe("ProviderIcon", () => {
  it("renders OpenAI brand icon for openai-codex provider", () => {
    render(<ProviderIcon provider="openai-codex" />);
    expect(screen.getByTestId("openai-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI Codex")).toBeInTheDocument();
  });

  it("applies provider-specific color for openai-codex", () => {
    render(<ProviderIcon provider="openai-codex" />);
    const icon = screen.getByTestId("openai-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#10a37f" });
  });

  it("passes correct color to SVG fill for openai-codex", () => {
    render(<ProviderIcon provider="openai-codex" />);
    const svg = screen.getByTestId("openai-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#10a37f");
  });

  it("renders Anthropic brand icon for anthropic provider", () => {
    render(<ProviderIcon provider="anthropic" />);
    expect(screen.getByTestId("anthropic-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
  });

  it("renders OpenAI brand icon for openai provider", () => {
    render(<ProviderIcon provider="openai" />);
    expect(screen.getByTestId("openai-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI")).toBeInTheDocument();
  });

  it("renders Gemini brand icon for google provider", () => {
    render(<ProviderIcon provider="google" />);
    expect(screen.getByTestId("gemini-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Google Gemini")).toBeInTheDocument();
  });

  it("renders Gemini brand icon for gemini provider", () => {
    render(<ProviderIcon provider="gemini" />);
    expect(screen.getByTestId("gemini-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Google Gemini")).toBeInTheDocument();
  });

  it("renders Ollama brand icon for ollama provider", () => {
    render(<ProviderIcon provider="ollama" />);
    expect(screen.getByTestId("ollama-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Ollama")).toBeInTheDocument();
  });

  it("renders Cpu icon as fallback for unknown providers", () => {
    render(<ProviderIcon provider="unknown" />);
    // Cpu icon from lucide-react renders as an svg without our custom data-testid
    const icon = screen.getByText((_, element) => {
      return element?.tagName.toLowerCase() === "svg" && 
             element?.parentElement?.getAttribute("data-provider") === "unknown";
    });
    expect(icon).toBeInTheDocument();
  });

  it("renders Cpu icon as fallback for empty provider", () => {
    render(<ProviderIcon provider="" />);
    const icon = screen.getByText((_, element) => {
      return element?.tagName.toLowerCase() === "svg" && 
             element?.parentElement?.getAttribute("data-provider") === "";
    });
    expect(icon).toBeInTheDocument();
  });

  it("normalizes provider name to lowercase", () => {
    render(<ProviderIcon provider="Anthropic" />);
    expect(screen.getByTestId("anthropic-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("anthropic-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "anthropic");
  });

  it("applies provider-specific color for anthropic", () => {
    render(<ProviderIcon provider="anthropic" />);
    const icon = screen.getByTestId("anthropic-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#d4a27f" });
  });

  it("applies provider-specific color for openai", () => {
    render(<ProviderIcon provider="openai" />);
    const icon = screen.getByTestId("openai-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#10a37f" });
  });

  it("applies provider-specific color for google", () => {
    render(<ProviderIcon provider="google" />);
    const icon = screen.getByTestId("gemini-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#4285f4" });
  });

  it("applies provider-specific color for ollama", () => {
    render(<ProviderIcon provider="ollama" />);
    const icon = screen.getByTestId("ollama-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#fff" });
  });

  it("applies default color for unknown providers", () => {
    render(<ProviderIcon provider="unknown" />);
    const icon = document.querySelector('[data-provider="unknown"]');
    expect(icon).toHaveStyle({ color: "var(--text-muted)" });
  });

  it("sets data-provider attribute with normalized provider name", () => {
    render(<ProviderIcon provider="OpenAI" />);
    const icon = screen.getByTestId("openai-icon").parentElement;
    expect(icon).toHaveAttribute("data-provider", "openai");
  });

  it("uses sm size (16px) by default", () => {
    render(<ProviderIcon provider="anthropic" />);
    const icon = screen.getByTestId("anthropic-icon");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
  });

  it("uses sm size when explicitly specified", () => {
    render(<ProviderIcon provider="anthropic" size="sm" />);
    const icon = screen.getByTestId("anthropic-icon");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
  });

  it("uses md size (20px) when specified", () => {
    render(<ProviderIcon provider="anthropic" size="md" />);
    const icon = screen.getByTestId("anthropic-icon");
    expect(icon).toHaveAttribute("width", "20");
    expect(icon).toHaveAttribute("height", "20");
  });

  it("uses lg size (24px) when specified", () => {
    render(<ProviderIcon provider="anthropic" size="lg" />);
    const icon = screen.getByTestId("anthropic-icon");
    expect(icon).toHaveAttribute("width", "24");
    expect(icon).toHaveAttribute("height", "24");
  });

  it("renders with className provider-icon", () => {
    render(<ProviderIcon provider="anthropic" />);
    const icon = screen.getByTestId("anthropic-icon").parentElement;
    expect(icon).toHaveClass("provider-icon");
  });

  it("passes correct color to SVG fill for anthropic", () => {
    render(<ProviderIcon provider="anthropic" />);
    const svg = screen.getByTestId("anthropic-icon");
    // The SVG should have the color in its path fill
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    // First path should have the provider color
    expect(paths[0]).toHaveAttribute("fill", "#d4a27f");
  });

  it("passes correct color to SVG fill for openai", () => {
    render(<ProviderIcon provider="openai" />);
    const svg = screen.getByTestId("openai-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#10a37f");
  });

  it("passes correct color to SVG fill for gemini", () => {
    render(<ProviderIcon provider="gemini" />);
    const svg = screen.getByTestId("gemini-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#4285f4");
  });

  it("passes correct color to SVG fill for ollama", () => {
    render(<ProviderIcon provider="ollama" />);
    const svg = screen.getByTestId("ollama-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#fff");
  });
});
