/**
 * Search entries for the Global General section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The section's bespoke rows are deliberately absent — CliBinaryPanel, the thinking-log pair, the `fn` binary check, and the update-check toggle are not descriptor rows, so they carry no `data-settings-key` anchor for a result to scroll to.
 *
 * FNXC:SettingsSearch 2026-07-15-20:30:
 * The global GitLab rows and the global tracking-repo select moved to SourceControlGlobalSection.search.ts with their controls; neither was indexed from here before (both were bespoke), so this is a move of the section's contents, not of its entries.
 */
import type { SettingsSearchEntry } from "../search/types";

export const globalGeneralSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "global-general",
    key: "dismissModalsOnOutsideClick",
    labelKey: "settings.globalGeneral.dismissModalsByClickingOutside",
    labelFallback: " Dismiss modals by clicking outside ",
    helpKey: "settings.globalGeneral.dismissModalsByClickingOutsideHint",
    helpFallback:
      " When enabled, clicking or tapping a modal backdrop closes the modal. Default: disabled, to prevent accidental dismissal. ",
    keywords: ["dialog", "backdrop", "accidental close"],
  },
  {
    sectionId: "global-general",
    key: "skipConfirmationDialogs",
    labelKey: "settings.globalGeneral.skipConfirmationDialogs",
    labelFallback: " Skip confirmation dialogs for critical actions ",
    helpKey: "settings.globalGeneral.skipConfirmationDialogsHint",
    helpFallback:
      " When enabled, destructive actions such as deleting a task or resetting progress run immediately without a prompt. Default: disabled",
    keywords: ["confirm", "critical action", "delete", "reset", "destructive"],
  },
  {
    sectionId: "global-general",
    key: "quickAddSubmitOnEnter",
    labelKey: "settings.globalGeneral.quickAddSubmitOnEnter",
    labelFallback: " Press Enter to save a task in Quick Add ",
    helpKey: "settings.globalGeneral.quickAddSubmitOnEnterHint",
    helpFallback: " Default: enabled. When disabled, Enter inserts a newline and Cmd/Ctrl+Enter saves. ",
    keywords: ["enter", "keyboard", "quick add", "newline", "submit"],
  },
  {
    sectionId: "global-general",
    key: "chatSubmitOnEnter",
    labelKey: "settings.globalGeneral.chatSubmitOnEnter",
    labelFallback: " Enter key behavior in conversations ",
    helpKey: "settings.globalGeneral.chatSubmitOnEnterHint",
    helpFallback:
      " Default: automatic — Enter inserts a newline on touch devices with an on-screen keyboard, and sends on desktop. Shift+Enter never sends, even with Cmd/Ctrl held; it inserts a newline except in Chat while an autocomplete menu is open, where the files/tasks, agents and skills menus consume it instead. Cmd/Ctrl+Enter without Shift sends regardless of this setting and of the device. While an autocomplete menu is open it takes priority and consumes both Enter and Cmd/Ctrl+Enter; press Escape to close it. In the task chat, an in-progress IME composition takes priority over all of these. The Send button stays available whenever the draft is not empty. ",
    keywords: ["enter", "newline", "mobile", "keyboard", "chat", "send", "shift"],
  },
  {
    sectionId: "global-general",
    key: "persistAgentToolOutput",
    labelKey: "settings.globalGeneral.saveToolOutputInAgentLogs",
    labelFallback: " Save tool output in agent logs ",
    helpKey: "settings.globalGeneral.whenDisabledToolRowsAreStillLoggedBut",
    helpFallback:
      " When disabled, tool rows are still logged but detailed tool payloads are omitted. Very large tool payloads may still be clipped even when this stays enabled. Default: enabled. ",
    keywords: ["persist", "transcript", "disk usage", "tool arguments", "tool results"],
  },
  {
    sectionId: "global-general",
    key: "agentToolOutputMaxChars",
    labelKey: "settings.globalGeneral.agentToolOutputLimit",
    labelFallback: " Agent tool-output limit ",
    helpKey: "settings.globalGeneral.agentToolOutputLimitHint",
    helpFallback:
      " Maximum characters returned from each engine-injected tool result. When unset, inherits the 16,000-character engine default. Leave empty to use the default. ",
    keywords: ["tokens", "context", "truncate", "tool output", "agent"],
  },
  {
    sectionId: "global-general",
    key: "agentToolOutputMaxCharsNoLimit",
    labelKey: "settings.globalGeneral.noLimitOnAgentToolOutput",
    labelFallback: " No limit on agent tool output ",
    helpKey: "settings.globalGeneral.noLimitOnAgentToolOutputHint",
    helpFallback:
      " Disable the shared tool-output clamp. A single tool result can consume the agent context window. Default: disabled; when unset, the budget inherits the 16,000-character engine default. ",
    keywords: ["unlimited", "tokens", "context", "truncate", "tool output"],
  },
  {
    sectionId: "global-general",
    key: "proactiveTaskChatEnabled",
    labelKey: "settings.globalGeneral.enableProactiveTaskChat",
    labelFallback: " Enable proactive task-chat updates ",
    helpKey: "settings.globalGeneral.enableProactiveTaskChatHint",
    helpFallback: " When enabled, Task chat reports step progress, failures, reviews, and rollbacks in real time. Default: disabled. ",
    keywords: ["task chat", "progress", "status", "rollback", "failure"],
  },
  {
    sectionId: "global-general",
    key: "updateCheckFrequency",
    labelKey: "settings.globalGeneral.frequency",
    labelFallback: "Frequency",
    helpKey: "settings.globalGeneral.controlsHowOftenTheDashboardReFetchesThe",
    helpFallback:
      " Controls how often the dashboard re-fetches the npm registry. Use the version + refresh control in the header to trigger an immediate check at any time. Default: daily. ",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The label is the bare word "Frequency" — it only reads as the update cadence because of the "Updates" heading above it, which the index does not see. The feature's own vocabulary is keyworded so a search for "update check" reaches this control.
    */
    keywords: ["update check", "cadence", "how often", "version check"],
  },
  {
    sectionId: "global-general",
    key: "updateChannel",
    labelKey: "settings.globalGeneral.releaseChannel",
    labelFallback: "Release channel",
    helpKey: "settings.globalGeneral.releaseChannelHelp",
    helpFallback:
      " Stable follows official releases. Beta follows pre-releases cut from main (versions like 0.73.0-beta.2) and also picks up each stable release once it overtakes the beta. Switching back to Stable never downgrades; you stay on the installed beta until the next stable release passes it. Default: stable. ",
    keywords: ["beta", "channel", "release track", "prerelease", "early access"],
  },
  {
    sectionId: "global-general",
    key: "autoUpdateEnabled",
    labelKey: "settings.globalGeneral.autoUpdateEnabled",
    labelFallback: " Automatically install updates ",
    helpKey: "settings.globalGeneral.autoUpdateEnabledHelp",
    helpFallback: " Installs updates from the selected release channel during the background update check. Unset: disabled. ",
    keywords: ["auto update", "automatic update", "install", "unattended"],
  },
  {
    sectionId: "global-general",
    key: "autoRestartAfterUpdate",
    labelKey: "settings.globalGeneral.autoRestartAfterUpdate",
    labelFallback: " Automatically restart after an update ",
    helpKey: "settings.globalGeneral.autoRestartAfterUpdateHelp",
    helpFallback: " After a dashboard update installs, requests a supervised restart. Unset: disabled. ",
    keywords: ["auto update", "automatic restart", "restart", "supervisor"],
  },
];
