import { isPlainObject } from "./settings-helpers.js";

export interface SettingsActivityChange {
  key: string;
  from: string;
  to: string;
  sensitive: boolean;
}

export const SETTINGS_ACTIVITY_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "engineLastActiveAt",
  "engineActiveSinceMs",
  "postgresMigrationInboxMessageSentAt",
  "secretsSyncPassphraseConfigured",
  "dashboardCurrentProjectIdByNode",
]);

const MAX_LISTED_CHANGES = 8;
const MAX_METADATA_CHANGES = 50;
const SENSITIVE_KEY_PATTERN = /token|secret|passphrase|password|apikey|credential/i;

/*
FNXC:SettingsAuditTrail 2026-10-12-15:03:
FN-8853 removes the allowlist after an incident where the Activity Log answered "never changed"
for autoMerge. Engine-owned churn, secret configuration state, and dashboard project-selection
restore state are excluded instead of abandoning generic coverage. Values are redacted or summarized
for the user-visible log; workflow settings such as requirePrApproval are MOVED_SETTINGS_KEYS and
never occur in this payload, so they remain outside this activity surface.
*/
export function isSensitiveSettingsKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function summarizeSettingsValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return "unset";
  if (isSensitiveSettingsKey(key)) return "«redacted»";
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  }
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (isPlainObject(value)) return "{…}";
  return String(value);
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  }
  return Object.prototype.toString.call(value);
}

export function diffSettingsForActivity(
  previous: object,
  next: object,
): SettingsActivityChange[] {
  const previousValues = previous as Record<string, unknown>;
  const nextValues = next as Record<string, unknown>;
  const keys = new Set([...Object.keys(previousValues), ...Object.keys(nextValues)]);
  return [...keys]
    .filter((key) => !SETTINGS_ACTIVITY_EXCLUDED_KEYS.has(key) && stableValue(previousValues[key]) !== stableValue(nextValues[key]))
    .sort()
    .map((key) => ({
      key,
      from: summarizeSettingsValue(key, previousValues[key]),
      to: summarizeSettingsValue(key, nextValues[key]),
      sensitive: isSensitiveSettingsKey(key),
    }));
}

export function formatSettingsActivity(
  changes: SettingsActivityChange[],
): { details: string; metadata: Record<string, unknown> } | null {
  if (changes.length === 0) return null;
  const listed = changes
    .slice(0, MAX_LISTED_CHANGES)
    .map((change) => `${change.key}: ${change.from} → ${change.to}`);
  const details = `Settings updated: ${listed.join(", ")}${changes.length > MAX_LISTED_CHANGES ? `, +${changes.length - MAX_LISTED_CHANGES} more` : ""}`;
  const metadataChanges = changes
    .slice(0, MAX_METADATA_CHANGES)
    .map((change) => `${change.key}: ${change.from} → ${change.to}`);
  return {
    details,
    metadata: {
      changes: metadataChanges,
      changedKeys: changes.slice(0, MAX_METADATA_CHANGES).map((change) => change.key),
      changedCount: changes.length,
    },
  };
}
