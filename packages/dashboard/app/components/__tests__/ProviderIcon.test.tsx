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

  it("renders MiniMax brand icon for minimax provider", () => {
    render(<ProviderIcon provider="minimax" />);
    expect(screen.getByTestId("minimax-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("MiniMax")).toBeInTheDocument();
  });

  it("applies provider-specific color for minimax", () => {
    render(<ProviderIcon provider="minimax" />);
    const icon = screen.getByTestId("minimax-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#E73562" });
  });

  it("passes correct color to SVG fill for minimax", () => {
    render(<ProviderIcon provider="minimax" />);
    const svg = screen.getByTestId("minimax-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#E73562");
  });

  it("normalizes Minimax (capitalized) to minimax", () => {
    render(<ProviderIcon provider="Minimax" />);
    expect(screen.getByTestId("minimax-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("minimax-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "minimax");
  });

  it("renders Z.ai brand icon for zai provider", () => {
    render(<ProviderIcon provider="zai" />);
    expect(screen.getByTestId("zai-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Z.ai")).toBeInTheDocument();
  });

  it("applies provider-specific color for zai", () => {
    render(<ProviderIcon provider="zai" />);
    const icon = screen.getByTestId("zai-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#1A6DFF" });
  });

  it("passes correct color to SVG fill for zai", () => {
    render(<ProviderIcon provider="zai" />);
    const svg = screen.getByTestId("zai-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#1A6DFF");
  });

  it("normalizes Zai (capitalized) to zai", () => {
    render(<ProviderIcon provider="Zai" />);
    expect(screen.getByTestId("zai-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("zai-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "zai");
  });

  it("renders Kimi brand icon for kimi provider", () => {
    render(<ProviderIcon provider="kimi" />);
    expect(screen.getByTestId("kimi-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Kimi")).toBeInTheDocument();
  });

  it("applies provider-specific color for kimi", () => {
    render(<ProviderIcon provider="kimi" />);
    const icon = screen.getByTestId("kimi-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#6C5CE7" });
  });

  it("passes correct color to SVG fill for kimi", () => {
    render(<ProviderIcon provider="kimi" />);
    const svg = screen.getByTestId("kimi-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#6C5CE7");
  });

  it("normalizes Kimi (capitalized) to kimi", () => {
    render(<ProviderIcon provider="Kimi" />);
    expect(screen.getByTestId("kimi-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("kimi-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "kimi");
  });

  it("renders Kimi brand icon for moonshot provider (alias)", () => {
    render(<ProviderIcon provider="moonshot" />);
    expect(screen.getByTestId("kimi-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Kimi")).toBeInTheDocument();
  });

  it("applies provider-specific color for moonshot (alias)", () => {
    render(<ProviderIcon provider="moonshot" />);
    const icon = screen.getByTestId("kimi-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#6C5CE7" });
  });

  it("passes correct color to SVG fill for moonshot (alias)", () => {
    render(<ProviderIcon provider="moonshot" />);
    const svg = screen.getByTestId("kimi-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#6C5CE7");
  });

  it("normalizes Moonshot (capitalized) to moonshot", () => {
    render(<ProviderIcon provider="Moonshot" />);
    expect(screen.getByTestId("kimi-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("kimi-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "moonshot");
  });

  it("renders Kimi brand icon for kimi-coding provider (alias)", () => {
    render(<ProviderIcon provider="kimi-coding" />);
    expect(screen.getByTestId("kimi-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Kimi")).toBeInTheDocument();
  });

  it("applies provider-specific color for kimi-coding (alias)", () => {
    render(<ProviderIcon provider="kimi-coding" />);
    const icon = screen.getByTestId("kimi-icon").parentElement;
    expect(icon).toHaveStyle({ color: "#6C5CE7" });
  });

  it("passes correct color to SVG fill for kimi-coding (alias)", () => {
    render(<ProviderIcon provider="kimi-coding" />);
    const svg = screen.getByTestId("kimi-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#6C5CE7");
  });

  // Regression test: verify the Kimi icon is the crescent moon shape, not the old "K" placeholder
  it("renders crescent moon icon geometry (not the old K placeholder)", () => {
    render(<ProviderIcon provider="kimi" />);
    const svg = screen.getByTestId("kimi-icon");
    const path = svg.querySelector("path");
    expect(path).toBeInTheDocument();
    
    // The old "K" placeholder path was: "M5.5 5.5h8v2.5h-5v2h3.5v2.5h-3.5v6.5h-3z"
    // The new crescent moon path should contain "a9 9" (circle arc) not "h8" (horizontal line)
    const pathD = path?.getAttribute("d") || "";
    expect(pathD).not.toBe("M5.5 5.5h8v2.5h-5v2h3.5v2.5h-3.5v6.5h-3z");
    // Verify the new crescent moon geometry: contains circle arc notation "a9 9"
    expect(pathD).toContain("a9 9");
  });
});
