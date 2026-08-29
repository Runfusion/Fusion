import "./OnboardingResumeCard.css";
import { Play, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getOnboardingResumeStep, ONBOARDING_FLOW_STEPS } from "./model-onboarding-state";
import { trackOnboardingEvent } from "./onboarding-events";

interface OnboardingResumeCardProps {
  /** Called when the user clicks "Continue onboarding" */
  onResume: () => void;
}

/**
 * A banner/card that appears when a user has previously started onboarding
 * but dismissed the modal without completing. It allows them to resume
 * from where they left off.
 */
export function OnboardingResumeCard({ onResume }: OnboardingResumeCardProps) {
  const { t } = useTranslation("app");
  const resumeStep = getOnboardingResumeStep();

  // Should not render if no resumable state exists
  if (!resumeStep) {
    return null;
  }

  const completedCount = resumeStep.completedSteps.length;
  const totalSteps = ONBOARDING_FLOW_STEPS.length;
  const progressText = completedCount > 0
    ? t("onboarding.progressText", "{{completed}} of {{total}} step{{pluralS}} complete — You're on the ", { completed: completedCount, total: totalSteps, pluralS: completedCount !== 1 ? "s" : "" })
    : t("onboarding.onTheStep", "You're on the ");

  return (
    <section
      className="onboarding-resume-card"
      role="region"
      aria-label={t("onboarding.resumeOnboarding", "Resume onboarding")}
    >
      <div className="onboarding-resume-card__main">
        <div className="onboarding-resume-card__icon" aria-hidden="true">
          <Sparkles size={20} />
        </div>
        <div className="onboarding-resume-card__content">
          <h2 className="onboarding-resume-card__title">{t("onboarding.continueSetup", "Continue Setup")}</h2>
          <p className="onboarding-resume-card__description">
            {progressText}<strong>{resumeStep.label}</strong> {t("onboarding.stepContinue", "step. Continue where you left off to complete your dashboard setup.")}
          </p>
        </div>
      </div>
      <div className="onboarding-resume-card__actions">
        <button
          className="onboarding-resume-card__resume-btn btn btn-primary btn-sm"
          onClick={() => {
            trackOnboardingEvent("onboarding:resumed", {
              source: "resume-card",
              resumedFromStep: resumeStep.currentStep,
            });
            onResume();
          }}
        >
          <Play size={14} aria-hidden="true" />
          <span>{t("onboarding.continueOnboarding", "Continue onboarding")}</span>
        </button>
      </div>
    </section>
  );
}
