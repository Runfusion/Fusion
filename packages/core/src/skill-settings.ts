export type SkillSettingState = "enabled" | "disabled";

export interface SkillSettingsScope {
  skills?: string[];
  packages?: Array<string | { source: string; skills?: string[] }>;
}

/**
 * Compute deterministic skill ID from metadata.
 * Format: encodeURIComponent(metadata.source) + "::" + relativePath
 *
 * @param source - The package source identifier
 * @param relativePath - Path relative to the skill directory
 * @returns Deterministic skill ID
 */
export function computeSkillId(source: string, relativePath: string): string {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  return `${encodeURIComponent(source)}::${normalizedPath}`;
}

/**
 * Parse a skill ID back into source and relativePath components.
 */
export function parseSkillId(skillId: string): { source: string; relativePath: string } | null {
  const parts = skillId.split("::");
  if (parts.length !== 2) return null;
  try {
    return {
      source: decodeURIComponent(parts[0]!),
      relativePath: parts[1]!,
    };
  } catch {
    return null;
  }
}

export function normalizeStoredSkillPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^skills\//, "");
}

function settingEntryState(entry: string): SkillSettingState {
  return entry.startsWith("+") ? "enabled" : "disabled";
}

/**
 * FNXC:PluginSkills 2026-07-12-00:00:
 * Plugin-skill effective enablement must have one resolver shared by dashboard discovery and engine session assembly. FN-7858 fixed drift where Skills view honored per-project toggles but collectPluginSkillNames only used static plugin defaults.
 */
export function getSkillSettingState(
  skillId: string,
  settings: SkillSettingsScope,
): SkillSettingState | undefined {
  const parsedSkillId = parseSkillId(skillId);
  if (!parsedSkillId) {
    return undefined;
  }

  const normalizedSkillPath = normalizeStoredSkillPath(parsedSkillId.relativePath);

  const skills = settings.skills ?? [];
  for (const entry of skills) {
    if (typeof entry !== "string") continue;
    const entryPath = normalizeStoredSkillPath(
      entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry,
    );
    const entryId = computeSkillId("*", `skills/${entryPath}`);
    if (entryId === skillId || entryPath === normalizedSkillPath) {
      return settingEntryState(entry);
    }
  }

  const packages = settings.packages ?? [];
  for (const pkg of packages) {
    const source = typeof pkg === "string" ? pkg : pkg.source;
    const pkgSkills = typeof pkg === "object" && pkg !== null ? pkg.skills : undefined;
    if (!pkgSkills) continue;

    for (const entry of pkgSkills) {
      if (typeof entry !== "string") continue;
      const entryPath = normalizeStoredSkillPath(
        entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry,
      );
      const entryId = computeSkillId(source, `skills/${entryPath}`);
      if (entryId === skillId || entryPath === normalizedSkillPath) {
        return settingEntryState(entry);
      }
    }
  }

  return undefined;
}

export function resolvePluginSkillEnabled(
  settings: SkillSettingsScope,
  pluginId: string,
  skillName: string,
  staticEnabled: boolean | undefined,
): boolean {
  const skillId = computeSkillId(`plugin:${pluginId}`, `skills/${skillName}/SKILL.md`);
  const settingState = getSkillSettingState(skillId, settings);
  return settingState === undefined ? staticEnabled !== false : settingState === "enabled";
}
