import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LOCALES } from "@fusion/core";
import { describe, expect, it } from "vitest";
import { findParityViolations, type CatalogObject, type NamespaceCatalogs } from "../parity.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const localesRoot = join(packageRoot, "locales");

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
  it("passes for the live catalogs across all supported locales and en namespaces", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "zh-CN", "zh-TW", "fr", "es", "ko", "pt-BR"]);
    expect(listNamespaces()).toEqual(["app", "cli", "common", "errors"]);

    const enCatalogs = readCatalogs("en");
    for (const locale of SUPPORTED_LOCALES) {
      expect(findParityViolations(enCatalogs, readCatalogs(locale), { locale })).toEqual([]);
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
