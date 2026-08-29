/**
 * Schema-driven Settings UI primitives (U8 / KTD-10). Shared building blocks the
 * redesigned SettingsModal (U9) and the WorkflowSettingsPanel (U6) compose.
 */
export { SettingsFieldRow } from "./SettingsFieldRow";
export type { SettingsFieldRowProps, SettingsScope } from "./SettingsFieldRow";
export { SettingsToggleRow } from "./SettingsToggleRow";
export type { SettingsToggleRowProps } from "./SettingsToggleRow";
export { SettingsNumberRow } from "./SettingsNumberRow";
export type { SettingsNumberRowProps } from "./SettingsNumberRow";
export { SettingsSelectRow } from "./SettingsSelectRow";
export type { SettingsSelectRowProps } from "./SettingsSelectRow";
export { SettingsTextRow } from "./SettingsTextRow";
export type { SettingsTextRowProps } from "./SettingsTextRow";
export { SettingsTextareaRow } from "./SettingsTextareaRow";
export type { SettingsTextareaRowProps } from "./SettingsTextareaRow";
export { SettingsSection } from "./SettingsSection";
export type { SettingsSectionProps } from "./SettingsSection";
export type {
  SettingsDescriptorBase,
  SettingsSelectOption,
  SettingsSelectDescriptor,
  SettingsNumberDescriptor,
  SettingsTextDescriptor,
} from "./types";
