import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GlobalSettings, PluginMcpServerContribution, Settings } from "@fusion/core";
import type { ToastType } from "../../../hooks/useToast";
import { McpServersCard } from "./McpServersCard";

export interface ProjectMcpSectionProps {
  form: Settings;
  setForm: Dispatch<SetStateAction<Settings>>;
  globalSettings?: Pick<GlobalSettings, "mcpServers"> | null;
  projectId?: string;
  /** Project-scoped plugin entries; global MCP settings never receive these. */
  pluginServers?: Array<{ pluginId: string; server: PluginMcpServerContribution }>;
  addToast: (message: string, type?: ToastType) => void;
}

export function ProjectMcpSection({ form, setForm, globalSettings, projectId, pluginServers, addToast }: ProjectMcpSectionProps) {
  const { t } = useTranslation("app");
  const [loadedPluginServers, setLoadedPluginServers] = useState<Array<{ pluginId: string; server: PluginMcpServerContribution }>>([]);

  useEffect(() => {
    if (pluginServers) return;
    const controller = new AbortController();
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    /*
     * FNXC:PluginMcpServers 2026-07-22-12:00:
     * FN-8491 obtains settings-card contributions only from the active-project
     * endpoint, which owns project_plugin_states filtering. Rendering never
     * writes declarations and global MCP settings never request this endpoint.
     */
    void fetch(`/api/mcp/plugin-servers${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load project plugin MCP servers");
        return response.json() as Promise<{ servers?: Array<{ pluginId: string; server: PluginMcpServerContribution }> }>;
      })
      .then((payload) => { if (!controller.signal.aborted) setLoadedPluginServers(Array.isArray(payload.servers) ? payload.servers : []); })
      .catch(() => { if (!controller.signal.aborted) setLoadedPluginServers([]); });
    return () => controller.abort();
  }, [pluginServers, projectId]);

  return (
    <>
      <h4 className="settings-section-heading">{t("settings.nav.mcp", "MCP Servers")}</h4>
      <McpServersCard scope="project" form={form} setForm={setForm} globalSettings={globalSettings} projectId={projectId} pluginServers={pluginServers ?? loadedPluginServers} addToast={addToast} />
    </>
  );
}

export default ProjectMcpSection;
