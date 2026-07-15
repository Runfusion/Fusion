import { describe, it, expect } from "vitest";
import {
  contentNeedsTranslation,
  detectContentLanguage,
  localeDisplayName,
  MIN_DETECTABLE_CHARS,
} from "../detectContentLanguage";

describe("detectContentLanguage", () => {
  it("returns unknown for empty or too-short text", () => {
    expect(detectContentLanguage("").locale).toBe("unknown");
    expect(detectContentLanguage("hi").confidence).toBe("low");
    expect(detectContentLanguage("a".repeat(MIN_DETECTABLE_CHARS - 1)).locale).toBe("unknown");
  });

  it("detects Korean Hangul prose", () => {
    const text =
      "이 이슈는 대시보드의 가져오기 미리보기에서 번역 옵션을 제공하기 위한 테스트 본문입니다. 사용자가 다른 언어로 작성된 내용을 읽을 수 있어야 합니다.";
    const detected = detectContentLanguage(text);
    expect(detected.locale).toBe("ko");
    expect(detected.family).toBe("hangul");
    expect(detected.confidence).not.toBe("low");
  });

  it("detects Chinese CJK prose", () => {
    const text =
      "这个议题描述了导入预览中的翻译功能需求。当内容语言与仪表盘语言不同时，应该向用户提供翻译选项，以便他们理解问题标题和正文。";
    const detected = detectContentLanguage(text);
    expect(detected.family).toBe("cjk");
    expect(detected.locale).toBe("zh-CN");
  });

  it("detects English stopword-heavy prose", () => {
    const text =
      "This issue describes the problem with the import preview and what we should change for the users that have content in another language when they open the dashboard.";
    const detected = detectContentLanguage(text);
    expect(detected.locale).toBe("en");
    expect(detected.family).toBe("latin");
  });

  it("detects French stopword-heavy prose", () => {
    const text =
      "Cette issue décrit le problème avec l'aperçu d'importation et ce que nous devrions changer pour les utilisateurs qui ont du contenu dans une autre langue dans le tableau de bord.";
    const detected = detectContentLanguage(text);
    expect(detected.locale).toBe("fr");
    expect(detected.family).toBe("latin");
  });

  it("detects Spanish stopword-heavy prose", () => {
    const text =
      "Este problema describe el fallo con la vista previa de importación y lo que deberíamos cambiar para los usuarios que tienen contenido en otro idioma cuando abren el panel.";
    const detected = detectContentLanguage(text);
    expect(detected.locale).toBe("es");
    expect(detected.family).toBe("latin");
  });

  it("ignores fenced code and URLs when scoring", () => {
    const text = `
## Bug
This issue describes the problem with the import preview and what we should change for the users.

\`\`\`ts
const hangul = "이것은 코드입니다";
\`\`\`

See https://github.com/owner/repo/issues/1 for context about the users.
`;
    const detected = detectContentLanguage(text);
    expect(detected.locale).toBe("en");
  });
});

describe("contentNeedsTranslation", () => {
  const french =
    "Cette issue décrit le problème avec l'aperçu d'importation et ce que nous devrions changer pour les utilisateurs qui ont du contenu dans une autre langue dans le tableau de bord.";
  const english =
    "This issue describes the problem with the import preview and what we should change for the users that have content in another language when they open the dashboard.";
  const korean =
    "이 이슈는 대시보드의 가져오기 미리보기에서 번역 옵션을 제공하기 위한 테스트 본문입니다. 사용자가 다른 언어로 작성된 내용을 읽을 수 있어야 합니다.";
  const chinese =
    "这个议题描述了导入预览中的翻译功能需求。当内容语言与仪表盘语言不同时，应该向用户提供翻译选项，以便他们理解问题标题和正文。";

  it("does not offer translation when content matches dashboard locale", () => {
    expect(contentNeedsTranslation(english, "en").needed).toBe(false);
    expect(contentNeedsTranslation(french, "fr").needed).toBe(false);
    expect(contentNeedsTranslation(korean, "ko").needed).toBe(false);
  });

  it("offers translation when content language differs from dashboard locale", () => {
    expect(contentNeedsTranslation(french, "en").needed).toBe(true);
    expect(contentNeedsTranslation(korean, "en").needed).toBe(true);
    expect(contentNeedsTranslation(english, "ko").needed).toBe(true);
  });

  it("does not offer Chinese translation when dashboard is either Chinese locale", () => {
    expect(contentNeedsTranslation(chinese, "zh-CN").needed).toBe(false);
    expect(contentNeedsTranslation(chinese, "zh-TW").needed).toBe(false);
  });

  it("offers translation for Chinese content when dashboard is English", () => {
    expect(contentNeedsTranslation(chinese, "en").needed).toBe(true);
  });
});

describe("localeDisplayName", () => {
  it("returns endonyms for supported locales", () => {
    expect(localeDisplayName("en")).toBe("English");
    expect(localeDisplayName("ko")).toBe("한국어");
    expect(localeDisplayName("fr")).toBe("Français");
  });
});
