import { describe, expect, it } from "vitest";
import { resolveTaskOutputLanguage } from "../ai/ai-output-language.js";

describe("resolveTaskOutputLanguage", () => {
  it("defaults to English and preserves legacy input compatibility", () => {
    expect(resolveTaskOutputLanguage({}, "Bonjour, ceci est une demande détaillée pour le projet.").mode).toBe("english");
    expect(resolveTaskOutputLanguage({ taskDefinitionInInputLanguage: true }, "Bonjour, ceci est une demande détaillée pour le projet.").mode).toBe("input");
  });

  it("lets an explicit mode override legacy and resolves the interface locale", () => {
    const resolved = resolveTaskOutputLanguage({ taskOutputLanguage: "interface", taskDefinitionInInputLanguage: true, language: "fr" }, "Necesito que este texto sea una solicitud detallada en español.");
    expect(resolved).toMatchObject({ mode: "interface", locale: "fr" });
    expect(resolved.instruction).toContain("Français");
  });

  it("keeps input mode useful when detection is unresolved", () => {
    const resolved = resolveTaskOutputLanguage({ taskOutputLanguage: "input" }, "short");
    expect(resolved.locale).toBeUndefined();
    expect(resolved.instruction).toContain("same language as the original user input");
  });
});
