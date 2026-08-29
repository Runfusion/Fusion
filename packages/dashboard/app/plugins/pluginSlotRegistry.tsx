import type { ComponentType, ReactNode } from "react";
import { lazy, Suspense, createElement } from "react";
import { useTranslation } from "react-i18next";
import type { PluginUiSlotEntry } from "../api";
import { DroidCliProviderCard } from "../components/DroidCliProviderCard";

export interface PluginSlotHostActions {
  refreshAuthProviders?: () => void;
  openSettingsSection?: (section: string) => void;
  openModelOnboarding?: () => void;
}

/*
FNXC:Quality 2026-07-14-21:50:
Task-detail plugin tabs need host-injected task context (taskId, worktree, projectId).
Without this bag Task QA cannot scope runs, preview servers, or suggestions.
*/
export interface PluginSlotTaskContext {
  taskId?: string;
  worktree?: string;
  projectId?: string;
  title?: string;
  modifiedFiles?: string[];
}

export interface PluginSlotComponentProps {
  entry: PluginUiSlotEntry;
  actions?: PluginSlotHostActions;
  context?: PluginSlotTaskContext;
  taskId?: string;
  worktree?: string;
  projectId?: string;
}

interface PluginSlotRegistration {
  pluginId: string;
  slotId: string;
  componentPath: string;
  component: ComponentType<PluginSlotComponentProps>;
}

function DroidSettingsProviderCard({ actions }: PluginSlotComponentProps): ReactNode {
  return (
    <DroidCliProviderCard
      compact
      authenticated={false}
      onToggled={() => {
        actions?.refreshAuthProviders?.();
      }}
    />
  );
}

function DroidOnboardingProviderCard({ actions }: PluginSlotComponentProps): ReactNode {
  return (
    <DroidCliProviderCard
      authenticated={false}
      onToggled={() => {
        actions?.refreshAuthProviders?.();
      }}
    />
  );
}

function DroidOnboardingSetupHelp(): ReactNode {
  const { t } = useTranslation("app");
  return (
    <p className="onboarding-helper-text" data-testid="droid-onboarding-setup-help">
      {t("plugins.droidOnboardingTip", "Tip: Enable Droid CLI to reuse your Factory AI subscription without adding an API key.")}
    </p>
  );
}

function DroidPostOnboardingRecommendation({ actions }: PluginSlotComponentProps): ReactNode {
  const { t } = useTranslation("app");
  return (
    <div className="post-onboarding-recommendations__item" data-testid="droid-post-onboarding-recommendation">
      <span className="post-onboarding-recommendations__item-text">
        <strong>{t("plugins.droidRecommendTitle", "Enable Droid CLI")}</strong>
        <span>{t("plugins.droidRecommendDesc", "Use your local Droid CLI session as an AI provider in Fusion.")}</span>
      </span>
      <button type="button" className="btn btn-sm" onClick={() => actions?.openSettingsSection?.("authentication")}>
        {t("plugins.openAuthentication", "Open Authentication")}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => actions?.openModelOnboarding?.()}>
        {t("plugins.openOnboarding", "Open Onboarding")}
      </button>
    </div>
  );
}

const LazyQualityQaTab = lazy(async () => {
  const mod = await import("@fusion-plugin-examples/quality/qa-tab");
  return { default: mod.QualityQaTabSlot ?? mod.default };
});

function QualityTaskDetailTab(props: PluginSlotComponentProps): ReactNode {
  return (
    <Suspense fallback={null}>
      {createElement(LazyQualityQaTab, {
        entry: props.entry,
        actions: props.actions,
        context: props.context,
        taskId: props.taskId ?? props.context?.taskId,
        worktree: props.worktree ?? props.context?.worktree,
        projectId: props.projectId ?? props.context?.projectId,
      })}
    </Suspense>
  );
}

const REGISTRY: PluginSlotRegistration[] = [
  {
    pluginId: "fusion-plugin-quality",
    slotId: "task-detail-tab",
    componentPath: "./qa-tab",
    component: QualityTaskDetailTab,
  },
  {
    pluginId: "fusion-plugin-droid-runtime",
    slotId: "settings-provider-card",
    componentPath: "./components/settings-provider-card.js",
    component: DroidSettingsProviderCard,
  },
  {
    pluginId: "fusion-plugin-droid-runtime",
    slotId: "settings-integration-card",
    componentPath: "./components/settings-integration-card.js",
    component: DroidSettingsProviderCard,
  },
  {
    pluginId: "fusion-plugin-droid-runtime",
    slotId: "onboarding-provider-card",
    componentPath: "./components/onboarding-provider-card.js",
    component: DroidOnboardingProviderCard,
  },
  {
    pluginId: "fusion-plugin-droid-runtime",
    slotId: "onboarding-setup-help",
    componentPath: "./components/onboarding-setup-help.js",
    component: DroidOnboardingSetupHelp,
  },
  {
    pluginId: "fusion-plugin-droid-runtime",
    slotId: "post-onboarding-recommendation",
    componentPath: "./components/post-onboarding-recommendation.js",
    component: DroidPostOnboardingRecommendation,
  },
];

export function resolvePluginSlotComponent(entry: PluginUiSlotEntry): ComponentType<PluginSlotComponentProps> | null {
  const hit = REGISTRY.find(
    (candidate) =>
      candidate.pluginId === entry.pluginId
      && candidate.slotId === entry.slot.slotId
      && candidate.componentPath === entry.slot.componentPath,
  );

  return hit?.component ?? null;
}
