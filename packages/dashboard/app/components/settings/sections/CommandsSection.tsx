import type { ReactNode } from "react";
import type { SectionBaseProps } from "./context";
import { SettingsTextRow } from "../SettingsTextRow";
import { useTranslation } from "react-i18next";
export interface CommandsSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
}
/*
FNXC:SettingsStyling 2026-07-15-17:35:
Both commands render through the shared settings primitives instead of hand-rolled `form-group` markup, so label, help, and scope badge come from the one settings type scale. `.form-group` stays untouched and global — 35 non-settings files style forms with it, so settings migrate off it rather than restyle it underneath everything else.

FNXC:SettingsScope 2026-07-15-17:35:
Both keys are project-scoped (`DEFAULT_PROJECT_SETTINGS`): a test/build command describes one repository's toolchain and must not follow the operator to another project. The nav already labels this section project-scoped; the badges restate it per row because search can land an operator on a single control with no section chrome in view.
*/
export function CommandsSection({ scopeBanner, form, setForm }: CommandsSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.commands.commands", "Commands")}</h4>
      {/* FNXC:Commands 2026-07-15-17:35: An emptied field stores `undefined`, not "", so the key is absent from the settings blob and spec generation omits the command rather than injecting a blank one. */}
      <SettingsTextRow
        descriptor={{
          key: "testCommand",
          label: t("settings.commands.testCommand", "Test Command"),
          help: t("settings.commands.commandUsedToRunTestsInjectedIntoGenerated", "Command used to run tests — injected into generated task specs. No default — unset."),
          scope: "project",
          placeholder: t("settings.commands.eGPnpmTest", "e.g. pnpm test"),
        }}
        value={form.testCommand ?? null}
        onChange={(v) => setForm((f) => ({ ...f, testCommand: v || undefined }))}
      />
      <SettingsTextRow
        descriptor={{
          key: "buildCommand",
          label: t("settings.commands.buildCommand", "Build Command"),
          help: t("settings.commands.commandUsedToBuildTheProjectInjectedInto", "Command used to build the project — injected into generated task specs. No default — unset."),
          scope: "project",
          placeholder: t("settings.commands.eGPnpmBuild", "e.g. pnpm build"),
        }}
        value={form.buildCommand ?? null}
        onChange={(v) => setForm((f) => ({ ...f, buildCommand: v || undefined }))}
      />
    </>);
}
export default CommandsSection;
