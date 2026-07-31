import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_VIEW_IDS,
  DASHBOARD_VIEWS,
} from "../../../src/shared/dashboard-views";
import { SETTINGS_SECTION_METADATA } from "../../../src/shared/settings-sections";
import {
  buildSettingsSectionsPayload,
  buildViewsPayload,
} from "../../../src/routes/register-ui-metadata-routes";
import {
  ADVANCED_SETTINGS_SECTION_IDS,
  SETTINGS_SECTIONS,
} from "../SettingsModal";
import { BUILT_IN_TASK_VIEWS } from "../../hooks/useViewState";
import {
  EXCLUDED_RESET_SECTIONS,
  GLOBAL_SECTION_KEYS,
  PROJECT_SECTION_KEYS,
  getSectionKeyEntry,
} from "../settings/section-keys";

function uiComparable(section: (typeof SETTINGS_SECTIONS)[number]) {
  return {
    id: section.id,
    label: section.label,
    labelKey: section.labelKey,
    scope: section.scope,
    isGroupHeader: section.isGroupHeader,
    searchableText: section.searchableText,
    searchableKeys: section.searchableKeys,
  };
}

function metadataComparable(section: (typeof SETTINGS_SECTION_METADATA)[number]) {
  return {
    id: section.id,
    label: section.label,
    labelKey: section.labelKey,
    scope: section.scope,
    isGroupHeader: section.isGroupHeader,
    searchableText: section.searchableText,
    searchableKeys: section.searchableKeys,
  };
}

describe("shared UI metadata no-drift contract", () => {
  it("keeps Settings navigation and advanced visibility derived from metadata", () => {
    expect(SETTINGS_SECTIONS.map(uiComparable)).toEqual(SETTINGS_SECTION_METADATA.map(metadataComparable));
    expect([...ADVANCED_SETTINGS_SECTION_IDS]).toEqual(
      SETTINGS_SECTION_METADATA.filter((section) => section.advanced).map((section) => section.id),
    );
  });

  it("keeps each section's served group equal to the group header it renders under", () => {
    // `group` is the only metadata field the Settings list does not itself render, so it is
    // pinned to the navigation structure the user actually sees: the nearest preceding header.
    let renderedGroup: string | undefined;
    for (const section of SETTINGS_SECTIONS) {
      if (section.isGroupHeader) {
        renderedGroup = section.label;
        continue;
      }
      const metadata = SETTINGS_SECTION_METADATA.find((entry) => entry.id === section.id);
      expect(metadata, `Missing Settings metadata for rendered section ${section.id}`).toBeDefined();
      expect(metadata!.group, `Wrong group for ${section.id}`).toBe(renderedGroup);
    }
    expect(renderedGroup).toBeDefined();
  });

  it("keeps persisted built-in views equal to canonical ids plus declared aliases", () => {
    const expectedViews = DASHBOARD_VIEWS.flatMap((view) => [...(view.aliases ?? []), view.id]);
    expect(BUILT_IN_TASK_VIEWS).toEqual(expectedViews);
    expect(DASHBOARD_VIEWS.map((view) => view.id)).toEqual(DASHBOARD_VIEW_IDS);
    expect(new Set(BUILT_IN_TASK_VIEWS).size).toBe(BUILT_IN_TASK_VIEWS.length);
  });

  /*
  FNXC:UiMetadataApi 2026-07-14-00:00:
  A published labelKey is only useful to an external consumer if resolving it yields a
  string. Pointing one at an i18n *namespace* (for example `taskDetail.title`, which owns
  `taskDetail.title.summarize`) hands the consumer an object — and because the object
  branch precedes defaultValue, the caller's fallback never applies. Neither registry may
  advertise a key that collides with a non-leaf node in the shipped catalog.

  This deliberately does NOT require every key to be present: the dashboard supplies much
  of its English inline as a t() default, so most nav and settings keys are legitimately
  absent from the catalog until they are extracted. An absent key degrades to the caller's
  own fallback, which is why the payload always carries `label`; a namespace collision does
  not degrade, it returns the wrong type.
  */
  it("never advertises a labelKey that resolves to a non-leaf i18n node", () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, "../../../../i18n/locales/en/app.json"), "utf8"),
    ) as Record<string, unknown>;
    const resolveKey = (key: string): unknown =>
      key.split(".").reduce<unknown>(
        (node, part) =>
          node && typeof node === "object" && part in (node as Record<string, unknown>)
            ? (node as Record<string, unknown>)[part]
            : undefined,
        catalog,
      );

    const advertised = [
      ...DASHBOARD_VIEWS.map((view) => ({ source: "view", id: view.id, labelKey: view.labelKey })),
      ...SETTINGS_SECTION_METADATA.map((section) => ({
        source: "settings section",
        id: section.id,
        labelKey: section.labelKey,
      })),
    ].filter((entry) => entry.labelKey);
    expect(advertised.length).toBeGreaterThan(0);
    for (const entry of advertised) {
      const resolved = resolveKey(entry.labelKey!);
      expect(
        typeof resolved === "object" && resolved !== null,
        `${entry.source} "${entry.id}" advertises labelKey "${entry.labelKey}", which is an i18n namespace, not a string`,
      ).toBe(false);
    }
  });

  it("keeps every settings reset-registry id backed by section metadata", () => {
    const metadataIds = new Set(SETTINGS_SECTION_METADATA.map((section) => section.id));
    const resetRegistryIds = new Set([
      ...Object.keys(GLOBAL_SECTION_KEYS),
      ...Object.keys(PROJECT_SECTION_KEYS),
      ...Object.keys(EXCLUDED_RESET_SECTIONS),
    ]);

    for (const sectionId of resetRegistryIds) {
      expect(metadataIds, `Missing Settings metadata for reset registry id ${sectionId}`).toContain(sectionId);
      if (!EXCLUDED_RESET_SECTIONS[sectionId]) {
        expect(getSectionKeyEntry(sectionId), `Missing reset entry for ${sectionId}`).not.toBeNull();
      }
    }
  });

  it("serves payloads built directly from the UI registries", () => {
    const viewsPayload = buildViewsPayload();
    const expectedViews = DASHBOARD_VIEWS.map((view) => ({
      id: view.id,
      label: view.label,
      ...(view.labelKey ? { labelKey: view.labelKey } : {}),
      ...(view.aliases ? { aliases: [...view.aliases] } : {}),
      ...(view.internal ? { internal: true } : {}),
    }));
    expect(viewsPayload.views).toEqual(expectedViews);
    expect(viewsPayload.views.map((view) => view.id)).toEqual(DASHBOARD_VIEW_IDS);

    const sectionsPayload = buildSettingsSectionsPayload();
    const selectableUiSections = SETTINGS_SECTIONS.filter((section) => !section.isGroupHeader);
    expect(sectionsPayload.sections.map((section) => section.id)).toEqual(
      selectableUiSections.map((section) => section.id),
    );
    for (const served of sectionsPayload.sections) {
      const source = SETTINGS_SECTION_METADATA.find((section) => section.id === served.id);
      expect(source).toBeDefined();
      expect(served).toEqual({
        id: source!.id,
        label: source!.label,
        labelKey: source!.labelKey,
        scope: source!.scope ?? null,
        group: source!.group,
        keywords: source!.searchableText ? [...source!.searchableText] : [],
        searchableKeys: source!.searchableKeys ? [...source!.searchableKeys] : [],
        advanced: source!.advanced,
      });
    }
  });
});
