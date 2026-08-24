import { forwardRef, type ReactNode } from "react";
import { X } from "lucide-react";
import "./Banner.css";

/*
FNXC:DashboardBanners 2026-08-23-22:36:
Dashboard banners share one shell so tone is expressed through a tint and a hairline full border using var(--btn-border-width), preserving thick-border themes. The operator explicitly removed left highlight borders, so this primitive must never add an accent bar.
*/
export type BannerTone = "info" | "warning" | "error" | "success" | "neutral";
export type BannerLayout = "inline" | "chrome";
export type BannerDensity = "compact" | "regular";

interface BannerProps {
  tone: BannerTone;
  layout?: BannerLayout;
  density?: BannerDensity;
  as?: "div" | "section";
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
  role?: string;
  "aria-live"?: "off" | "assertive" | "polite";
  "aria-label"?: string;
  "data-testid"?: string;
}

export const Banner = forwardRef<HTMLDivElement | HTMLElement, BannerProps>(function Banner({
  tone,
  layout = "inline",
  density = "regular",
  as: Component = "div",
  icon,
  title,
  children,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
  role,
  "aria-live": ariaLive,
  "aria-label": ariaLabel,
  "data-testid": dataTestId,
}, ref) {
  const classes = [
    "banner",
    `banner--${tone}`,
    `banner--${layout}`,
    `banner--${density}`,
    className,
  ].filter(Boolean).join(" ");

  return (
    <Component
      ref={ref as never}
      className={classes}
      role={role}
      aria-live={ariaLive}
      aria-label={ariaLabel}
      data-testid={dataTestId}
    >
      {icon ? <span className="banner__icon">{icon}</span> : null}
      <div className="banner__copy">
        {title ? <div className="banner__title">{title}</div> : null}
        {children ? <div className="banner__body">{children}</div> : null}
      </div>
      {actions ? <div className="banner__actions">{actions}</div> : null}
      {onDismiss ? (
        <button type="button" className="btn-icon banner__dismiss" aria-label={dismissLabel} onClick={onDismiss}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </Component>
  );
});
