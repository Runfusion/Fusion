import { DASHBOARD_VIEWS } from "../shared/dashboard-views.js";
import { SETTINGS_SECTION_METADATA } from "../shared/settings-sections.js";
import type { ApiRouteRegistrar } from "./types.js";

export function buildViewsPayload() {
  return {
    views: DASHBOARD_VIEWS.map((view) => ({
      id: view.id,
      label: view.label,
      ...(view.labelKey ? { labelKey: view.labelKey } : {}),
      ...(view.aliases ? { aliases: [...view.aliases] } : {}),
      ...(view.internal ? { internal: true } : {}),
    })),
  };
}

export function buildSettingsSectionsPayload() {
  return {
    sections: SETTINGS_SECTION_METADATA
      .filter((section) => !section.isGroupHeader)
      .map((section) => ({
        id: section.id,
        label: section.label,
        labelKey: section.labelKey,
        scope: section.scope ?? null,
        group: section.group,
        keywords: section.searchableText ? [...section.searchableText] : [],
        // `keywords` and `searchableKeys` are best-effort, non-contractual search
        // hints, not a stable API surface. `searchableKeys` exposes raw i18n
        // translation-key strings backing a section's searchable copy; their
        // values/ordering/presence may change between releases. Consumers should
        // use them to widen search matching, never as stable identifiers.
        searchableKeys: section.searchableKeys ? [...section.searchableKeys] : [],
        advanced: section.advanced,
      })),
  };
}

/*
FNXC:UiMetadataApi 2026-07-14-00:00:
These authenticated read-only routes return project-independent static metadata. They deliberately do not call getScopedStore or touch TaskStore; request-scoped store resolution is required only for routes that access project state, while standard /api authentication is inherited from the server mount.
*/
export const registerUiMetadataRoutes: ApiRouteRegistrar = ({ router }) => {
  router.get("/views", (_req, res) => {
    res.json(buildViewsPayload());
  });

  router.get("/settings/sections", (_req, res) => {
    res.json(buildSettingsSectionsPayload());
  });
};
