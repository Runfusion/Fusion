import type { ReactNode } from "react";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export interface CommandsSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
}
export function CommandsSection({ scopeBanner, form, setForm }: CommandsSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.commands.commands", "Commands")}</h4>
      <div className="form-group">
        <label htmlFor="testCommand">{t("settings.commands.testCommand", "Test Command")}</label>
        <input id="testCommand" type="text" placeholder={t("settings.commands.eGPnpmTest", "e.g. pnpm test")} value={form.testCommand || ""} onChange={(e) => setForm((f) => ({ ...f, testCommand: e.target.value || undefined }))}/>
        <small>{t("settings.commands.commandUsedToRunTestsInjectedIntoGenerated", "Command used to run tests \u2014 injected into generated task specs")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="buildCommand">{t("settings.commands.buildCommand", "Build Command")}</label>
        <input id="buildCommand" type="text" placeholder={t("settings.commands.eGPnpmBuild", "e.g. pnpm build")} value={form.buildCommand || ""} onChange={(e) => setForm((f) => ({ ...f, buildCommand: e.target.value || undefined }))}/>
        <small>{t("settings.commands.commandUsedToBuildTheProjectInjectedInto", "Command used to build the project \u2014 injected into generated task specs")}</small>
      </div>
    </>);
}
export default CommandsSection;
