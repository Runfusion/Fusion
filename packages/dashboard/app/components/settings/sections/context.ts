/**
 * Shared contract for the per-section components the SettingsModal shell composes
 * (U9 / KTD-10).
 *
 * The shell owns ALL persistence: it holds the single merged `form`, the
 * scope-aware save-split (see settings/save-split.ts), null-as-delete, and the
 * changed-only project-write gate. Sections are presentational — they read from
 * `form`/section-specific data and emit edits back through `setForm` (and a few
 * section-scoped setters/handlers). They never call `updateSettings` /
 * `updateGlobalSettings` themselves.
 *
 * This is intentionally a pragmatic prop bag rather than a redesigned state
 * model: it mirrors exactly how the inline JSX read and wrote the modal's local
 * state, so extraction is behavior-preserving. Each section's props interface
 * extends {@link SectionBaseProps} and adds only the slice it needs.
 */
import type { Settings, GlobalSettings } from "@fusion/core";

/** A model-lane descriptor pairing a role's global and project override keys.
 *  Mirrors the `ModelLane` shape SettingsModal builds for its model pickers. */
export interface ModelLane {
  laneId: string;
  label: string;
  globalProviderKey: keyof GlobalSettings;
  globalModelKey: keyof GlobalSettings;
  globalThinkingKey?: keyof GlobalSettings;
  projectProviderKey: keyof Settings;
  projectModelKey: keyof Settings;
  projectThinkingKey?: keyof Settings;
  helperText: string;
  fallbackOrder: string;
}

/** Local form state extends Settings with a worktreeInitCommand override and
 *  lets tokenCap carry null (delete semantic). Mirrors SettingsModal's
 *  SettingsFormState. */
export type SettingsFormState = Settings & {
  worktreeInitCommand?: string;
  tokenCap?: number | null;
};

/** State updater identical to React's `setState` for the modal form. */
export type SetSettingsForm = (
  updater: SettingsFormState | ((prev: SettingsFormState) => SettingsFormState),
) => void;

/** Async callback registered by a section when it owns a shell-triggered save side effect. */
export type SectionSaveHandler = () => Promise<void>;

/** Props every extracted section receives. */
export interface SectionBaseProps {
  /** The single merged settings form (global + project keys). */
  form: SettingsFormState;
  /** Mutates the form; the shell's save-split decides scope + persistence. */
  setForm: SetSettingsForm;
}
