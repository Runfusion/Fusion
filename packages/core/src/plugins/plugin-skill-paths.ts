import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginSkillContribution } from "./plugin-types.js";

export interface PluginSkillBodyPath {
  absolutePath: string;
  relativePath: string;
}

function normalizeSkillRelativePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveInsidePluginRoot(pluginRoot: string, relativePath: string): PluginSkillBodyPath | null {
  const normalizedRoot = resolve(pluginRoot);
  const normalizedRelativePath = normalizeSkillRelativePath(relativePath);
  if (!normalizedRelativePath) return null;
  const absolutePath = resolve(normalizedRoot, normalizedRelativePath);
  if (!isWithinRoot(normalizedRoot, absolutePath)) return null;
  return {
    absolutePath,
    relativePath: relative(normalizedRoot, absolutePath).split(sep).join("/"),
  };
}

/**
 * FNXC:PluginSkills 2026-07-12-00:00:
 * PluginSkillContribution.skillFiles was declared in the public SDK but the host ignored it (GitHub #2018), which forced plugin authors to mirror skill names in a flat skills/<name>/SKILL.md layout. This resolver makes skillFiles[0] the authoritative plugin-root-relative body path, preserves the name-derived fallback for existing plugins, and rejects traversal so plugin skill bodies never resolve outside the plugin package.
 */
export function resolvePluginSkillBodyPath(
  skill: Pick<PluginSkillContribution, "name" | "skillFiles">,
  pluginRoot: string,
): PluginSkillBodyPath {
  const declaredPath = skill.skillFiles?.[0];
  if (typeof declaredPath === "string" && declaredPath.trim().length > 0) {
    const declared = resolveInsidePluginRoot(pluginRoot, declaredPath);
    if (declared) return declared;
  }

  const fallbackPath = `skills/${skill.name}/SKILL.md`;
  const fallback = resolveInsidePluginRoot(pluginRoot, fallbackPath);
  if (!fallback) {
    throw new Error(`Plugin skill body path for "${skill.name}" escapes plugin root: ${fallbackPath}`);
  }
  return fallback;
}

export function resolvePluginRootFromEntryPath(pluginEntryPath: string): string {
  const entryDir = dirname(resolve(pluginEntryPath));
  const dirName = entryDir.split(sep).pop();
  return dirName && ["dist", "build", "lib", "src"].includes(dirName) ? dirname(entryDir) : entryDir;
}
