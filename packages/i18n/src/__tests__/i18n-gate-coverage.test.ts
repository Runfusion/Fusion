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

  /*
   * FNXC:i18n-CatalogParity 2026-09-22-00:40:
   * Restored archive, snippets, and workflow labels must resolve from each selected catalog.
   * Raw-catalog assertions prevent English fallback from hiding a future missing-key regression.
   */
  it("keeps repaired archive, snippets, and workflow copy translated in every secondary app catalog", () => {
    for (const locale of SUPPORTED_LOCALES.filter((locale) => locale !== "en")) {
      const app = readCatalog(locale, "app");
      for (const keyPath of ["board.archived", "skills.snippetsTitle", "workflowSwitcher.plan"]) {
        expect(getStringAtPath(app, keyPath), `${locale} app.${keyPath}`).toBeTruthy();
      }
    }
  });

  /*
   * FNXC:i18n-CatalogParity 2026-09-22-00:56:
   * Restored Antigravity and workflow state entries must preserve the meaning of each source string.
   * A non-empty generic category label masks missing translations just as effectively as fallback copy.
   */
  /*
   * FNXC:i18n-CatalogParity 2026-09-22-01:13:
   * Restored archive, scheduling, validation, provider, and workflow entries each describe a distinct UI state.
   * Keep the raw catalog values distinct so a generic category label cannot silently replace source-specific copy.
   */
  it("keeps restored provider, archive, settings, validation, and workflow states distinct", () => {
    for (const locale of SUPPORTED_LOCALES.filter((locale) => locale !== "en")) {
      const app = readCatalog(locale, "app");
      const providerName = getStringAtPath(app, "setup.antigravityCli.providerName");
      const providerStates = [
        "setup.antigravityCli.binaryNotFound",
        "setup.antigravityCli.binaryPathPlaceholder",
        "setup.antigravityCli.connected",
        "setup.antigravityCli.enable",
      ].map((keyPath) => getStringAtPath(app, keyPath));
      expect(providerName, `${locale} Antigravity provider name`).toContain("agy");
      expect(providerStates, `${locale} Antigravity states`).not.toContain(providerName);

      const archiveValues = [
        "column.collapseArchivedLabel",
        "column.expandArchivedLabel",
        "listView.archiveUnavailable",
        "listView.bulkArchiveNoTasks",
        "settings.scheduling.archiveAgentLog",
        "settings.scheduling.autoArchiveDuplicateTasksHelp",
        "scriptsModal.nameErrorMsg",
        "scriptsModal.nameHint",
      ].map((keyPath) => getStringAtPath(app, keyPath));
      expect(archiveValues, `${locale} archive, settings, and validation copy`).not.toContain("");
      expect(archiveValues[0], `${locale} archive collapse action`).not.toBe(archiveValues[1]);
      expect(archiveValues[2], `${locale} archive unavailable state`).not.toBe(archiveValues[3]);
      expect(archiveValues[4], `${locale} archive setting label`).not.toBe(archiveValues[5]);
      expect(archiveValues[6], `${locale} script validation`).not.toBe(archiveValues[7]);

      const workflowStates = ["workflowSwitcher.todo", "workflowSwitcher.inProgress", "workflowSwitcher.done"].map((keyPath) =>
        getStringAtPath(app, keyPath),
      );
      expect(new Set(workflowStates).size, `${locale} workflow states`).toBe(workflowStates.length);
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
