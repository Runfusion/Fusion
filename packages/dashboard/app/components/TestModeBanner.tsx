import { FlaskConical } from "lucide-react";
import "./TestModeBanner.css";

interface TestModeBannerProps {
  isActive: boolean;
}

export function TestModeBanner({ isActive }: TestModeBannerProps) {
  if (!isActive) {
    return null;
  }

  return (
    <div className="test-mode-banner" role="status" aria-live="polite">
      <FlaskConical aria-hidden="true" />
      <span>Test mode — no real AI calls</span>
    </div>
  );
}
