import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorBoundary } from "./ErrorBoundary";
import { usePluginUiSlots } from "../hooks/usePluginUiSlots";
import {
  resolvePluginSlotComponent,
  type PluginSlotHostActions,
  type PluginSlotTaskContext,
} from "../plugins/pluginSlotRegistry";
import "./PluginSlot.css";

interface PluginSlotProps {
  /** The slot identifier to render (e.g., "task-detail-tab", "header-action") */
  slotId: string;
  /** Optional project ID for multi-project slot scoping */
  projectId?: string;
  /** Optional plugin IDs to restrict rendering to a subset of matching entries */
  pluginIds?: string[];
  /** Render unresolved entry shell states for unregistered slot components */
  renderPlaceholder?: boolean;
  /** Optional host-controlled callbacks that slot components can call */
  actions?: PluginSlotHostActions;
  /** Optional task context for task-detail-tab and similar surfaces */
  context?: PluginSlotTaskContext;
  taskId?: string;
  worktree?: string;
}

function PluginSlotMissingComponent({ slotId, pluginId }: { slotId: string; pluginId: string }): ReactNode {
  const { t } = useTranslation("app");
  return (
    <section
      className="plugin-slot-shell"
      data-plugin-slot
      data-slot-id={slotId}
      data-plugin-id={pluginId}
      data-plugin-slot-state="missing-component"
      role="status"
      aria-live="polite"
    >
      <p className="plugin-slot-shell__title">{t("plugins.componentUnavailable", "Plugin component unavailable")}</p>
      <p className="plugin-slot-shell__message">
        {t("plugins.couldNotResolve", "The dashboard could not resolve this plugin surface from the static host registry.")}
      </p>
    </section>
  );
}

/**
 * Renders plugin slot registrations for a host surface.
 */
export function PluginSlot({
  slotId,
  projectId,
  pluginIds,
  renderPlaceholder = true,
  actions,
  context,
  taskId,
  worktree,
}: PluginSlotProps): ReactNode {
  const { getSlotsForId, loading, error } = usePluginUiSlots(projectId);

  if (loading || error || !slotId) {
    return null;
  }

  const matchingEntries = getSlotsForId(slotId).filter((entry) =>
    pluginIds && pluginIds.length > 0 ? pluginIds.includes(entry.pluginId) : true,
  );

  if (matchingEntries.length === 0) {
    return null;
  }

  const resolvedContext: PluginSlotTaskContext = {
    ...context,
    projectId: context?.projectId ?? projectId,
    taskId: context?.taskId ?? taskId,
    worktree: context?.worktree ?? worktree,
  };

  return (
    <ErrorBoundary level="page">
      <>
        {matchingEntries.map((entry, index) => {
          const key = `${entry.pluginId}-${entry.slot.slotId}-${index}`;
          const SlotComponent = resolvePluginSlotComponent(entry);

          if (SlotComponent) {
            return (
              <SlotComponent
                key={key}
                entry={entry}
                actions={actions}
                context={resolvedContext}
                taskId={resolvedContext.taskId}
                worktree={resolvedContext.worktree}
                projectId={resolvedContext.projectId}
              />
            );
          }

          if (!renderPlaceholder) {
            return null;
          }

          return <PluginSlotMissingComponent key={key} slotId={entry.slot.slotId} pluginId={entry.pluginId} />;
        })}
      </>
    </ErrorBoundary>
  );
}
