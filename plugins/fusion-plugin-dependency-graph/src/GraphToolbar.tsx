import { Maximize, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import "./GraphToolbar.css";

export interface GraphToolbarProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToGraph: () => void;
  onResetView: () => void;
}

export function GraphToolbar({
  zoom,
  onZoomIn,
  onZoomOut,
  onFitToGraph,
  onResetView,
}: GraphToolbarProps) {
  return (
    <div className="graph-toolbar" data-testid="graph-toolbar">
      <button className="btn btn-icon" title="Zoom in (Ctrl+=)" aria-label="Zoom in" onClick={onZoomIn}>
        <ZoomIn size={16} />
      </button>
      <button className="btn btn-icon" title="Zoom out (Ctrl+-)" aria-label="Zoom out" onClick={onZoomOut}>
        <ZoomOut size={16} />
      </button>
      <div className="graph-toolbar__zoom-label" aria-live="polite">{Math.round(zoom * 100)}%</div>
      <button className="btn btn-icon" title="Fit to graph (Ctrl+Shift+F)" aria-label="Fit to graph" onClick={onFitToGraph}>
        <Maximize size={16} />
      </button>
      <button className="btn btn-icon" title="Reset view (Ctrl+0)" aria-label="Reset view" onClick={onResetView}>
        <RotateCcw size={16} />
      </button>
    </div>
  );
}
