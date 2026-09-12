import { forwardRef, type ButtonHTMLAttributes } from "react";
import { X } from "lucide-react";
import "./ModalCloseButton.css";

/*
FNXC:ModalChrome 2026-09-11-23:35:
FN-351 makes the History close affordance the canonical close control for every dashboard modal. Hosts retain ownership of labels, guards, refs, disabled state, and test hooks while this primitive guarantees one decorative icon and button semantics.
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
      className={["modal-close", "btn", "btn-icon", className].filter(Boolean).join(" ")}
    >
      <X aria-hidden="true" />
    </button>
  );
});
