import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentActivityEventType } from "../../api";
import { ActivityFeedRowPresentation } from "../ActivityFeed";
import { AreaShell } from "./areas/AreaShell";
import { AGENT_ACTIVITY_TYPE_CONFIG, DEFAULT_AGENT_ACTIVITY_CONFIG } from "./agentActivityPresentation";
import type { DateRange } from "./DateRangePicker";
import { useAgentActivity, type AgentActivityFilters } from "./useAgentActivity";
import "./AgentActivityPanel.css";

const LIVE_RENDER_LIMIT = 100;
const TIMELINE_WINDOW_SIZE = 100;
const EVENT_TYPES = Object.keys(AGENT_ACTIVITY_TYPE_CONFIG) as AgentActivityEventType[];

export interface AgentActivityPanelProps {
  projectId?: string;
  range: DateRange;
  onOpenAgent?: (agentId: string) => void;
  onOpenTask?: (taskId: string) => void;
}

/*
FNXC:CommandCenterAgentActivity 2026-08-10-02:03:
This panel provides the org-wide live log and manual-windowed scroll-back timeline without a virtualization dependency. It reuses the ActivityFeed icon/time vocabulary, fetches only `/api/agent-activity`, and keeps DateRange client-side because that route has no time-range parameter.
*/
export function AgentActivityPanel({ projectId, range, onOpenAgent, onOpenTask }: AgentActivityPanelProps) {
  const { t } = useTranslation("app");
  const [mode, setMode] = useState<"live" | "timeline">("live");
  const [filters, setFilters] = useState<AgentActivityFilters>({});
  const [timelineLimit, setTimelineLimit] = useState(TIMELINE_WINDOW_SIZE);
  const activity = useAgentActivity({ projectId, filters, range });

  useEffect(() => {
    setTimelineLimit(TIMELINE_WINDOW_SIZE);
  }, [filters.agentId, filters.taskId, filters.type, range.from, range.to]);

  const agentOptions = useMemo(
    () => [...new Set(activity.events.map((event) => event.agentId).filter(Boolean))].sort(),
    [activity.events],
  );
  const rows = mode === "live"
    ? activity.events.slice(0, LIVE_RENDER_LIMIT)
    : activity.visibleEvents.slice(0, timelineLimit);

  return (
    <section className="cc-agent-activity">
      <div className="cc-agent-activity-mode" role="group" aria-label={t("commandCenter.agentActivity.mode", "Activity mode")}>
        <button type="button" className="btn btn-sm" aria-pressed={mode === "live"} onClick={() => setMode("live")}>{t("commandCenter.agentActivity.live", "Live")}</button>
        <button type="button" className="btn btn-sm" aria-pressed={mode === "timeline"} onClick={() => setMode("timeline")}>{t("commandCenter.agentActivity.timeline", "Timeline")}</button>
      </div>
      {mode === "timeline" ? (
        <div className="cc-agent-activity-filters">
          <select className="input" aria-label={t("commandCenter.agentActivity.agentFilter", "Filter by agent")} value={filters.agentId ?? ""} onChange={(event) => setFilters((current) => ({ ...current, agentId: event.target.value || undefined }))}>
            <option value="">{t("commandCenter.agentActivity.allAgents", "All agents")}</option>
            {agentOptions.map((agentId) => <option key={agentId} value={agentId}>{agentId}</option>)}
          </select>
          <input className="input" aria-label={t("commandCenter.agentActivity.taskFilter", "Filter by task")} value={filters.taskId ?? ""} placeholder={t("commandCenter.agentActivity.taskFilter", "Filter by task")} onChange={(event) => setFilters((current) => ({ ...current, taskId: event.target.value || undefined }))} />
          <select className="input" aria-label={t("commandCenter.agentActivity.typeFilter", "Filter by event type")} value={filters.type ?? ""} onChange={(event) => setFilters((current) => ({ ...current, type: (event.target.value || undefined) as AgentActivityEventType | undefined }))}>
            <option value="">{t("commandCenter.agentActivity.allTypes", "All event types")}</option>
            {EVENT_TYPES.map((type) => <option key={type} value={type}>{AGENT_ACTIVITY_TYPE_CONFIG[type].label}</option>)}
          </select>
          <span className="cc-agent-activity-range-note">{t("commandCenter.agentActivity.rangeNote", "Time range filters loaded events; it is not sent to the server.")}</span>
        </div>
      ) : null}
      <AreaShell testId="agent-activity" isLoading={activity.isLoading} error={activity.error} isEmpty={!rows.length && !activity.hasMore} emptyMessage={t("commandCenter.agentActivity.empty", "No agent activity yet.")}>
        <div className="cc-agent-activity-list">
          {rows.map((row) => <AgentActivityRow key={row.eventId} event={row} onOpenAgent={onOpenAgent} onOpenTask={onOpenTask} />)}
        </div>
        {mode === "timeline" && timelineLimit < activity.visibleEvents.length ? (
          <button type="button" className="btn" onClick={() => setTimelineLimit((value) => value + TIMELINE_WINDOW_SIZE)}>{t("commandCenter.agentActivity.showMore", "Show more loaded activity")}</button>
        ) : null}
        {mode === "timeline" && activity.hasMore ? (
          <button type="button" className="btn" onClick={activity.loadOlder} disabled={activity.isLoadingOlder}>
            {activity.isLoadingOlder ? t("commandCenter.agentActivity.loadingOlder", "Loading…") : t("commandCenter.agentActivity.loadOlder", "Load older")}
          </button>
        ) : null}
        {mode === "timeline" && !activity.hasMore && activity.exhaustedReason ? <p className="cc-agent-activity-end">{t("commandCenter.agentActivity.end", "End of activity history")}</p> : null}
      </AreaShell>
    </section>
  );
}

function AgentActivityRow({ event, onOpenAgent, onOpenTask }: { event: ReturnType<typeof useAgentActivity>["events"][number]; onOpenAgent?: (agentId: string) => void; onOpenTask?: (taskId: string) => void }) {
  const { t } = useTranslation("app");
  const baseConfig = AGENT_ACTIVITY_TYPE_CONFIG[event.type] ?? DEFAULT_AGENT_ACTIVITY_CONFIG;
  const config = { ...baseConfig, label: t(`commandCenter.agentActivity.eventTypes.${event.type}`, baseConfig.label) };
  const openTaskLabel = t("commandCenter.agentActivity.openTask", "Open task {{taskId}}", { taskId: event.taskId });
  const openAgentLabel = t("commandCenter.agentActivity.openAgent", "Open agent {{agentId}}", { agentId: event.agentId });
  const content = <ActivityFeedRowPresentation
    config={config}
    timestamp={event.occurredAt}
    details={<span className="activity-feed-description">{event.summary}</span>}
  />;
  if (event.taskId && onOpenTask) {
    return <div className="cc-agent-activity-target"><button type="button" className="cc-agent-activity-row" aria-label={openTaskLabel} onClick={() => onOpenTask(event.taskId!)}>{content}</button>{onOpenAgent ? <button type="button" className="btn btn-sm" aria-label={openAgentLabel} onClick={() => onOpenAgent(event.agentId)}>{event.agentId}</button> : null}</div>;
  }
  if (event.agentId && onOpenAgent) return <button type="button" className="cc-agent-activity-row" aria-label={openAgentLabel} onClick={() => onOpenAgent(event.agentId)}>{content}</button>;
  return <div className="cc-agent-activity-row">{content}</div>;
}
