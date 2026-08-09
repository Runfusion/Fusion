import { SUPPORTED_LOCALES } from "@fusion/core";
import { describe, expect, it } from "vitest";
import { cliResources } from "../cli-catalogs.js";
import {
  baseInitOptions,
  CLI_NAMESPACES,
  DASHBOARD_NAMESPACES,
  DEFAULT_NAMESPACE,
  FALLBACK_LNG,
  NAMESPACES,
  normalizeToSupportedLocale,
} from "../config.js";

describe("@fusion/i18n config", () => {
  it("dashboard and cli namespaces are subsets of NAMESPACES", () => {
    for (const ns of [...DASHBOARD_NAMESPACES, ...CLI_NAMESPACES]) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  it("defaults to the common namespace", () => {
    expect(DEFAULT_NAMESPACE).toBe("common");
  });

  it("keeps zh-CN and zh-TW separate (load: currentOnly)", () => {
    const opts = baseInitOptions();
    expect(opts.load).toBe("currentOnly");
    expect(opts.supportedLngs).toEqual([...SUPPORTED_LOCALES]);
    expect(opts.interpolation?.escapeValue).toBe(false);
  });

  it("routes Chinese scripts and defaults everything else to en", () => {
    expect(FALLBACK_LNG.zh).toEqual(["zh-CN"]);
    expect(FALLBACK_LNG["zh-Hans"]).toEqual(["zh-CN"]);
    expect(FALLBACK_LNG["zh-Hant"]).toEqual(["zh-TW"]);
    expect(FALLBACK_LNG.pt).toEqual(["pt-BR"]);
    expect(FALLBACK_LNG["pt-PT"]).toEqual(["pt-BR"]);
    expect(FALLBACK_LNG.default).toEqual(["en"]);
  });

  it("ships a CLI catalog map for every supported locale and namespace", () => {
    for (const lng of SUPPORTED_LOCALES) {
      expect(cliResources).toHaveProperty(lng);
      for (const ns of CLI_NAMESPACES) {
        expect(cliResources[lng]).toHaveProperty(ns);
      }
    }
  });

  it("has real en content (catalogs wired, not empty)", () => {
    expect(cliResources.en.cli).toMatchObject({ tui: { loading: expect.any(String) } });
    expect(cliResources.en.common).toMatchObject({ inline: { online: "Online" } });
  });

  it("keeps dashboard/cli namespace lists as subsets of the canonical set", () => {
    for (const ns of [...DASHBOARD_NAMESPACES, ...CLI_NAMESPACES]) {
      expect(NAMESPACES).toContain(ns);
    }
    // The shared json source drives all three: config + the two build scripts.
    expect([...NAMESPACES]).toEqual(["common", "app", "errors", "cli"]);
  });
});

describe("normalizeToSupportedLocale", () => {
  it("passes through exact supported codes", () => {
    expect(normalizeToSupportedLocale("en")).toBe("en");
    expect(normalizeToSupportedLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeToSupportedLocale("zh-TW")).toBe("zh-TW");
  });

  it("resolves Traditional-script/region Chinese to zh-TW", () => {
    expect(normalizeToSupportedLocale("zh-Hant")).toBe("zh-TW");
    expect(normalizeToSupportedLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(normalizeToSupportedLocale("zh_HK")).toBe("zh-TW");
    expect(normalizeToSupportedLocale("zh-MO")).toBe("zh-TW");
  });

  it("resolves Simplified/other Chinese to zh-CN", () => {
    expect(normalizeToSupportedLocale("zh")).toBe("zh-CN");
    expect(normalizeToSupportedLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeToSupportedLocale("zh-SG")).toBe("zh-CN");
  });

  it("lets an explicit Simplified script win over a Traditional-leaning region", () => {
    // zh-Hans-HK / zh-Hans-MO are valid BCP-47: Simplified script in HK/Macau.
    expect(normalizeToSupportedLocale("zh-Hans-HK")).toBe("zh-CN");
    expect(normalizeToSupportedLocale("zh-Hans-MO")).toBe("zh-CN");
    expect(normalizeToSupportedLocale("zh_Hans_HK")).toBe("zh-CN");
    // And the reverse stays Traditional regardless of region.
    expect(normalizeToSupportedLocale("zh-Hant-CN")).toBe("zh-TW");
  });

  it("strips region subtags on other languages and rejects unsupported", () => {
    expect(normalizeToSupportedLocale("fr-FR")).toBe("fr");
    expect(normalizeToSupportedLocale("es-419")).toBe("es");
    expect(normalizeToSupportedLocale("de-DE")).toBeUndefined();
    expect(normalizeToSupportedLocale("")).toBeUndefined();
  });

  it("resolves any-region Portuguese to pt-BR", () => {
    expect(normalizeToSupportedLocale("pt")).toBe("pt-BR");
    expect(normalizeToSupportedLocale("pt-PT")).toBe("pt-BR");
    expect(normalizeToSupportedLocale("pt_PT.UTF-8")).toBe("pt-BR");
    expect(normalizeToSupportedLocale("ptx")).toBeUndefined();
  });
});
