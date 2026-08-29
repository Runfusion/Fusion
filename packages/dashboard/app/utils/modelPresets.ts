import type { ModelPreset } from "@fusion/core";

export function getPresetByName(presets: ModelPreset[], name: string): ModelPreset | undefined {
  const normalizedName = name.trim().toLowerCase();
  return presets.find((preset) => preset.name.trim().toLowerCase() === normalizedName);
}

export function applyPresetToSelection(preset: ModelPreset | undefined): {
  executorValue: string;
  validatorValue: string;
} {
  return {
    executorValue: preset?.executorProvider && preset?.executorModelId
      ? `${preset.executorProvider}/${preset.executorModelId}`
      : "",
    validatorValue: preset?.validatorProvider && preset?.validatorModelId
      ? `${preset.validatorProvider}/${preset.validatorModelId}`
      : "",
  };
}

export function getRecommendedPresetForSize(
  size: "S" | "M" | "L" | undefined,
  defaultPresetBySize: Record<string, string>,
  presets: ModelPreset[],
): ModelPreset | undefined {
  if (!size) return undefined;
  const presetId = defaultPresetBySize[size];
  if (!presetId) return undefined;
  return presets.find((preset) => preset.id === presetId);
}

export function validatePresetId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(id);
}

export function generatePresetId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);

  return slug || "preset";
}

/**
 * Generate a unique preset ID derived from the preset name, avoiding collisions
 * with existing preset IDs. If the base slug is already taken, appends `-1`,
 * `-2`, etc. until a unique ID is found.
 */
export function generateUniquePresetId(name: string, existingPresets: ModelPreset[]): string {
  const baseId = generatePresetId(name);
  const takenIds = new Set(existingPresets.map((p) => p.id));

  if (!takenIds.has(baseId)) return baseId;

  // Leave room for the numeric suffix (-N)
  const maxBase = 30;
  let candidate = baseId;
  let idx = 1;
  while (takenIds.has(candidate) && idx < 100) {
    const suffix = `-${idx}`;
    candidate = `${baseId.slice(0, maxBase - suffix.length)}${suffix}`;
    idx++;
  }
  return candidate;
}
