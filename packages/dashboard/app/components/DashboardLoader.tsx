import { Loader2 } from "lucide-react";
import { useState } from "react";
import { consumeVersionUpdateFlag } from "../versionCheck";
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
  const [isVersionUpdate] = useState(() => consumeVersionUpdateFlag());

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
            Updating to a new version...
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
