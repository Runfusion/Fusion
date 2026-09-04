import { describe, expect, it } from "vitest";
import { contentNeedsTranslation, detectContentLanguage } from "../i18n/detect-content-language.js";

const reporterRepro = "Compare v2 par default vs v3, plus check the est timezone handling in scheduling.";

const genuineFrench = "Cette description explique le problème avec les utilisateurs et leurs tâches dans le tableau de bord pour une meilleure expérience.";
const genuineSpanish = "Este problema explica la vista previa con los usuarios y sus tareas para que puedan revisar el panel cuando cambian los datos.";
const genuinePortuguese = "Não podemos usar essa configuração quando o painel está aberto porque você deve revisar as tarefas para que tudo funcione como esperado.";

describe("detectContentLanguage", () => {
  it("does not classify the reported English chat title input as medium French", () => {
    const detected = detectContentLanguage(reporterRepro);

    expect(detected.locale).not.toBe("fr");
    expect(detected.confidence).toBe("low");
  });

  it("does not promote English technical prose with remaining French collisions", () => {
    const detected = detectContentLanguage(
      "Check the sur option without changes, then compare sans cache behavior with the default configuration.",
    );

    expect(detected).not.toMatchObject({ locale: "fr", confidence: "medium" });
    expect(detected).not.toMatchObject({ locale: "fr", confidence: "high" });
  });

  it.each([
    ["French", genuineFrench, "fr"],
    ["Spanish", genuineSpanish, "es"],
    ["Brazilian Portuguese", genuinePortuguese, "pt-BR"],
  ] as const)("retains high-confidence %s detection", (_language, text, locale) => {
    expect(detectContentLanguage(text)).toMatchObject({ locale, confidence: "high" });
  });

  it("preserves import translation behavior for real French and ambiguous English", () => {
    expect(contentNeedsTranslation(genuineFrench, "en").needed).toBe(true);
    expect(contentNeedsTranslation(reporterRepro, "en").needed).toBe(false);
  });
});
