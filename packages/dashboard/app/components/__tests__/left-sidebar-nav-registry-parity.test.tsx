import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { DASHBOARD_VIEWS } from "../../../src/shared/dashboard-views";

/*
FNXC:UiMetadataApi 2026-07-14-00:00:
`ui-metadata-sync.test.ts` proves the /api/views payload equals the shared view
registry, but the desktop sidebar (LeftSidebarNav) still hand-writes one nav
entry per view with a hardcoded i18n key + registry-derived English fallback.
Nothing there is derived from the same source the sync test compares, so a
registry↔sidebar drift (e.g. renaming a view's `labelKey`) would ship silently.

This test renders LeftSidebarNav with every feature flag enabled and captures
each `t(key, fallback)` call. For every view id the sidebar is contracted to
surface, it asserts the sidebar invoked translation with EXACTLY the registry's
`labelKey` and `label`. That pins the hardcoded keys/fallbacks to the registry:
change a registry entry (or re-hardcode a wrong key in the sidebar) and this
fails. The fallback half is registry-derived in the component already, but the
key half is the real drift risk, and this is the assertion that closes it.
*/

const { tCalls } = vi.hoisted(() => ({
  tCalls: [] as Array<{ key: string; fallback: unknown }>,
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown) => {
        tCalls.push({ key, fallback });
        return typeof fallback === "string" ? fallback : key;
      },
    }),
  };
});

// Imported after the mock so LeftSidebarNav binds the recording `t`.
import { LeftSidebarNav } from "../LeftSidebarNav";

/*
View ids the desktop sidebar renders with registry-derived labels, in the order
declared by LeftSidebarNav. Deliberately excluded and why:
  - graph / compound: surfaced via plugin dashboard-view entries whose labels
    come from the plugin manifest, not this registry.
  - todos / secrets / dev-server / pull-requests: intentionally NOT primary
    sidebar destinations (right dock / overflow / mobile More-sheet).
  - task-detail: internal, non-navigable destination.
*/
const SIDEBAR_REGISTRY_VIEW_IDS = [
  "command-center",
  "board",
  "list",
  "patchnode",
  "planning",
  "missions",
  "agents",
  "chat",
  "mailbox",
  "recommendations",
  "skills",
  "memory",
  "documents",
  "goalsView",
  "automations",
  "import-tasks",
  "workflows",
  "insights",
  "research",
  "ideation",
  "evals",
  "settings",
] as const;

describe("LeftSidebarNav ↔ dashboard view registry parity", () => {
  it("renders each surfaced view with its registry labelKey and English fallback", () => {
    tCalls.length = 0;

    const { container } = render(
      <LeftSidebarNav
        view="board"
        onChangeView={() => {}}
        onNewTask={() => {}}
        onOpenSettings={() => {}}
        showAgentsTab
        showSkillsTab
        experimentalFeatures={{
          insights: true,
          memoryView: true,
          devServerView: true,
          researchView: true,
          evalsView: true,
          ideationView: true,
          goalsView: true,
        }}
      />,
    );

    /*
    FNXC:UiMetadataApi 2026-07-14-00:00:
    SIDEBAR_REGISTRY_VIEW_IDS is hand-maintained, so pinning only the ids it already
    lists would let a newly added sidebar destination skip this check entirely. Counting
    the rendered non-plugin destinations makes enrolment mandatory: a new entry fails here
    until it is added to the list above (and therefore to the registry parity assertions).
    */
    const NON_DESTINATION_CONTROLS = new Set(["new-task", "collapse-toggle", "resize-handle"]);
    const renderedDestinationIds = [...container.querySelectorAll("[data-testid^='sidebar-nav-']")]
      .map((element) => element.getAttribute("data-testid")!.replace("sidebar-nav-", ""))
      .filter((id) => !id.startsWith("plugin-") && !NON_DESTINATION_CONTROLS.has(id));
    expect(
      renderedDestinationIds.length,
      `LeftSidebarNav rendered ${renderedDestinationIds.length} destinations ` +
        `(${renderedDestinationIds.join(", ")}) but SIDEBAR_REGISTRY_VIEW_IDS lists ` +
        `${SIDEBAR_REGISTRY_VIEW_IDS.length}. Enrol the new destination above so its ` +
        `registry labelKey and English fallback are pinned too.`,
    ).toBe(SIDEBAR_REGISTRY_VIEW_IDS.length);

    const registryById = new Map(DASHBOARD_VIEWS.map((view) => [view.id, view]));

    for (const id of SIDEBAR_REGISTRY_VIEW_IDS) {
      const registryEntry = registryById.get(id);
      expect(registryEntry, `sidebar view id "${id}" is missing from the shared registry`).toBeDefined();

      const matched = tCalls.some(
        (call) => call.key === registryEntry!.labelKey && call.fallback === registryEntry!.label,
      );
      expect(
        matched,
        `LeftSidebarNav must render view "${id}" via t("${registryEntry!.labelKey}", "${registryEntry!.label}"); ` +
          `no matching translation call was made. Sidebar and registry have drifted.`,
      ).toBe(true);
    }
  });
});
