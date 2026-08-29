import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findParityViolations, type CatalogObject, type NamespaceCatalogs } from "../parity.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = join(packageRoot, "..", "..");
const localesRoot = join(packageRoot, "locales");

function listSupportedLocales() {
  const configText = readFileSync(join(repoRoot, "i18next.config.ts"), "utf8");
  const localesMatch = configText.match(/locales:\s*\[([^\]]+)\]/m);
  if (!localesMatch) {
    throw new Error("Unable to read locales from i18next.config.ts");
  }
  return [...localesMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function listNamespaces() {
  return readdirSync(join(localesRoot, "en"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => basename(entry.name, ".json"))
    .sort();
}

function readCatalog(locale: string, namespace: string): CatalogObject {
  return JSON.parse(readFileSync(join(localesRoot, locale, `${namespace}.json`), "utf8")) as CatalogObject;
}

function readCatalogs(locale: string, namespaces = listNamespaces()): NamespaceCatalogs {
  return Object.fromEntries(namespaces.map((namespace) => [namespace, readCatalog(locale, namespace)]));
}

describe("i18n key parity", () => {
  /*
   * FNXC:i18n-ParityGate 2026-08-13-22:06:
   * FN-9036 pins githubNativeAutoMerge catalog structure across configured secondary locales so a regression is caught by package tests rather than only i18n:status.
   * The configured locale list is parsed with the same contract as the parity gate, keeping future locale additions covered automatically.
   */
  it("passes for live catalogs and pins GitHub native auto-merge keys across configured locales", () => {
    const supportedLocales = listSupportedLocales();
    const secondaryLocales = supportedLocales.filter((locale) => locale !== "en");
    expect(supportedLocales).toEqual(["en", "zh-CN", "zh-TW", "fr", "es", "ko", "pt-BR"]);
    expect(listNamespaces()).toEqual(["app", "cli", "common", "errors"]);

    const enCatalogs = readCatalogs("en");
    for (const locale of secondaryLocales) {
      expect(findParityViolations(enCatalogs, readCatalogs(locale), { locale })).toEqual([]);

      const mergeSettings = readCatalog(locale, "app").settings?.merge;
      expect(mergeSettings).toHaveProperty("githubNativeAutoMerge");
      expect(mergeSettings).toHaveProperty("githubNativeAutoMergeHelp");
    }
  });

  it("reports an absent key but allows an empty present value", () => {
    const enCatalogs: NamespaceCatalogs = {
      common: {
        nav: {
          home: "Home",
          settings: "Settings",
        },
      },
    };

    expect(
      findParityViolations(
        enCatalogs,
        {
          common: {
            nav: {
              home: "Accueil",
              settings: "",
            },
          },
        },
        { locale: "fr" },
      ),
    ).toEqual([]);

    expect(
      findParityViolations(
        enCatalogs,
        {
          common: {
            nav: {
              home: "Accueil",
            },
          },
        },
        { locale: "fr" },
      ),
    ).toEqual([
      {
        locale: "fr",
        namespace: "common",
        kind: "absent",
        key: "nav.settings",
      },
    ]);
  });

  it("normalizes plural-category suffixes before comparing structure", () => {
    const enCatalogs: NamespaceCatalogs = {
      app: {
        inbox: {
          task_one: "{{count}} task",
          task_other: "{{count}} tasks",
        },
      },
    };
    const localeCatalogs: NamespaceCatalogs = {
      app: {
        inbox: {
          task_many: "",
          task_other: "",
        },
      },
    };

    expect(findParityViolations(enCatalogs, localeCatalogs, { locale: "fr" })).toEqual([]);
  });

  it("reports orphan keys that exist only in a secondary locale", () => {
    expect(
      findParityViolations(
        {
          errors: {
            general: "Something went wrong",
          },
        },
        {
          errors: {
            general: "",
            stale: "Old copy",
          },
        },
        { locale: "es" },
      ),
    ).toEqual([
      {
        locale: "es",
        namespace: "errors",
        kind: "orphan",
        key: "stale",
      },
    ]);
  });
});
