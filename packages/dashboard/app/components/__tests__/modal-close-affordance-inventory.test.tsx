import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";

/*
FNXC:ModalChromeTests 2026-09-14-10:24:
FN-379 remediation: the mail composer is hosted content, not a chrome owner. Its local header title and X exit were
removed in favour of the owning Mailbox ViewHeader, so its former internal exemptions are deleted and re-adding a local
composer close fails this ratchet.

FNXC:ModalChromeTests 2026-09-13-22:40:
FN-379 remediation: the window-shaped producers (agent creation/import/generation, artifact viewers, onboarding,
the first-run wizard, reporting, the workflow step picker, the planning history overlay, and the dev-server
preview window) kept a locally named header row and therefore still imported the primitive directly. They now
build the shared header, so the census shrinks to the owners that pass a close INTO that header.

FNXC:ModalChromeTests 2026-09-13-21:49:
FN-379 moved every recorded destination, window, dialog, confirmation, and onboarding surface onto the shared
ViewHeader, which builds their exit through the canonical primitive on their behalf. Those owners are no longer
direct importers, so the census shrinks to the remaining surfaces that still construct a close outside a shared
header; re-adding a local close row to a migrated owner fails this ratchet.
*/
/*
FNXC:ModalChromeTests 2026-09-15-04:56:
FN-406: the file browser stopped constructing its own close and now hands it to the shared ViewHeader through
`onClose`, which is what lets the single drawer-chrome rule remove it on phone drawers. It therefore leaves this census.
*/
/*
FN-407: the workflow editor lost its modal presentation, and with it the only close affordance it constructed.
It is a persistent view now, so it no longer imports ModalCloseButton and leaves this census.
*/
const canonicalConsumers = [
  "AgentDetailView.tsx",
  "FloatingWindow.tsx",
  "MailboxModal.tsx",
  "RightDockExpandModal.tsx",
  "ScheduledTasksModal.tsx",
  "TaskDetailModal.tsx",
  "TerminalModal.tsx",
  "ViewHeader.tsx",
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
  "MilestoneSliceInterviewModal.tsx:1",
  "MissionInterviewModal.tsx:1",
  "MissionManager.tsx:1",
  "NodeDetailModal.tsx:3",
  "PendingChatMessageQueue.tsx:1",
  "PiExtensionsManager.tsx:1",
  "PlanningModeModal.tsx:1",
  "PluginManager.tsx:1",
  "PostOnboardingRecommendations.tsx:1",
  "PrCreateModal.tsx:1",
  "ProjectSelector.tsx:1",
  "ScriptsModal.tsx:1",
  "SessionNotificationBanner.tsx:3",
  "SkillsView.tsx:2",
  "TaskCard.tsx:1",
  "TaskDetailModal.tsx:1",
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
  "PendingChatMessageQueue.tsx:1",
  "RightDock.tsx:2",
  "SkillsView.tsx:2",
].sort();

/*
FNXC:ModalChromeTests 2026-09-12-00:04:
The modal-close census guards executable JSX constructions rather than comments or import presence alone. Every true modal close owner uses the canonical primitive; exact inventories reserve manual X icons, text glyphs, and Close/Cancel labels for internal search, tag, banner, delete, edit, navigation, and Back actions so a new manual modal close fails the ratchet.

FNXC:ModalChromeTests 2026-09-13-14:21:
Canonical construction is insufficient when a host stylesheet can repaint or resize the shared button. Model Onboarding must leave all close-button chrome to ModalCloseButton; its stylesheet may arrange the header but cannot target `.modal-close` locally.
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
    expect(constructionCounts(/<(?:button|UiButton)\b[^>]*?aria-label\s*=\s*(?:"[^"]*(?:close|cancel)[^"]*"|\{[^}]*?(?:close|cancel)[^}]*?\})[^>]*>/gis)).toEqual(internalCloseLabelExemptions);
  });

  it("leaves no manual legacy close-class construction anywhere", () => {
    const manual = listComponentFiles()
      .filter((file) => !file.startsWith("__tests__/") && file !== "ModalCloseButton.tsx")
      .flatMap((file) => {
        const source = productionComponentSource(file);
        const matches = source.match(/<(?:button|UiButton)\b[^>]*className=(?:"[^"]*(?:modal-close|floating-window__close|chat-modal-close|report-modal__close)[^"]*"|\{[^}]*(?:modal-close|floating-window__close|chat-modal-close|report-modal__close)[^}]*\})[^>]*>/gs) ?? [];
        return matches.map((construct) => ({ file, construct: construct.replace(/\s+/g, " ") }));
      });
    expect(manual).toEqual([]);
  });

  it("leaves host-specific close chrome to the canonical primitive", () => {
    const modelOnboardingCss = readAppFile("components/ModelOnboardingModal.css")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const mailboxCss = readAppFile("components/MailboxModal.css")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    expect(modelOnboardingCss).not.toMatch(/\.model-onboarding-header\s+\.modal-close\b/);
    expect(mailboxCss).not.toMatch(/\.mailbox-modal\s+\.mailbox-header-actions\s+\.modal-close\s*\{/);
  });
});
