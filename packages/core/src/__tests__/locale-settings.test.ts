import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_LOCALE,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
  isLocale,
  isProjectSettingsKey,
  type Locale,
  SUPPORTED_LOCALES,
  validateLocale,
} from "../index.js";

describe("locale primitives", () => {
  it("exposes exactly the seven supported locale codes", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "zh-CN", "zh-TW", "fr", "es", "ko", "pt-BR"]);
  });

  it("uses en as the default/source locale", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expectTypeOf<Locale>().toEqualTypeOf<"en" | "zh-CN" | "zh-TW" | "fr" | "es" | "ko" | "pt-BR">();
  });

  it("narrows supported codes and rejects everything else via isLocale", () => {
    for (const code of SUPPORTED_LOCALES) {
      expect(isLocale(code)).toBe(true);
    }
    expect(isLocale("zh")).toBe(false);
    expect(isLocale("pt")).toBe(false);
    expect(isLocale("de")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

describe("language global setting", () => {
  it("registers language as a global-only settings key", () => {
    expect(isGlobalSettingsKey("language")).toBe(true);
    expect(isProjectSettingsKey("language")).toBe(false);
    expect(GLOBAL_SETTINGS_KEYS).toContain("language");
  });

  it("defaults language to undefined (resolve-at-runtime, not persisted en)", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.language).toBeUndefined();
  });

  it("validates supported codes and rejects unsupported ones", () => {
    expect(validateLocale("en")).toBe("en");
    expect(validateLocale("zh-CN")).toBe("zh-CN");
    expect(validateLocale("zh-TW")).toBe("zh-TW");
    expect(validateLocale("fr")).toBe("fr");
    expect(validateLocale("es")).toBe("es");
    expect(validateLocale("pt-BR")).toBe("pt-BR");
    expect(validateLocale(undefined)).toBeUndefined();
    expect(validateLocale("zh")).toBeUndefined();
    expect(validateLocale("de")).toBeUndefined();
    expect(validateLocale("")).toBeUndefined();
    expect(validateLocale(null)).toBeUndefined();
    expect(validateLocale(42)).toBeUndefined();
  });

  it("round-trips a settings object without language unchanged (backward compat)", () => {
    const legacy = { themeMode: "dark", colorTheme: "default" } as const;
    const roundTripped = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    expect("language" in roundTripped).toBe(false);
    expect(validateLocale(roundTripped.language)).toBeUndefined();
  });
});
