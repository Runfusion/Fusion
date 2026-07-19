import { useState } from "react";
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
  return <div className="report-action-menu">
    <button className="btn btn-secondary" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Report</button>
    {open && <div className="report-action-menu__list" role="menu">
      {actions.map(({ type, label, Icon }) => <button className="report-action-menu__item" type="button" role="menuitem" key={type} onClick={() => { setOpen(false); onSelect(type); }}><Icon aria-hidden="true" />{label}</button>)}
    </div>}
  </div>;
}
