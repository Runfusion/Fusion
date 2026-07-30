import type { PluginSettingSchema } from "@fusion/plugin-sdk";

const DEFAULT_BASE_URL = "http://localhost:4040";
const DEFAULT_POLLING_INTERVAL_SECONDS = 30;
const MIN_POLLING_INTERVAL_SECONDS = 5;
const DEFAULT_NOTIFY_COLUMNS = ["in-review"];
/*
FNXC:PluginLifecycleColumns 2026-07-30-11:30 (Phase C convergence):
The quick-capture default was `triage` — the column U11 (#2515) DELETED from the default
lineage. So every voice-captured card asked the server for a column the default board no
longer declares. `todo` is the post-U11 merged planning column AND a column every pre-U11
lineage also declares, so it is correct on both sides of the migration; `triage` was correct
on neither after #2515.

NOT trait-resolved, deliberately: this is a SETTINGS DEFAULT with no task and no workflow in
hand — there is nothing to resolve against at module scope. The operator picks the real
column from `enumValues`; this only has to be a column that exists when they have not.

KNOWN REMAINING GAP, recorded rather than half-fixed: `TaskColumn`/`COLUMN_SET` are still the
five legacy ids, so on a RENAMED board the enum offers columns that do not exist and
`normalizeCaptureColumn` silently substitutes the default for a column the operator did name
(voice "put it in checking" lands in planning, with no error). Closing that needs the board's
declared columns, and this plugin reaches Fusion over HTTP with no board-columns endpoint in
`FusionApiClient` — a new read, not a rename. Silent substitution is the worse half of that
bug and it is unchanged here; I am not papering over it with a guess.
*/
const DEFAULT_QUICK_CAPTURE_COLUMN = "todo";

type TaskColumn = "triage" | "todo" | "in-progress" | "in-review" | "done";

const COLUMN_SET = new Set<TaskColumn>(["triage", "todo", "in-progress", "in-review", "done"]);

export const settingsSchema: Record<string, PluginSettingSchema> = {
  fusionApiBaseUrl: {
    type: "string",
    label: "Fusion API Base URL",
    defaultValue: DEFAULT_BASE_URL,
  },
  fusionApiToken: {
    type: "password",
    label: "Fusion API Token",
  },
  apiKey: {
    type: "password",
    label: "Glasses Route API Key",
  },
  glassesDeviceId: {
    type: "string",
    label: "Glasses Device ID",
  },
  companionWebhookUrl: {
    type: "string",
    label: "Companion Webhook URL",
  },
  pollingIntervalSeconds: {
    type: "number",
    label: "Polling Interval (seconds)",
    defaultValue: DEFAULT_POLLING_INTERVAL_SECONDS,
  },
  notifyOnColumns: {
    type: "array",
    label: "Notify on Columns",
    itemType: "string",
    defaultValue: DEFAULT_NOTIFY_COLUMNS,
  },
  quickCaptureDefaultColumn: {
    type: "enum",
    label: "Quick Capture Default Column",
    enumValues: [...COLUMN_SET],
    defaultValue: DEFAULT_QUICK_CAPTURE_COLUMN,
  },
  enableAgentActions: {
    type: "boolean",
    label: "Enable Agent Actions",
    defaultValue: true,
  },
};

function getSettingString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function getFusionBaseUrl(settings: Record<string, unknown>): string {
  return getSettingString(settings, "fusionApiBaseUrl") ?? DEFAULT_BASE_URL;
}

export function getFusionToken(settings: Record<string, unknown>): string | undefined {
  return getSettingString(settings, "fusionApiToken");
}

export function getCompanionWebhookUrl(settings: Record<string, unknown>): string | undefined {
  return getSettingString(settings, "companionWebhookUrl");
}

export function getPollingIntervalMs(settings: Record<string, unknown>): number {
  const raw = settings.pollingIntervalSeconds;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_POLLING_INTERVAL_SECONDS * 1000;
  }
  const seconds = Math.max(MIN_POLLING_INTERVAL_SECONDS, Math.floor(raw));
  return seconds * 1000;
}

export function getNotifyColumns(settings: Record<string, unknown>): TaskColumn[] {
  const raw = settings.notifyOnColumns;
  if (!Array.isArray(raw)) {
    return [...DEFAULT_NOTIFY_COLUMNS] as TaskColumn[];
  }
  const columns = raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value): value is TaskColumn => COLUMN_SET.has(value as TaskColumn));
  return columns.length > 0 ? columns : ([...DEFAULT_NOTIFY_COLUMNS] as TaskColumn[]);
}

export function getQuickCaptureColumn(settings: Record<string, unknown>): TaskColumn {
  const raw = getSettingString(settings, "quickCaptureDefaultColumn");
  return raw && COLUMN_SET.has(raw as TaskColumn) ? (raw as TaskColumn) : DEFAULT_QUICK_CAPTURE_COLUMN;
}

export function agentActionsEnabled(settings: Record<string, unknown>): boolean {
  const raw = settings.enableAgentActions;
  return typeof raw === "boolean" ? raw : true;
}

export type { TaskColumn };
