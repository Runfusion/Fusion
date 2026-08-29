import { Folder, Activity, CheckCircle, AlertCircle } from "lucide-react";

/**
 * ProjectGridSkeleton - Loading skeleton for project grid
 * 
 * Shows 6 skeleton cards in a responsive grid layout with pulse animation.
 * Uses CSS variables for theming compatibility.
 */
export function ProjectGridSkeleton() {
  return (
    <div className="project-overview project-overview--loading">
      {/* Header stats skeleton */}
      <div className="project-overview__header-skeleton">
        <div className="project-overview__stats-row">
          <div className="project-overview__stat-skeleton">
            <div className="project-skeleton project-skeleton--icon">
              <Folder size={20} className="project-skeleton-icon" />
            </div>
            <div className="project-skeleton project-skeleton--value" />
            <div className="project-skeleton project-skeleton--label" />
          </div>
          <div className="project-overview__stat-skeleton">
            <div className="project-skeleton project-skeleton--icon">
              <Activity size={20} className="project-skeleton-icon" />
            </div>
            <div className="project-skeleton project-skeleton--value" />
            <div className="project-skeleton project-skeleton--label" />
          </div>
          <div className="project-overview__stat-skeleton">
            <div className="project-skeleton project-skeleton--icon">
              <CheckCircle size={20} className="project-skeleton-icon" />
            </div>
            <div className="project-skeleton project-skeleton--value" />
            <div className="project-skeleton project-skeleton--label" />
          </div>
          <div className="project-overview__stat-skeleton">
            <div className="project-skeleton project-skeleton--icon">
              <AlertCircle size={20} className="project-skeleton-icon" />
            </div>
            <div className="project-skeleton project-skeleton--value" />
            <div className="project-skeleton project-skeleton--label" />
          </div>
        </div>
      </div>

      {/* Filter tabs skeleton */}
      <div className="project-overview__filters-skeleton">
        <div className="project-skeleton project-skeleton--tab" />
        <div className="project-skeleton project-skeleton--tab" />
        <div className="project-skeleton project-skeleton--tab" />
        <div className="project-skeleton project-skeleton--tab" />
      </div>

      {/* Grid skeleton - 6 cards */}
      <div className="project-grid project-grid--skeleton">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="project-card project-card--skeleton">
            <div className="project-card-skeleton__header">
              <div className="project-skeleton project-skeleton--icon-circle" />
              <div className="project-skeleton__text-group">
                <div className="project-skeleton project-skeleton--title" />
                <div className="project-skeleton project-skeleton--path" />
              </div>
              <div className="project-skeleton project-skeleton--badge" />
            </div>
            <div className="project-card-skeleton__health">
              <div className="project-skeleton project-skeleton--metric" />
              <div className="project-skeleton project-skeleton--metric" />
              <div className="project-skeleton project-skeleton--metric" />
            </div>
            <div className="project-card-skeleton__footer">
              <div className="project-skeleton project-skeleton--activity" />
              <div className="project-skeleton project-skeleton--actions" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
