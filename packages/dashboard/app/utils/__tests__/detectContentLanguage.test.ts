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

/* Realistic issue-form fixtures deliberately include English scaffolding around user prose. */
const SPANISH_ISSUE_FORM = `
<!-- Please complete each field before submitting. -->
### Bug description
**What happened?**
### Expected behavior
**What did you expect to happen?**
### Environment
**Which operating system and version are you using?**
### Additional details
**What other context would help us investigate?**
El servidor devuelve un error cuando el usuario intenta guardar los cambios y la aplicación no responde. Por favor revise los registros porque este problema ocurre para todos los usuarios después de actualizar la configuración.

### Steps to reproduce
**Steps**
- [x] I searched existing issues
- [ ] I can provide more details
1. Abra la configuración y guarde los cambios para comprobar que el fallo aparece de nuevo cuando el sistema procesa la solicitud.

### Additional context
**Logs**
_No response_
`;

const HANGUL_ISSUE_FORM = `
<!-- Please complete each field before submitting. -->
### Bug description
**What happened?**
### Expected behavior
**What did you expect to happen?**
### Environment
**Which operating system and version are you using?**
### Additional details
**What other context would help us investigate?**
대시보드에서 설정을 저장하면 오류가 발생하고 사용자가 변경한 내용을 확인할 수 없습니다. 이 문제는 모든 프로젝트에서 반복되며 화면을 새로 고쳐도 계속됩니다.

### Steps to reproduce
**Steps**
- [x] I searched existing issues
- [ ] I can provide more details

### Additional context
**Logs**
_No response_
`;

const REPORTED_CZECH_ISSUE_FORM = `
# PWA na iOS: studený start bez tokenu skončí ve smyčce „Can't reach Fusion Backend" — dialog pro vložení tokenu se nikdy nezobrazí

**GitHub issue:** Runfusion/Fusion#TBD
**Verze Fusion:** 0.72.0 (zdrojový checkout)
**Oblast:** Dashboard / autentizace (PWA, vzdálený přístup přes tunel)
**Závažnost:** Vysoká — aplikaci přidanou na plochu iPhonu nelze vůbec autorizovat.

## Shrnutí

Dashboard zpřístupněný přes Remote Access funguje v mobilním Safari správně. Token přiteče přes přihlašovací URL a uloží se do localStorage. Po přidání na plochu na iOS ale instalovaná webová aplikace startuje bez tokenu v URL, běží v izolovaném úložišti a místo dialogu pro vložení tokenu zobrazí jen chybovou stránku Unauthorized.

## Reprodukce

1. Spusťte dashboard s aktivní bearer-token autentizací a zpřístupněte ho přes tunel.
2. Na iPhonu otevřete přihlašovací URL v Safari a potom aplikaci přidejte na plochu.
3. Otevřete aplikaci z plochy: zobrazí se chyba Unauthorized a tlačítko Retry Connection nic nedělá.

## Očekávané chování

Nepřihlášený studený start nabídne vložení tokenu, aby aplikace nebyla trvale nepoužitelná.
`;

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

  it("detects foreign GitHub issue-form answers instead of English scaffolding", () => {
    expect(contentNeedsTranslation(SPANISH_ISSUE_FORM, "en").needed).toBe(true);
    expect(contentNeedsTranslation(HANGUL_ISSUE_FORM, "en").needed).toBe(true);
  });

  it("recognizes the reported Czech issue-form body as unsupported foreign Latin prose", () => {
    const result = contentNeedsTranslation(REPORTED_CZECH_ISSUE_FORM, "en");
    expect(result.needed).toBe(true);
    expect(result.detected).toMatchObject({ locale: "unknown", family: "latin", confidence: "high" });
  });

  it("does not offer translation for English issue-form answers", () => {
    const englishForm = SPANISH_ISSUE_FORM.replace(
      /El servidor[\s\S]*?solicitud\./,
      "The server returns an error when a user saves settings, and the application stops responding for every project after configuration changes.",
    ).replace(
      /Abra la configuración[\s\S]*?solicitud\./,
      "Open settings and save the changes to confirm that the problem happens again when the system processes the request.",
    );
    expect(contentNeedsTranslation(englishForm, "en").needed).toBe(false);
  });

  it("keeps scaffold-only issue forms unknown", () => {
    const scaffoldOnly = `
### Bug description
**What happened?**
_No response_
- [x] I searched existing issues
<!-- Form guidance -->`;
    const result = contentNeedsTranslation(scaffoldOnly, "en");
    expect(result.needed).toBe(false);
    expect(result.detected.locale).toBe("unknown");
  });

  it("preserves inline bold, list prose, and quoted foreign content", () => {
    const ordinaryProse = `**palabra importante**
- falla al guardar
> Esta explicación citada confirma que el servidor devuelve errores para todos los proyectos y los usuarios cuando intentan guardar cambios en la configuración.`;
    expect(contentNeedsTranslation("**palabra importante**\n- falla al guardar", "en").needed).toBe(false);
    expect(contentNeedsTranslation(ordinaryProse, "en").needed).toBe(true);
  });

  it("preserves meaningful headings and task-list prose outside issue forms", () => {
    const markdownReport = `### Informe del problema
- [x] El servidor devuelve errores para todos los usuarios cuando guardan cambios en la configuración.
### Pasos realizados
- [x] Abra el panel, cambie una opción y guarde para confirmar que el fallo continúa.`;

    expect(contentNeedsTranslation(markdownReport, "en").needed).toBe(true);
  });
});

describe("localeDisplayName", () => {
  it("returns endonyms for supported locales", () => {
    expect(localeDisplayName("en")).toBe("English");
    expect(localeDisplayName("ko")).toBe("한국어");
    expect(localeDisplayName("fr")).toBe("Français");
  });
});
