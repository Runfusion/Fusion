import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { NtfyNotificationEvent } from "@fusion/core";
import type { SectionBaseProps } from "./context";
/** Default event set used when a provider has no explicit `*Events` override. */
export const DEFAULT_NTFY_EVENTS: NtfyNotificationEvent[] = [
    "in-review",
    "merged",
    "failed",
    "awaiting-approval",
    "awaiting-user-review",
    "planning-awaiting-input",
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
    scopeBanner: ReactNode;
    testNotificationLoading: Record<string, boolean>;
    testNotificationResult: Record<string, {
        status: "success" | "error";
        message: string;
    }>;
    onTestProviderNotification: (provider: TestNotificationProvider) => void;
}
export function NotificationsSection({ scopeBanner, form, setForm, testNotificationLoading, testNotificationResult, onTestProviderNotification, }: NotificationsSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.notifications.notifications", "Notifications")}</h4>

      <div className="notification-provider-card">
        <div className="form-group">
          <label htmlFor="failureNotificationMode">{t("settings.notifications.failureNotificationMode", "Failure notification mode")}</label>
          <select id="failureNotificationMode" value={form.failureNotificationMode ?? "sticky-only"} onChange={(e) => {
            const value = e.target.value as "sticky-only" | "all" | "terminal-only";
            setForm((f) => ({ ...f, failureNotificationMode: value }));
        }}>
            <option value="sticky-only">{t("settings.notifications.stickyFailuresOnlyDefault", "Sticky failures only (default)")}</option>
            <option value="terminal-only">{t("settings.notifications.terminalFailuresOnlySuppressAutoRetried", "Terminal failures only (suppress auto-retried)")}</option>
            <option value="all">{t("settings.notifications.allFailuresLegacy", "All failures (legacy)")}</option>
          </select>
          <small>{t("settings.notifications.stickyOnlySuppressesRecoveredFailuresTerminalOnlyWaits", "Sticky-only suppresses recovered failures; terminal-only waits for paused/in-review failed tasks; all restores legacy alerts.")}</small>
        </div>
        <div className="form-group">
          <label htmlFor="failureNotificationDelayMs">{t("settings.notifications.failureNotificationDelayMs", "Failure notification delay (ms)")}</label>
          <input id="failureNotificationDelayMs" type="number" min={0} step={1000} disabled={(form.failureNotificationMode ?? "sticky-only") === "all"} value={form.failureNotificationDelayMs ?? 30000} onChange={(e) => {
            const parsed = Number(e.target.value);
            setForm((f) => ({
                ...f,
                failureNotificationDelayMs: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
            }));
        }}/>
          <small>{t("settings.notifications.howLongAFailureMustPersistBeforeA", " How long a failure must persist before a push notification is sent. 0 = notify immediately. ")}</small>
        </div>
      </div>

      <div className="notification-provider-card">
        <div className="notification-provider-header">
          <strong>{t("settings.notifications.ntfy", "ntfy")}</strong>
          <label htmlFor="ntfyEnabled" className="checkbox-label">
            <input id="ntfyEnabled" type="checkbox" checked={form.ntfyEnabled || false} onChange={(e) => setForm((f) => ({ ...f, ntfyEnabled: e.target.checked }))}/>{t("settings.notifications.enable", " Enable ")}</label>
        </div>
        {form.ntfyEnabled && (<div className="notification-provider-body">
            <div className="form-group">
              <label htmlFor="ntfyTopic">{t("settings.notifications.ntfyTopic", "ntfy Topic")}</label>
              <input id="ntfyTopic" type="text" placeholder={t("settings.notifications.myTopicName", "my-topic-name")} value={form.ntfyTopic || ""} onChange={(e) => {
                const val = e.target.value;
                setForm((f) => ({ ...f, ntfyTopic: val || undefined }));
            }}/>
              <small>{t("settings.notifications.yourNtfyShTopicName164Alphanumeric", " Your ntfy.sh topic name (1\u201364 alphanumeric/hyphen/underscore characters).")}{" "}
                <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer" className="settings-inline-link">{t("settings.notifications.learnMoreAboutNtfySh", " Learn more about ntfy.sh ")}</a>
              </small>
              {form.ntfyTopic && !/^[a-zA-Z0-9_-]{1,64}$/.test(form.ntfyTopic) && (<small className="field-error">{t("settings.notifications.topicMustBe164AlphanumericHyphenOr", " Topic must be 1\u201364 alphanumeric, hyphen, or underscore characters ")}</small>)}
              <details className="ntfy-advanced-disclosure">
                <summary>{t("settings.notifications.advanced", "Advanced")}</summary>
                <div className="ntfy-advanced-content">
                  <label htmlFor="ntfyBaseUrl">{t("settings.notifications.customNtfyServerURLOptional", "Custom ntfy server URL (optional)")}</label>
                  <input id="ntfyBaseUrl" type="url" placeholder={t("settings.notifications.httpsNtfySh", "https://ntfy.sh")} value={form.ntfyBaseUrl || ""} onChange={(e) => {
                const value = e.target.value;
                setForm((f) => ({ ...f, ntfyBaseUrl: value || undefined }));
            }}/>
                  <small>{t("settings.notifications.leaveBlankToKeepTheDefaultServerHttps", " Leave blank to keep the default server: https://ntfy.sh. Custom servers must use http:// or https://. ")}</small>
                  <label htmlFor="ntfyAccessToken">{t("settings.notifications.accessTokenOptional", "Access token (optional)")}</label>
                  <input id="ntfyAccessToken" type="password" autoComplete="off" placeholder={t("settings.notifications.tk", "tk_...")} value={form.ntfyAccessToken || ""} onChange={(e) => {
                const value = e.target.value;
                setForm((f) => ({ ...f, ntfyAccessToken: value || undefined }));
            }}/>
                  <small>{t("settings.notifications.leaveBlankToPublishWithoutAuthenticationWhenSet", " Leave blank to publish without authentication. When set, Fusion sends an Authorization Bearer header with ntfy requests. ")}</small>
                </div>
              </details>
            </div>
            <div className="form-group">
              <label>{t("settings.notifications.notifyOnEvents", "Notify on events")}</label>
              <div className="ntfy-events-list">
                {NOTIFICATION_EVENT_OPTIONS.map(({ event, label, description }) => {
                const checked = form.ntfyEvents?.includes(event) ?? true;
                return (<div key={`ntfy-${event}`}>
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
                      <small>{description}</small>
                    </div>);
            })}
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="ntfyDashboardHost">{t("settings.notifications.dashboardHostname", "Dashboard Hostname")}</label>
              <input id="ntfyDashboardHost" type="text" placeholder={t("settings.notifications.httpLocalhost3000", "http://localhost:3000")} value={form.ntfyDashboardHost || ""} onChange={(e) => {
                const val = e.target.value;
                setForm((f) => ({ ...f, ntfyDashboardHost: val || undefined }));
            }}/>
              <small>{t("settings.notifications.baseURLForDeepLinksInNotificationsWhen", " Base URL for deep links in notifications. When set, clicking a notification opens the dashboard directly to the task. ")}</small>
              {form.ntfyDashboardHost && !/^https?:\/\/.+/.test(form.ntfyDashboardHost) && (<small className="field-error">{t("settings.notifications.mustBeAValidURLStartingWithHttp", " Must be a valid URL starting with http:// or https:// ")}</small>)}
            </div>
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
        </div>
        {form.webhookEnabled && (<div className="notification-provider-body">
            <div className="form-group">
              <label htmlFor="webhookUrl">{t("settings.notifications.webhookURL", "Webhook URL")}</label>
              <input id="webhookUrl" type="text" placeholder={t("settings.notifications.httpsHooksExampleCom", "https://hooks.example.com/...")} value={form.webhookUrl || ""} onChange={(e) => {
                const val = e.target.value;
                setForm((f) => ({ ...f, webhookUrl: val || undefined }));
            }}/>
            </div>
            <div className="form-group">
              <label htmlFor="webhookFormat">{t("settings.notifications.format", "Format")}</label>
              <select id="webhookFormat" value={form.webhookFormat || "generic"} onChange={(e) => {
                const val = e.target.value as "slack" | "discord" | "generic";
                setForm((f) => ({ ...f, webhookFormat: val }));
            }}>
                <option value="slack">{t("settings.notifications.slack", "Slack")}</option>
                <option value="discord">{t("settings.notifications.discord", "Discord")}</option>
                <option value="generic">{t("settings.notifications.generic", "Generic")}</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t("settings.notifications.notifyOnEvents", "Notify on events")}</label>
              <div className="ntfy-events-list">
                {NOTIFICATION_EVENT_OPTIONS.map(({ event, label, description }) => {
                const currentEvents = form.webhookEvents ?? [...DEFAULT_NTFY_EVENTS];
                const checked = currentEvents.includes(event);
                return (<div key={`webhook-${event}`}>
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
                      <small>{description}</small>
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
