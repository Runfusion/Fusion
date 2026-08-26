import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiDisclosure, normalizeAiAttributionValue } from "../AiDisclosure";

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

  it("normalizes safe values and rejects sensitive or malformed metadata", () => {
    expect(normalizeAiAttributionValue(" openai-compatible ")).toBe("openai-compatible");
    expect(normalizeAiAttributionValue("gpt-5.6/codex")).toBe("gpt-5.6/codex");
    expect(normalizeAiAttributionValue("credential-id")).toBeUndefined();
    expect(normalizeAiAttributionValue("https://example.test/model")).toBeUndefined();
  });
});
