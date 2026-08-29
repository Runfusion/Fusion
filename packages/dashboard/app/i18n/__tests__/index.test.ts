import { beforeAll, describe, expect, it } from "vitest";
import i18n, { i18nReady, LANGUAGE_STORAGE_KEY } from "../index";

// Exercises the real dashboard i18next instance (not mocked): the languageChanged
// handler that mirrors the active locale onto <html lang> and the storage key.
describe("dashboard i18n runtime", () => {
  beforeAll(async () => {
    await i18nReady;
  });

  it("initializes to a supported locale and never blocks the app", () => {
    // i18nReady resolved above; init did not reject (main.tsx relies on this).
    expect(i18n.isInitialized).toBe(true);
  });

  it("uses the kb-dashboard-language storage key", () => {
    expect(LANGUAGE_STORAGE_KEY).toBe("kb-dashboard-language");
  });

  it("mirrors the active locale onto document.documentElement.lang", async () => {
    await i18n.changeLanguage("fr");
    expect(document.documentElement.lang).toBe("fr");
    await i18n.changeLanguage("zh-TW");
    expect(document.documentElement.lang).toBe("zh-TW");
  });
});
