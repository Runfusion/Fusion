import i18next, { type Resource } from "i18next";
import { describe, expect, it } from "vitest";
import { baseInitOptions, FALLBACK_LNG, normalizeToSupportedLocale } from "../config.js";

/**
 * FNXC:i18n-Fallback 2026-06-20-00:00:
 * Secondary locale catalogs intentionally keep untranslated entries as empty strings, so runtime fallback must prefer the en source instead of rendering blanks.
 * These in-memory fixtures exercise real i18next options for translated, empty, missing, and unsupported-locale boundary cases without loading catalogs or spawning gate commands.
 */

const resources = {
  en: {
    common: {
      translated: "English translated source",
      empty: "English empty fallback",
      absent: "English absent fallback",
      defaultFallback: "English default fallback",
    },
  },
  fr: {
    common: {
      translated: "Valeur française",
      empty: "",
    },
  },
} satisfies Resource;

async function createFixtureInstance(lng: string) {
  const instance = i18next.createInstance();
  await instance.init({
    ...baseInitOptions(),
    resources,
    lng,
    ns: ["common"],
    defaultNS: "common",
  });
  return instance;
}

describe("locale fallback boundary cases", () => {
  it("uses translated values and falls back to en for empty or absent secondary values", async () => {
    const instance = await createFixtureInstance("fr");

    expect(instance.t("translated")).toBe("Valeur française");
    expect(instance.t("empty")).toBe("English empty fallback");
    expect(instance.t("absent")).toBe("English absent fallback");
  });

  it("normalizes known locale tags and rejects unsupported tags", () => {
    expect(normalizeToSupportedLocale("en-US")).toBe("en");
    expect(normalizeToSupportedLocale("zh-Hant-HK")).toBe("zh-TW");
    expect(normalizeToSupportedLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeToSupportedLocale("xx")).toBeUndefined();
  });

  it("resolves unsupported runtime languages through the default en fallback chain", async () => {
    const instance = await createFixtureInstance("xx");

    expect(FALLBACK_LNG.default).toEqual(["en"]);
    expect(instance.t("defaultFallback")).toBe("English default fallback");
  });

  it("keeps Simplified and Traditional Chinese catalogs from collapsing", () => {
    const options = baseInitOptions();

    expect(options.load).toBe("currentOnly");
    expect(options.nonExplicitSupportedLngs).toBe(false);
    expect(normalizeToSupportedLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeToSupportedLocale("zh-TW")).toBe("zh-TW");
    expect(normalizeToSupportedLocale("zh")).toBe("zh-CN");
  });
});
