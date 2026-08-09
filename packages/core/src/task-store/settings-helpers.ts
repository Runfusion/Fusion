/**
 * Settings canonicalization and deep-merge helpers.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: function bodies are byte-identical to their
 * pre-extraction form. store.ts re-imports these helpers.
 */
import type { Settings } from "../types.js";
import { validateWorktrunkSettings } from "../config/worktrunk-settings.js";

/**
 * Canonicalizes a settings object by stripping legacy fields that are no longer valid
 * and rewriting legacy path values left over from the kb → fn rename.
 */
export function canonicalizeSettings(settings: Settings): Settings {
  /*
  FNXC:WorkflowAgentRouting 2026-08-09-01:04:
  FN-8847 removes the retired ephemeralAgentsEnabled compatibility input. Strip it with the
  earlier globalMaxConcurrent field at every read boundary so stale configuration payloads cannot
  reappear or affect durable workflow-principal routing.
  */
  const { globalMaxConcurrent, ephemeralAgentsEnabled: _ephemeralAgentsEnabled, ...rest } = settings as Settings & {
    globalMaxConcurrent?: number;
    ephemeralAgentsEnabled?: boolean;
  };
  const base = globalMaxConcurrent !== undefined || _ephemeralAgentsEnabled !== undefined ? (rest as Settings) : settings;

  const canonicalWorktrunk = (() => {
    try {
      return validateWorktrunkSettings(base.worktrunk);
    } catch {
      return undefined;
    }
  })();

  const withWorktrunk = {
    ...base,
    ...(canonicalWorktrunk !== undefined ? { worktrunk: canonicalWorktrunk } : {}),
  };

  // Rewrite legacy .kb/backups → .fusion/backups for projects upgraded from the
  // old brand so persisted settings keep working. Custom .kb/* paths are left alone.
  if (withWorktrunk.autoBackupDir === ".kb/backups") {
    return { ...withWorktrunk, autoBackupDir: ".fusion/backups" };
  }
  return withWorktrunk;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMergeWithNullDelete(
  existingValue: unknown,
  patchValue: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = isPlainObject(existingValue) ? { ...existingValue } : {};

  for (const [key, value] of Object.entries(patchValue)) {
    if (value === null) {
      delete merged[key];
      continue;
    }

    if (isPlainObject(value)) {
      const nested = deepMergeWithNullDelete(merged[key], value);
      if (nested === undefined) {
        delete merged[key];
      } else {
        merged[key] = nested;
      }
      continue;
    }

    merged[key] = value;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}
