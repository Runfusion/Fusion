import { useTranslation } from "react-i18next";
import type { NtfyNotificationEvent } from "@fusion/core";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsTextRow } from "../SettingsTextRow";
import { SettingsHelpTip } from "../SettingsHelpTip";
import type { SectionBaseProps } from "./context";
/** Default event set used when a provider has no explicit `*Events` override. */
export const DEFAULT_NTFY_EVENTS: NtfyNotificationEvent[] = [
    "in-review",
    "merged",
    "failed",
    "awaiting-approval",
    "awaiting-user-review",
    "planning-awaiting-input",
    "cli-agent-awaiting-input",
    "gridlock",
    "fallback-used",
    "memory-dreams-processed",
    "message:agent-to-user",
    "message:agent-to-agent",
    "message:room",
    "oauth-token-expired",
];
export const NOTIFICATION_EVENT_OPTIONS: Array<{
    event: NtfyNotificationEvent;
    label: string;
    description: string;
}> = [
    { event: "in-review", label: "Task completed (in-review)", description: "When a task moves to In Review (ready for review)" },
    { event: "merged", label: "Task merged", description: "When a task is successfully merged to main" },
    { event: "failed", label: "Task failed", description: "When a task fails during execution (high priority)" },
    { event: "awaiting-approval", label: "Plan needs approval", description: "When a task specification needs manual approval before execution" },
    { event: "awaiting-user-review", label: "User review needed", description: "When an agent hands off a task for human review (high priority)" },
    { event: "planning-awaiting-input", label: "Planning needs input", description: "When planning mode is waiting for your response to continue" },
    // FNXC:ToolPermissionNotifications 2026-06-27-00:00: Settings must expose CLI-agent awaiting-input alerts separately from plan approval so operators can opt into external notifications for blocked terminal tool permissions.
    { event: "cli-agent-awaiting-input", label: "CLI agent needs input", description: "When a CLI agent is blocked on a tool permission or terminal input prompt" },
    { event: "gridlock", label: "Pipeline gridlocked", description: "When all schedulable todo tasks are blocked and work cannot advance" },
    { event: "fallback-used", label: "Fallback model used (recovered)", description: "When Fusion recovers from a retryable model failure by switching to a fallback model" },
    { event: "task-created", label: "Agent created a task", description: "When an agent files a new task on the board" },
    { event: "memory-dreams-processed", label: "DREAMS.md entry added", description: "When manual dream processing writes a new entry to project or agent DREAMS.md" },
    { event: "message:agent-to-user", label: "Agent → user message", description: "An agent sent you a direct message" },
    { event: "message:agent-to-agent", label: "Agent → agent message", description: "Agents are talking to each other (including replies)" },
    { event: "message:room", label: "Agent message in room", description: "An agent posted a reply in a chat room you're watching" },
    { event: "oauth-token-expired", label: "OAuth token expired", description: "Notify when a provider OAuth token (Codex, Claude, etc.) expires." },
];
export type TestNotificationProvider = "ntfy" | "webhook" | "ntfy-message" | "ntfy-room";
export interface NotificationsSectionProps extends SectionBaseProps {
    testNotificationLoading: Record<string, boolean>;
    testNotificationResult: Record<string, {
        status: "success" | "error";
        message: string;
    }>;
    onTestProviderNotification: (provider: TestNotificationProvider) => void;
}
/*
FNXC:SettingsStyling 2026-07-15-17:35:
Plain configuration rows render through the shared settings primitives; the hand-rolled `form-group` wrappers they sat in are dropped rather than kept around them, because `.form-group label` (and the `.settings-content` narrowing of it) out-specifies `.settings-field-row-label` and would re-impose the uppercase/muted treatment the primitives exist to retire. `.form-group` itself stays global and untouched — 35 non-settings files style forms with it.

FNXC:SettingsScope 2026-07-15-17:35:
Every migrated row here is global: ntfy, webhook, and failure-notification keys all live in DEFAULT_GLOBAL_SETTINGS, so notification delivery is configured once per operator rather than per project.

FNXC:SettingsStyling 2026-07-15-17:35:
Deliberately NOT migrated, and why — each is a real behavior/copy constraint, not an oversight:
- The ntfy/webhook `Enable` checkboxes stay in `.notification-provider-header`, a flex space-between card header pairing a provider title with its switch. That is a card header, not a plain label→control row.
- `ntfyTopic`'s help embeds an ntfy.sh anchor, and the primitives take `help` as a pre-translated string; migrating would silently drop the link.
- (Resolved 2026-07-15-18:52) `ntfyBaseUrl`/`ntfyAccessToken` previously could not migrate because SettingsTextRow hardcoded type="text" and would have rendered the access token UNMASKED. The descriptor now carries `type`, so both are migrated inside the Advanced disclosure, with the token masked and `autocomplete="off"` by default.
- The `ntfyEvents` / `webhookEvents` grids are per-event checkbox lists with their own descriptions, not single controls.
*/
export function NotificationsSection({ form, setForm, testNotificationLoading, testNotificationResult, onTestProviderNotification, }: NotificationsSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.notifications.notifications", "Notifications")}</h4>

      <div className="notification-provider-card">
        {/*
        FNXC:SettingsLayout 2026-07-11-19:00:
        The failure-notification card must reuse `.notification-provider-body` because `.notification-provider-card` has no own padding; this keeps its field gutters aligned with ntfy/webhook provider cards on desktop and mobile.
        */}
        <div className="notification-provider-body">
          <SettingsSelectRow
            descriptor={{
              key: "failureNotificationMode",
              label: t("settings.notifications.failureNotificationMode", "Failure notification mode"),
              help: t("settings.notifications.stickyOnlySuppressesRecoveredFailuresTerminalOnlyWaits", "Sticky-only suppresses recovered failures; terminal-only waits for paused/in-review failed tasks; all restores legacy alerts."),
              scope: "global",
              options: [
                { value: "sticky-only", label: t("settings.notifications.stickyFailuresOnlyDefault", "Sticky failures only (default)") },
                { value: "terminal-only", label: t("settings.notifications.terminalFailuresOnlySuppressAutoRetried", "Terminal failures only (suppress auto-retried)") },
                { value: "all", label: t("settings.notifications.allFailuresLegacy", "All failures (legacy)") },
              ],
            }}
            value={form.failureNotificationMode ?? "sticky-only"}
            onChange={(v) => setForm((f) => ({ ...f, failureNotificationMode: (v ?? "sticky-only") as "sticky-only" | "all" | "terminal-only" }))}
          />
          {/*
          FNXC:FailureNotifications 2026-07-15-17:35:
          The delay is disabled rather than hidden in "all" mode: legacy alerting fires immediately, so the value cannot apply — but an operator switching modes needs to see the delay that will take effect again.
          Coercion is preserved verbatim from the hand-rolled input: a cleared field and any negative value both settle to 0 (notify immediately), never to undefined, so the stored key always holds a usable delay.
          */}
          <SettingsNumberRow
            descriptor={{
              key: "failureNotificationDelayMs",
              label: t("settings.notifications.failureNotificationDelayMs", "Failure notification delay (ms)"),
              help: t("settings.notifications.howLongAFailureMustPersistBeforeA", " How long a failure must persist before a push notification is sent. 0 = notify immediately. Default: 30000 (30 seconds). "),
              scope: "global",
              min: 0,
              step: 1000,
              disabled: (form.failureNotificationMode ?? "sticky-only") === "all",
            }}
            value={form.failureNotificationDelayMs ?? 30000}
            onChange={(v) => setForm((f) => ({
              ...f,
              failureNotificationDelayMs: v !== null && Number.isFinite(v) && v >= 0 ? v : 0,
            }))}
          />
        </div>
      </div>

      <div className="notification-provider-card">
        <div className="notification-provider-header">
          <strong>{t("settings.notifications.ntfy", "ntfy")}</strong>
          <label htmlFor="ntfyEnabled" className="checkbox-label">
            <input id="ntfyEnabled" type="checkbox" checked={form.ntfyEnabled || false} onChange={(e) => setForm((f) => ({ ...f, ntfyEnabled: e.target.checked }))}/>{t("settings.notifications.enable", " Enable ")}</label>
          {/*
          FNXC:SettingsHelp 2026-07-15-21:40:
          The tip replaces the `<small>` in place rather than wrapping label+tip in a `.settings-field-label-row`: `.notification-provider-header` is ALREADY that line — a flex/align-center row — so it needs no second one, and re-parenting the label would change what its `space-between` distributes. The invariant that matters still holds: the trigger is a sibling of the `<label>`, never a button nested inside it.
          */}
          <SettingsHelpTip settingKey="ntfyEnabled">{t("settings.notifications.ntfyEnabledHint", "Default: disabled.")}</SettingsHelpTip>
        </div>
        {form.ntfyEnabled && (<div className="notification-provider-body">
            <div className="form-group">
              {/*
              FNXC:SettingsHelp 2026-07-15-21:40:
              This row cannot move onto the shared primitive (its `help` takes a pre-translated STRING, and this copy carries an ntfy.sh anchor a string would silently drop \u2014 see the note above), but it can still use the same affordance: SettingsHelpTip takes ReactNode, so the link and the `t()` fragments go behind the "?" verbatim.
              */}
              <div className="settings-field-label-row">
                <label htmlFor="ntfyTopic">{t("settings.notifications.ntfyTopic", "ntfy Topic")}</label>
                <SettingsHelpTip settingKey="ntfyTopic">{t("settings.notifications.yourNtfyShTopicName164Alphanumeric", " Your ntfy.sh topic name (1\u201364 alphanumeric/hyphen/underscore characters). No default \u2014 unset.")}{" "}
                  <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer" className="settings-inline-link">{t("settings.notifications.learnMoreAboutNtfySh", " Learn more about ntfy.sh ")}</a>
                </SettingsHelpTip>
              </div>
              <input id="ntfyTopic" type="text" placeholder={t("settings.notifications.myTopicName", "my-topic-name")} value={form.ntfyTopic || ""} onChange={(e) => {
                const val = e.target.value;
                setForm((f) => ({ ...f, ntfyTopic: val || undefined }));
            }}/>
              {form.ntfyTopic && !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic) && (<small className="field-error">{t("settings.notifications.topicMustBe164AlphanumericHyphenOr", " Topic must be 1\u201364 alphanumeric, hyphen, or underscore characters ")}</small>)}
              <details className="ntfy-advanced-disclosure">
                <summary>{t("settings.notifications.advanced", "Advanced")}</summary>
                {/*
                FNXC:SettingsSecurity 2026-07-15-18:52:
                The access token renders through `type: "password"` so it stays masked, and inherits the primitive's `autocomplete="off"` default so a browser never offers to save it \u2014 the same guarantees the hand-rolled input carried before it moved onto the shared row.
                The disclosure stays: these are the rarely-touched ntfy overrides, and a descriptor's help renders unconditionally, so flattening them into the section body would push the common case (topic) below a wall of prose.
                */}
                <div className="ntfy-advanced-content">
                  <SettingsTextRow
                    descriptor={{
                      key: "ntfyBaseUrl",
                      label: t("settings.notifications.customNtfyServerURLOptional", "Custom ntfy server URL (optional)"),
                      help: t("settings.notifications.leaveBlankToKeepTheDefaultServerHttps", " Leave blank to keep the default server: https://ntfy.sh. Custom servers must use http:// or https://. No default \u2014 unset. "),
                      placeholder: t("settings.notifications.httpsNtfySh", "https://ntfy.sh"),
                      type: "url",
                      scope: "global",
                    }}
                    value={form.ntfyBaseUrl ?? null}
                    onChange={(v) => setForm((f) => ({ ...f, ntfyBaseUrl: v || undefined }))}
                  />
                  <SettingsTextRow
                    descriptor={{
                      key: "ntfyAccessToken",
                      label: t("settings.notifications.accessTokenOptional", "Access token (optional)"),
                      help: t("settings.notifications.leaveBlankToPublishWithoutAuthenticationWhenSet", " Leave blank to publish without authentication. When set, Fusion sends an Authorization Bearer header with ntfy requests. No default \u2014 unset. "),
                      placeholder: t("settings.notifications.tk", "tk_..."),
                      type: "password",
                      scope: "global",
                    }}
                    value={form.ntfyAccessToken ?? null}
                    onChange={(v) => setForm((f) => ({ ...f, ntfyAccessToken: v || undefined }))}
                  />
                </div>
              </details>
            </div>
            {/*
            FNXC:SettingsHelp 2026-07-16-12:45:
            (Supersedes the 2026-07-15-21:40 note that kept the per-event `<small>`s inline as option descriptions.) Operator decision 2026-07-16: ALL inline description/help text in Settings moves behind the shared "?" affordance — including these per-event descriptions. Each option now carries a SettingsHelpTip beside its checkbox label, keyed `ntfy-event-${event}` / `webhook-event-${event}` so bubble DOM ids stay unique across the two lists.
            */}
            <div className="form-group">
              <label>{t("settings.notifications.notifyOnEvents", "Notify on events")}</label>
              <div className="ntfy-events-list">
                {NOTIFICATION_EVENT_OPTIONS.map(({ event, label, description }) => {
                const checked = form.ntfyEvents?.includes(event) ?? true;
                return (<div key={`ntfy-${event}`}>
                      {/* FNXC:SettingsHelp 2026-07-16-12:45: Inline help moved behind the shared "?" affordance — operator requirement: no inline description paragraphs in Settings. */}
                      <div className="settings-field-label-row">
                        <label className="checkbox-label">
                          <input type="checkbox" checked={checked} onChange={(e) => {
                          const current = form.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS];
                          const newEvents = e.target.checked
                              ? (current.includes(event) ? current : [...current, event])
                              : current.filter((ev): ev is NtfyNotificationEvent => ev !== event);
                          setForm((f) => ({ ...f, ntfyEvents: newEvents.length > 0 ? newEvents : undefined }));
                      }}/>
                          {label}
                        </label>
                        <SettingsHelpTip settingKey={`ntfy-event-${event}`}>{description}</SettingsHelpTip>
                      </div>
                    </div>);
            })}
              </div>
            </div>
            {/* FNXC:SettingsValidation 2026-07-15-17:35: The http(s) check rides the row's error band so an invalid deep-link host reports against the control that owns it. Empty coerces to undefined, not "", keeping "no default \u2014 unset" a real unset rather than a stored blank. */}
            <SettingsTextRow
              descriptor={{
                key: "ntfyDashboardHost",
                label: t("settings.notifications.dashboardHostname", "Dashboard Hostname"),
                help: t("settings.notifications.baseURLForDeepLinksInNotificationsWhen", " Base URL for deep links in notifications. When set, clicking a notification opens the dashboard directly to the task. No default \u2014 unset. "),
                scope: "global",
                placeholder: t("settings.notifications.httpLocalhost3000", "http://localhost:3000"),
              }}
              value={form.ntfyDashboardHost || ""}
              onChange={(v) => setForm((f) => ({ ...f, ntfyDashboardHost: v || undefined }))}
              error={form.ntfyDashboardHost && !/^https?:\/\/.+/.test(form.ntfyDashboardHost)
                ? t("settings.notifications.mustBeAValidURLStartingWithHttp", " Must be a valid URL starting with http:// or https:// ")
                : undefined}
            />

            <div className="notification-provider-actions">
              <button type="button" className="btn btn-sm" onClick={() => onTestProviderNotification("ntfy")} disabled={testNotificationLoading["ntfy"] ||
                testNotificationLoading["ntfy-message"] ||
                testNotificationLoading["ntfy-room"] ||
                !form.ntfyEnabled ||
                !form.ntfyTopic ||
                !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic)}>
                {testNotificationLoading["ntfy"] ? t("settings.notifications.sending", "Sending…") : t("settings.notifications.testNotification", "Test notification")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => onTestProviderNotification("ntfy-message")} disabled={testNotificationLoading["ntfy"] ||
                testNotificationLoading["ntfy-message"] ||
                testNotificationLoading["ntfy-room"] ||
                !form.ntfyEnabled ||
                !form.ntfyTopic ||
                !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic)}>
                {testNotificationLoading["ntfy-message"] ? t("settings.notifications.sending", "Sending…") : t("settings.notifications.testMessageInbox", "Test message inbox")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => onTestProviderNotification("ntfy-room")} disabled={testNotificationLoading["ntfy"] ||
                testNotificationLoading["ntfy-message"] ||
                testNotificationLoading["ntfy-room"] ||
                !form.ntfyEnabled ||
                !form.ntfyTopic ||
                !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic)}>
                {testNotificationLoading["ntfy-room"] ? t("settings.notifications.sending", "Sending…") : t("settings.notifications.testRoomReply", "Test room reply")}
              </button>
            </div>
            {(testNotificationResult["ntfy"] || testNotificationResult["ntfy-message"] || testNotificationResult["ntfy-room"]) && (<div className="notification-test-feedback" aria-live="polite">
                {testNotificationResult["ntfy"] && (<small className={`notification-test-feedback-item notification-test-feedback-item--${testNotificationResult["ntfy"].status}`}>{t("settings.notifications.general", " General: ")}{testNotificationResult["ntfy"].message}
                  </small>)}
                {testNotificationResult["ntfy-message"] && (<small className={`notification-test-feedback-item notification-test-feedback-item--${testNotificationResult["ntfy-message"].status}`}>{t("settings.notifications.messageInbox", " Message inbox: ")}{testNotificationResult["ntfy-message"].message}
                  </small>)}
                {testNotificationResult["ntfy-room"] && (<small className={`notification-test-feedback-item notification-test-feedback-item--${testNotificationResult["ntfy-room"].status}`}>{t("settings.notifications.roomReply", " Room reply: ")}{testNotificationResult["ntfy-room"].message}
                  </small>)}
              </div>)}
          </div>)}
      </div>

      <div className="notification-provider-card">
        <div className="notification-provider-header">
          <strong>{t("settings.notifications.webhook", "Webhook")}</strong>
          <label htmlFor="webhookEnabled" className="checkbox-label">
            <input id="webhookEnabled" type="checkbox" checked={form.webhookEnabled || false} onChange={(e) => setForm((f) => ({ ...f, webhookEnabled: e.target.checked }))}/>{t("settings.notifications.webhookNotifications", " Webhook notifications ")}</label>
          {/* FNXC:SettingsHelp 2026-07-15-21:40: In-place tip for the same reason as the ntfy card header above. */}
          <SettingsHelpTip settingKey="webhookEnabled">{t("settings.notifications.webhookEnabledHint", "Default: disabled.")}</SettingsHelpTip>
        </div>
        {form.webhookEnabled && (<div className="notification-provider-body">
            <SettingsTextRow
              descriptor={{
                key: "webhookUrl",
                label: t("settings.notifications.webhookURL", "Webhook URL"),
                help: t("settings.notifications.webhookUrlHint", "No default \u2014 unset."),
                scope: "global",
                placeholder: t("settings.notifications.httpsHooksExampleCom", "https://hooks.example.com/..."),
              }}
              value={form.webhookUrl || ""}
              onChange={(v) => setForm((f) => ({ ...f, webhookUrl: v || undefined }))}
            />
            <SettingsSelectRow
              descriptor={{
                key: "webhookFormat",
                label: t("settings.notifications.format", "Format"),
                help: t("settings.notifications.webhookFormatHint", "Default: generic."),
                scope: "global",
                options: [
                  { value: "slack", label: t("settings.notifications.slack", "Slack") },
                  { value: "discord", label: t("settings.notifications.discord", "Discord") },
                  { value: "generic", label: t("settings.notifications.generic", "Generic") },
                ],
              }}
              value={form.webhookFormat || "generic"}
              onChange={(v) => setForm((f) => ({ ...f, webhookFormat: (v ?? "generic") as "slack" | "discord" | "generic" }))}
            />
            <div className="form-group">
              <label>{t("settings.notifications.notifyOnEvents", "Notify on events")}</label>
              <div className="ntfy-events-list">
                {NOTIFICATION_EVENT_OPTIONS.map(({ event, label, description }) => {
                const currentEvents = form.webhookEvents ?? [...DEFAULT_NTFY_EVENTS];
                const checked = currentEvents.includes(event);
                return (<div key={`webhook-${event}`}>
                      {/* FNXC:SettingsHelp 2026-07-16-12:45: Inline help moved behind the shared "?" affordance — operator requirement: no inline description paragraphs in Settings. */}
                      <div className="settings-field-label-row">
                        <label className="checkbox-label">
                          <input type="checkbox" checked={checked} onChange={(e) => {
                          const current = form.webhookEvents ?? [...DEFAULT_NTFY_EVENTS];
                          const newEvents = e.target.checked
                              ? (current.includes(event) ? current : [...current, event])
                              : current.filter((ev) => ev !== event);
                          setForm((f) => ({ ...f, webhookEvents: newEvents.length > 0 ? newEvents : undefined }));
                      }}/>
                          {label}
                        </label>
                        <SettingsHelpTip settingKey={`webhook-event-${event}`}>{description}</SettingsHelpTip>
                      </div>
                    </div>);
            })}
              </div>
            </div>
            <div className="notification-provider-actions">
              <button type="button" className="btn btn-sm" onClick={() => onTestProviderNotification("webhook")} disabled={testNotificationLoading["webhook"] || !form.webhookUrl}>
                {testNotificationLoading["webhook"] ? t("settings.notifications.sending", "Sending…") : t("settings.notifications.testNotification", "Test notification")}
              </button>
            </div>
            {testNotificationResult["webhook"] && (<div className="notification-test-feedback" aria-live="polite">
                <small className={`notification-test-feedback-item notification-test-feedback-item--${testNotificationResult["webhook"].status}`}>
                  {testNotificationResult["webhook"].message}
                </small>
              </div>)}
          </div>)}
      </div>
    </>);
}
export default NotificationsSection;
