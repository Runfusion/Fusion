import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { moveTaskDetailTab } from "../utils/taskDetailTabOrder";
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
  order: readonly string[];
  onOrderChange: (order: string[]) => void;
  reorderAnnouncement: (label: string, position: number, count: number) => string;
}

/*
FNXC:TaskDetailTabs 2026-09-12-02:34:
Les destinations du détail de tâche se réordonnent avec le drag HTML uniquement sur les pointeurs desktop. Le strip conserve le pan horizontal tactile et propose Alt+Flèche gauche/droite comme commande clavier équivalente, sans sélectionner ni ouvrir l'onglet déplacé.
*/
export function TaskDetailTabStrip({
  items,
  activeId,
  ariaLabel,
  order,
  onOrderChange,
  reorderAnnouncement,
}: TaskDetailTabStripProps) {
  const [desktopDrag, setDesktopDrag] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [target, setTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const draggingRef = useRef<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 769px) and (pointer: fine)");
    const update = () => setDesktopDrag(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => () => {
    draggingRef.current = null;
  }, []);

  const clearDrag = () => {
    draggingRef.current = null;
    setDraggingId(null);
    setTarget(null);
  };

  const commitMove = (sourceId: string, targetId: string, position: "before" | "after") => {
    const next = moveTaskDetailTab(order, sourceId, targetId, position);
    if (next.every((id, index) => id === order[index])) return;
    onOrderChange(next);
    const movedItem = items.find((item) => item.id === sourceId);
    setAnnouncement(reorderAnnouncement(movedItem?.label ?? sourceId, next.indexOf(sourceId) + 1, next.length));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    const index = order.indexOf(id);
    const targetIndex = event.key === "ArrowLeft" ? index - 1 : index + 1;
    const targetId = order[targetIndex];
    if (!targetId) return;
    event.preventDefault();
    commitMove(id, targetId, event.key === "ArrowLeft" ? "before" : "after");
  };

  return (
    <div className="detail-tabs" role="tablist" aria-label={ariaLabel} data-active-tab={activeId}>
      {order.map((id) => {
        const item = items.find((candidate) => candidate.id === id);
        if (!item) return null;
        const position = target?.id === id ? target.position : null;
        return (
          <div
            key={id}
            role="presentation"
            className={`task-detail-tab-slot${draggingId === id ? " task-detail-tab-slot--dragging" : ""}${position ? ` task-detail-tab-slot--drop-${position}` : ""}`}
            data-tab-id={id}
            draggable={desktopDrag}
            onKeyDown={(event) => handleKeyDown(event, id)}
            onDragStart={desktopDrag ? (event) => {
              event.stopPropagation();
              draggingRef.current = id;
              setDraggingId(id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", id);
            } : undefined}
            onDragOver={desktopDrag ? (event: DragEvent<HTMLDivElement>) => {
              event.stopPropagation();
              const sourceId = draggingRef.current;
              if (!sourceId || sourceId === id) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              setTarget({ id, position: event.clientX < rect.left + rect.width / 2 ? "before" : "after" });
            } : undefined}
            onDragLeave={desktopDrag ? () => {
              if (target?.id === id) setTarget(null);
            } : undefined}
            onDrop={desktopDrag ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              const sourceId = draggingRef.current;
              if (sourceId && target?.id === id) commitMove(sourceId, id, target.position);
              clearDrag();
            } : undefined}
            onDragEnd={desktopDrag ? (event) => {
              event.stopPropagation();
              clearDrag();
            } : undefined}
          >
            {item.node}
          </div>
        );
      })}
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </div>
  );
}
