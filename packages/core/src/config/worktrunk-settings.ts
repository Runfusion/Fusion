import type { WorktrunkOnFailure, WorktrunkSettings } from "../types.js";

const WORKTRUNK_ON_FAILURE_VALUES: readonly WorktrunkOnFailure[] = [
  "fail",
  "fallback-native",
] as const;

export const DEFAULT_WORKTRUNK_SETTINGS: Required<Pick<WorktrunkSettings, "enabled" | "onFailure">> &
  Pick<WorktrunkSettings, "binaryPath" | "installedBinaryPath"> = {
  enabled: false,
  binaryPath: undefined,
  installedBinaryPath: undefined,
  onFailure: "fail",
};

/** Merge global ← project field-by-field so partial project overrides don't
 *  wipe global values. A project value of `undefined` is treated as "inherit
 *  from global". */
export function resolveWorktrunkSettings(
  globalValue: WorktrunkSettings | undefined,
  projectValue: WorktrunkSettings | undefined,
): WorktrunkSettings {
  const enabled = projectValue?.enabled ?? globalValue?.enabled ?? DEFAULT_WORKTRUNK_SETTINGS.enabled;
  const binaryPath =
    projectValue?.binaryPath ?? globalValue?.binaryPath ?? DEFAULT_WORKTRUNK_SETTINGS.binaryPath;
  const installedBinaryPath =
    projectValue?.installedBinaryPath ??
    globalValue?.installedBinaryPath ??
    DEFAULT_WORKTRUNK_SETTINGS.installedBinaryPath;
  const onFailure =
    projectValue?.onFailure ?? globalValue?.onFailure ?? DEFAULT_WORKTRUNK_SETTINGS.onFailure;

  return {
    enabled,
    ...(binaryPath !== undefined ? { binaryPath } : {}),
    ...(installedBinaryPath !== undefined ? { installedBinaryPath } : {}),
    onFailure,
  };
}

/** Strict validator used by GlobalSettingsStore writes and CLI parsing. */
export function requiresWorktrunkInstallVerification(params: {
  current: WorktrunkSettings | undefined;
  next: WorktrunkSettings | undefined;
}): boolean {
  const currentEnabled = params.current?.enabled ?? DEFAULT_WORKTRUNK_SETTINGS.enabled;
  const nextEnabled = params.next?.enabled ?? DEFAULT_WORKTRUNK_SETTINGS.enabled;
  return currentEnabled !== true && nextEnabled === true;
}

/** Strict validator used by GlobalSettingsStore writes and CLI parsing. */
export function validateWorktrunkSettings(value: unknown): WorktrunkSettings {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("worktrunk settings must be an object");
  }

  const input = value as Record<string, unknown>;
  const validated: WorktrunkSettings = {};

  if (input.enabled !== undefined) {
    validated.enabled = Boolean(input.enabled);
  }

  if (input.binaryPath !== undefined) {
    if (typeof input.binaryPath !== "string") {
      throw new Error("worktrunk.binaryPath must be a string when set");
    }
    const trimmed = input.binaryPath.trim();
    if (trimmed.length === 0) {
      throw new Error("worktrunk.binaryPath cannot be empty");
    }
    validated.binaryPath = trimmed;
  }

  if (input.onFailure !== undefined) {
    if (typeof input.onFailure !== "string") {
      throw new Error("worktrunk.onFailure must be a string when set");
    }
    if (!(WORKTRUNK_ON_FAILURE_VALUES as readonly string[]).includes(input.onFailure)) {
      throw new Error('worktrunk.onFailure must be one of: "fail", "fallback-native"');
    }
    validated.onFailure = input.onFailure as WorktrunkOnFailure;
  }

  if (input.installedBinaryPath !== undefined) {
    if (typeof input.installedBinaryPath !== "string") {
      throw new Error("worktrunk.installedBinaryPath must be a string when set");
    }
    const trimmed = input.installedBinaryPath.trim();
    if (trimmed.length === 0) {
      throw new Error("worktrunk.installedBinaryPath cannot be empty");
    }
    validated.installedBinaryPath = trimmed;
  }

  return validated;
}
