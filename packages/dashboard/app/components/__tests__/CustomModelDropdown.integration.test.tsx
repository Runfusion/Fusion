import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomModelDropdown } from "../CustomModelDropdown";
import type { ModelInfo } from "../../api";

const MOCK_MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
  { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4", reasoning: true, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  { provider: "ollama", id: "llama3", name: "Llama 3", reasoning: false, contextWindow: 4096 },
];

const defaultProps = {
  models: MOCK_MODELS,
  value: "",
  onChange: vi.fn(),
  label: "Test Model",
  id: "test-model",
};

describe("CustomModelDropdown ProviderIcon Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders actual OpenAI SVG icon in trigger when OpenAI model is selected", () => {
    render(<CustomModelDropdown {...defaultProps} value="openai/gpt-4o" />);

    // Verify the actual OpenAI SVG icon is rendered in the trigger
    const openaiIcon = screen.getByTestId("openai-icon");
    expect(openaiIcon).toBeInTheDocument();
    expect(openaiIcon).toHaveAttribute("aria-label", "OpenAI");

    // Verify the SVG has the correct fill color (#10a37f - OpenAI green)
    const paths = openaiIcon.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#10a37f");
  });

  it("renders actual OpenAI SVG icon in dropdown group header", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    // When dropdown is open, there should be OpenAI icons in the group header
    // Since no model is selected, the trigger won't have an icon, but the group header will
    const openaiIcons = screen.getAllByTestId("openai-icon");
    expect(openaiIcons.length).toBeGreaterThanOrEqual(1);

    // Verify at least one has the correct aria-label
    const openaiIcon = screen.getByLabelText("OpenAI");
    expect(openaiIcon).toBeInTheDocument();

    // Verify the icon has the correct color
    const paths = openaiIcon.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toHaveAttribute("fill", "#10a37f");
  });

  it("renders actual provider icons for all providers in dropdown", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    // Verify all provider icons are rendered with proper SVG elements
    const anthropicIcon = screen.getByTestId("anthropic-icon");
    expect(anthropicIcon).toBeInTheDocument();
    expect(anthropicIcon).toHaveAttribute("aria-label", "Anthropic");
    expect(anthropicIcon.querySelector("path")).toHaveAttribute("fill", "#d4a27f");

    const openaiIcon = screen.getByTestId("openai-icon");
    expect(openaiIcon).toBeInTheDocument();
    expect(openaiIcon).toHaveAttribute("aria-label", "OpenAI");
    expect(openaiIcon.querySelector("path")).toHaveAttribute("fill", "#10a37f");

    const ollamaIcon = screen.getByTestId("ollama-icon");
    expect(ollamaIcon).toBeInTheDocument();
    expect(ollamaIcon).toHaveAttribute("aria-label", "Ollama");
    expect(ollamaIcon.querySelector("path")).toHaveAttribute("fill", "#fff");
  });

  it("renders both trigger icon and group header icons when dropdown is open with OpenAI selected", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} value="openai/gpt-4o" />);

    // Initially, trigger should show the OpenAI icon
    expect(screen.getByTestId("openai-icon")).toBeInTheDocument();

    // Open dropdown
    await user.click(screen.getByLabelText("Test Model"));

    // Now there should be two OpenAI icons: one in trigger, one in group header
    const openaiIcons = screen.getAllByTestId("openai-icon");
    expect(openaiIcons).toHaveLength(2);

    // Both should have correct attributes
    openaiIcons.forEach((icon) => {
      expect(icon).toHaveAttribute("aria-label", "OpenAI");
      expect(icon.querySelector("path")).toHaveAttribute("fill", "#10a37f");
    });
  });

  it("renders icons with correct sizes (16px for sm size)", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} value="openai/gpt-4o" />);

    const openaiIcon = screen.getByTestId("openai-icon");
    expect(openaiIcon).toHaveAttribute("width", "16");
    expect(openaiIcon).toHaveAttribute("height", "16");

    // Open dropdown and verify group header icon also has correct size
    await user.click(screen.getByLabelText("Test Model"));
    const openaiIcons = screen.getAllByTestId("openai-icon");
    openaiIcons.forEach((icon) => {
      expect(icon).toHaveAttribute("width", "16");
      expect(icon).toHaveAttribute("height", "16");
    });
  });
});
