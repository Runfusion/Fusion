import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { GlobalSettings, Settings } from "@fusion/core";
import type { ToastType } from "../../../hooks/useToast";
import { McpServersCard } from "./McpServersCard";

export interface ProjectMcpSectionProps {
  form: Settings;
  setForm: Dispatch<SetStateAction<Settings>>;
  globalSettings?: Pick<GlobalSettings, "mcpServers"> | null;
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
}

export function ProjectMcpSection({ form, setForm, globalSettings, projectId, addToast }: ProjectMcpSectionProps) {
  const { t } = useTranslation("app");
  return (
    <>
      <h4 className="settings-section-heading">{t("settings.nav.mcp", "MCP Servers")}</h4>
      <McpServersCard scope="project" form={form} setForm={setForm} globalSettings={globalSettings} projectId={projectId} addToast={addToast} />
    </>
  );
}

export default ProjectMcpSection;
