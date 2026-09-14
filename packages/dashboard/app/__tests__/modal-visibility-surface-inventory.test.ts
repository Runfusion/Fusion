import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../test/cssFixture";

const managedPortalPrimitives = [
  "AlphaMobileDrawer.tsx",
  "FloatingWindow.tsx",
  "alpha-ui/AlphaPrimitives.tsx",
] as const;

const modalPortalRoots = [
  "ConfirmDialog.tsx",
  "NewAgentDialog.tsx",
  "NewTaskModal.tsx",
  "ProviderLoginDialog.tsx",
  "TaskDetailModal.tsx",
  "TerminalModal.tsx",
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

const nonModalPortalExclusions = [
  "Board.tsx",
  "ChatThinkingLevelControl.tsx",
  "CustomModelDropdown.tsx",
  "DashboardWindowVisibilityToggle.tsx",
  "ExecutorStatusBar.tsx",
  "GraphWorkflowSwitcherSlot.tsx",
  "HeaderWorkflowSwitcherSlot.tsx",
  "InlineCreateCard.tsx",
  "ListView.tsx",
  "QuickEntryBox.tsx",
  "ReportActionMenu.tsx",
  "TaskCard.tsx",
  "TaskChatTab.tsx",
  "TaskPlannerChatTab.tsx",
  "WorkflowNodeEditor.tsx",
  "WorkflowOptionalStepsDropdown.tsx",
  "WorkflowSwitcher.tsx",
] as const;

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
      expect(source, file).toMatch(/(?:role=["']dialog["']|aria-modal|floating-window|mobile-drawer|AlphaDialog)/);
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

  it("wires the shared window-manager context into portal primitives when that module is present", () => {
    const contextSource = readOptionalAppFile("context/DashboardWindowManagerContext.tsx");
    if (contextSource === undefined) return;

    expect(contextSource).toMatch(/createContext/);
    expect(contextSource).toMatch(/(?:Provider|useDashboardWindowManager)/);

    for (const file of ["FloatingWindow.tsx", "AlphaMobileDrawer.tsx"]) {
      expect(readAppFile(`components/${file}`), file).toMatch(/DashboardWindowManager/);
    }
  });
});
