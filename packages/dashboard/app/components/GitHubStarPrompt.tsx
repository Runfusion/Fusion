import { Star, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./GitHubStarPrompt.css";

const GITHUB_REPO_URL = "https://github.com/Runfusion/Fusion";

interface GitHubStarPromptProps {
  onStar?: () => void;
  onDismiss: () => void;
}

export function GitHubStarPrompt({ onStar, onDismiss }: GitHubStarPromptProps) {
  const { t } = useTranslation("app");

  const handleStar = () => {
    onStar?.();
    onDismiss();
  };

  return (
    <section className="card github-star-prompt" role="region" aria-live="polite" aria-label={t("githubStarPrompt.regionLabel", "GitHub star prompt")}>
      <div className="github-star-prompt__header">
        <div className="github-star-prompt__title-wrap">
          <Star aria-hidden="true" />
          <h3>{t("githubStarPrompt.title", "Enjoying Fusion?")}</h3>
        </div>
        <button
          type="button"
          className="btn-icon github-star-prompt__dismiss"
          onClick={onDismiss}
          aria-label={t("githubStarPrompt.dismissLabel", "Dismiss GitHub star prompt")}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <p>
        {t("githubStarPrompt.body", "If Fusion has saved you time, a GitHub star goes a long way. It helps other developers discover the project and keeps the team motivated to ship improvements.")}
      </p>
      <div className="github-star-prompt__actions">
        <a
          className="btn btn-sm github-star-prompt__cta"
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleStar}
        >
          <Star aria-hidden="true" />
          <span>{t("githubStarPrompt.starOnGitHub", "Star on GitHub")}</span>
        </a>
      </div>
    </section>
  );
}

export { GITHUB_REPO_URL };
