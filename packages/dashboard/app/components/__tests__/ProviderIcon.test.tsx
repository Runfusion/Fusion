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
    expect(icon).toHaveStyle({ color: "var(--provider-openai)" });
  });

  it("passes correct color to SVG fill for openai-codex", () => {
    render(<ProviderIcon provider="openai-codex" />);
    const svg = screen.getByTestId("openai-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-openai)");
  });

  it("renders Anthropic brand icon for anthropic provider", () => {
    render(<ProviderIcon provider="anthropic" />);
    expect(screen.getByTestId("anthropic-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Anthropic")).toBeInTheDocument();
  });

  it("renders claude-cli icon with tokenized contrast stroke", () => {
    render(<ProviderIcon provider="claude-cli" />);
    const svg = screen.getByTestId("claude-cli-icon");
    expect(svg).toBeInTheDocument();
    expect(screen.getByLabelText("Anthropic — via Claude CLI")).toBeInTheDocument();
    const badgeGlyph = svg.querySelector('path[stroke]');
    expect(badgeGlyph).toHaveAttribute("stroke", "var(--provider-icon-contrast)");
  });

  it("renders pi-claude-cli with Claude CLI icon, label, and provider color", () => {
    render(<ProviderIcon provider="pi-claude-cli" />);
    const svg = screen.getByTestId("claude-cli-icon");
    expect(svg).toBeInTheDocument();
    expect(screen.getByLabelText("Anthropic — via Claude CLI")).toBeInTheDocument();
    const wrapper = svg.parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "pi-claude-cli");
    expect(wrapper).toHaveStyle({ color: "var(--provider-anthropic)" });
  });

  it("normalizes PI-Claude-CLI provider name to lowercase alias", () => {
    render(<ProviderIcon provider="PI-Claude-CLI" />);
    const svg = screen.getByTestId("claude-cli-icon");
    expect(svg).toBeInTheDocument();
    expect(svg.parentElement).toHaveAttribute("data-provider", "pi-claude-cli");
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

  it("renders Gemini brand icon for google-antigravity provider", () => {
    render(<ProviderIcon provider="google-antigravity" />);
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

  it("normalizes Google-Antigravity (capitalized) to google-antigravity", () => {
    render(<ProviderIcon provider="Google-Antigravity" />);
    expect(screen.getByTestId("gemini-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("gemini-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "google-antigravity");
  });

  it("applies provider-specific color for anthropic", () => {
    render(<ProviderIcon provider="anthropic" />);
    const icon = screen.getByTestId("anthropic-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--provider-anthropic)" });
  });

  it("applies provider-specific color for openai", () => {
    render(<ProviderIcon provider="openai" />);
    const icon = screen.getByTestId("openai-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--provider-openai)" });
  });

  it("applies provider-specific color for google", () => {
    render(<ProviderIcon provider="google" />);
    const icon = screen.getByTestId("gemini-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--provider-gemini)" });
  });

  it("applies provider-specific color for google-antigravity", () => {
    render(<ProviderIcon provider="google-antigravity" />);
    const icon = screen.getByTestId("gemini-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--provider-gemini)" });
  });

  it("applies theme-safe color for ollama", () => {
    render(<ProviderIcon provider="ollama" />);
    const icon = screen.getByTestId("ollama-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--text)" });
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
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-anthropic)");
  });

  it("passes correct color to SVG fill for openai", () => {
    render(<ProviderIcon provider="openai" />);
    const svg = screen.getByTestId("openai-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-openai)");
  });

  it("passes correct color to SVG fill for gemini", () => {
    render(<ProviderIcon provider="gemini" />);
    const svg = screen.getByTestId("gemini-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-gemini)");
  });

  it("passes correct color to SVG fill for google-antigravity", () => {
    render(<ProviderIcon provider="google-antigravity" />);
    const svg = screen.getByTestId("gemini-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-gemini)");
  });

  it("passes theme-safe color to SVG fill for ollama", () => {
    render(<ProviderIcon provider="ollama" />);
    const svg = screen.getByTestId("ollama-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--text)");
  });

  it("renders MiniMax brand icon for minimax provider", () => {
    render(<ProviderIcon provider="minimax" />);
    expect(screen.getByTestId("minimax-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("MiniMax")).toBeInTheDocument();
  });

  it("applies provider-specific color for minimax", () => {
    render(<ProviderIcon provider="minimax" />);
    const icon = screen.getByTestId("minimax-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--provider-minimax)" });
  });

  it("passes correct color to SVG fill for minimax", () => {
    render(<ProviderIcon provider="minimax" />);
    const svg = screen.getByTestId("minimax-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-minimax)");
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
    expect(icon).toHaveStyle({ color: "var(--provider-zai)" });
  });

  it("passes correct color to SVG fill for zai", () => {
    render(<ProviderIcon provider="zai" />);
    const svg = screen.getByTestId("zai-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-zai)");
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
    expect(icon).toHaveStyle({ color: "var(--provider-kimi)" });
  });

  it("passes correct color to SVG fill for kimi", () => {
    render(<ProviderIcon provider="kimi" />);
    const svg = screen.getByTestId("kimi-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-kimi)");
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
    expect(icon).toHaveStyle({ color: "var(--provider-kimi)" });
  });

  it("passes correct color to SVG fill for moonshot (alias)", () => {
    render(<ProviderIcon provider="moonshot" />);
    const svg = screen.getByTestId("kimi-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-kimi)");
  });

  it("normalizes Moonshot (capitalized) to moonshot", () => {
    render(<ProviderIcon provider="Moonshot" />);
    expect(screen.getByTestId("kimi-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("kimi-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "moonshot");
  });

  it("renders OpenRouter brand icon for openrouter provider", () => {
    render(<ProviderIcon provider="openrouter" />);
    expect(screen.getByTestId("openrouter-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenRouter")).toBeInTheDocument();
  });

  it("renders GitHub brand icon for github provider", () => {
    render(<ProviderIcon provider="github" />);
    expect(screen.getByTestId("github-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub")).toBeInTheDocument();
  });

  it("reuses GitHub icon for github-copilot alias", () => {
    render(<ProviderIcon provider="github-copilot" />);
    expect(screen.getByTestId("github-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub Copilot")).toBeInTheDocument();
  });

  it("renders Kimi brand icon for kimi-coding provider (alias)", () => {
    render(<ProviderIcon provider="kimi-coding" />);
    expect(screen.getByTestId("kimi-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Kimi")).toBeInTheDocument();
  });

  it("applies provider-specific color for kimi-coding (alias)", () => {
    render(<ProviderIcon provider="kimi-coding" />);
    const icon = screen.getByTestId("kimi-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--provider-kimi)" });
  });

  it("passes correct color to SVG fill for kimi-coding (alias)", () => {
    render(<ProviderIcon provider="kimi-coding" />);
    const svg = screen.getByTestId("kimi-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-kimi)");
  });

  // xAI provider tests
  it("renders xAI brand icon for xai provider", () => {
    render(<ProviderIcon provider="xai" />);
    expect(screen.getByTestId("xai-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("xAI")).toBeInTheDocument();
  });

  it("applies theme-safe color for xai", () => {
    render(<ProviderIcon provider="xai" />);
    const icon = screen.getByTestId("xai-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--text)" });
  });

  it("passes correct color to SVG fill for xai", () => {
    render(<ProviderIcon provider="xai" />);
    const svg = screen.getByTestId("xai-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--text)");
  });

  it("normalizes Xai (capitalized) to xai", () => {
    render(<ProviderIcon provider="Xai" />);
    expect(screen.getByTestId("xai-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("xai-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "xai");
  });

  it("renders xAI brand icon for grok provider (alias)", () => {
    render(<ProviderIcon provider="grok" />);
    expect(screen.getByTestId("xai-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("xAI")).toBeInTheDocument();
  });

  it("applies theme-safe color for grok (alias)", () => {
    render(<ProviderIcon provider="grok" />);
    const icon = screen.getByTestId("xai-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--text)" });
  });

  // Opencode provider tests
  it("renders Opencode brand icon for opencode provider", () => {
    render(<ProviderIcon provider="opencode" />);
    expect(screen.getByTestId("opencode-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Opencode")).toBeInTheDocument();
  });

  it("applies provider-specific color for opencode", () => {
    render(<ProviderIcon provider="opencode" />);
    const icon = screen.getByTestId("opencode-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--provider-opencode)" });
  });

  it("passes correct color to SVG fill for opencode", () => {
    render(<ProviderIcon provider="opencode" />);
    const svg = screen.getByTestId("opencode-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-opencode)");
  });

  it("normalizes Opencode (capitalized) to opencode", () => {
    render(<ProviderIcon provider="Opencode" />);
    expect(screen.getByTestId("opencode-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("opencode-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "opencode");
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

  it("renders Bedrock brand icon for bedrock provider", () => {
    render(<ProviderIcon provider="bedrock" />);
    expect(screen.getByTestId("bedrock-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Amazon Bedrock")).toBeInTheDocument();
  });

  it("applies provider-specific color for bedrock", () => {
    render(<ProviderIcon provider="bedrock" />);
    const icon = screen.getByTestId("bedrock-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--provider-bedrock)" });
  });

  it("passes correct color to SVG fill for bedrock", () => {
    render(<ProviderIcon provider="bedrock" />);
    const svg = screen.getByTestId("bedrock-icon");
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "var(--provider-bedrock)");
  });

  it("normalizes Bedrock (capitalized) to bedrock", () => {
    render(<ProviderIcon provider="Bedrock" />);
    expect(screen.getByTestId("bedrock-icon")).toBeInTheDocument();
    const wrapper = screen.getByTestId("bedrock-icon").parentElement;
    expect(wrapper).toHaveAttribute("data-provider", "bedrock");
  });

  it("renders Bedrock brand icon for amazon-bedrock alias", () => {
    render(<ProviderIcon provider="amazon-bedrock" />);
    expect(screen.getByTestId("bedrock-icon")).toBeInTheDocument();
    expect(screen.getByLabelText("Amazon Bedrock")).toBeInTheDocument();
  });

  it("applies provider-specific color for amazon-bedrock alias", () => {
    render(<ProviderIcon provider="amazon-bedrock" />);
    const icon = screen.getByTestId("bedrock-icon").parentElement;
    expect(icon).toHaveStyle({ color: "var(--provider-bedrock)" });
  });

  // ── New providers (Qwen, LM Studio, Hugging Face, Mistral, Azure, Fireworks)
  // and additional Gemini-mapped Google product aliases.

  it("renders Qwen icon for qwen and its aliases", () => {
    for (const provider of ["qwen", "qwen-coder", "alibaba", "tongyi"]) {
      const { unmount } = render(<ProviderIcon provider={provider} />);
      expect(screen.getByTestId("qwen-icon")).toBeInTheDocument();
      unmount();
    }
  });

  it("renders LM Studio icon for both lmstudio and lm-studio", () => {
    for (const provider of ["lmstudio", "lm-studio"]) {
      const { unmount } = render(<ProviderIcon provider={provider} />);
      expect(screen.getByTestId("lmstudio-icon")).toBeInTheDocument();
      expect(screen.getByLabelText("LM Studio")).toBeInTheDocument();
      unmount();
    }
  });

  it("renders Hugging Face icon for huggingface, hugging-face, and hf", () => {
    for (const provider of ["huggingface", "hugging-face", "hf"]) {
      const { unmount } = render(<ProviderIcon provider={provider} />);
      expect(screen.getByTestId("huggingface-icon")).toBeInTheDocument();
      expect(screen.getByLabelText("Hugging Face")).toBeInTheDocument();
      unmount();
    }
  });

  it("renders Mistral icon for mistral and mistral-ai", () => {
    for (const provider of ["mistral", "mistral-ai"]) {
      const { unmount } = render(<ProviderIcon provider={provider} />);
      expect(screen.getByTestId("mistral-icon")).toBeInTheDocument();
      expect(screen.getByLabelText("Mistral AI")).toBeInTheDocument();
      unmount();
    }
  });

  it("renders Azure icon for azure and azure-openai with provider-azure color", () => {
    for (const provider of ["azure", "azure-openai"]) {
      const { unmount } = render(<ProviderIcon provider={provider} />);
      expect(screen.getByTestId("azure-icon")).toBeInTheDocument();
      const wrap = screen.getByTestId("azure-icon").parentElement;
      expect(wrap).toHaveStyle({ color: "var(--provider-azure)" });
      unmount();
    }
  });

  it("renders Fireworks icon for fireworks and fireworks-ai", () => {
    for (const provider of ["fireworks", "fireworks-ai"]) {
      const { unmount } = render(<ProviderIcon provider={provider} />);
      expect(screen.getByTestId("fireworks-icon")).toBeInTheDocument();
      expect(screen.getByLabelText("Fireworks AI")).toBeInTheDocument();
      unmount();
    }
  });

  it("maps Google Vertex / Cloud Code / Antigravity all to the Gemini icon", () => {
    for (const provider of ["google-vertex", "vertex", "google-cloud-code", "cloud-code", "google-antigravity", "antigravity"]) {
      const { unmount } = render(<ProviderIcon provider={provider} />);
      expect(screen.getByTestId("gemini-icon")).toBeInTheDocument();
      const wrap = screen.getByTestId("gemini-icon").parentElement;
      expect(wrap).toHaveStyle({ color: "var(--provider-gemini)" });
      unmount();
    }
  });

  // ── pi-ai catalog gap fills (Cerebras, Groq, Vercel) and aliases for
  // existing icons (minimax-cn, azure-openai-responses, google-gemini-cli,
  // opencode-go).

  it("renders Cerebras icon for cerebras provider", () => {
    render(<ProviderIcon provider="cerebras" />);
    expect(screen.getByTestId("cerebras-icon")).toBeInTheDocument();
  });

  it("renders Groq icon for groq provider", () => {
    render(<ProviderIcon provider="groq" />);
    expect(screen.getByTestId("groq-icon")).toBeInTheDocument();
  });

  it("renders Vercel icon for vercel and vercel-ai-gateway", () => {
    for (const provider of ["vercel", "vercel-ai-gateway"]) {
      const { unmount } = render(<ProviderIcon provider={provider} />);
      expect(screen.getByTestId("vercel-icon")).toBeInTheDocument();
      unmount();
    }
  });

  it("aliases minimax-cn to the MiniMax icon", () => {
    render(<ProviderIcon provider="minimax-cn" />);
    expect(screen.getByTestId("minimax-icon")).toBeInTheDocument();
  });

  it("aliases azure-openai-responses to the Azure icon", () => {
    render(<ProviderIcon provider="azure-openai-responses" />);
    expect(screen.getByTestId("azure-icon")).toBeInTheDocument();
  });

  it("aliases google-gemini-cli and google-generative-ai to the Gemini icon", () => {
    for (const provider of ["google-gemini-cli", "google-generative-ai"]) {
      const { unmount } = render(<ProviderIcon provider={provider} />);
      expect(screen.getByTestId("gemini-icon")).toBeInTheDocument();
      unmount();
    }
  });

  it("aliases opencode-go to the Opencode icon", () => {
    render(<ProviderIcon provider="opencode-go" />);
    expect(screen.getByTestId("opencode-icon")).toBeInTheDocument();
  });
});
