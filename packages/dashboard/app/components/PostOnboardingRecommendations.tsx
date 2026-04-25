import "./PostOnboardingRecommendations.css";
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { AlertCircle, GitPullRequest, Key, Lightbulb, X, Zap } from "lucide-react";
import { fetchAuthStatus, fetchGlobalSettings } from "../api";
import {
  dismissPostOnboardingRecommendations,
  isOnboardingCompleted,
  isPostOnboardingDismissed,
} from "./model-onboarding-state";

interface PostOnboardingRecommendationsProps {
  onOpenSettings: (section: string) => void;
  onOpenModelOnboarding: () => void;
}

interface RecommendationItem {
  id: "ai-provider" | "default-model" | "github";
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
}

export function PostOnboardingRecommendations({
  onOpenSettings,
  onOpenModelOnboarding,
}: PostOnboardingRecommendationsProps) {
  const onboardingCompleted = isOnboardingCompleted();
  const postOnboardingDismissed = isPostOnboardingDismissed();

  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [dismissedLocally, setDismissedLocally] = useState(false);
  const [incompleteState, setIncompleteState] = useState<{
    needsAiProvider: boolean;
    needsDefaultModel: boolean;
    needsGitHub: boolean;
  }>({
    needsAiProvider: false,
    needsDefaultModel: false,
    needsGitHub: false,
  });

  useEffect(() => {
    if (!onboardingCompleted || postOnboardingDismissed) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        setHasError(false);

        const [authStatus, globalSettings] = await Promise.all([
          fetchAuthStatus(),
          fetchGlobalSettings(),
        ]);

        if (cancelled) {
          return;
        }

        const providers = authStatus.providers ?? [];
        const githubProvider = providers.find((provider) => provider.id === "github");
        const hasAuthenticatedAiProvider = providers.some(
          (provider) => provider.id !== "github" && provider.authenticated,
        );

        const needsAiProvider = !hasAuthenticatedAiProvider;
        const needsDefaultModel = !globalSettings.defaultProvider && !globalSettings.defaultModelId;
        const needsGitHub = githubProvider ? !githubProvider.authenticated : false;

        setIncompleteState({ needsAiProvider, needsDefaultModel, needsGitHub });
      } catch {
        if (!cancelled) {
          setHasError(true);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [onboardingCompleted, postOnboardingDismissed]);

  const handleDismiss = useCallback(() => {
    dismissPostOnboardingRecommendations();
    setDismissedLocally(true);
  }, []);

  const handleOpenModelOnboarding = useCallback(() => {
    onOpenModelOnboarding();
  }, [onOpenModelOnboarding]);

  const handleOpenGlobalModels = useCallback(() => {
    onOpenSettings("global-models");
  }, [onOpenSettings]);

  const handleOpenAuthentication = useCallback(() => {
    onOpenSettings("authentication");
  }, [onOpenSettings]);

  const recommendations = useMemo<RecommendationItem[]>(() => {
    const items: RecommendationItem[] = [];

    if (incompleteState.needsAiProvider) {
      items.push({
        id: "ai-provider",
        title: "Connect AI Provider",
        description: "Connect an AI provider to enable AI agents for task planning and code generation",
        actionLabel: "Set Up AI",
        onAction: handleOpenModelOnboarding,
        icon: Zap,
      });
    }

    if (incompleteState.needsDefaultModel) {
      items.push({
        id: "default-model",
        title: "Select Default Model",
        description: "Choose a default AI model for task execution",
        actionLabel: "Choose Model",
        onAction: handleOpenGlobalModels,
        icon: Key,
      });
    }

    if (incompleteState.needsGitHub) {
      items.push({
        id: "github",
        title: "Connect GitHub",
        description: "Connect GitHub to import issues and track pull requests",
        actionLabel: "Connect GitHub",
        onAction: handleOpenAuthentication,
        icon: GitPullRequest,
      });
    }

    return items;
  }, [
    incompleteState.needsAiProvider,
    incompleteState.needsDefaultModel,
    incompleteState.needsGitHub,
    handleOpenAuthentication,
    handleOpenGlobalModels,
    handleOpenModelOnboarding,
  ]);

  if (!onboardingCompleted || postOnboardingDismissed || dismissedLocally || loading || hasError || recommendations.length === 0) {
    return null;
  }

  return (
    <section
      className="post-onboarding-recommendations"
      role="region"
      aria-label="Setup recommendations"
    >
      <div className="post-onboarding-recommendations__main">
        <div className="post-onboarding-recommendations__icon" aria-hidden="true">
          <Lightbulb size={18} aria-hidden={true} />
        </div>
        <div className="post-onboarding-recommendations__content">
          <h2 className="post-onboarding-recommendations__title">Recommended Next Steps</h2>
          <p className="post-onboarding-recommendations__description">
            Complete these setup items to get the most out of Fusion.
          </p>
          <ul className="post-onboarding-recommendations__list">
            {recommendations.map((item) => {
              const ItemIcon = item.icon;

              return (
                <li key={item.id} className="post-onboarding-recommendations__item">
                  <span className="post-onboarding-recommendations__item-icon" aria-hidden="true">
                    <AlertCircle size={14} aria-hidden={true} />
                    <ItemIcon size={14} aria-hidden={true} />
                  </span>
                  <span className="post-onboarding-recommendations__item-text">
                    <strong>{item.title}</strong>
                    <span>{item.description}</span>
                  </span>
                  <button type="button" className="btn btn-sm btn-primary" onClick={item.onAction}>
                    {item.actionLabel}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <button
        type="button"
        className="post-onboarding-recommendations__dismiss"
        onClick={handleDismiss}
        aria-label="Dismiss recommendations"
      >
        <X size={16} aria-hidden={true} />
      </button>
    </section>
  );
}
