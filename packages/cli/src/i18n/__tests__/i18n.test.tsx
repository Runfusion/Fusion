import { Text } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { cliI18n, detectEnvLocale, initCliI18n, resolveCliLocale } from "../index.js";

// cliI18n is a module singleton: restore the locale after each test so cases
// that switch language (zh-CN/fr) can't leak state into later tests.
afterEach(async () => {
  if (cliI18n.isInitialized && cliI18n.language !== "en") {
    await cliI18n.changeLanguage("en");
  }
});

describe("detectEnvLocale", () => {
  it("parses POSIX locale env values to a supported locale", () => {
    expect(detectEnvLocale({ LANG: "fr_FR.UTF-8" })).toBe("fr");
    expect(detectEnvLocale({ LC_ALL: "es_ES.UTF-8" })).toBe("es");
    expect(detectEnvLocale({ LANG: "zh_CN.UTF-8" })).toBe("zh-CN");
    expect(detectEnvLocale({ LANG: "zh_TW" })).toBe("zh-TW");
  });

  it("honors precedence LC_ALL > LC_MESSAGES > LANG > LANGUAGE", () => {
    expect(detectEnvLocale({ LC_ALL: "fr_FR", LANG: "es_ES" })).toBe("fr");
    expect(detectEnvLocale({ LC_MESSAGES: "es_ES", LANG: "fr_FR" })).toBe("es");
  });

  it("falls back to a bare language and undefined for unsupported", () => {
    expect(detectEnvLocale({ LANG: "zh" })).toBe("zh-CN");
    expect(detectEnvLocale({ LANG: "de_DE.UTF-8" })).toBeUndefined();
    expect(detectEnvLocale({})).toBeUndefined();
  });

  it("resolves Traditional-script Chinese tags to zh-TW, not Simplified", () => {
    expect(detectEnvLocale({ LANG: "zh_Hant_TW.UTF-8" })).toBe("zh-TW");
    expect(detectEnvLocale({ LANG: "zh_Hant" })).toBe("zh-TW");
    expect(detectEnvLocale({ LANG: "zh_HK.UTF-8" })).toBe("zh-TW");
    expect(detectEnvLocale({ LANG: "zh_MO" })).toBe("zh-TW");
    // Simplified-script and mainland tags stay Simplified.
    expect(detectEnvLocale({ LANG: "zh_Hans_CN" })).toBe("zh-CN");
    expect(detectEnvLocale({ LANG: "zh_SG" })).toBe("zh-CN");
  });

  it("normalizes multi-underscore POSIX tags", () => {
    expect(detectEnvLocale({ LANG: "en_US_POSIX" })).toBe("en");
    expect(detectEnvLocale({ LANGUAGE: "fr_FR.UTF-8" })).toBe("fr");
  });
});

describe("resolveCliLocale precedence", () => {
  it("flag overrides setting and env", () => {
    expect(resolveCliLocale({ flag: "zh-TW", setting: "fr", env: { LANG: "es_ES" } })).toBe("zh-TW");
  });
  it("setting overrides env", () => {
    expect(resolveCliLocale({ setting: "fr", env: { LANG: "es_ES" } })).toBe("fr");
  });
  it("env used when no flag/setting", () => {
    expect(resolveCliLocale({ env: { LANG: "es_ES.UTF-8" } })).toBe("es");
  });
  it("defaults to en", () => {
    expect(resolveCliLocale({ env: {} })).toBe("en");
    expect(resolveCliLocale({ flag: "de", env: {} })).toBe("en");
  });
});

// The load-bearing spike: react-i18next must work under Ink's custom reconciler.
function Loading() {
  const { t } = useTranslation("cli");
  return createElement(Text, null, t("tui.loading", "Loading…"));
}

describe("react-i18next under the Ink reconciler", () => {
  it("renders a localized first frame synchronously", () => {
    const i18n = initCliI18n("en");
    const { lastFrame } = render(
      createElement(I18nextProvider, { i18n }, createElement(Loading)),
    );
    expect(lastFrame()).toContain("Loading…");
  });

  it("renders from a real catalog, not the defaultValue fallback", async () => {
    // t("tui.loading", "Loading…") can't distinguish a loaded catalog from the
    // inline defaultValue. A non-en lookup with no defaultValue proves the
    // bundled catalog itself resolved.
    const i18n = initCliI18n("en");
    await i18n.changeLanguage("fr");
    function FrLoading() {
      const { t } = useTranslation("cli");
      return createElement(Text, null, t("tui.loading"));
    }
    const { lastFrame } = render(
      createElement(I18nextProvider, { i18n }, createElement(FrLoading)),
    );
    expect(lastFrame()).toContain("Chargement…");
    await i18n.changeLanguage("en");
  });

  it("re-renders on changeLanguage", async () => {
    const i18n = initCliI18n("en");
    cliI18n.addResourceBundle("zh-CN", "cli", { tui: { loading: "加载中…" } }, true, true);
    const { lastFrame } = render(
      createElement(I18nextProvider, { i18n }, createElement(Loading)),
    );
    expect(lastFrame()).toContain("Loading…");
    await i18n.changeLanguage("zh-CN");
    expect(lastFrame()).toContain("加载中…");
  });
});

// Keybinding accelerators must stay literal even inside translated hints.
function ProjectHint() {
  const { t } = useTranslation("cli");
  return createElement(
    Text,
    null,
    t("tui.switchProjectsHint", { key: "p", defaultValue: "Press [{{key}}] to switch projects." }),
  );
}

describe("CLI string migration", () => {
  it("renders the migrated en label", () => {
    const i18n = initCliI18n("en");
    function Tasks() {
      const { t } = useTranslation("cli");
      return createElement(Text, null, t("tui.loadingTasks", "Loading tasks…"));
    }
    const { lastFrame } = render(
      createElement(I18nextProvider, { i18n }, createElement(Tasks)),
    );
    expect(lastFrame()).toContain("Loading tasks…");
  });

  it("keeps the [p] accelerator literal in an interpolated hint", () => {
    const i18n = initCliI18n("en");
    const { lastFrame } = render(
      createElement(I18nextProvider, { i18n }, createElement(ProjectHint)),
    );
    expect(lastFrame()).toContain("[p]");
    expect(lastFrame()).toContain("Press");
  });
});
