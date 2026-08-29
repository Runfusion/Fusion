export interface DroidCliSettings {
  binaryPath: string;
  model?: string;
}

export function resolveCliSettings(settings?: Record<string, unknown>): DroidCliSettings {
  const binaryPath =
    typeof settings?.droidBinaryPath === "string" && settings.droidBinaryPath.trim().length > 0
      ? settings.droidBinaryPath.trim()
      : "droid";
  const model = typeof settings?.droidModel === "string" ? settings.droidModel : undefined;
  return { binaryPath, model };
}
