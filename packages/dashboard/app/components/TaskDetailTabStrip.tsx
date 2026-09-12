import { Fragment, useCallback, useState, type ReactNode } from "react";
import { useHorizontalMousePan } from "../hooks/useHorizontalMousePan";
import "./TaskDetailTabStrip.css";

export interface TaskDetailTabStripItem {
  id: string;
  label: string;
  node: ReactNode;
}

interface TaskDetailTabStripProps {
  items: readonly TaskDetailTabStripItem[];
  activeId: string;
  ariaLabel: string;
}

/*
FNXC:TaskDetailTabs 2026-09-12-18:58:
Task Detail destinations always render in canonical order. An overflowed strip accepts delayed-capture mouse drag-to-scroll only from real tab and Activity controls contained by the strip, so events bubbling through a portaled Activity menu remain native. A proven pan consumes only its compatibility click, while stationary clicks, keyboard interaction, touch, and pen stay browser-owned.
*/
export function TaskDetailTabStrip({ items, activeId, ariaLabel }: TaskDetailTabStripProps) {
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const canStartFrom = useCallback((target: EventTarget | null) => (
    target instanceof Element
    && scrollElement?.contains(target) === true
    && target.closest(".detail-tab") !== null
  ), [scrollElement]);
  const { isPanning, ...mousePanBindings } = useHorizontalMousePan(scrollElement, { canStartFrom });

  return (
    <div
      ref={setScrollElement}
      className={`detail-tabs${isPanning ? " is-mouse-panning" : ""}`}
      role="tablist"
      aria-label={ariaLabel}
      data-active-tab={activeId}
      {...mousePanBindings}
    >
      {items.map((item) => <Fragment key={item.id}>{item.node}</Fragment>)}
    </div>
  );
}
