import { Loader2 } from "lucide-react";
import { useState } from "react";
import { consumeVersionUpdateFlag } from "../versionCheck";
import { SWR_CACHE_KEYS, clearCache } from "../utils/swrCache";
import "./DashboardLoader.css";

export type DashboardLoaderStage = "projects" | "project" | "tasks" | "ready";

interface DashboardLoaderProps {
  stage: DashboardLoaderStage;
}

interface LoaderStep {
  id: Exclude<DashboardLoaderStage, "ready">;
  label: string;
}

const LOADER_STEPS: LoaderStep[] = [
  { id: "projects", label: "Loading projects" },
  { id: "project", label: "Selecting project" },
  { id: "tasks", label: "Fetching tasks" },
];

function getStepState(stepId: LoaderStep["id"], stage: DashboardLoaderStage): "done" | "active" | "pending" {
  if (stage === "ready") {
    return "done";
  }

  const currentStageIndex = LOADER_STEPS.findIndex((step) => step.id === stage);
  const stepIndex = LOADER_STEPS.findIndex((step) => step.id === stepId);

  if (stepIndex < currentStageIndex) {
    return "done";
  }

  if (stepIndex === currentStageIndex) {
    return "active";
  }

  return "pending";
}

export function DashboardLoader({ stage }: DashboardLoaderProps) {
  const [isVersionUpdate] = useState(() => {
    const versionUpdated = consumeVersionUpdateFlag();
    if (versionUpdated) {
      clearCache(SWR_CACHE_KEYS.TASKS_PREFIX);
      clearCache(SWR_CACHE_KEYS.PROJECTS);
      clearCache(SWR_CACHE_KEYS.CURRENT_PROJECT_ID);
      clearCache(SWR_CACHE_KEYS.AGENTS);
      clearCache(SWR_CACHE_KEYS.AGENT_STATS);
      clearCache(SWR_CACHE_KEYS.DOCUMENTS_PREFIX);
      clearCache(SWR_CACHE_KEYS.TODO_LISTS_PREFIX);
      clearCache(SWR_CACHE_KEYS.CHAT_ROOMS);
      clearCache(SWR_CACHE_KEYS.ACTIVE_CHAT_ROOM_ID);
      clearCache(SWR_CACHE_KEYS.CHAT_SESSIONS_PREFIX);
      clearCache(SWR_CACHE_KEYS.CHAT_MESSAGES_PREFIX);
      clearCache(SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX);
      clearCache(SWR_CACHE_KEYS.MODELS);
      clearCache(SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX);
      clearCache(SWR_CACHE_KEYS.INSIGHTS_PREFIX);
      clearCache(SWR_CACHE_KEYS.INSIGHT_LATEST_RUN_PREFIX);
      clearCache(SWR_CACHE_KEYS.RESEARCH_RUNS_PREFIX);
      clearCache(SWR_CACHE_KEYS.RESEARCH_SELECTED_ID_PREFIX);
      clearCache(SWR_CACHE_KEYS.EVALS_RUNS_PREFIX);
      clearCache(SWR_CACHE_KEYS.EVALS_RESULTS_PREFIX);
      clearCache(SWR_CACHE_KEYS.MISSIONS_PREFIX);
      clearCache(SWR_CACHE_KEYS.MISSIONS_SELECTED_ID_PREFIX);
      clearCache(SWR_CACHE_KEYS.MAILBOX_INBOX_PREFIX);
      clearCache(SWR_CACHE_KEYS.MAILBOX_OUTBOX_PREFIX);
      clearCache(SWR_CACHE_KEYS.MAILBOX_UNREAD_COUNT_PREFIX);
    }
    return versionUpdated;
  });

  return (
    <div
      className="dashboard-loader"
      role="status"
      aria-live="polite"
      aria-label={isVersionUpdate ? "Updating Fusion dashboard" : "Loading Fusion dashboard"}
      data-stage={stage}
      data-version-update={isVersionUpdate ? "true" : undefined}
    >
      <div className="dashboard-loader__content">
        <h1 className="dashboard-loader__logo">Fusion</h1>
        {isVersionUpdate ? (
          <p className="dashboard-loader__message dashboard-loader__message--update">
            Updating to a new frontend version...
          </p>
        ) : (
          <p className="dashboard-loader__message">Initializing dashboard...</p>
        )}

        <ol className="dashboard-loader__steps" aria-label="Dashboard loading progress">
          {LOADER_STEPS.map((step) => {
            const stepState = getStepState(step.id, stage);

            return (
              <li
                key={step.id}
                className={`dashboard-loader__step dashboard-loader__step--${stepState}`}
                data-testid={`dashboard-loader-step-${step.id}`}
              >
                <span className="dashboard-loader__step-icon" aria-hidden="true">
                  {stepState === "done" ? (
                    "✓"
                  ) : stepState === "active" ? (
                    <Loader2 className="dashboard-loader__spinner animate-spin" size={14} />
                  ) : (
                    "•"
                  )}
                </span>
                <span className="dashboard-loader__step-label">{step.label}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
