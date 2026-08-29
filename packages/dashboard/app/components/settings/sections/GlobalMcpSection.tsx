import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";
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
  const [builtInAvailable, setBuiltInAvailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    void fetch(`/api/mcp/plugin-servers${query}`, { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<{ fusionMemoryMcpAvailable?: boolean }> : null)
      .then((payload) => { if (!controller.signal.aborted) setBuiltInAvailable(payload?.fusionMemoryMcpAvailable === true); })
      .catch(() => { if (!controller.signal.aborted) setBuiltInAvailable(false); });
    return () => controller.abort();
  }, [projectId]);
  return (
    <>
      <h4 className="settings-section-heading">{t("settings.nav.globalMcp", "MCP Servers")}</h4>
      <McpServersCard scope="global" form={form} setForm={setForm} projectId={projectId} builtInAvailable={builtInAvailable} addToast={addToast} />
    </>
  );
}

export default GlobalMcpSection;
