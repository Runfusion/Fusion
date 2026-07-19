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

/**
 * Input types a settings text row may render.
 *
 * FNXC:SettingsSecurity 2026-07-15-18:52:
 * `password` exists because the primitive previously hardcoded `type="text"`, which made every secret-bearing row unmigratable: ntfy access tokens and GitHub/GitLab/Cloudflare tunnel tokens would have rendered on screen in plain text. Rows stayed hand-rolled to stay masked, which is why they were also absent from the settings search index.
 * `url` carries the same intent for the URL fields those blocks sit beside — keeping a block's rows on one idiom rather than splitting it across primitive and bespoke markup.
 * Deliberately NOT the full HTML input-type surface: this is the set settings actually store. `number` has its own row primitive, and `email`/`tel`/`search` have no settings that use them — adding them speculatively would invite a caller to pick a type the row's string plumbing does not model.
 */
export type SettingsTextInputType = "text" | "password" | "url";

export interface SettingsTextDescriptor extends SettingsDescriptorBase {
  placeholder?: string;
  /** Input type. Defaults to `text`. */
  type?: SettingsTextInputType;
  /**
   * `autocomplete` attribute for the control.
   *
   * FNXC:SettingsSecurity 2026-07-15-18:52:
   * Defaults to `off` for `password` rows so a browser never offers to save or autofill a stored API token, matching the `autoComplete="off"` the hand-rolled token inputs carried. Secure-by-default: a caller who forgets it still gets the safe behavior, and opting back in has to be deliberate.
   */
  autoComplete?: string;
}
