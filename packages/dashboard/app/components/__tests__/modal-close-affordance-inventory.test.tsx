import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";

const canonicalConsumers = [
  "ActivityLogModal.tsx",
  "AddNodeModal.tsx",
  "AgentDetailView.tsx",
  "AgentErrorDetailsModal.tsx",
  "AgentGenerationModal.tsx",
  "AgentImportModal.tsx",
  "AgentListModal.tsx",
  "AgentOnboardingModal.tsx",
  "ArtifactImageViewer.tsx",
  "ArtifactsGallery.tsx",
  "ChangesDiffModal.tsx",
  "ConfirmDialog.tsx",
  "ConnectNodeModal.tsx",
  "CreateRoomModal.tsx",
  "DevServerView.tsx",
  "DockerNodeOnboardingModal.tsx",
  "ExperimentalAgentOnboardingModal.tsx",
  "FileBrowserModal.tsx",
  "FloatingWindow.tsx",
  "GitHubImportModal.tsx",
  "GitManagerModal.tsx",
  "GroupTaskModal.tsx",
  "MailboxModal.tsx",
  "MilestoneSliceInterviewModal.tsx",
  "MissionInterviewModal.tsx",
  "MissionManager.tsx",
  "ModelOnboardingModal.tsx",
  "ModelSelectionModal.tsx",
  "NativeShellConnectionManager.tsx",
  "NewAgentDialog.tsx",
  "NewTaskModal.tsx",
  "NodeDetailModal.tsx",
  "PlanningModeModal.tsx",
  "PrCreateModal.tsx",
  "ProviderLoginDialog.tsx",
  "ReportModal.tsx",
  "ResearchTaskActionModal.tsx",
  "RightDockExpandModal.tsx",
  "ScheduledTasksModal.tsx",
  "ScriptsModal.tsx",
  "SecretsView.tsx",
  "SettingsModal.tsx",
  "SettingsSyncConflictModal.tsx",
  "SetupWizardModal.tsx",
  "StashRecoveryView.tsx",
  "TaskDetailModal.tsx",
  "TaskResetDialog.tsx",
  "TerminalModal.tsx",
  "UsageIndicator.tsx",
  "ViewHeader.tsx",
  "WorkflowAddStepModal.tsx",
  "WorkflowNodeEditor.tsx",
  "WorkflowResultsTab.tsx",
  "settings/sections/ModelPricingSection.tsx",
] as const;

function productionComponentSource(file: string) {
  return readAppFile(`components/${file}`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function constructionCounts(pattern: RegExp) {
  return listComponentFiles()
    .filter((file) => !file.startsWith("__tests__/") && file !== "ModalCloseButton.tsx")
    .flatMap((file) => {
      const count = productionComponentSource(file).match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
      return count > 0 ? [`${file}:${count}`] : [];
    })
    .sort();
}

const internalXIconExemptions = [
  "ActivityLogModal.tsx:1",
  "AgentDetailView.tsx:1",
  "AgentImportModal.tsx:2",
  "ApprovalNotificationBanner.tsx:1",
  "Banner.tsx:1",
  "ChatView.tsx:2",
  "EngineControlMenu.tsx:1",
  "GitHubStarPrompt.tsx:1",
  "GitManagerModal.tsx:5",
  "GoalsView.tsx:1",
  "InsightsView.tsx:2",
  "MergeAdvanceNotice.tsx:1",
  "MessageComposer.tsx:1",
  "MilestoneSliceInterviewModal.tsx:1",
  "MissionInterviewModal.tsx:1",
  "MissionManager.tsx:2",
  "NodeDetailModal.tsx:3",
  "NodesView.tsx:1",
  "PendingChatMessageQueue.tsx:1",
  "PiExtensionsManager.tsx:1",
  "PlanningModeModal.tsx:1",
  "PluginManager.tsx:2",
  "PostOnboardingRecommendations.tsx:1",
  "PrCreateModal.tsx:1",
  "ProjectSelector.tsx:1",
  "ScriptsModal.tsx:1",
  "SessionNotificationBanner.tsx:3",
  "SkillsView.tsx:2",
  "TaskCard.tsx:1",
  "TaskDetailModal.tsx:1",
  "TaskSearchInput.tsx:1",
  "WorkflowResultsTab.tsx:1",
].sort();

const internalTextGlyphExemptions = [
  "ChatView.tsx:1",
  "CustomModelDropdown.tsx:1",
  "CustomProviderForm.tsx:1",
  "NewTaskModal.tsx:1",
  "PendingAttachmentPreviews.tsx:1",
  "PrCreateModal.tsx:3",
  "PrPanel.tsx:1",
  "SkillMultiselect.tsx:1",
  "TaskDetailModal.tsx:2",
  "TaskForm.tsx:1",
  "TerminalModal.tsx:1",
  "settings/sections/GeneralSection.tsx:1",
].sort();

const internalCloseLabelExemptions = [
  "ChatView.tsx:1",
  "DirectoryPicker.tsx:1",
  "EngineControlMenu.tsx:1",
  "InsightsView.tsx:1",
  "MessageComposer.tsx:1",
  "NodesView.tsx:1",
  "PendingChatMessageQueue.tsx:1",
  "RightDock.tsx:2",
  "SkillsView.tsx:2",
  "TaskSearchInput.tsx:1",
].sort();

/*
FNXC:ModalChromeTests 2026-09-12-00:04:
The modal-close census guards executable JSX constructions rather than comments or import presence alone. Every true modal close owner uses the canonical primitive; exact inventories reserve manual X icons, text glyphs, and Close/Cancel labels for internal search, tag, banner, delete, edit, navigation, and Back actions so a new manual modal close fails the ratchet.
*/
describe("modal close affordance inventory", () => {
  it("keeps the exact production consumer census on the canonical primitive", () => {
    const consumers = listComponentFiles()
      .filter((file) => !file.startsWith("__tests__/") && file !== "ModalCloseButton.tsx")
      .filter((file) => readAppFile(`components/${file}`).includes('import { ModalCloseButton'));
    expect(consumers).toEqual(canonicalConsumers);
  });

  it("reserves every direct X icon for an explicit internal, non-modal-close action", () => {
    expect(constructionCounts(/<X\b[^>]*?(?:\/>|>.*?<\/X>)/gs)).toEqual(internalXIconExemptions);
  });

  it("reserves every text X glyph for an explicit internal, non-modal-close action", () => {
    expect(constructionCounts(/(?:&times;|>\s*[×✕✖]\s*<)/g)).toEqual(internalTextGlyphExemptions);
  });

  it("reserves manual Close and Cancel labels for explicit internal controls", () => {
    expect(constructionCounts(/<(?:button|AlphaButton)\b[^>]*?aria-label\s*=\s*(?:"[^"]*(?:close|cancel)[^"]*"|\{[^}]*?(?:close|cancel)[^}]*?\})[^>]*>/gis)).toEqual(internalCloseLabelExemptions);
  });

  it("leaves no manual legacy close-class construction except mobile Back navigation", () => {
    const manual = listComponentFiles()
      .filter((file) => !file.startsWith("__tests__/") && file !== "ModalCloseButton.tsx")
      .flatMap((file) => {
        const source = productionComponentSource(file);
        const matches = source.match(/<(?:button|AlphaButton)\b[^>]*className=(?:"[^"]*(?:modal-close|floating-window__close|chat-modal-close|report-modal__close)[^"]*"|\{[^}]*(?:modal-close|floating-window__close|chat-modal-close|report-modal__close)[^}]*\})[^>]*>/gs) ?? [];
        return matches.map((construct) => ({ file, construct: construct.replace(/\s+/g, " ") }));
      });
    expect(manual).toEqual([
      expect.objectContaining({ file: "TaskDetailModal.tsx", construct: expect.stringContaining("task-detail-mobile-back") }),
    ]);
  });
});
