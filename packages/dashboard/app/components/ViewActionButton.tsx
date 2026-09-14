import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from "react";
import { ChevronLeft, Plus, type LucideProps } from "lucide-react";
import { AlphaButton } from "./alpha-ui";
import "./ViewActionButton.css";

export type ViewActionButtonKind = "action" | "create";

export interface ViewActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: ReactNode;
  /** Required when label is not a string. */
  accessibleLabel?: string;
  icon?: ComponentType<LucideProps>;
  iconClassName?: string;
  kind?: ViewActionButtonKind;
  iconOnlyOnMobile?: boolean;
}

/*
FNXC:StandardizedViewActions 2026-09-13-16:12:
Primary resource creation has one shared Plus button across dashboard headers. Its visible label remains on desktop/tablet and becomes visually hidden only on phone chrome, while the same localized string remains the accessible name.
*/
export const ViewActionButton = forwardRef<HTMLButtonElement, ViewActionButtonProps>(function ViewActionButton(
  {
    label,
    accessibleLabel,
    icon,
    iconClassName,
    kind = "action",
    iconOnlyOnMobile = true,
    className,
    type = "button",
    ...props
  },
  ref,
) {
  const Icon = icon ?? (kind === "create" ? Plus : undefined);
  const ariaLabel = accessibleLabel ?? (typeof label === "string" ? label : undefined);
  /*
  FNXC:StandardizedViewActions 2026-09-13-20:32:
  Collapsing to icon-only is only legal when there IS an icon: hiding the label of an icon-less action would leave a
  visually empty touch target. An action without a pictogram therefore keeps its readable label on every viewport.
  */
  const collapsesOnMobile = iconOnlyOnMobile && Boolean(Icon);
  const classes = [
    "btn",
    "btn-sm",
    kind === "create" ? "btn-primary view-action-button--create" : "view-action-button--action",
    "view-action-button",
    collapsesOnMobile ? "view-action-button--mobile-icon-only" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <AlphaButton {...props} ref={ref} type={type} className={classes} aria-label={props["aria-label"] ?? ariaLabel}>
      {Icon ? <Icon aria-hidden="true" className={iconClassName} /> : null}
      <span className="view-action-button__label">{label}</span>
    </AlphaButton>
  );
});

export interface ViewBackButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  label: string;
  "data-testid"?: string;
}

/*
FNXC:StandardizedViewNavigation 2026-09-13-16:12:
Every list-to-detail return is a real, single ChevronLeft button before the owning title. The full touch target is interactive; no parent wrapper or separate textual Back row competes for the same transition.
*/
export const ViewBackButton = forwardRef<HTMLButtonElement, ViewBackButtonProps>(function ViewBackButton(
  { label, className, type = "button", ...props },
  ref,
) {
  return (
    <AlphaButton
      {...props}
      ref={ref}
      type={type}
      className={["btn", "btn-icon", "view-back-button", className].filter(Boolean).join(" ")}
      aria-label={label}
      title={props.title ?? label}
    >
      <ChevronLeft aria-hidden="true" />
    </AlphaButton>
  );
});
