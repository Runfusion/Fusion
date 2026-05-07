import "./TodoModal.css";
import { Suspense, lazy, useEffect } from "react";
import { ListChecks, X } from "lucide-react";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useViewportMode } from "./Header";
const TodoView = lazy(() => import("./TodoView").then((module) => ({ default: module.TodoView })));

interface TodoModalProps {
  isOpen?: boolean;
  onClose: () => void;
  projectId?: string;
  addToast: (message: string, type?: "success" | "error" | "info") => void;
  onPlanningMode?: (initialPlan: string) => void;
}

export function TodoModal({ onClose, projectId, addToast, onPlanningMode }: TodoModalProps) {
  const overlayDismissProps = useOverlayDismiss(onClose);
  const mode = useViewportMode();
  const isMobile = mode === "mobile";
  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } = useMobileKeyboard({
    enabled: isMobile,
  });
  useMobileScrollLock(isMobile);

  const modalKeyboardStyle: React.CSSProperties =
    keyboardOpen
      ? ({
          "--keyboard-overlap": `${keyboardOverlap}px`,
          "--vv-offset-top": `${viewportOffsetTop}px`,
          ...(viewportHeight !== null ? { "--vv-height": `${viewportHeight}px` } : {}),
        } as React.CSSProperties)
      : {};

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay open" {...overlayDismissProps} role="dialog" aria-modal="true">
      <div className="modal todo-modal" style={modalKeyboardStyle}>
        <div className="modal-header todo-modal-header">
          <div className="todo-modal-header-title">
            <ListChecks size={18} />
            <div>
              <h2>Todos</h2>
              <p>Manage reusable todo lists for your project.</p>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="todo-modal-body">
          <Suspense fallback={null}>
            <TodoView
              projectId={projectId}
              addToast={addToast}
              onPlanningMode={onPlanningMode}
              onClose={onClose}
              mobileKeyboardActive={isMobile && keyboardOpen}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
