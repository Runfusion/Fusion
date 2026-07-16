import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@fusion/core";
import type { ToastType } from "../../../hooks/useToast";
import { McpServersCard } from "./McpServersCard";

export interface GlobalMcpSectionProps {
  form: Settings;
  setForm: Dispatch<SetStateAction<Settings>>;
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
}

export function GlobalMcpSection({ form, setForm, projectId, addToast }: GlobalMcpSectionProps) {
  const { t } = useTranslation("app");
  return (
    <>
      <h4 className="settings-section-heading">{t("settings.nav.globalMcp", "MCP Servers")}</h4>
      <McpServersCard scope="global" form={form} setForm={setForm} projectId={projectId} addToast={addToast} />
    </>
  );
}

export default GlobalMcpSection;
