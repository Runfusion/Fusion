import { createElement, type ReactElement } from "react";
import { AgentErrorDetailsModal } from "../AgentErrorDetailsModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { ModelSelectionModal } from "../ModelSelectionModal";
import { ProviderLoginDialog } from "../ProviderLoginDialog";
import { ReportModal } from "../ReportModal";
import { SettingsSyncConflictModal } from "../SettingsSyncConflictModal";
import StashConflictModal from "../StashConflictModal";
import { AgentGenerationModal } from "../AgentGenerationModal";
import { AgentImportModal } from "../AgentImportModal";
import { AgentListModal } from "../AgentListModal";
import { AgentOnboardingModal } from "../AgentOnboardingModal";
import { DockerNodeOnboardingModal } from "../DockerNodeOnboardingModal";
import { ExperimentalAgentOnboardingModal } from "../ExperimentalAgentOnboardingModal";
import { MailboxModal } from "../MailboxModal";
import { MilestoneSliceInterviewModal } from "../MilestoneSliceInterviewModal";
import { NativeShellOnboardingModal } from "../NativeShellOnboardingModal";
import { SetupWizardModal } from "../SetupWizardModal";

export type MigratedModalFixture = {
  name: string;
  file: string;
  key: string | null;
  outside: boolean;
  /** Renders the production modal, never a synthetic FloatingWindow stand-in. */
  render?: (onClose: () => void) => ReactElement;
  optOut?: string;
  /*
  FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
  FN-394's re-hosted dashboard dialogs share ONE sheet class (`floating-window--dialog`) instead of a
  per-dialog CSS selector list, so the sheet contract is declared here rather than derived from the key.
  */
  sheetClass?: string;
  /** A dialog owned by a larger view, covered by that view's own suite rather than a standalone render. */
  hostedInsideView?: string;
};

const noop = () => {};
const toast = () => {};

/*
FNXC:ModalTouchGeometry 2026-07-26-20:20:
FN-8607 coverage must mount every production host rather than a generic FloatingWindow. This
keeps header selectors, sheet classes, and each modal's close contract under the same test matrix.
The inventory's short-lived decision dialogs remain explicit opt-outs below.
*/
/*
FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
FN-394 removed the desktop static opt-out: a dashboard dialog is a window like any other, so the former
opt-out rows below are now real hosts with production renders, and the dialogs owned by a larger view
declare the view that renders them.
*/
const DIALOG_SHEET_CLASS = "floating-window--dialog";

export const migratedModalFixtures: readonly MigratedModalFixture[] = [
  { name: "ConfirmDialog", file: "ConfirmDialog.tsx", key: "floating-window:confirm-dialog", outside: false, sheetClass: DIALOG_SHEET_CLASS, render: (onClose) => createElement(ConfirmDialog, { isOpen: true, options: { title: "Discard", message: "Discard changes?" }, onConfirm: noop, onCancel: onClose }) },
  { name: "AgentErrorDetailsModal", file: "AgentErrorDetailsModal.tsx", key: "floating-window:agent-error-details", outside: false, sheetClass: DIALOG_SHEET_CLASS, render: (onClose) => createElement(AgentErrorDetailsModal, { open: true, onClose, errorText: "boom", issueContext: { surface: "agents" } }) },
  { name: "ModelSelectionModal", file: "ModelSelectionModal.tsx", key: "floating-window:model-selection", outside: false, sheetClass: DIALOG_SHEET_CLASS, render: (onClose) => createElement(ModelSelectionModal, { isOpen: true, onClose, models: [], executorValue: "", validatorValue: "", onExecutorChange: noop, onValidatorChange: noop }) },
  { name: "ReportModal", file: "ReportModal.tsx", key: "floating-window:report-bug", outside: false, sheetClass: DIALOG_SHEET_CLASS, render: (onClose) => createElement(ReportModal, { actionType: "bug", onClose }) },
  { name: "ProviderLoginDialog", file: "ProviderLoginDialog.tsx", key: "floating-window:provider-login-anthropic", outside: false, sheetClass: DIALOG_SHEET_CLASS, render: (onClose) => createElement(ProviderLoginDialog, { providerName: "anthropic", phase: "waiting", manualCode: { prompt: "Paste the redirect URL" }, codeValue: "", onCodeChange: noop, onSubmitCode: noop, onOpenAuthUrl: noop, onCancel: onClose }) },
  { name: "ResearchTaskActionModal", file: "ResearchTaskActionModal.tsx", key: "floating-window:research-task-create", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "ResearchView" },
  { name: "SettingsSyncConflictModal", file: "SettingsSyncConflictModal.tsx", key: "floating-window:settings-sync-conflict", outside: false, sheetClass: DIALOG_SHEET_CLASS, render: (onClose) => createElement(SettingsSyncConflictModal, { isOpen: true, onClose, onResolve: async () => {}, conflicts: [{ key: "theme", localValue: "dark", remoteValue: "light" } as never], localNodeName: "local", remoteNodeName: "remote", addToast: toast }) },
  { name: "StashConflictModal", file: "StashConflictModal.tsx", key: "floating-window:stash-conflict", outside: false, sheetClass: DIALOG_SHEET_CLASS, render: (onClose) => createElement(StashConflictModal, { open: true, onClose, worktreePath: "/tmp/wt", integrationBranch: "main", stashSha: "abcdef1234", stashLabel: "stash@{0}", conflictedFiles: ["a.ts"], autostashOutcome: "conflict-needs-manual" }) },
  { name: "NewAgentDialog", file: "NewAgentDialog.tsx", key: "floating-window:new-agent", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "AgentsView" },
  { name: "NativeShellConnectionManager", file: "NativeShellConnectionManager.tsx", key: "floating-window:native-shell-connection-manager", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "NativeShellSettings" },
  { name: "AgentPromptsManager", file: "AgentPromptsManager.tsx", key: "floating-window:prompt-override", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "SettingsModal" },
  { name: "BranchGroupCard", file: "BranchGroupCard.tsx", key: "floating-window:branch-group-promotion", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "BranchGroupsView" },
  { name: "DevServerView", file: "DevServerView.tsx", key: "floating-window:devserver-preview", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "DevServerView" },
  { name: "MissionManager", file: "MissionManager.tsx", key: "floating-window:mission-manager", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "MissionManager" },
  { name: "ReliabilityView", file: "ReliabilityView.tsx", key: "floating-window:reliability-reset", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "ReliabilityView" },
  { name: "SecretsView", file: "SecretsView.tsx", key: "floating-window:secret-sync-passphrase", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "SecretsView" },
  { name: "StashRecoveryView", file: "StashRecoveryView.tsx", key: "floating-window:stash-recovery-diff", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "StashRecoveryView" },
  { name: "UsageIndicator", file: "UsageIndicator.tsx", key: "floating-window:usage", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "Header" },
  { name: "WorkflowResultsTab", file: "WorkflowResultsTab.tsx", key: "floating-window:workflow-output", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "TaskDetailModal" },
  { name: "WorkflowNodeEditor", file: "WorkflowNodeEditor.tsx", key: "floating-window:workflow-create", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "WorkflowNodeEditor" },
  { name: "ModelPricingSection", file: "settings/sections/ModelPricingSection.tsx", key: "floating-window:model-pricing-table", outside: false, sheetClass: DIALOG_SHEET_CLASS, hostedInsideView: "SettingsModal" },
  { name: "AgentListModal", file: "AgentListModal.tsx", key: "floating-window:agent-list", outside: true, render: (onClose) => createElement(AgentListModal, { isOpen: true, onClose, addToast: toast }) },
  { name: "AgentImportModal", file: "AgentImportModal.tsx", key: "floating-window:agent-import", outside: true, render: (onClose) => createElement(AgentImportModal, { isOpen: true, onClose, onImported: noop }) },
  { name: "AgentGenerationModal", file: "AgentGenerationModal.tsx", key: "floating-window:agent-generation", outside: true, render: (onClose) => createElement(AgentGenerationModal, { isOpen: true, onClose, onGenerated: noop }) },
  { name: "AgentOnboardingModal", file: "AgentOnboardingModal.tsx", key: "floating-window:agent-onboarding", outside: false, render: (onClose) => createElement(AgentOnboardingModal, { isOpen: true, onClose, onCreated: noop, addToast: toast, existingAgents: [] }) },
  { name: "ExperimentalAgentOnboardingModal", file: "ExperimentalAgentOnboardingModal.tsx", key: "floating-window:experimental-agent-onboarding", outside: false, render: (onClose) => createElement(ExperimentalAgentOnboardingModal, { isOpen: true, onClose, onUseDraft: noop, existingAgents: [] }) },
  { name: "SetupWizardModal", file: "SetupWizardModal.tsx", key: "floating-window:setup-wizard", outside: false, render: (onClose) => createElement(SetupWizardModal, { onProjectRegistered: noop, onClose }) },
  { name: "NativeShellOnboardingModal", file: "NativeShellOnboardingModal.tsx", key: "floating-window:native-shell-onboarding", outside: false, render: (onClose) => createElement(NativeShellOnboardingModal, { open: true, onComplete: onClose, shellApi: {} as never, shellState: {} as never }) },
  { name: "DockerNodeOnboardingModal", file: "DockerNodeOnboardingModal.tsx", key: "floating-window:docker-node-onboarding", outside: true, render: (onClose) => createElement(DockerNodeOnboardingModal, { isOpen: true, onClose, onSubmit: async () => {}, addToast: toast }) },
  { name: "MailboxModal", file: "MailboxModal.tsx", key: "floating-window:mailbox", outside: true, render: (onClose) => createElement(MailboxModal, { isOpen: true, onClose, addToast: toast, onOpenTask: noop, onOpenPlanningSession: noop, onOpenNativeStructure: noop, nativeStructureCandidates: [] }) },
  { name: "MilestoneSliceInterviewModal", file: "MilestoneSliceInterviewModal.tsx", key: "floating-window:milestone-slice-interview", outside: true, render: (onClose) => createElement(MilestoneSliceInterviewModal, { isOpen: true, onClose, onApplied: noop, targetType: "milestone", targetId: "m-1", targetTitle: "Mission", missionContext: "Test context" }) },
] as const;
