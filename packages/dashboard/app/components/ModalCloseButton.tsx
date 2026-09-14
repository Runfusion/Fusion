import { forwardRef, type ButtonHTMLAttributes } from "react";
import { X } from "lucide-react";
import "./ModalCloseButton.css";

/*
FNXC:ModalChrome 2026-09-13-11:59:
Every dashboard modal close affordance uses this canonical control, except Task Detail's semantic mobile Back action. Hosts retain ownership of labels, guards, refs, disabled state, and test hooks while the primitive guarantees one decorative icon plus the shared compact icon-button geometry.
*/
export type ModalCloseButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> & {
  "data-testid"?: string;
};

export const ModalCloseButton = forwardRef<HTMLButtonElement, ModalCloseButtonProps>(function ModalCloseButton(
  { className, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      className={["modal-close", "btn", "btn-icon", "btn-sm", className].filter(Boolean).join(" ")}
    >
      <X aria-hidden="true" />
    </button>
  );
});
