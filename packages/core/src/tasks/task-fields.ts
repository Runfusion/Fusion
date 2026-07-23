/**
 * Custom task field validation & reconciliation authority (U11 / KTD-13).
 *
 * Workflows declare typed custom task fields ({@link WorkflowFieldDefinition});
 * task values live in `tasks.customFields` (a JSON object keyed by field id).
 * This module is the single, side-effect-free validation core that the store
 * write authority (`updateTaskCustomFields` / `updateTask`) delegates to. It
 * mirrors the `TransitionRejection` style: a flat, JSON-safe typed rejection
 * with a machine-stable `code`, the offending `fieldId`, and a non-localized
 * `detail` string for audit/logs.
 *
 * Three operations:
 *  - {@link validateCustomFieldPatch} — validate a `Record<string, unknown>`
 *    patch against a field schema, normalizing accepted values. `null`/`undefined`
 *    in the patch is a delete sentinel for that field (always accepted).
 *  - {@link applyFieldDefaults} — fill `default` for required fields absent from
 *    the current values (task create / workflow selection).
 *  - {@link reconcileFieldsOnWorkflowChange} — partition existing values into
 *    `kept` (same id, type-compatible) and `orphaned` (everything else) when a
 *    workflow's fields change or the task switches workflows. Orphans are
 *    RETAINED in storage — this only computes the partition so the UI can render
 *    the orphaned-fields disclosure.
 */

import type {
  WorkflowFieldDefinition,
} from "../workflows/workflow-ir-types.js";

// ---------------------------------------------------------------------------
// Typed rejection (TransitionRejection-style: flat, JSON-safe, no class)
// ---------------------------------------------------------------------------

/**
 * Reason codes for a rejected custom-field write. Stable string literals — they
 * cross the agent-tool / HTTP boundary and are matched by surfaces for copy, so
 * they must not change without migrating consumers.
 */
export type CustomFieldRejectionCode =
  | "no-fields-defined"
  | "unknown-field"
  | "type-mismatch"
  | "enum-violation";

/** The full, immutable set of custom-field rejection codes. */
export const CUSTOM_FIELD_REJECTION_CODES: readonly CustomFieldRejectionCode[] = [
  "no-fields-defined",
  "unknown-field",
  "type-mismatch",
  "enum-violation",
] as const;

/**
 * A typed custom-field rejection. Flat and JSON-safe by construction — mirrors
 * {@link import("./transition-types.js").TransitionRejection}.
 *
 * - `code` — machine-stable {@link CustomFieldRejectionCode}.
 * - `fieldId` — the offending field id (the patch key that failed).
 * - `detail` — non-localized diagnostic context for audit/logs.
 */
export interface CustomFieldRejection {
  code: CustomFieldRejectionCode;
  fieldId: string;
  detail: string;
}

/** Result of validating a custom-field patch. Discriminated on `ok`. */
export type CustomFieldPatchResult =
  | { ok: true; normalized: Record<string, unknown> }
  | { ok: false; rejection: CustomFieldRejection };

/** Construct a {@link CustomFieldRejection}. */
export function makeCustomFieldRejection(
  code: CustomFieldRejectionCode,
  fieldId: string,
  detail: string,
): CustomFieldRejection {
  return { code, fieldId, detail };
}

/**
 * Thrown by the throw-based write paths (`updateTask` with a `customFields`
 * patch) when validation rejects. `updateTaskCustomFields` returns the typed
 * rejection instead; this wrapper exists for the legacy throw contract so a bad
 * `updateTask` write fails loudly rather than silently round-tripping an invalid
 * value (the U4 opaque behavior). Carries the structured rejection so HTTP/agent
 * surfaces can recover the field path and code.
 */
export class CustomFieldRejectionError extends Error {
  readonly rejection: CustomFieldRejection;
  constructor(rejection: CustomFieldRejection) {
    super(`custom field '${rejection.fieldId}' rejected (${rejection.code}): ${rejection.detail}`);
    this.name = "CustomFieldRejectionError";
    this.rejection = rejection;
  }
}

// ---------------------------------------------------------------------------
// Per-type value validation
// ---------------------------------------------------------------------------

/** True iff `value` is a non-empty option-value member of `field.options`. */
function isEnumMember(field: WorkflowFieldDefinition, value: string): boolean {
  return (field.options ?? []).some((o) => o.value === value);
}

/**
 * Validate (and normalize) a single non-null value against a field's type.
 * Returns the normalized value on success, or a rejection. The caller has
 * already resolved the field definition.
 */
function validateValue(
  field: WorkflowFieldDefinition,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; rejection: CustomFieldRejection } {
  const reject = (
    code: CustomFieldRejectionCode,
    detail: string,
  ): { ok: false; rejection: CustomFieldRejection } => ({
    ok: false,
    rejection: makeCustomFieldRejection(code, field.id, detail),
  });

  switch (field.type) {
    case "string":
    case "text": {
      if (typeof value !== "string") {
        return reject("type-mismatch", `field '${field.id}' expects a string, got ${typeof value}`);
      }
      return { ok: true, value };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return reject(
          "type-mismatch",
          `field '${field.id}' expects a finite number, got ${typeof value === "number" ? String(value) : typeof value}`,
        );
      }
      return { ok: true, value };
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return reject("type-mismatch", `field '${field.id}' expects a boolean, got ${typeof value}`);
      }
      return { ok: true, value };
    }
    case "enum": {
      if (typeof value !== "string") {
        return reject("type-mismatch", `field '${field.id}' (enum) expects a string option value, got ${typeof value}`);
      }
      if (!isEnumMember(field, value)) {
        return reject("enum-violation", `field '${field.id}' value '${value}' is not a declared option`);
      }
      return { ok: true, value };
    }
    case "multi-enum": {
      if (!Array.isArray(value)) {
        return reject("type-mismatch", `field '${field.id}' (multi-enum) expects an array, got ${typeof value}`);
      }
      const seen = new Set<string>();
      for (const item of value) {
        if (typeof item !== "string") {
          return reject("type-mismatch", `field '${field.id}' (multi-enum) members must be strings`);
        }
        if (!isEnumMember(field, item)) {
          return reject("enum-violation", `field '${field.id}' member '${item}' is not a declared option`);
        }
        if (seen.has(item)) {
          return reject("enum-violation", `field '${field.id}' has duplicate member '${item}'`);
        }
        seen.add(item);
      }
      return { ok: true, value: [...value] as string[] };
    }
    case "date": {
      if (typeof value !== "string") {
        return reject("type-mismatch", `field '${field.id}' (date) expects an ISO date string, got ${typeof value}`);
      }
      const ms = Date.parse(value);
      if (Number.isNaN(ms)) {
        return reject("type-mismatch", `field '${field.id}' value '${value}' is not a parseable date`);
      }
      return { ok: true, value };
    }
    case "url": {
      if (typeof value !== "string") {
        return reject("type-mismatch", `field '${field.id}' (url) expects a string, got ${typeof value}`);
      }
      try {
        new URL(value);
      } catch {
        return reject("type-mismatch", `field '${field.id}' value '${value}' is not a valid URL`);
      }
      return { ok: true, value };
    }
    default: {
      // Exhaustiveness guard — an unknown type cannot validate.
      const _exhaustive: never = field.type;
      return reject("type-mismatch", `field '${field.id}' has unsupported type '${String(_exhaustive)}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Patch validation authority
// ---------------------------------------------------------------------------

/**
 * Validate a custom-field `patch` against a workflow's field `fields`.
 *
 * - A `null`/`undefined` patch value is a DELETE sentinel: the field's stored
 *   value should be removed. It is always accepted (even for required fields —
 *   required is not a write-time gate this round, KTD-13) and surfaces in
 *   `normalized` as `null` so the caller can apply the delete uniformly.
 * - A non-null value is validated/normalized per the field's type.
 * - A patch key that names no declared field → `unknown-field`.
 * - When `fields` is undefined/empty and the patch carries any key → the whole
 *   patch is rejected `no-fields-defined` (the default workflow declares no
 *   fields; nothing can be written). An empty patch against no fields is `ok`.
 *
 * Validation is fail-fast: the first offending key produces the rejection.
 */
export function validateCustomFieldPatch(
  fields: WorkflowFieldDefinition[] | undefined,
  patch: Record<string, unknown>,
): CustomFieldPatchResult {
  const keys = Object.keys(patch);
  const byId = new Map<string, WorkflowFieldDefinition>((fields ?? []).map((f) => [f.id, f]));

  if (byId.size === 0) {
    if (keys.length === 0) return { ok: true, normalized: {} };
    return {
      ok: false,
      rejection: makeCustomFieldRejection(
        "no-fields-defined",
        keys[0]!,
        "the resolved workflow declares no custom fields; no values may be written",
      ),
    };
  }

  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    const value = patch[key];
    const field = byId.get(key);
    if (!field) {
      return {
        ok: false,
        rejection: makeCustomFieldRejection(
          "unknown-field",
          key,
          `field '${key}' is not declared by the task's workflow`,
        ),
      };
    }
    // null/undefined = delete this field's value.
    if (value === null || value === undefined) {
      normalized[key] = null;
      continue;
    }
    const res = validateValue(field, value);
    if (!res.ok) return res;
    normalized[key] = res.value;
  }
  return { ok: true, normalized };
}

// ---------------------------------------------------------------------------
// Defaults at create / workflow selection
// ---------------------------------------------------------------------------

/**
 * Fill `default` values for REQUIRED fields that are absent from `current`.
 * Returns a NEW merged object (does not mutate `current`); existing values win.
 * Non-required fields and fields without a declared `default` are left absent.
 *
 * Used at task create / workflow selection so a workflow with required+default
 * fields lands sensible initial values. Defaults are taken on trust from the
 * (already-validated-at-save) field schema.
 */
export function applyFieldDefaults(
  fields: WorkflowFieldDefinition[] | undefined,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(current ?? {}) };
  for (const field of fields ?? []) {
    if (!field.required) continue;
    if (field.default === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(out, field.id) && out[field.id] !== undefined) {
      continue;
    }
    out[field.id] = field.default;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconciliation on workflow edit / switch
// ---------------------------------------------------------------------------

/**
 * A stored value for `field` is type-compatible with a new field definition iff
 * the new value re-validates cleanly. For enum-kind fields, compatibility also
 * requires the value still be a member of the new options (handled by
 * re-validation). This is the same gate {@link validateValue} applies on write,
 * so "kept" values are guaranteed re-writable under the new schema.
 */
function valueCompatible(newField: WorkflowFieldDefinition, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return validateValue(newField, value).ok;
}

/** Partition of existing values produced by {@link reconcileFieldsOnWorkflowChange}. */
export interface FieldReconciliation {
  /** Values whose id survives in the new schema AND remain type-compatible. */
  kept: Record<string, unknown>;
  /**
   * Values that no longer fit: id removed from the new schema, or the type
   * changed incompatibly (including an enum value no longer in the new options).
   * RETAINED in storage — listed here only so the UI can render them under the
   * orphaned-fields disclosure.
   */
  orphaned: Record<string, unknown>;
}

/**
 * Reconcile stored `values` when a workflow's field schema changes (edit) or a
 * task switches workflows. Same-id values are KEPT when the new field is
 * type-compatible (same type, or both enum-kind with the value still a member —
 * enforced by re-validation); everything else is ORPHANED.
 *
 * Storage keeps EVERYTHING — this function only computes the partition. Callers
 * persist `{...kept, ...orphaned}` (i.e. the original values, unchanged) and use
 * `orphaned` purely for UI disclosure. `oldFields` is accepted for symmetry and
 * future heuristics; the decision is driven entirely by `newFields` + the value.
 */
export function reconcileFieldsOnWorkflowChange(
  oldFields: WorkflowFieldDefinition[] | undefined,
  newFields: WorkflowFieldDefinition[] | undefined,
  values: Record<string, unknown> | undefined,
): FieldReconciliation {
  void oldFields; // reserved for future migration heuristics; intentionally unused
  const newById = new Map<string, WorkflowFieldDefinition>((newFields ?? []).map((f) => [f.id, f]));
  const kept: Record<string, unknown> = {};
  const orphaned: Record<string, unknown> = {};

  for (const [id, value] of Object.entries(values ?? {})) {
    const newField = newById.get(id);
    if (newField && valueCompatible(newField, value)) {
      kept[id] = value;
    } else {
      orphaned[id] = value;
    }
  }
  return { kept, orphaned };
}
