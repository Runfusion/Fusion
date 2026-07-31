import { createElement, type ReactElement } from "react";
import { AgentErrorDetailsModal } from "../AgentErrorDetailsModal";
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
import { SubtaskBreakdownModal } from "../SubtaskBreakdownModal";

export type MigratedModalFixture = {
  name: string;
  file: string;
  key: string | null;
  outside: boolean;
  /** Renders the production modal, never a synthetic FloatingWindow stand-in. */
  render?: (onClose: () => void) => ReactElement;
  optOut?: string;
};

const noop = () => {};
const toast = () => {};

/*
FNXC:ModalTouchGeometry 2026-07-26-20:20:
FN-8607 coverage must mount every production host rather than a generic FloatingWindow. This
keeps header selectors, sheet classes, and each modal's close contract under the same test matrix.
The inventory's short-lived decision dialogs remain explicit opt-outs below.
*/
export const migratedModalFixtures: readonly MigratedModalFixture[] = [
  { name: "AgentErrorDetailsModal", file: "AgentErrorDetailsModal.tsx", key: null, outside: true, optOut: "brief error acknowledgement" },
  { name: "ModelSelectionModal", file: "ModelSelectionModal.tsx", key: null, outside: true, optOut: "compact focused choice" },
  { name: "ReportModal", file: "ReportModal.tsx", key: null, outside: false, optOut: "brief reporting action" },
  { name: "ResearchTaskActionModal", file: "ResearchTaskActionModal.tsx", key: null, outside: true, optOut: "bounded task-action confirmation" },
  { name: "SettingsSyncConflictModal", file: "SettingsSyncConflictModal.tsx", key: null, outside: true, optOut: "urgent blocking conflict decision" },
  { name: "StashConflictModal", file: "StashConflictModal.tsx", key: null, outside: false, optOut: "urgent bounded git-conflict recovery" },
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
  { name: "SubtaskBreakdownModal", file: "SubtaskBreakdownModal.tsx", key: "floating-window:subtask-breakdown", outside: true, render: (onClose) => createElement(SubtaskBreakdownModal, { isOpen: true, onClose, initialDescription: "Test task", onTasksCreated: noop, parentTaskId: "task-1" }) },
] as const;
