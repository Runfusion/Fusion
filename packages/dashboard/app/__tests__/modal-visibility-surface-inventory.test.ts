import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../test/cssFixture";

const managedPortalPrimitives = [
  "MobileDrawer.tsx",
  "FloatingWindow.tsx",
  "ui/UiPrimitives.tsx",
] as const;

/*
FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
FN-394 re-hosted the confirmation, provider sign-in, agent-creation, and workflow-creation dialogs in the shared
FloatingWindow, which owns the single portal for them. They are therefore no longer their own portal roots.
*/
/*
FNXC:PopoverLayering 2026-09-15-09:31:
FN-413 portals the header-anchored Usage popover to document.body so its `--fusion-max-z`-derived layer is compared
in the root stacking context; that makes UsageIndicator its own portal root in addition to its FloatingWindow branch.
*/
const modalPortalRoots = [
  "NewTaskModal.tsx",
  "TaskDetailModal.tsx",
  "TerminalModal.tsx",
  "UsageIndicator.tsx",
] as const;

const declarativelyManagedDirectModalRoots = [
  "AgentErrorDetailsModal.tsx",
  "AgentPromptsManager.tsx",
  "BranchGroupCard.tsx",
  "DevServerView.tsx",
  "MissionManager.tsx",
  "ModelSelectionModal.tsx",
  "NativeShellConnectionManager.tsx",
  "NewAgentDialog.tsx",
  "NewTaskModal.tsx",
  "ProviderLoginDialog.tsx",
  "ReliabilityView.tsx",
  "ReportModal.tsx",
  "ResearchTaskActionModal.tsx",
  "SecretsView.tsx",
  "SettingsSyncConflictModal.tsx",
  "StashConflictModal.tsx",
  "StashRecoveryView.tsx",
  "TerminalModal.tsx",
  "UsageIndicator.tsx",
  "WorkflowNodeEditor.tsx",
  "WorkflowResultsTab.tsx",
  "settings/sections/ModelPricingSection.tsx",
] as const;

/*
FNXC:PopoverLayering 2026-09-17-05:20:
FN-488 classifies the three anchored, explicitly NON-modal portals that landed with the neighbouring search and
list-menu work (`aria-modal="false"` tool popover, `role="menu"` list context menu, non-modal task-search results
panel). They portal to document.body for root-context layering only; none is a window root, so none joins
`modalPortalRoots` or the declarative manager bridge.
*/
const nonModalPortalExclusions = [
  "Board.tsx",
  "ChatThinkingLevelControl.tsx",
  "CustomModelDropdown.tsx",
  "DashboardToolPopover.tsx",
  "DashboardWindowVisibilityToggle.tsx",
  "ExecutorStatusBar.tsx",
  "GraphWorkflowSwitcherSlot.tsx",
  "HeaderWorkflowSwitcherSlot.tsx",
  "InlineCreateCard.tsx",
  "ListItemContextMenu.tsx",
  "ListView.tsx",
  "QuickEntryBox.tsx",
  "ReportActionMenu.tsx",
  "TaskCard.tsx",
  "TaskChatTab.tsx",
  "TaskPlannerChatTab.tsx",
  "TaskSearchResultsPopover.tsx",
  /* FNXC:FloatingWindowDialogHosts 2026-09-14-22:36: FN-394 moved the workflow editor's last portal (the expanded prompt editor) into the shared window, so this file portals nothing itself. */
  "WorkflowOptionalStepsDropdown.tsx",
  "WorkflowSwitcher.tsx",
] as const;

/*
FNXC:DialogStacking 2026-09-14-17:46:
FN-392: every consumer of the shared native dialog primitive inherits one portal, one manager registration, and one live
layer claim. Enumerating them makes a new child dialog a conscious addition instead of a surface that silently reverts
to a static CSS z-index under its own parent window.
*/
/*
FNXC:TaskRefine 2026-09-14-22:23:
FN-400: TaskDetailModal no longer builds a dialog itself — its Refine composer became the standalone
TaskRefineDialog, which the card and the list row host directly instead of opening a task record.
*/
const sharedDialogPrimitiveConsumers = [
  "ChatView.tsx",
  "DuplicateWarningModal.tsx",
  "TaskRefineDialog.tsx",
  "TaskResetDialog.tsx",
] as const;

function sharedDialogPrimitiveHosts(): string[] {
  return listComponentFiles()
    .filter((file) => !file.includes("__tests__/") && !file.startsWith("ui/"))
    .filter((file) => /\b(?:UiDialog|UiDialogBackdrop)\b/.test(readAppFile(`components/${file}`)))
    .sort();
}

function directPortalHosts(): string[] {
  return listComponentFiles()
    .filter((file) => !file.includes("__tests__/"))
    .filter((file) => readAppFile(`components/${file}`).includes("createPortal("))
    .sort();
}

function readOptionalAppFile(path: string): string | undefined {
  try {
    return readAppFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

describe("modal visibility surface inventory", () => {
  it("classifies every component-level portal by its rendered construction", () => {
    const classified = [
      ...managedPortalPrimitives,
      ...modalPortalRoots,
      ...nonModalPortalExclusions,
    ].sort();

    expect(directPortalHosts()).toEqual(classified);
  });

  it("keeps managed primitives and direct modal roots structurally distinct from menu portals", () => {
    for (const file of managedPortalPrimitives) {
      const source = readAppFile(`components/${file}`);
      expect(source, file).toContain("createPortal(");
      expect(source, file).toMatch(/(?:role=["']dialog["']|aria-modal|floating-window|mobile-drawer|UiDialog)/);
    }

    for (const file of modalPortalRoots) {
      const source = readAppFile(`components/${file}`);
      expect(source, file).toContain("createPortal(");
      expect(source, file).toMatch(/(?:role=["']dialog["']|aria-modal|modal-overlay|<FloatingWindow)/);
    }

    for (const file of nonModalPortalExclusions) {
      expect(readAppFile(`components/${file}`), file).toContain("createPortal(");
    }
  });

  it("routes every autonomous direct modal root through the declarative manager bridge", () => {
    for (const file of declarativelyManagedDirectModalRoots) {
      const source = readAppFile(`components/${file}`);
      expect(source, file).toMatch(/(?:DashboardWindowSurfaceRoot|<FloatingWindow)/);
    }
  });

  it("routes every shared dialog consumer through one portaled, layered primitive", () => {
    expect(sharedDialogPrimitiveHosts()).toEqual([...sharedDialogPrimitiveConsumers].sort());

    const primitive = readAppFile("components/ui/UiPrimitives.tsx");
    expect(primitive).toContain("nextFloatingZ");
    expect(primitive).toContain("stackOrder");
    expect(primitive).toContain("useDashboardWindowFocusRestoring");
    /*
    Both dialog primitives return through the same unconditional portal helper. A dialog portaled only on the Alpha
    surface flag would render inside its parent's stacking context, where no layer can beat a sibling window.
    */
    expect(primitive).toContain("function portalDialog(");
    expect(primitive.match(/return portalDialog\(dialog\);/g) ?? []).toHaveLength(2);
  });

  it("wires the shared window-manager context into portal primitives when that module is present", () => {
    const contextSource = readOptionalAppFile("context/DashboardWindowManagerContext.tsx");
    if (contextSource === undefined) return;

    expect(contextSource).toMatch(/createContext/);
    expect(contextSource).toMatch(/(?:Provider|useDashboardWindowManager)/);

    for (const file of ["FloatingWindow.tsx", "MobileDrawer.tsx"]) {
      expect(readAppFile(`components/${file}`), file).toMatch(/DashboardWindowManager/);
    }
  });
});
