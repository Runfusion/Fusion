import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiDisclosure, normalizeAiAttributionValue, readStoredAiAttribution } from "../AiDisclosure";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => ({
      "aiDisclosure.interaction": "Interacción con IA",
      "aiDisclosure.generatedOutput": "Generado por IA",
      "aiDisclosure.assistedAnalysis": "Análisis asistido por IA",
      "aiDisclosure.translation": "Traducción con IA",
    }[key] ?? fallback ?? key),
  }),
}));

describe("AiDisclosure", () => {
  afterEach(cleanup);

  it("renders localized visible copy, semantic note, and exact known attribution metadata", () => {
    render(<AiDisclosure kind="generated-output" provider="anthropic" modelId="claude-opus-4-1" />);

    const note = screen.getByRole("note", { name: "Generado por IA · anthropic/claude-opus-4-1" });
    expect(note).toHaveTextContent("Generado por IA");
    expect(note).toHaveAttribute("data-compliance", "eu-ai-act-art-50");
    expect(note).toHaveAttribute("data-ai-disclosure", "generated-output");
    expect(note).toHaveAttribute("data-ai-provider", "anthropic");
    expect(note).toHaveAttribute("data-ai-model", "claude-opus-4-1");
    expect(note).not.toHaveAttribute("data-ai-attribution");
  });

  it("uses provider-agnostic metadata without guessing a provider", () => {
    render(<AiDisclosure kind="ai-assisted-analysis" />);

    const note = screen.getByRole("note", { name: "Análisis asistido por IA" });
    expect(note).toHaveAttribute("data-ai-attribution", "provider-agnostic");
    expect(note).not.toHaveAttribute("data-ai-provider");
    expect(note).not.toHaveAttribute("data-ai-model");
  });

  it("rejects URL and secret-like values instead of exposing them as DOM attributes", () => {
    render(<AiDisclosure kind="ai-interaction" provider="https://provider.example/v1" modelId="api-key-secret" />);

    const note = screen.getByRole("note", { name: "Interacción con IA" });
    expect(note).toHaveAttribute("data-ai-attribution", "provider-agnostic");
    expect(note.outerHTML).not.toContain("provider.example");
    expect(note.outerHTML).not.toContain("api-key-secret");
  });

  it("rejects mailto and other scheme-like metadata without requiring ://", () => {
    render(<AiDisclosure kind="ai-interaction" provider="mailto:alice@example.com" modelId="claude-opus-4-1" />);

    const note = screen.getByRole("note", { name: "Interacción con IA" });
    expect(note).toHaveAttribute("data-ai-attribution", "provider-agnostic");
    expect(note.outerHTML).not.toContain("alice@example.com");
    expect(note.outerHTML).not.toContain("mailto:");
  });

  it("normalizes safe values and rejects sensitive or malformed metadata", () => {
    expect(normalizeAiAttributionValue(" openai-compatible ")).toBe("openai-compatible");
    expect(normalizeAiAttributionValue("gpt-5.6/codex")).toBe("gpt-5.6/codex");
    expect(normalizeAiAttributionValue("credential-id")).toBeUndefined();
    expect(normalizeAiAttributionValue("https://example.test/model")).toBeUndefined();
    expect(normalizeAiAttributionValue("mailto:alice@example.com")).toBeUndefined();
    expect(normalizeAiAttributionValue("vendor/token-abc")).toBeUndefined();
    expect(normalizeAiAttributionValue("openai/api-key-live")).toBeUndefined();
  });

  it("reads persisted provider/model metadata and ignores mixed or unsafe values", () => {
    expect(readStoredAiAttribution({ modelProvider: "anthropic", modelId: "claude-opus-4-1" })).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-1",
    });
    expect(readStoredAiAttribution({ provider: "openai" })).toEqual({ provider: "openai" });
    expect(readStoredAiAttribution({ modelProvider: "https://provider.example", modelId: "gpt-4o" })).toEqual({});
    expect(readStoredAiAttribution(null)).toEqual({});
  });

  it("uses dashboard spacing and type tokens instead of raw rem values", () => {
    const css = readFileSync(resolve(__dirname, "../AiDisclosure.css"), "utf8");
    expect(css).toMatch(/gap:\s*var\(--space-xs\)/);
    expect(css).toMatch(/font-size:\s*var\(--font-size-xs\)/);
    expect(css).toMatch(/line-height:\s*var\(--line-height-tight\)/);
    expect(css).toMatch(/\.ai-disclosure--compact[\s\S]*font-size:\s*var\(--font-size-2xs\)/);
    expect(css).toMatch(/\.ai-disclosure--compact[\s\S]*gap:\s*var\(--space-3xs\)/);
    expect(css).not.toMatch(/font-size:\s*0\.\d+rem/);
    expect(css).not.toMatch(/gap:\s*0\.\d+rem/);
  });
});
