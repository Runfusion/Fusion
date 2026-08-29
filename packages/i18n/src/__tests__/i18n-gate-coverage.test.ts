import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LOCALES } from "@fusion/core";
import { describe, expect, it } from "vitest";
import config from "../../../../i18next.config.ts";
import namespaces from "../../namespaces.json";
import { findParityViolations, type CatalogObject, type NamespaceCatalogs } from "../parity.js";

/**
 * FNXC:i18n-GateRegression 2026-06-20-00:00:
 * The post-localization dashboard must stay inside both i18n guardrails: future hardcoded dashboard copy cannot be hidden in lint.ignore, and future en keys must be synced structurally across every locale/namespace.
 * This test duplicates the gate invariants in fast Vitest coverage without shelling out, so CI catches drift even before a human reruns the i18n CLI commands.
 */

type Locale = (typeof SUPPORTED_LOCALES)[number];
type Namespace = (typeof namespaces.all)[number];

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const expectedNonShippingLintIgnores = ["**/__tests__/**", "**/*.test.*", "**/*.stories.*"];

const representativeDashboardFiles = {
  plugin: "packages/dashboard/app/components/PiExtensionsManager.tsx",
  agent: "packages/dashboard/app/components/AgentDetailView.tsx",
  mission: "packages/dashboard/app/components/MissionManager.tsx",
  node: "packages/dashboard/app/components/AddNodeModal.tsx",
  research: "packages/dashboard/app/components/ResearchView.tsx",
  document: "packages/dashboard/app/components/DocumentsView.tsx",
  activity: "packages/dashboard/app/components/ActivityFeed.tsx",
  workflow: "packages/dashboard/app/components/WorkflowSelector.tsx",
  task: "packages/dashboard/app/components/TaskDetailModal.tsx",
  setup: "packages/dashboard/app/components/SetupWizardModal.tsx",
  pr: "packages/dashboard/app/components/PullRequestView.tsx",
  settings: "packages/dashboard/app/components/settings/sections/GeneralSection.tsx",
} as const;

function readCatalog(locale: Locale, namespace: Namespace): CatalogObject {
  const path = `${repoRoot}/packages/i18n/locales/${locale}/${namespace}.json`;
  return JSON.parse(readFileSync(path, "utf8")) as CatalogObject;
}

function readCatalogs(locale: Locale): NamespaceCatalogs {
  return Object.fromEntries(namespaces.all.map((namespace) => [namespace, readCatalog(locale, namespace)]));
}

function getStringAtPath(catalog: CatalogObject, path: string): string | undefined {
  const value = path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
  return typeof value === "string" ? value : undefined;
}

describe("i18n gate regression coverage", () => {
  it("keeps dashboard source files under the hardcoded-string lint gate", () => {
    expect(config.lint?.ignore).toEqual(expectedNonShippingLintIgnores);
    expect(config.lint?.ignoredTags).toEqual(["kbd"]);

    for (const [area, file] of Object.entries(representativeDashboardFiles)) {
      expect(config.lint?.ignore, `${area} representative must not be ignored`).not.toContain(file);
    }
    expect(config.lint?.ignore?.filter((entry) => entry.includes("packages/dashboard/app/"))).toEqual([]);
  });

  it("keeps real catalogs in key parity across every supported locale and namespace", () => {
    expect(config.locales).toEqual([...SUPPORTED_LOCALES]);
    expect(namespaces.all).toEqual(["common", "app", "errors", "cli"]);

    const enCatalogs = readCatalogs("en");
    for (const locale of SUPPORTED_LOCALES.filter((locale) => locale !== "en")) {
      expect(findParityViolations(enCatalogs, readCatalogs(locale), { locale })).toEqual([]);
    }
  });

  it("keeps the top-level documents destination renamed to Artifacts while preserving keys", () => {
    const enApp = readCatalog("en", "app");
    expect(getStringAtPath(enApp, "nav.documents")).toBe("Artifacts");
    expect(getStringAtPath(enApp, "documents.title")).toBe("Artifacts");
    expect(getStringAtPath(enApp, "header.documentsView")).toBe("Artifacts view");

    for (const locale of SUPPORTED_LOCALES) {
      const app = readCatalog(locale, "app");
      for (const keyPath of ["nav.documents", "documents.title", "header.documentsView"]) {
        expect(getStringAtPath(app, keyPath), `${locale} app.${keyPath}`).toBeTruthy();
      }
    }
  });
});
