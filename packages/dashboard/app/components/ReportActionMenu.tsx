import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bug, Lightbulb, LifeBuoy, MessageSquare } from "lucide-react";
import type { ReportActionType } from "@fusion/core";
import "./ReportActionMenu.css";

const actions: Array<{ type: ReportActionType; label: string; Icon: typeof Bug }> = [
  { type: "bug", label: "Report bug", Icon: Bug },
  { type: "feedback", label: "Send feedback", Icon: MessageSquare },
  { type: "idea", label: "Share idea", Icon: Lightbulb },
  { type: "help", label: "Get help", Icon: LifeBuoy },
];

/** Four guided entry points share the same report pipeline rather than issue textboxes. */
export function ReportActionMenu({ onSelect }: { onSelect: (action: ReportActionType) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; right: number }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ top: rect.bottom, left: rect.left, right: window.innerWidth - rect.right });
  }, []);

  /*
  FNXC:ReportPipeline 2026-07-19-14:00:
  FN-8406 requires the shared Report menu to escape Command Center and Settings
  scroll owners. Portal it to document.body and keep it fixed to the trigger so
  the guided actions cannot be clipped beneath surrounding dashboard content.
  */
  useEffect(() => {
    if (!open) return;
    reposition();
    const handlePositionChange = () => reposition();
    window.addEventListener("resize", handlePositionChange);
    window.addEventListener("scroll", handlePositionChange, true);
    return () => {
      window.removeEventListener("resize", handlePositionChange);
      window.removeEventListener("scroll", handlePositionChange, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const menu = open && position && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={menuRef}
          className="report-action-menu__list report-action-menu__list--portal"
          role="menu"
          style={{ top: position.top, left: position.left, right: position.right }}
        >
          {actions.map(({ type, label, Icon }) => <button className="report-action-menu__item" type="button" role="menuitem" key={type} onClick={() => { setOpen(false); onSelect(type); }}><Icon aria-hidden="true" />{label}</button>)}
        </div>,
        document.body,
      )
    : null;

  return <div className="report-action-menu">
    <button ref={triggerRef} className="btn btn-secondary" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Report</button>
    {menu}
  </div>;
}
