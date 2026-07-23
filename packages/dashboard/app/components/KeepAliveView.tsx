import type { ReactNode } from "react";
import "./KeepAliveView.css";

/*
FNXC:KeepAlive 2026-07-22-12:20:
Shared wrapper for surfaces that stay mounted-but-hidden across navigation (Planning Mode main view, task-detail terminal/planner-chat tabs).
Contract, mirroring FloatingWindow's hidden branch:
- Hiding uses `visibility: hidden` + `pointer-events: none`, NEVER `display: none` — xterm's FitAddon floors a zero-geometry container to a degenerate 2x1 grid permanently (docs/solutions/ui-bugs/mobile-terminal-blank-render-zero-geometry-container.md), so the hidden box must keep real dimensions.
- The hidden state is out-of-flow (position: absolute; inset: 0): a hidden in-flow flex child would still occupy layout space beside the active view. While visible the wrapper is a plain in-flow flex child so footer padding and definite flex sizing chains keep working.
- Hidden wrappers carry aria-hidden so assistive tech never walks a kept-alive invisible subtree.
The host container must be `position: relative` so the hidden absolute box keeps its (non-zero) size.
*/
export interface KeepAliveViewProps {
  hidden: boolean;
  children: ReactNode;
  className?: string;
  testId?: string;
}

export function KeepAliveView({ hidden, children, className, testId }: KeepAliveViewProps) {
  return (
    <div
      className={`keep-alive-view${hidden ? " keep-alive-view--hidden" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden={hidden || undefined}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
