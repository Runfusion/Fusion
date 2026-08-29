/**
 * SettingsSection — section scaffolding for grouped settings rows (U8 / KTD-10).
 * Renders a titled block with optional description and consistent spacing; the
 * redesigned SettingsModal and the WorkflowSettingsPanel both group their rows
 * inside one. Title/description are pre-translated by the caller.
 */
import type { ReactNode } from "react";
import "./SettingsSection.css";

export interface SettingsSectionProps {
  /** Pre-translated section title. */
  title: string;
  /** Pre-translated section description, rendered under the title. */
  description?: string;
  children: ReactNode;
}

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className="settings-section">
      <header className="settings-section-head">
        <h3 className="settings-section-title">{title}</h3>
        {description && <p className="settings-section-desc">{description}</p>}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

export default SettingsSection;
