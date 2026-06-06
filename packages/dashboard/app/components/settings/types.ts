/**
 * Shared descriptor types for the schema-driven settings primitives (U8 /
 * KTD-10). Rows render from a per-field descriptor — the same render-by-type
 * idiom WorkflowFieldsPanel uses for custom-field widgets. Label/help strings on
 * the descriptor are pre-translated by the caller; primitives never translate
 * descriptor copy themselves.
 */
import type { SettingsScope } from "./SettingsFieldRow";

export type { SettingsScope };

/** Fields common to every typed row descriptor. */
export interface SettingsDescriptorBase {
  /** Stable setting key (also used as the control's element id). */
  key: string;
  /** Pre-translated label. */
  label: string;
  /** Pre-translated help/description. */
  help?: string;
  /** Scope badge to display (global/project), or none. */
  scope?: SettingsScope;
  /** Disable the control + clear affordance. */
  disabled?: boolean;
}

/** A single option for a select descriptor. `label` is pre-translated. */
export interface SettingsSelectOption {
  value: string;
  label: string;
}

export interface SettingsSelectDescriptor extends SettingsDescriptorBase {
  options: SettingsSelectOption[];
}

export interface SettingsNumberDescriptor extends SettingsDescriptorBase {
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export interface SettingsTextDescriptor extends SettingsDescriptorBase {
  placeholder?: string;
}
