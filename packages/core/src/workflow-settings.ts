/**
 * Workflow setting-value validation & effective-resolution authority (U2, R2/R4).
 *
 * Workflows declare typed settings ({@link WorkflowSettingDefinition}); setting
 * *values* live per `(workflowId, projectId)` in the `workflow_settings` table (a
 * JSON object keyed by setting id). This module is the single, side-effect-free
 * validation core that the store write authority
 * (`updateWorkflowSettingValues`) delegates to. It mirrors `task-fields.ts`: a
 * flat, JSON-safe typed rejection with a machine-stable `code`, the offending
 * `settingId`, and a non-localized `detail` string for audit/logs.
 *
 * Two operations:
 *  - {@link validateSettingValuePatch} — validate a `Record<string, unknown>`
 *    patch against a setting schema, normalizing accepted values. `null`/`undefined`
 *    in the patch is a delete sentinel for that setting (always accepted).
 *  - {@link resolveEffectiveSettingValues} — compose stored values + declaration
 *    defaults into the effective value map, implementing DROP-ON-ORPHAN (KTD-6).
 *
 * KTD-6 — DELIBERATE DIVERGENCE FROM `task-fields.ts`. The custom-field reconciler
 * (`reconcileFieldsOnWorkflowChange`) RETAINS orphaned values and surfaces them in
 * a UI disclosure — safe for display data. Workflow settings are POLICY the engine
 * consumes (a retyped enum→number setting with a stale string value would feed
 * garbage into execution), so effective resolution DROPS any stored value that no
 * longer validates against the current declaration and falls to the declaration
 * `default`. The dropped raw values never reach the engine; the editor surfaces
 * them via {@link findOrphanedSettingValues} for the U6 disclosure.
 */

import type {
  WorkflowSettingDefinition,
} from "./workflow-ir-types.js";

// ---------------------------------------------------------------------------
// Typed rejection (TransitionRejection-style: flat, JSON-safe, no class)
// ---------------------------------------------------------------------------

/**
 * Reason codes for a rejected setting-value write. Stable string literals — they
 * cross the agent-tool / HTTP boundary and are matched by surfaces for copy, so
 * they must not change without migrating consumers. Mirrors
 * {@link import("./task-fields.js").CustomFieldRejectionCode}.
 */
export type WorkflowSettingRejectionCode =
  | "no-settings-defined"
  | "unknown-setting"
  | "type-mismatch"
  | "enum-violation";

/** The full, immutable set of setting-value rejection codes. */
export const WORKFLOW_SETTING_REJECTION_CODES: readonly WorkflowSettingRejectionCode[] = [
  "no-settings-defined",
  "unknown-setting",
  "type-mismatch",
  "enum-violation",
] as const;

/**
 * A typed setting-value rejection. Flat and JSON-safe by construction — mirrors
 * {@link import("./task-fields.js").CustomFieldRejection}.
 *
 * - `code` — machine-stable {@link WorkflowSettingRejectionCode}.
 * - `settingId` — the offending setting id (the patch key that failed).
 * - `message` — non-localized diagnostic context for audit/logs.
 */
export interface WorkflowSettingRejection {
  code: WorkflowSettingRejectionCode;
  settingId: string;
  message: string;
}

/** Result of validating a setting-value patch. */
export interface SettingValuePatchResult {
  /** The accepted, normalized values (a `null` entry is a delete sentinel). */
  accepted: Record<string, unknown>;
  /** The rejected keys with their typed reasons. */
  rejections: WorkflowSettingRejection[];
}

/** Construct a {@link WorkflowSettingRejection}. */
export function makeWorkflowSettingRejection(
  code: WorkflowSettingRejectionCode,
  settingId: string,
  message: string,
): WorkflowSettingRejection {
  return { code, settingId, message };
}

/**
 * Thrown by the throw-based store write path when a setting-value write rejects.
 * Mirrors {@link import("./task-fields.js").CustomFieldRejectionError}: carries
 * the structured rejection(s) so HTTP/agent surfaces can recover the setting path
 * and code.
 */
export class WorkflowSettingRejectionError extends Error {
  readonly rejections: WorkflowSettingRejection[];
  constructor(rejections: WorkflowSettingRejection[]) {
    const first = rejections[0];
    super(
      first
        ? `workflow setting '${first.settingId}' rejected (${first.code}): ${first.message}`
        : "workflow setting value write rejected",
    );
    this.name = "WorkflowSettingRejectionError";
    this.rejections = rejections;
  }
}

// ---------------------------------------------------------------------------
// Per-type value validation
// ---------------------------------------------------------------------------

/** True iff `value` is an option-value member of `setting.options`. */
function isEnumMember(setting: WorkflowSettingDefinition, value: string): boolean {
  return (setting.options ?? []).some((o) => o.value === value);
}

/**
 * Validate (and normalize) a single non-null value against a setting's type.
 * Returns the normalized value on success, or a rejection. The caller has already
 * resolved the setting definition.
 */
function validateValue(
  setting: WorkflowSettingDefinition,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; rejection: WorkflowSettingRejection } {
  const reject = (
    code: WorkflowSettingRejectionCode,
    message: string,
  ): { ok: false; rejection: WorkflowSettingRejection } => ({
    ok: false,
    rejection: makeWorkflowSettingRejection(code, setting.id, message),
  });

  switch (setting.type) {
    case "string":
    case "text": {
      if (typeof value !== "string") {
        return reject("type-mismatch", `setting '${setting.id}' expects a string, got ${typeof value}`);
      }
      return { ok: true, value };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return reject(
          "type-mismatch",
          `setting '${setting.id}' expects a finite number, got ${typeof value === "number" ? String(value) : typeof value}`,
        );
      }
      if (setting.integer === true && !Number.isInteger(value)) {
        return reject("type-mismatch", `setting '${setting.id}' expects an integer, got ${value}`);
      }
      if (setting.minimum !== undefined && value < setting.minimum) {
        return reject("type-mismatch", `setting '${setting.id}' must be at least ${setting.minimum}, got ${value}`);
      }
      return { ok: true, value };
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return reject("type-mismatch", `setting '${setting.id}' expects a boolean, got ${typeof value}`);
      }
      return { ok: true, value };
    }
    case "enum": {
      if (typeof value !== "string") {
        return reject("type-mismatch", `setting '${setting.id}' (enum) expects a string option value, got ${typeof value}`);
      }
      if (!isEnumMember(setting, value)) {
        return reject("enum-violation", `setting '${setting.id}' value '${value}' is not a declared option`);
      }
      return { ok: true, value };
    }
    case "multi-enum": {
      if (!Array.isArray(value)) {
        return reject("type-mismatch", `setting '${setting.id}' (multi-enum) expects an array, got ${typeof value}`);
      }
      const seen = new Set<string>();
      for (const item of value) {
        if (typeof item !== "string") {
          return reject("type-mismatch", `setting '${setting.id}' (multi-enum) members must be strings`);
        }
        if (!isEnumMember(setting, item)) {
          return reject("enum-violation", `setting '${setting.id}' member '${item}' is not a declared option`);
        }
        if (seen.has(item)) {
          return reject("enum-violation", `setting '${setting.id}' has duplicate member '${item}'`);
        }
        seen.add(item);
      }
      return { ok: true, value: [...value] as string[] };
    }
    default: {
      // Exhaustiveness guard — an unknown type cannot validate.
      const _exhaustive: never = setting.type;
      return reject("type-mismatch", `setting '${setting.id}' has unsupported type '${String(_exhaustive)}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Patch validation authority
// ---------------------------------------------------------------------------

/**
 * Validate a setting-value `patch` against a workflow's `declarations`.
 *
 * - A `null`/`undefined` patch value is a DELETE sentinel: the setting's stored
 *   value should be removed. It is ALWAYS accepted (null-as-delete) and surfaces
 *   in `accepted` as `null` so the caller can apply the delete uniformly.
 * - A non-null value is validated/normalized per the setting's type.
 * - A patch key that names no declared setting → `unknown-setting`.
 * - When `declarations` is undefined/empty and the patch carries any non-null key →
 *   that key is rejected `no-settings-defined`. (A delete against no declarations is
 *   harmless and accepted so stale rows can always be cleared.)
 *
 * Unlike the custom-field authority this is NOT fail-fast: every offending key is
 * reported so the editor can render per-field errors while applying the rest.
 */
export function validateSettingValuePatch(
  declarations: WorkflowSettingDefinition[] | undefined,
  patch: Record<string, unknown>,
): SettingValuePatchResult {
  const byId = new Map<string, WorkflowSettingDefinition>((declarations ?? []).map((d) => [d.id, d]));
  const accepted: Record<string, unknown> = {};
  const rejections: WorkflowSettingRejection[] = [];

  for (const key of Object.keys(patch)) {
    const value = patch[key];
    // null/undefined = delete this setting's value. Always accepted, even when the
    // declaration is gone (lets the editor clear orphaned rows).
    if (value === null || value === undefined) {
      accepted[key] = null;
      continue;
    }
    const setting = byId.get(key);
    if (byId.size === 0) {
      rejections.push(
        makeWorkflowSettingRejection(
          "no-settings-defined",
          key,
          "the named workflow declares no settings; no values may be written",
        ),
      );
      continue;
    }
    if (!setting) {
      rejections.push(
        makeWorkflowSettingRejection(
          "unknown-setting",
          key,
          `setting '${key}' is not declared by the named workflow`,
        ),
      );
      continue;
    }
    const res = validateValue(setting, value);
    if (!res.ok) {
      rejections.push(res.rejection);
      continue;
    }
    accepted[key] = res.value;
  }

  return { accepted, rejections };
}

// ---------------------------------------------------------------------------
// Effective resolution (drop-on-orphan, KTD-6)
// ---------------------------------------------------------------------------

/** A stored value re-validates cleanly against the current declaration. */
function valueStillValid(setting: WorkflowSettingDefinition, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return validateValue(setting, value).ok;
}

/** An orphaned stored entry: a value that no longer validates against the current
 *  declaration (type change, enum option removed, declaration deleted). Surfaced to
 *  the U6 editor disclosure; never fed to the engine. */
export interface OrphanedSettingValue {
  id: string;
  value: unknown;
}

/**
 * Resolve the EFFECTIVE setting values for a workflow from its `declarations` and
 * the raw `stored` map, implementing DROP-ON-ORPHAN (KTD-6).
 *
 * For each declared setting:
 *  - if a stored value exists AND re-validates against the current declaration →
 *    use the stored value;
 *  - otherwise (no stored value, OR a stored value that no longer validates —
 *    type change, enum option removed) → DROP it and use the declaration `default`
 *    when one is present; absent declarations contribute nothing.
 *
 * Stored values for ids with NO current declaration (declaration deleted) are
 * dropped entirely — they cannot reach the effective map. The raw `stored` row is
 * never mutated here; this is a pure read. Use {@link findOrphanedSettingValues}
 * to surface the dropped entries in the editor.
 */
export function resolveEffectiveSettingValues(
  declarations: WorkflowSettingDefinition[] | undefined,
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const storedMap = stored ?? {};
  const effective: Record<string, unknown> = {};

  for (const setting of declarations ?? []) {
    const has = Object.prototype.hasOwnProperty.call(storedMap, setting.id);
    const raw = has ? storedMap[setting.id] : undefined;
    if (has && valueStillValid(setting, raw)) {
      effective[setting.id] = raw;
      continue;
    }
    // Drop-on-orphan / unset → declaration default (when present).
    if (setting.default !== undefined) {
      effective[setting.id] = setting.default;
    }
  }

  return effective;
}

/**
 * Compute the orphaned stored entries for the U6 editor disclosure: stored ids
 * that either have no current declaration, or whose stored value no longer
 * validates against the current declaration. These are exactly the entries
 * {@link resolveEffectiveSettingValues} drops. The raw row is untouched.
 */
export function findOrphanedSettingValues(
  declarations: WorkflowSettingDefinition[] | undefined,
  stored: Record<string, unknown> | undefined,
): OrphanedSettingValue[] {
  const byId = new Map<string, WorkflowSettingDefinition>((declarations ?? []).map((d) => [d.id, d]));
  const orphaned: OrphanedSettingValue[] = [];

  for (const [id, value] of Object.entries(stored ?? {})) {
    if (value === null || value === undefined) continue;
    const setting = byId.get(id);
    if (!setting || !valueStillValid(setting, value)) {
      orphaned.push({ id, value });
    }
  }

  return orphaned;
}
