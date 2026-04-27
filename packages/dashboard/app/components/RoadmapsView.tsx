import { useState, useCallback, useEffect, useRef } from "react";
import { Plus, Pencil, Trash2, Check, X, GripVertical, Sparkles, Download, Copy, Loader, ArrowLeft, ChevronUp } from "lucide-react";
import "./RoadmapsView.css";
import type { ToastType } from "../hooks/useToast";
import { useRoadmaps, type FeatureSuggestion, type MilestoneSuggestion, type SuggestionDraftPatch } from "../hooks/useRoadmaps";
import { useViewportMode } from "../hooks/useViewportMode";
import { useConfirm } from "../hooks/useConfirm";
import type {
  Roadmap,
  RoadmapMilestone,
  RoadmapFeature,
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestoneCreateInput,
  RoadmapMilestoneUpdateInput,
  RoadmapFeatureCreateInput,
  RoadmapFeatureUpdateInput,
  RoadmapMissionPlanningHandoff,
  RoadmapFeatureTaskPlanningHandoff,
} from "@fusion/core";

export interface RoadmapsViewProps {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
}

// ── Drag State Types ────────────────────────────────────────────────

interface MilestoneDragState {
  draggingId: string | null;
  dropTargetId: string | null;
  dropPosition: "before" | "after" | null;
}

interface FeatureDragState {
  draggingId: string | null;
  draggingMilestoneId: string | null;
  dropTargetMilestoneId: string | null;
  dropTargetIndex: number | null;
  dropPosition: "before" | "after" | null;
}

// ── Inline Edit State Types ─────────────────────────────────────────

interface InlineEditState {
  roadmapId: string | null;
  field: "title" | "description" | null;
  value: string;
}

interface MilestoneInlineEditState {
  milestoneId: string | null;
  field: "title" | "description" | null;
  value: string;
}

interface FeatureInlineEditState {
  featureId: string | null;
  field: "title" | "description" | null;
  value: string;
}

// ── Create Form State ───────────────────────────────────────────────

interface CreateFormState {
  type: "roadmap" | "milestone" | "feature" | null;
  parentId?: string;
  title: string;
  description: string;
}

// ── Handoff Modal Types ─────────────────────────────────────────────

interface HandoffModalProps {
  isOpen: boolean;
  onClose: () => void;
  roadmapId: string;
  roadmapTitle: string;
  handoffPayload: { mission: RoadmapMissionPlanningHandoff; features: RoadmapFeatureTaskPlanningHandoff[] } | null;
  isLoading: boolean;
  error: Error | null;
  onFetchHandoff: () => void;
  onCopyToClipboard: () => void;
}

// ── Handoff Modal Component ─────────────────────────────────────────

function HandoffModal({
  isOpen,
  onClose,
  roadmapTitle,
  handoffPayload,
  isLoading,
  error,
  onFetchHandoff,
  onCopyToClipboard,
}: HandoffModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={onClose} role="presentation">
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="handoff-modal-title">
        <div className="modal-header">
          <h2 id="handoff-modal-title">Export Roadmap: {roadmapTitle}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p className="text-muted" style={{ marginBottom: "var(--space-lg)" }}>
            Export roadmap data for use in mission and task planning flows.
            This is a read-only export — no missions or tasks will be created.
          </p>
          
          {error && (
            <div className="form-error" style={{ marginBottom: "var(--space-lg)" }}>
              Error loading handoff data: {error.message}
            </div>
          )}

          {!handoffPayload && !isLoading && (
            <div style={{ textAlign: "center", padding: "var(--space-xl)" }}>
              <button className="btn btn-primary" onClick={onFetchHandoff}>
                <Download size={16} style={{ marginRight: "var(--space-sm)" }} />
                Load Handoff Data
              </button>
            </div>
          )}

          {isLoading && (
            <div style={{ textAlign: "center", padding: "var(--space-xl)" }}>
              <Loader size={24} className="spin" />
              <p style={{ marginTop: "var(--space-md)" }}>Loading handoff data...</p>
            </div>
          )}

          {handoffPayload && (
            <>
              <div style={{ marginBottom: "var(--space-lg)" }}>
                <h3 style={{ marginBottom: "var(--space-sm)" }}>Mission Planning Handoff</h3>
                <div className="card" style={{ padding: "var(--space-md)" }}>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px", maxHeight: "200px", overflow: "auto" }}>
                    {JSON.stringify(handoffPayload.mission, null, 2)}
                  </pre>
                </div>
              </div>

              <div style={{ marginBottom: "var(--space-lg)" }}>
                <h3 style={{ marginBottom: "var(--space-sm)" }}>
                  Feature Task Planning Handoffs ({handoffPayload.features.length})
                </h3>
                <div className="card" style={{ padding: "var(--space-md)" }}>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px", maxHeight: "300px", overflow: "auto" }}>
                    {JSON.stringify(handoffPayload.features, null, 2)}
                  </pre>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="modal-actions">
          <div className="modal-actions-left">
            {handoffPayload && (
              <button className="btn btn-sm" onClick={onCopyToClipboard}>
                <Copy size={14} style={{ marginRight: "var(--space-xs)" }} />
                Copy to Clipboard
              </button>
            )}
          </div>
          <div className="modal-actions-right">
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Roadmap Item ─────────────────────────────────────────────────────

function RoadmapItem({
  roadmap,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
  onExport,
}: {
  roadmap: Roadmap;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      onSelect();
    }
  };

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit();
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  const handleExportClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onExport();
  };

  return (
    <div
      className={`roadmaps-view__sidebar-item${isSelected ? " roadmaps-view__sidebar-item--active" : ""}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-selected={isSelected}
      data-testid={`roadmap-item-${roadmap.id}`}
    >
      <div className="roadmaps-view__sidebar-item-content">
        <div className="roadmaps-view__sidebar-item-title">{roadmap.title}</div>
        {roadmap.description && (
          <div className="roadmaps-view__sidebar-item-desc">{roadmap.description}</div>
        )}
      </div>
      <div className="roadmaps-view__sidebar-item-actions" onClick={handleEditClick} role="presentation">
        <span
          className="roadmaps-view__icon-btn"
          onClick={handleExportClick}
          role="button"
          title="Export roadmap"
          aria-label="Export roadmap"
          data-testid={`roadmap-export-${roadmap.id}`}
          tabIndex={0}
        >
          <Download size={14} />
        </span>
        <span
          className="roadmaps-view__icon-btn"
          onClick={handleEditClick}
          role="button"
          title="Edit roadmap"
          aria-label="Edit roadmap"
          data-testid={`roadmap-edit-${roadmap.id}`}
          tabIndex={0}
        >
          <Pencil size={14} />
        </span>
        <span
          className="roadmaps-view__icon-btn roadmaps-view__icon-btn--danger"
          onClick={handleDeleteClick}
          role="button"
          title="Delete roadmap"
          aria-label="Delete roadmap"
          data-testid={`roadmap-delete-${roadmap.id}`}
          tabIndex={0}
        >
          <Trash2 size={14} />
        </span>
      </div>
    </div>
  );
}

// ── Mobile Roadmap List ──────────────────────────────────────────────

function MobileRoadmapList({
  roadmaps,
  selectedRoadmapId,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
  onExport,
  showCreateForm,
  onCancelCreate,
  onSaveCreate,
}: {
  roadmaps: Roadmap[];
  selectedRoadmapId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: (roadmap: Roadmap) => void;
  onDelete: (roadmapId: string) => void;
  onExport: (roadmap: Roadmap) => void;
  showCreateForm: boolean;
  onCancelCreate: () => void;
  onSaveCreate: (input: RoadmapCreateInput) => void;
}) {
  return (
    <div className="roadmaps-view__mobile-list" data-testid="roadmaps-view__mobile-list">
      <div className="roadmaps-view__mobile-list-header">
        <h2 className="roadmaps-view__mobile-list-title">Roadmaps</h2>
        {!showCreateForm && (
          <button
            className="roadmaps-view__mobile-add-btn"
            onClick={onCreate}
            title="Create roadmap"
            aria-label="Create roadmap"
            data-testid="mobile-create-roadmap-btn"
          >
            <Plus size={18} />
          </button>
        )}
      </div>

      {showCreateForm && (
        <div className="roadmaps-view__mobile-create-form">
          <CreateRoadmapForm onSave={onSaveCreate} onCancel={onCancelCreate} />
        </div>
      )}

      {roadmaps.length === 0 && !showCreateForm ? (
        <div className="roadmaps-view__mobile-empty">
          <p>No roadmaps yet.</p>
          <button className="btn btn-primary btn-sm" onClick={onCreate}>
            <Plus size={14} />
            <span>Create Roadmap</span>
          </button>
        </div>
      ) : (
        <div className="roadmaps-view__mobile-list-items">
          {roadmaps.map((roadmap) => (
            <div
              key={roadmap.id}
              className={`roadmaps-view__mobile-item${roadmap.id === selectedRoadmapId ? " roadmaps-view__mobile-item--active" : ""}`}
              onClick={() => onSelect(roadmap.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onSelect(roadmap.id);
                }
              }}
              data-testid={`mobile-roadmap-item-${roadmap.id}`}
            >
              <div className="roadmaps-view__mobile-item-content">
                <span className="roadmaps-view__mobile-item-title">{roadmap.title}</span>
                {roadmap.description && (
                  <span className="roadmaps-view__mobile-item-desc">{roadmap.description}</span>
                )}
              </div>
              <div className="roadmaps-view__mobile-item-actions">
                <button
                  className="roadmaps-view__mobile-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExport(roadmap);
                  }}
                  title="Export roadmap"
                  aria-label="Export roadmap"
                  data-testid={`mobile-roadmap-export-${roadmap.id}`}
                >
                  <Download size={16} />
                </button>
                <button
                  className="roadmaps-view__mobile-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(roadmap);
                  }}
                  title="Edit roadmap"
                  aria-label="Edit roadmap"
                  data-testid={`mobile-roadmap-edit-${roadmap.id}`}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="roadmaps-view__mobile-action-btn roadmaps-view__mobile-action-btn--danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(roadmap.id);
                  }}
                  title="Delete roadmap"
                  aria-label="Delete roadmap"
                  data-testid={`mobile-roadmap-delete-${roadmap.id}`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Mobile Roadmap Header (shown when roadmap is selected) ────────────

function MobileRoadmapHeader({
  roadmapTitle,
  onBack,
  onEdit,
  onDelete,
  onCreate,
}: {
  roadmapTitle: string;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="roadmaps-view__mobile-header" data-testid="roadmaps-view__mobile-header">
      <button
        className="roadmaps-view__mobile-back-btn"
        onClick={onBack}
        title="Back to roadmap list"
        aria-label="Back to roadmap list"
        data-testid="mobile-back-btn"
      >
        <ArrowLeft size={20} />
      </button>
      <h2 className="roadmaps-view__mobile-header-title">{roadmapTitle}</h2>
      <div className="roadmaps-view__mobile-header-actions">
        <button
          className="roadmaps-view__mobile-action-btn"
          onClick={onCreate}
          title="Create roadmap"
          aria-label="Create roadmap"
          data-testid="mobile-header-create-btn"
        >
          <Plus size={18} />
        </button>
        <button
          className="roadmaps-view__mobile-action-btn"
          onClick={onEdit}
          title="Edit roadmap"
          aria-label="Edit roadmap"
          data-testid="mobile-header-edit-btn"
        >
          <Pencil size={18} />
        </button>
        <button
          className="roadmaps-view__mobile-action-btn roadmaps-view__mobile-action-btn--danger"
          onClick={onDelete}
          title="Delete roadmap"
          aria-label="Delete roadmap"
          data-testid="mobile-header-delete-btn"
        >
          <Trash2 size={18} />
        </button>
      </div>
    </div>
  );
}

// ── Milestone Card ───────────────────────────────────────────────────

function MilestoneCard({
  milestone,
  features,
  onEditMilestone,
  onDeleteMilestone,
  onAddFeature,
  onEditFeature,
  onDeleteFeature,
  milestoneEdit,
  onStartMilestoneEdit,
  onCancelMilestoneEdit,
  onSaveMilestoneEdit,
  featureEdit,
  onStartFeatureEdit: _onStartFeatureEdit,
  onCancelFeatureEdit,
  onSaveFeatureEdit,
  projectId: _projectId,
  addToast: _addToast,
  // Milestone drag-and-drop props
  isMilestoneDragging,
  isMilestoneDropTarget,
  milestoneDropPosition,
  onMilestoneDragStart,
  onMilestoneDragEnd,
  onMilestoneDragOver,
  onMilestoneDrop,
  onMilestoneDragLeave,
  // Feature drag-and-drop props
  isFeatureDragging,
  isFeatureDropTarget,
  featureDropIndex,
  onFeatureDragStart,
  onFeatureDragEnd,
  onFeatureDragOver,
  onFeatureDrop,
  onFeatureDragLeave,
  onFeatureDropOnMilestone,
  // Feature suggestion props
  featureSuggestions,
  isGeneratingFeatureSuggestions,
  onGenerateFeatureSuggestions,
  onAcceptFeatureSuggestion,
  onAcceptAllFeatureSuggestions,
  onUpdateFeatureSuggestionDraft,
  onClearFeatureSuggestions,
}: {
  milestone: RoadmapMilestone;
  features: RoadmapFeature[];
  onEditMilestone: () => void;
  onDeleteMilestone: () => void;
  onAddFeature: () => void;
  onEditFeature: (featureId: string) => void;
  onDeleteFeature: (featureId: string) => void;
  milestoneEdit: MilestoneInlineEditState | null;
  onStartMilestoneEdit: () => void;
  onCancelMilestoneEdit: () => void;
  onSaveMilestoneEdit: (updates: RoadmapMilestoneUpdateInput) => void;
  featureEdit: FeatureInlineEditState | null;
  onStartFeatureEdit: (featureId: string, currentTitle: string, currentDescription?: string) => void;
  onCancelFeatureEdit: () => void;
  onSaveFeatureEdit: (updates: RoadmapFeatureUpdateInput) => void;
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  // Milestone drag-and-drop props
  isMilestoneDragging: boolean;
  isMilestoneDropTarget: boolean;
  milestoneDropPosition: "before" | "after" | null;
  onMilestoneDragStart: (milestoneId: string) => void;
  onMilestoneDragEnd: () => void;
  onMilestoneDragOver: (milestoneId: string) => void;
  onMilestoneDrop: (milestoneId: string) => void;
  onMilestoneDragLeave: (e: React.DragEvent) => void;
  // Feature drag-and-drop props
  isFeatureDragging: (featureId: string) => boolean;
  isFeatureDropTarget: boolean;
  featureDropIndex: number | null;
  onFeatureDragStart: (featureId: string, milestoneId: string) => void;
  onFeatureDragEnd: () => void;
  onFeatureDragOver: (featureId: string, position: "before" | "after") => void;
  onFeatureDrop: (featureId: string, targetIndex: number) => void;
  onFeatureDragLeave: (e: React.DragEvent) => void;
  onFeatureDropOnMilestone: () => void;
  // Feature suggestion props
  featureSuggestions?: FeatureSuggestion[];
  isGeneratingFeatureSuggestions?: boolean;
  onGenerateFeatureSuggestions?: () => void;
  onUpdateFeatureSuggestionDraft?: (milestoneId: string, draftId: string, patch: SuggestionDraftPatch) => void;
  onAcceptFeatureSuggestion?: (milestoneId: string, draftId: string) => void;
  onAcceptAllFeatureSuggestions?: () => void;
  onClearFeatureSuggestions?: () => void;
}) {
  const isEditingMilestone = milestoneEdit?.milestoneId === milestone.id;

  const handleMilestoneTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (milestoneEdit) {
        onSaveMilestoneEdit({ title: milestoneEdit.value });
      }
    } else if (e.key === "Escape") {
      onCancelMilestoneEdit();
    }
  };

  const handleMilestoneDescKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      onCancelMilestoneEdit();
    }
  };

  // Build class names for drag states
  const milestoneClasses = [
    "roadmaps-view__milestone",
    isMilestoneDragging ? "roadmaps-view__milestone--dragging" : "",
    isMilestoneDropTarget ? "roadmaps-view__milestone--drop-target" : "",
    isMilestoneDropTarget && milestoneDropPosition === "before" ? "roadmaps-view__milestone--drop-before" : "",
    isMilestoneDropTarget && milestoneDropPosition === "after" ? "roadmaps-view__milestone--drop-after" : "",
  ].filter(Boolean).join(" ");

  // Build class names for feature list drop state
  const featureListClasses = [
    "roadmaps-view__feature-list",
    isFeatureDropTarget ? "roadmaps-view__feature-list--drop-target" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={milestoneClasses}
      draggable={!isEditingMilestone}
      onDragStart={(e) => {
        if (!isEditingMilestone) {
          onMilestoneDragStart(milestone.id);
          e.dataTransfer.setData("text/plain", `milestone:${milestone.id}`);
          e.dataTransfer.effectAllowed = "move";
        }
      }}
      onDragEnd={onMilestoneDragEnd}
      onDragOver={(e) => {
        // Only prevent default for milestone drops, not feature drops
        if (e.dataTransfer.types.includes("text/plain")) {
          const data = e.dataTransfer.types.includes("text/plain");
          if (data) {
            // This is a milestone drag
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            onMilestoneDragOver(milestone.id);
          }
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        // Check if this is a feature drop or milestone drop
        const data = e.dataTransfer.getData("text/plain");
        if (data?.startsWith("feature:")) {
          // Feature drop - handled by child element
        } else {
          onMilestoneDrop(milestone.id);
        }
      }}
      onDragLeave={onMilestoneDragLeave}
      data-testid={`milestone-card-${milestone.id}`}
    >
      <div className="roadmaps-view__milestone-header">
        {isEditingMilestone ? (
          <div className="roadmaps-view__inline-edit">
            <div className="roadmaps-view__inline-edit-row">
              <span
                className="roadmaps-view__drag-handle"
                title="Drag to reorder"
                aria-label="Drag to reorder"
                data-testid={`milestone-drag-handle-${milestone.id}`}
              >
                <GripVertical size={14} />
              </span>
              <input
                type="text"
                className="roadmaps-view__inline-input"
                value={milestoneEdit.value}
                onChange={() =>
                  onStartMilestoneEdit()
                }
                onKeyDown={handleMilestoneTitleKeyDown}
                placeholder="Milestone title"
                autoFocus
                data-testid={`milestone-title-input-${milestone.id}`}
              />
              <button
                className="roadmaps-view__icon-btn roadmaps-view__icon-btn--success"
                onClick={() => onSaveMilestoneEdit({ title: milestoneEdit.value })}
                aria-label="Save milestone title"
                title="Save"
              >
                <Check size={14} />
              </button>
              <button
                className="roadmaps-view__icon-btn"
                onClick={onCancelMilestoneEdit}
                aria-label="Cancel editing"
                title="Cancel"
              >
                <X size={14} />
              </button>
            </div>
            <textarea
              className="roadmaps-view__inline-textarea"
              value={milestoneEdit.field === "description" ? milestoneEdit.value : milestone.description || ""}
              onChange={() => {
                // Update the edit state with description
              }}
              onKeyDown={handleMilestoneDescKeyDown}
              placeholder="Milestone description (optional)"
              rows={2}
              data-testid={`milestone-desc-input-${milestone.id}`}
            />
          </div>
        ) : (
          <>
            <div className="roadmaps-view__milestone-title-row">
              <span
                className="roadmaps-view__drag-handle"
                title="Drag to reorder"
                aria-label="Drag to reorder"
                data-testid={`milestone-drag-handle-${milestone.id}`}
              >
                <GripVertical size={14} />
              </span>
              <h3 className="roadmaps-view__milestone-title">{milestone.title}</h3>
              <div className="roadmaps-view__milestone-actions">
                <button
                  className="roadmaps-view__icon-btn"
                  onClick={onEditMilestone}
                  title="Edit milestone"
                  aria-label="Edit milestone"
                  data-testid={`milestone-edit-${milestone.id}`}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="roadmaps-view__icon-btn roadmaps-view__icon-btn--danger"
                  onClick={onDeleteMilestone}
                  title="Delete milestone"
                  aria-label="Delete milestone"
                  data-testid={`milestone-delete-${milestone.id}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            {milestone.description && (
              <p className="roadmaps-view__milestone-desc">{milestone.description}</p>
            )}
          </>
        )}
      </div>

      <div className="roadmaps-view__milestone-actions-bar">
        <button
          className="roadmaps-view__add-feature-btn"
          onClick={onAddFeature}
          title="Add feature"
          aria-label="Add feature"
          data-testid={`add-feature-${milestone.id}`}
        >
          <Plus size={12} />
          <span>Add Feature</span>
        </button>
        <button
          className="roadmaps-view__suggest-btn"
          onClick={() => {
            // Generate feature suggestions for this milestone
            onGenerateFeatureSuggestions?.();
          }}
          disabled={isGeneratingFeatureSuggestions ?? false}
          title="Generate feature suggestions with AI"
          aria-label="Generate feature suggestions"
          data-testid={`generate-features-${milestone.id}`}
        >
          <Sparkles size={12} />
          <span>{isGeneratingFeatureSuggestions ? "Generating..." : "AI Suggestions"}</span>
        </button>
      </div>

      <div
        className={featureListClasses}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          // Check if this is a feature being dragged
          const data = e.dataTransfer.getData("text/plain");
          if (data?.startsWith("feature:")) {
            onFeatureDropOnMilestone();
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          const data = e.dataTransfer.getData("text/plain");
          if (data?.startsWith("feature:")) {
            // Drop on empty area of feature list - append to end
            onFeatureDrop(data.split(":")[1], features.length);
          }
        }}
        onDragLeave={onFeatureDragLeave}
      >
        {features.length === 0 ? (
          <p className="roadmaps-view__empty-features">No features yet.</p>
        ) : (
          features.map((feature, index) => {
            const isEditingFeature = featureEdit?.featureId === feature.id;
            const isFeatureDraggingThis = isFeatureDragging(feature.id);

            const handleFeatureTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (featureEdit) {
                  onSaveFeatureEdit({ title: featureEdit.value });
                }
              } else if (e.key === "Escape") {
                onCancelFeatureEdit();
              }
            };

            // Build class names for feature drag states
            const featureClasses = [
              "roadmaps-view__feature-item",
              isFeatureDraggingThis ? "roadmaps-view__feature-item--dragging" : "",
              isFeatureDropTarget && featureDropIndex === index ? "roadmaps-view__feature-item--drop-before" : "",
              isFeatureDropTarget && featureDropIndex === index + 1 ? "roadmaps-view__feature-item--drop-after" : "",
            ].filter(Boolean).join(" ");

            return (
              <div
                key={feature.id}
                className={featureClasses}
                draggable={!isEditingFeature}
                onDragStart={(e) => {
                  if (!isEditingFeature) {
                    onFeatureDragStart(feature.id, milestone.id);
                    e.dataTransfer.setData("text/plain", `feature:${feature.id}`);
                    e.dataTransfer.effectAllowed = "move";
                  }
                }}
                onDragEnd={onFeatureDragEnd}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  const data = e.dataTransfer.getData("text/plain");
                  if (data?.startsWith("feature:")) {
                    // Calculate position (before or after)
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    const position: "before" | "after" = e.clientY < midY ? "before" : "after";
                    onFeatureDragOver(feature.id, position);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const data = e.dataTransfer.getData("text/plain");
                  if (data?.startsWith("feature:")) {
                    const draggedFeatureId = data.split(":")[1];
                    // Calculate target index
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    const position: "before" | "after" = e.clientY < midY ? "before" : "after";
                    let targetIndex = index;
                    if (position === "after") {
                      targetIndex = index + 1;
                    }
                    onFeatureDrop(draggedFeatureId, targetIndex);
                  }
                }}
                onDragLeave={onFeatureDragLeave}
                data-testid={`feature-item-${feature.id}`}
              >
                {isEditingFeature ? (
                  <div className="roadmaps-view__inline-edit roadmaps-view__inline-edit--compact">
                    <div className="roadmaps-view__inline-edit-row">
                      <span
                        className="roadmaps-view__drag-handle roadmaps-view__drag-handle--feature"
                        title="Drag to reorder"
                        aria-label="Drag to reorder"
                        data-testid={`feature-drag-handle-${feature.id}`}
                      >
                        <GripVertical size={12} />
                      </span>
                      <input
                        type="text"
                        className="roadmaps-view__inline-input"
                        value={featureEdit.value}
                        onChange={() => {}}
                        onKeyDown={handleFeatureTitleKeyDown}
                        placeholder="Feature title"
                        autoFocus
                        data-testid={`feature-title-input-${feature.id}`}
                      />
                      <button
                        className="roadmaps-view__icon-btn roadmaps-view__icon-btn--success"
                        onClick={() => onSaveFeatureEdit({ title: featureEdit.value })}
                        aria-label="Save feature title"
                        title="Save"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        className="roadmaps-view__icon-btn"
                        onClick={onCancelFeatureEdit}
                        aria-label="Cancel editing"
                        title="Cancel"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span
                      className="roadmaps-view__drag-handle roadmaps-view__drag-handle--feature"
                      title="Drag to reorder"
                      aria-label="Drag to reorder"
                      data-testid={`feature-drag-handle-${feature.id}`}
                    >
                      <GripVertical size={12} />
                    </span>
                    <div className="roadmaps-view__feature-content">
                      <span className="roadmaps-view__feature-title">{feature.title}</span>
                      {feature.description && (
                        <p className="roadmaps-view__feature-desc">{feature.description}</p>
                      )}
                    </div>
                    <div className="roadmaps-view__feature-actions">
                      <button
                        className="roadmaps-view__icon-btn"
                        onClick={() => onEditFeature(feature.id)}
                        title="Edit feature"
                        aria-label="Edit feature"
                        data-testid={`feature-edit-${feature.id}`}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        className="roadmaps-view__icon-btn roadmaps-view__icon-btn--danger"
                        onClick={() => onDeleteFeature(feature.id)}
                        title="Delete feature"
                        aria-label="Delete feature"
                        data-testid={`feature-delete-${feature.id}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}

        {/* Feature Suggestions Section */}
        {featureSuggestions && featureSuggestions.length > 0 && (
          <div className="roadmap-suggestion-section">
            <div className="roadmap-suggestion-header">
              <h4 className="roadmap-suggestion-title">AI Feature Suggestions</h4>
              <div className="roadmap-suggestion-actions">
                <button
                  className="roadmap-suggestion-accept-all-btn"
                  onClick={() => onAcceptAllFeatureSuggestions?.()}
                  title="Accept all suggestions"
                  aria-label="Accept all"
                  data-testid={`accept-all-features-${milestone.id}`}
                >
                  Accept All
                </button>
                <button
                  className="roadmap-suggestion-clear-btn"
                  onClick={() => onClearFeatureSuggestions?.()}
                  title="Clear suggestions"
                  aria-label="Clear"
                  data-testid={`clear-features-${milestone.id}`}
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="roadmap-suggestion-list">
              {featureSuggestions.map((suggestion) => (
                <FeatureSuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  onUpdateDraft={(patch) => onUpdateFeatureSuggestionDraft?.(milestone.id, suggestion.id, patch)}
                  onAccept={() => {
                    onAcceptFeatureSuggestion?.(milestone.id, suggestion.id);
                  }}
                  testIdPrefix={`feature-suggestion-${milestone.id}`}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Feature Suggestion Card ───────────────────────────────────────────

interface FeatureSuggestionCardProps {
  suggestion: FeatureSuggestion;
  onUpdateDraft: (patch: SuggestionDraftPatch) => void;
  onAccept: () => void;
  testIdPrefix: string;
}

function FeatureSuggestionCard({
  suggestion,
  onUpdateDraft,
  onAccept,
  testIdPrefix,
}: FeatureSuggestionCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(suggestion.title);
  const [editDescription, setEditDescription] = useState(suggestion.description || "");

  const handleStartEdit = () => {
    setEditTitle(suggestion.title);
    setEditDescription(suggestion.description || "");
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    onUpdateDraft({
      title: editTitle.trim(),
      description: editDescription.trim() || undefined,
    });
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditTitle(suggestion.title);
    setEditDescription(suggestion.description || "");
    setIsEditing(false);
  };

  const handleAccept = () => {
    if (!suggestion.title.trim()) {
      return; // Don't accept empty titles
    }
    onAccept();
  };

  const isValid = suggestion.title.trim().length > 0;

  if (isEditing) {
    return (
      <div className="roadmap-suggestion-card roadmap-suggestion-card--editing">
        <div className="roadmap-suggestion-edit-form">
          <input
            type="text"
            className="roadmap-suggestion-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder="Feature title"
            autoFocus
            data-testid={`${testIdPrefix}-${suggestion.id}-title-input`}
          />
          <textarea
            className="roadmap-suggestion-textarea"
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            data-testid={`${testIdPrefix}-${suggestion.id}-desc-input`}
          />
          <div className="roadmap-suggestion-edit-actions">
            <button
              className="roadmap-suggestion-save-btn"
              onClick={handleSaveEdit}
              disabled={!editTitle.trim()}
              title="Save"
              data-testid={`${testIdPrefix}-${suggestion.id}-save`}
            >
              <Check size={12} />
            </button>
            <button
              className="roadmap-suggestion-cancel-btn"
              onClick={handleCancelEdit}
              title="Cancel"
              data-testid={`${testIdPrefix}-${suggestion.id}-cancel`}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="roadmap-suggestion-card"
      data-testid={`${testIdPrefix}-${suggestion.id}`}
    >
      <div className="roadmap-suggestion-content">
        <span className="roadmap-suggestion-card-title">{suggestion.title}</span>
        {suggestion.description && (
          <p className="roadmap-suggestion-card-desc">{suggestion.description}</p>
        )}
      </div>
      <div className="roadmap-suggestion-card-actions">
        <button
          className="roadmap-suggestion-edit-btn"
          onClick={handleStartEdit}
          title="Edit suggestion"
          aria-label="Edit"
          data-testid={`${testIdPrefix}-${suggestion.id}-edit`}
        >
          <Pencil size={12} />
        </button>
        <button
          className="roadmap-suggestion-accept-btn"
          onClick={handleAccept}
          disabled={!isValid}
          title="Accept this suggestion"
          aria-label="Accept"
          data-testid={`${testIdPrefix}-${suggestion.id}-accept`}
        >
          <Check size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Milestone Suggestion Card ────────────────────────────────────────

interface MilestoneSuggestionCardProps {
  suggestion: MilestoneSuggestion;
  onUpdateDraft: (patch: SuggestionDraftPatch) => void;
  onAccept: () => void;
  testIdPrefix: string;
}

function MilestoneSuggestionCard({
  suggestion,
  onUpdateDraft,
  onAccept,
  testIdPrefix,
}: MilestoneSuggestionCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(suggestion.title);
  const [editDescription, setEditDescription] = useState(suggestion.description || "");

  const handleStartEdit = () => {
    setEditTitle(suggestion.title);
    setEditDescription(suggestion.description || "");
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    onUpdateDraft({
      title: editTitle.trim(),
      description: editDescription.trim() || undefined,
    });
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditTitle(suggestion.title);
    setEditDescription(suggestion.description || "");
    setIsEditing(false);
  };

  const handleAccept = () => {
    if (!suggestion.title.trim()) {
      return; // Don't accept empty titles
    }
    onAccept();
  };

  const isValid = suggestion.title.trim().length > 0;

  if (isEditing) {
    return (
      <div className="roadmap-suggestion-card roadmap-suggestion-card--editing">
        <div className="roadmap-suggestion-edit-form">
          <input
            type="text"
            className="roadmap-suggestion-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder="Milestone title"
            autoFocus
            data-testid={`${testIdPrefix}-${suggestion.id}-title-input`}
          />
          <textarea
            className="roadmap-suggestion-textarea"
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            data-testid={`${testIdPrefix}-${suggestion.id}-desc-input`}
          />
          <div className="roadmap-suggestion-edit-actions">
            <button
              className="roadmap-suggestion-save-btn"
              onClick={handleSaveEdit}
              disabled={!editTitle.trim()}
              title="Save"
              data-testid={`${testIdPrefix}-${suggestion.id}-save`}
            >
              <Check size={12} />
            </button>
            <button
              className="roadmap-suggestion-cancel-btn"
              onClick={handleCancelEdit}
              title="Cancel"
              data-testid={`${testIdPrefix}-${suggestion.id}-cancel`}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="roadmap-suggestion-card"
      data-testid={`${testIdPrefix}-${suggestion.id}`}
    >
      <div className="roadmap-suggestion-content">
        <span className="roadmap-suggestion-card-title">{suggestion.title}</span>
        {suggestion.description && (
          <p className="roadmap-suggestion-card-desc">{suggestion.description}</p>
        )}
      </div>
      <div className="roadmap-suggestion-card-actions">
        <button
          className="roadmap-suggestion-edit-btn"
          onClick={handleStartEdit}
          title="Edit suggestion"
          aria-label="Edit"
          data-testid={`${testIdPrefix}-${suggestion.id}-edit`}
        >
          <Pencil size={12} />
        </button>
        <button
          className="roadmap-suggestion-accept-btn"
          onClick={handleAccept}
          disabled={!isValid}
          title="Accept this suggestion"
          aria-label="Accept"
          data-testid={`${testIdPrefix}-${suggestion.id}-accept`}
        >
          <Check size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Create Form ───────────────────────────────────────────────────────

function CreateRoadmapForm({
  onSave,
  onCancel,
}: {
  onSave: (input: RoadmapCreateInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({ title: title.trim(), description: description.trim() || undefined });
  };

  return (
    <div className="roadmaps-view__create-form" data-testid="create-roadmap-form">
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          className="roadmaps-view__inline-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Roadmap title"
          autoFocus
          data-testid="create-roadmap-title"
        />
        <textarea
          className="roadmaps-view__inline-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Roadmap description (optional)"
          rows={2}
          data-testid="create-roadmap-description"
        />
        <div className="roadmaps-view__create-form-actions">
          <button
            type="submit"
            className="roadmaps-view__btn roadmaps-view__btn--primary"
            disabled={!title.trim()}
            data-testid="create-roadmap-submit"
          >
            Create
          </button>
          <button
            type="button"
            className="roadmaps-view__btn"
            onClick={onCancel}
            data-testid="create-roadmap-cancel"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function CreateMilestoneForm({
  onSave,
  onCancel,
}: {
  onSave: (input: RoadmapMilestoneCreateInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({ title: title.trim(), description: description.trim() || undefined });
  };

  return (
    <div className="roadmaps-view__create-form roadmaps-view__create-form--inline" data-testid="create-milestone-form">
      <form onSubmit={handleSubmit} className="roadmaps-view__inline-form">
        <input
          type="text"
          className="roadmaps-view__inline-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Milestone title"
          autoFocus
          data-testid="create-milestone-title"
        />
        <textarea
          className="roadmaps-view__inline-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={1}
          data-testid="create-milestone-description"
        />
        <div className="roadmaps-view__inline-form-actions">
          <button
            type="submit"
            className="roadmaps-view__icon-btn roadmaps-view__icon-btn--success"
            disabled={!title.trim()}
            aria-label="Save milestone"
            title="Save"
            data-testid="create-milestone-submit"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            className="roadmaps-view__icon-btn"
            onClick={onCancel}
            aria-label="Cancel"
            title="Cancel"
            data-testid="create-milestone-cancel"
          >
            <X size={14} />
          </button>
        </div>
      </form>
    </div>
  );
}

function CreateFeatureForm({
  onSave,
  onCancel,
}: {
  onSave: (input: RoadmapFeatureCreateInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({ title: title.trim(), description: description.trim() || undefined });
  };

  return (
    <div className="roadmaps-view__create-form roadmaps-view__create-form--inline" data-testid="create-feature-form">
      <form onSubmit={handleSubmit} className="roadmaps-view__inline-form">
        <input
          type="text"
          className="roadmaps-view__inline-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Feature title"
          autoFocus
          data-testid="create-feature-title"
        />
        <textarea
          className="roadmaps-view__inline-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={1}
          data-testid="create-feature-description"
        />
        <div className="roadmaps-view__inline-form-actions">
          <button
            type="submit"
            className="roadmaps-view__icon-btn roadmaps-view__icon-btn--success"
            disabled={!title.trim()}
            aria-label="Save feature"
            title="Save"
            data-testid="create-feature-submit"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            className="roadmaps-view__icon-btn"
            onClick={onCancel}
            aria-label="Cancel"
            title="Cancel"
            data-testid="create-feature-cancel"
          >
            <X size={14} />
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────

export function RoadmapsView({ projectId, addToast }: RoadmapsViewProps) {
  const { confirm } = useConfirm();
  const isMobile = useViewportMode() === "mobile";

  const {
    roadmaps,
    selectedRoadmapId,
    selectedRoadmap,
    milestones,
    featuresByMilestoneId,
    loading,
    error,
    createRoadmap,
    updateRoadmap,
    deleteRoadmap,
    selectRoadmap,
    createMilestone,
    updateMilestone,
    deleteMilestone,
    createFeature,
    updateFeature,
    deleteFeature,
    reorderMilestones,
    reorderFeatures,
    moveFeature,
    milestoneSuggestions,
    isGeneratingSuggestions,
    generateMilestoneSuggestions,
    updateMilestoneSuggestionDraft,
    acceptMilestoneSuggestion,
    acceptAllMilestoneSuggestions,
    clearMilestoneSuggestions,
    featureSuggestionsByMilestoneId,
    isGeneratingFeatureSuggestions,
    generateFeatureSuggestions,
    updateFeatureSuggestionDraft,
    acceptFeatureSuggestion,
    acceptAllFeatureSuggestions,
    clearFeatureSuggestions,
    handoffPayload,
    isFetchingHandoff,
    handoffError,
    fetchHandoff,
    clearHandoff,
  } = useRoadmaps({ projectId });

  // Handoff modal state
  const [handoffModalOpen, setHandoffModalOpen] = useState(false);
  const [handoffRoadmapId, setHandoffRoadmapId] = useState<string | null>(null);
  const [handoffRoadmapTitle, setHandoffRoadmapTitle] = useState<string>("");

  // Goal prompt state for milestone suggestion generation
  const [goalPrompt, setGoalPrompt] = useState("");

  // Mobile suggestion panel collapse state
  const [showSuggestionPanel, setShowSuggestionPanel] = useState(false);

  // Reset suggestion panel when roadmap changes on mobile
  const prevRoadmapIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevRoadmapIdRef.current !== null && prevRoadmapIdRef.current !== selectedRoadmapId) {
      setShowSuggestionPanel(false);
    }
    prevRoadmapIdRef.current = selectedRoadmapId;
  }, [selectedRoadmapId]);

  // Inline edit states
  const [roadmapEdit, setRoadmapEdit] = useState<InlineEditState>({
    roadmapId: null,
    field: null,
    value: "",
  });
  const [milestoneEdit, setMilestoneEdit] = useState<MilestoneInlineEditState>({
    milestoneId: null,
    field: null,
    value: "",
  });
  const [featureEdit, setFeatureEdit] = useState<FeatureInlineEditState>({
    featureId: null,
    field: null,
    value: "",
  });

  // Create form state
  const [createForm, setCreateForm] = useState<CreateFormState>({
    type: null,
    parentId: undefined,
    title: "",
    description: "",
  });

  // Mobile roadmap list create form state
  const [mobileShowCreateForm, setMobileShowCreateForm] = useState(false);

  // Milestone drag-and-drop state
  const [milestoneDrag, setMilestoneDrag] = useState<MilestoneDragState>({
    draggingId: null,
    dropTargetId: null,
    dropPosition: null,
  });

  // Milestone drag handlers
  const handleMilestoneDragStart = useCallback((milestoneId: string) => {
    setMilestoneDrag((prev) => ({
      ...prev,
      draggingId: milestoneId,
    }));
  }, []);

  const handleMilestoneDragEnd = useCallback(() => {
    setMilestoneDrag({
      draggingId: null,
      dropTargetId: null,
      dropPosition: null,
    });
  }, []);

  const handleMilestoneDragOver = useCallback((targetMilestoneId: string) => {
    setMilestoneDrag((prev) => {
      // Don't update if dragging over self
      if (prev.draggingId === targetMilestoneId) {
        return prev;
      }
      // Calculate drop position based on mouse position relative to target
      // The position will be computed based on where the drop will happen
      // For now, we just track the target
      return {
        ...prev,
        dropTargetId: targetMilestoneId,
        dropPosition: null, // Will be set in handleMilestoneDrop
      };
    });
  }, []);

  // Feature drag-and-drop state
  const [featureDrag, setFeatureDrag] = useState<FeatureDragState>({
    draggingId: null,
    draggingMilestoneId: null,
    dropTargetMilestoneId: null,
    dropTargetIndex: null,
    dropPosition: null,
  });

  // Feature drag handlers
  const handleFeatureDragStart = useCallback((featureId: string, milestoneId: string) => {
    setFeatureDrag((prev) => ({
      ...prev,
      draggingId: featureId,
      draggingMilestoneId: milestoneId,
    }));
  }, []);

  const handleFeatureDragEnd = useCallback(() => {
    setFeatureDrag({
      draggingId: null,
      draggingMilestoneId: null,
      dropTargetMilestoneId: null,
      dropTargetIndex: null,
      dropPosition: null,
    });
  }, []);

  const handleFeatureDragOver = useCallback((targetFeatureId: string, position: "before" | "after") => {
    setFeatureDrag((prev) => {
      // Don't update if dragging over self
      if (prev.draggingId === targetFeatureId) {
        return prev;
      }
      // Find the target feature's index in its milestone
      const targetFeatures = featuresByMilestoneId[prev.draggingMilestoneId || ""] || [];
      const targetIndex = targetFeatures.findIndex((f) => f.id === targetFeatureId);

      let dropTargetIndex: number;
      if (position === "before") {
        dropTargetIndex = targetIndex;
      } else {
        dropTargetIndex = targetIndex + 1;
      }

      return {
        ...prev,
        dropTargetMilestoneId: prev.draggingMilestoneId,
        dropTargetIndex,
        dropPosition: position,
      };
    });
  }, [featuresByMilestoneId]);

  const handleFeatureDropOnMilestone = useCallback(() => {
    setFeatureDrag((prev) => ({
      ...prev,
      dropTargetMilestoneId: prev.draggingMilestoneId,
      // Append to end of feature list
      dropTargetIndex: (featuresByMilestoneId[prev.draggingMilestoneId || ""] || []).length,
    }));
  }, [featuresByMilestoneId]);

  const handleFeatureDrop = useCallback(async (featureId: string, targetIndex: number) => {
    const { draggingMilestoneId, dropTargetMilestoneId } = featureDrag;
    if (!draggingMilestoneId) {
      handleFeatureDragEnd();
      return;
    }

    // Determine the target milestone - use the drop target if available, otherwise the dragging milestone
    const targetMilestoneId = dropTargetMilestoneId || draggingMilestoneId;

    // Get the source features
    const sourceFeatures = featuresByMilestoneId[draggingMilestoneId] || [];

    // Find the feature being dragged
    const featureBeingDragged = sourceFeatures.find((f) => f.id === featureId);
    if (!featureBeingDragged) {
      handleFeatureDragEnd();
      return;
    }

    // Check if this is a cross-milestone move
    const isCrossMilestone = draggingMilestoneId !== targetMilestoneId;

    if (isCrossMilestone) {
      // No-op check: if moving to same position in same milestone (shouldn't happen but safety check)
      if (draggingMilestoneId === targetMilestoneId) {
        handleFeatureDragEnd();
        return;
      }

      // Perform the move
      try {
        await moveFeature(featureId, targetMilestoneId, targetIndex, {
          onError: (err) => {
            addToast(`Failed to move feature: ${err.message}`, "error");
          },
        });
      } catch {
        // Error handled in callback
      }
    } else {
      // Same-milestone reorder
      const targetFeatures = [...sourceFeatures];
      const fromIndex = targetFeatures.findIndex((f) => f.id === featureId);

      // Remove from current position and insert at target
      targetFeatures.splice(fromIndex, 1);
      targetFeatures.splice(targetIndex, 0, featureBeingDragged);

      // Compute new order of feature IDs
      const orderedIds = targetFeatures.map((f) => f.id);

      // No-op check: if order is unchanged
      const currentIds = sourceFeatures.map((f) => f.id);
      if (orderedIds.join(",") === currentIds.join(",")) {
        handleFeatureDragEnd();
        return;
      }

      // Perform the reorder
      try {
        await reorderFeatures(draggingMilestoneId, orderedIds, {
          onError: (err) => {
            addToast(`Failed to reorder features: ${err.message}`, "error");
          },
        });
      } catch {
        // Error handled in callback
      }
    }

    handleFeatureDragEnd();
  }, [featureDrag, featuresByMilestoneId, reorderFeatures, moveFeature, addToast, handleFeatureDragEnd]);

  const handleFeatureDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the element entirely
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setFeatureDrag((prev) => ({
        ...prev,
        dropTargetMilestoneId: null,
        dropTargetIndex: null,
        dropPosition: null,
      }));
    }
  }, []);

  // Check if a feature is being dragged
  const isFeatureDragging = useCallback((featureId: string) => {
    return featureDrag.draggingId === featureId;
  }, [featureDrag.draggingId]);

  const handleMilestoneDrop = useCallback(async (targetMilestoneId: string) => {
    const { draggingId } = milestoneDrag;
    if (!draggingId || draggingId === targetMilestoneId) {
      handleMilestoneDragEnd();
      return;
    }

    // Compute the new order
    const currentOrder = milestones.map((m) => m.id);
    const fromIndex = currentOrder.indexOf(draggingId);
    const toIndex = currentOrder.indexOf(targetMilestoneId);

    if (fromIndex === -1 || toIndex === -1) {
      handleMilestoneDragEnd();
      return;
    }

    // Compute the new order based on drop position
    // The drop indicator shows where the item will be inserted
    const newOrder = [...currentOrder];
    newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, draggingId);

    // No-op check: if the order is unchanged
    if (newOrder.join(",") === currentOrder.join(",")) {
      handleMilestoneDragEnd();
      return;
    }

    // Perform the reorder
    try {
      await reorderMilestones(selectedRoadmapId!, newOrder, {
        onError: (err) => {
          addToast(`Failed to reorder milestones: ${err.message}`, "error");
        },
      });
    } catch {
      // Error handled in callback
    }

    handleMilestoneDragEnd();
  }, [milestoneDrag, milestones, selectedRoadmapId, reorderMilestones, addToast, handleMilestoneDragEnd]);

  const handleMilestoneDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the element entirely
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setMilestoneDrag((prev) => ({
        ...prev,
        dropTargetId: null,
        dropPosition: null,
      }));
    }
  }, []);

  // Roadmap handlers
  const handleStartRoadmapEdit = useCallback((roadmap: Roadmap) => {
    selectRoadmap(roadmap.id);
    setRoadmapEdit({
      roadmapId: roadmap.id,
      field: "title",
      value: roadmap.title,
    });
  }, [selectRoadmap]);

  const handleCancelRoadmapEdit = useCallback(() => {
    setRoadmapEdit({ roadmapId: null, field: null, value: "" });
  }, []);

  const handleSaveRoadmapEdit = useCallback(
    async (updates: RoadmapUpdateInput) => {
      if (!roadmapEdit.roadmapId) return;
      try {
        await updateRoadmap(roadmapEdit.roadmapId, updates, {
          onError: (err) => addToast(err.message, "error"),
        });
        handleCancelRoadmapEdit();
      } catch {
        // Error handled in callback
      }
    },
    [roadmapEdit.roadmapId, updateRoadmap, handleCancelRoadmapEdit, addToast]
  );

  const handleDeleteRoadmap = useCallback(
    async (roadmapId: string) => {
      const shouldDelete = await confirm({
        title: "Delete Roadmap",
        message: "Delete this roadmap? This cannot be undone.",
        danger: true,
      });
      if (!shouldDelete) return;
      try {
        await deleteRoadmap(roadmapId, {
          onError: (err) => addToast(err.message, "error"),
        });
        addToast("Roadmap deleted", "success");
      } catch {
        // Error handled in callback
      }
    },
    [deleteRoadmap, addToast, confirm]
  );

  // Handoff handlers
  const handleOpenHandoffModal = useCallback((roadmapId: string, roadmapTitle: string) => {
    setHandoffRoadmapId(roadmapId);
    setHandoffRoadmapTitle(roadmapTitle);
    setHandoffModalOpen(true);
    // Clear any previous handoff data
    clearHandoff();
  }, [clearHandoff]);

  const handleCloseHandoffModal = useCallback(() => {
    setHandoffModalOpen(false);
    setHandoffRoadmapId(null);
    setHandoffRoadmapTitle("");
    clearHandoff();
  }, [clearHandoff]);

  const handleFetchHandoff = useCallback(() => {
    if (handoffRoadmapId) {
      fetchHandoff(handoffRoadmapId, {
        onError: (err) => addToast(`Failed to load handoff: ${err.message}`, "error"),
      });
    }
  }, [handoffRoadmapId, fetchHandoff, addToast]);

  const handleCopyHandoffToClipboard = useCallback(() => {
    if (handoffPayload) {
      const data = JSON.stringify(handoffPayload, null, 2);
      navigator.clipboard.writeText(data).then(() => {
        addToast("Handoff data copied to clipboard", "success");
      }).catch(() => {
        addToast("Failed to copy to clipboard", "error");
      });
    }
  }, [handoffPayload, addToast]);

  const handleCreateRoadmap = useCallback(
    async (input: RoadmapCreateInput) => {
      try {
        await createRoadmap(input, {
          onError: (err) => addToast(err.message, "error"),
        });
        setCreateForm({ type: null, parentId: undefined, title: "", description: "" });
        addToast("Roadmap created", "success");
      } catch {
        // Error handled in callback
      }
    },
    [createRoadmap, addToast]
  );

  // Milestone handlers
  const handleStartMilestoneEdit = useCallback((milestone: RoadmapMilestone) => {
    setMilestoneEdit({
      milestoneId: milestone.id,
      field: "title",
      value: milestone.title,
    });
  }, []);

  const handleCancelMilestoneEdit = useCallback(() => {
    setMilestoneEdit({ milestoneId: null, field: null, value: "" });
  }, []);

  const handleSaveMilestoneEdit = useCallback(
    async (updates: RoadmapMilestoneUpdateInput) => {
      if (!milestoneEdit.milestoneId) return;
      try {
        await updateMilestone(milestoneEdit.milestoneId, updates, {
          onError: (err) => addToast(err.message, "error"),
        });
        handleCancelMilestoneEdit();
      } catch {
        // Error handled in callback
      }
    },
    [milestoneEdit.milestoneId, updateMilestone, handleCancelMilestoneEdit, addToast]
  );

  const handleDeleteMilestone = useCallback(
    async (milestoneId: string) => {
      const shouldDelete = await confirm({
        title: "Delete Milestone",
        message: "Delete this milestone and all its features?",
        danger: true,
      });
      if (!shouldDelete) return;
      try {
        await deleteMilestone(milestoneId, {
          onError: (err) => addToast(err.message, "error"),
        });
        addToast("Milestone deleted", "success");
      } catch {
        // Error handled in callback
      }
    },
    [deleteMilestone, addToast, confirm]
  );

  const handleCreateMilestone = useCallback(
    async (input: RoadmapMilestoneCreateInput) => {
      try {
        await createMilestone(input, {
          onError: (err) => addToast(err.message, "error"),
        });
        setCreateForm({ type: null, parentId: undefined, title: "", description: "" });
        addToast("Milestone created", "success");
      } catch {
        // Error handled in callback
      }
    },
    [createMilestone, addToast]
  );

  // Feature handlers
  const handleStartFeatureEdit = useCallback(
    (featureId: string, currentTitle: string, _currentDescription?: string) => {
      setFeatureEdit({
        featureId,
        field: "title",
        value: currentTitle,
      });
    },
    []
  );

  const handleCancelFeatureEdit = useCallback(() => {
    setFeatureEdit({ featureId: null, field: null, value: "" });
  }, []);

  const handleSaveFeatureEdit = useCallback(
    async (updates: RoadmapFeatureUpdateInput) => {
      if (!featureEdit.featureId) return;
      try {
        await updateFeature(featureEdit.featureId, updates, {
          onError: (err) => addToast(err.message, "error"),
        });
        handleCancelFeatureEdit();
      } catch {
        // Error handled in callback
      }
    },
    [featureEdit.featureId, updateFeature, handleCancelFeatureEdit, addToast]
  );

  const handleDeleteFeature = useCallback(
    async (featureId: string) => {
      const shouldDelete = await confirm({
        title: "Delete Feature",
        message: "Delete this feature?",
        danger: true,
      });
      if (!shouldDelete) return;
      try {
        await deleteFeature(featureId, {
          onError: (err) => addToast(err.message, "error"),
        });
        addToast("Feature deleted", "success");
      } catch {
        // Error handled in callback
      }
    },
    [deleteFeature, addToast, confirm]
  );

  // Milestone suggestion handlers
  const handleGenerateSuggestions = useCallback(
    async () => {
      if (!goalPrompt.trim()) return;
      try {
        await generateMilestoneSuggestions(goalPrompt, 5, {
          onError: (err) => addToast(err.message, "error"),
        });
      } catch {
        // Error handled in callback
      }
    },
    [goalPrompt, generateMilestoneSuggestions, addToast]
  );

  const handleAcceptSuggestion = useCallback(
    async (draftId: string) => {
      try {
        await acceptMilestoneSuggestion(draftId, {
          onError: (err) => addToast(err.message, "error"),
        });
        addToast("Milestone added", "success");
      } catch {
        // Error handled in callback
      }
    },
    [acceptMilestoneSuggestion, addToast]
  );

  const handleAcceptAllSuggestions = useCallback(
    async () => {
      try {
        await acceptAllMilestoneSuggestions({
          onError: (err) => addToast(err.message, "error"),
        });
        addToast(`${milestoneSuggestions.length} milestones added`, "success");
        setGoalPrompt("");
      } catch {
        // Error handled in callback
      }
    },
    [acceptAllMilestoneSuggestions, milestoneSuggestions.length, addToast]
  );

  const handleClearSuggestions = useCallback(() => {
    clearMilestoneSuggestions();
    setGoalPrompt("");
  }, [clearMilestoneSuggestions]);

  // Feature suggestion handlers
  const handleGenerateFeatureSuggestions = useCallback(
    async (milestoneId: string) => {
      try {
        await generateFeatureSuggestions(milestoneId, { count: 5 }, {
          onError: (err) => addToast(err.message, "error"),
        });
      } catch {
        // Error handled in callback
      }
    },
    [generateFeatureSuggestions, addToast]
  );

  const handleAcceptFeatureSuggestion = useCallback(
    async (milestoneId: string, draftId: string) => {
      try {
        await acceptFeatureSuggestion(milestoneId, draftId, {
          onError: (err) => addToast(err.message, "error"),
        });
        addToast("Feature added", "success");
      } catch {
        // Error handled in callback
      }
    },
    [acceptFeatureSuggestion, addToast]
  );

  const handleUpdateFeatureSuggestionDraft = useCallback(
    (milestoneId: string, draftId: string, patch: SuggestionDraftPatch) => {
      updateFeatureSuggestionDraft(milestoneId, draftId, patch);
    },
    [updateFeatureSuggestionDraft]
  );

  const handleAcceptAllFeatureSuggestions = useCallback(
    async (milestoneId: string) => {
      const suggestions = featureSuggestionsByMilestoneId[milestoneId] || [];
      try {
        await acceptAllFeatureSuggestions(milestoneId, {
          onError: (err) => addToast(err.message, "error"),
        });
        addToast(`${suggestions.length} features added`, "success");
      } catch {
        // Error handled in callback
      }
    },
    [acceptAllFeatureSuggestions, featureSuggestionsByMilestoneId, addToast]
  );

  const handleClearFeatureSuggestions = useCallback(
    (milestoneId: string) => {
      clearFeatureSuggestions(milestoneId);
    },
    [clearFeatureSuggestions]
  );

  const handleCreateFeature = useCallback(
    async (milestoneId: string, input: RoadmapFeatureCreateInput) => {
      try {
        await createFeature(milestoneId, input, {
          onError: (err) => addToast(err.message, "error"),
        });
        setCreateForm({ type: null, parentId: undefined, title: "", description: "" });
        addToast("Feature created", "success");
      } catch {
        // Error handled in callback
      }
    },
    [createFeature, addToast]
  );

  // Get the currently selected roadmap ID (handles both desktop and mobile)
  const effectiveSelectedRoadmapId = selectedRoadmapId;

  if (loading && roadmaps.length === 0) {
    return (
      <div className="roadmaps-view roadmaps-view--loading">
        <div className="roadmaps-view__loading-state">Loading roadmaps...</div>
      </div>
    );
  }

  if (error && roadmaps.length === 0) {
    return (
      <div className="roadmaps-view roadmaps-view--error">
        <div className="roadmaps-view__error-state">
          <p>Failed to load roadmaps</p>
          <p className="roadmaps-view__error-msg">{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="roadmaps-view">
      {/* Mobile Roadmap List (shown when mobile and no roadmap selected) */}
      {isMobile && !effectiveSelectedRoadmapId && (
        <MobileRoadmapList
          roadmaps={roadmaps}
          selectedRoadmapId={effectiveSelectedRoadmapId}
          onSelect={(id) => selectRoadmap(id)}
          onCreate={() => setMobileShowCreateForm(true)}
          onEdit={handleStartRoadmapEdit}
          onDelete={handleDeleteRoadmap}
          onExport={(roadmap) => handleOpenHandoffModal(roadmap.id, roadmap.title)}
          showCreateForm={mobileShowCreateForm}
          onCancelCreate={() => setMobileShowCreateForm(false)}
          onSaveCreate={async (input) => {
            await handleCreateRoadmap(input);
            setMobileShowCreateForm(false);
          }}
        />
      )}

      {/* Desktop sidebar (hidden on mobile) */}
      {!isMobile && (
        <aside className="roadmaps-view__sidebar" aria-label="Roadmaps">
          <div className="roadmaps-view__sidebar-header">
            <h2 className="roadmaps-view__sidebar-title">Roadmaps</h2>
            <button
              className="roadmaps-view__add-btn"
              onClick={() => setCreateForm({ type: "roadmap", title: "", description: "" })}
              title="Create roadmap"
              aria-label="Create roadmap"
              data-testid="create-roadmap-btn"
            >
              <Plus size={16} />
            </button>
          </div>

          {createForm.type === "roadmap" && (
            <CreateRoadmapForm
              onSave={handleCreateRoadmap}
              onCancel={() => setCreateForm({ type: null, parentId: undefined, title: "", description: "" })}
            />
          )}

          <div className="roadmaps-view__sidebar-list">
            {roadmaps.length === 0 ? (
              <p className="roadmaps-view__empty-sidebar">No roadmaps yet. Click + to create one.</p>
            ) : (
              roadmaps.map((roadmap) => (
                <RoadmapItem
                  key={roadmap.id}
                  roadmap={roadmap}
                  isSelected={roadmap.id === effectiveSelectedRoadmapId}
                  onSelect={() => selectRoadmap(roadmap.id)}
                  onEdit={() => handleStartRoadmapEdit(roadmap)}
                  onDelete={() => handleDeleteRoadmap(roadmap.id)}
                  onExport={() => handleOpenHandoffModal(roadmap.id, roadmap.title)}
                />
              ))
            )}
          </div>
        </aside>
      )}

      {/* Main content */}
      <main className="roadmaps-view__main" aria-label="Roadmap content">
        {/* Mobile header when roadmap is selected */}
        {isMobile && effectiveSelectedRoadmapId && (
          <MobileRoadmapHeader
            roadmapTitle={selectedRoadmap?.title || "Untitled Roadmap"}
            onBack={() => selectRoadmap(null)}
            onEdit={() => {
              if (selectedRoadmap) handleStartRoadmapEdit(selectedRoadmap);
            }}
            onDelete={() => handleDeleteRoadmap(effectiveSelectedRoadmapId)}
            onCreate={() => setMobileShowCreateForm(true)}
          />
        )}

        {!effectiveSelectedRoadmapId ? (
          <div className="roadmaps-view__empty-main">
            <p>Select a roadmap from the sidebar to view its milestones.</p>
          </div>
        ) : (
          <>
            {/* Roadmap header */}
            <div className="roadmaps-view__roadmap-header">
              {roadmapEdit.roadmapId === effectiveSelectedRoadmapId ? (
                <div className="roadmaps-view__inline-edit">
                  <div className="roadmaps-view__inline-edit-row">
                    <input
                      type="text"
                      className="roadmaps-view__inline-input roadmaps-view__inline-input--large"
                      value={roadmapEdit.value}
                      onChange={(e) =>
                        setRoadmapEdit((prev) => ({ ...prev, value: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleSaveRoadmapEdit({ title: roadmapEdit.value });
                        } else if (e.key === "Escape") {
                          handleCancelRoadmapEdit();
                        }
                      }}
                      placeholder="Roadmap title"
                      autoFocus
                      data-testid="roadmap-title-input"
                    />
                    <button
                      className="roadmaps-view__icon-btn roadmaps-view__icon-btn--success"
                      onClick={() => handleSaveRoadmapEdit({ title: roadmapEdit.value })}
                      aria-label="Save"
                      title="Save"
                    >
                      <Check size={16} />
                    </button>
                    <button
                      className="roadmaps-view__icon-btn"
                      onClick={handleCancelRoadmapEdit}
                      aria-label="Cancel"
                      title="Cancel"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="roadmaps-view__roadmap-title-row">
                    <h1 className="roadmaps-view__roadmap-title">
                      {selectedRoadmap?.title || "Untitled Roadmap"}
                    </h1>
                    <div className="roadmaps-view__roadmap-actions">
                      <button
                        className="roadmaps-view__icon-btn"
                        onClick={() => {
                          if (selectedRoadmap) handleStartRoadmapEdit(selectedRoadmap);
                        }}
                        title="Edit roadmap"
                        aria-label="Edit roadmap"
                        data-testid="edit-roadmap-btn"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="roadmaps-view__icon-btn roadmaps-view__icon-btn--danger"
                        onClick={() => handleDeleteRoadmap(effectiveSelectedRoadmapId)}
                        title="Delete roadmap"
                        aria-label="Delete roadmap"
                        data-testid="delete-roadmap-btn"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                  {selectedRoadmap?.description && (
                    <p className="roadmaps-view__roadmap-desc">{selectedRoadmap.description}</p>
                  )}
                </>
              )}
            </div>

            {/* Milestone Suggestions Section */}
            {isMobile ? (
              showSuggestionPanel ? (
                <div className="roadmap-suggestion-section">
                  <div className="roadmap-suggestion-header">
                    <h3 className="roadmap-suggestion-title">Generate Milestone Ideas</h3>
                    <button
                      className="roadmap-suggestion-collapse-btn"
                      onClick={() => setShowSuggestionPanel(false)}
                      aria-label="Collapse suggestion panel"
                      data-testid="collapse-suggestion-panel-btn"
                    >
                      <ChevronUp size={16} />
                    </button>
                  </div>
                  <div className="roadmap-suggestion-form">
                    <textarea
                      className="roadmap-suggestion-input"
                      value={goalPrompt}
                      onChange={(e) => setGoalPrompt(e.target.value)}
                      placeholder="Describe your roadmap goal (e.g., 'Build a user authentication system with OAuth, profiles, and admin dashboard')"
                      rows={2}
                      disabled={isGeneratingSuggestions || !selectedRoadmapId}
                      data-testid="goal-prompt-input"
                      autoFocus
                    />
                    <div className="roadmap-suggestion-actions">
                      <button
                        className="roadmap-suggestion-generate-btn"
                        onClick={handleGenerateSuggestions}
                        disabled={!goalPrompt.trim() || isGeneratingSuggestions || !selectedRoadmapId}
                        data-testid="generate-suggestions-btn"
                      >
                        {isGeneratingSuggestions ? "Generating..." : "Generate Milestones"}
                      </button>
                      {milestoneSuggestions.length > 0 && (
                        <>
                          <button
                            className="roadmap-suggestion-accept-all-btn"
                            onClick={handleAcceptAllSuggestions}
                            data-testid="accept-all-suggestions-btn"
                          >
                            Accept All ({milestoneSuggestions.length})
                          </button>
                          <button
                            className="roadmap-suggestion-clear-btn"
                            onClick={handleClearSuggestions}
                            title="Clear suggestions"
                            aria-label="Clear suggestions"
                            data-testid="clear-suggestions-btn"
                          >
                            <X size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Suggestion Cards */}
                  {milestoneSuggestions.length > 0 && (
                    <div className="roadmap-suggestion-list">
                      {milestoneSuggestions.map((suggestion) => (
                        <MilestoneSuggestionCard
                          key={suggestion.id}
                          suggestion={suggestion}
                          onUpdateDraft={(patch) => updateMilestoneSuggestionDraft(suggestion.id, patch)}
                          onAccept={() => handleAcceptSuggestion(suggestion.id)}
                          testIdPrefix="suggestion"
                        />
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="roadmap-suggestion-section">
                  <button
                    className="roadmap-suggestion-expand-btn"
                    onClick={() => setShowSuggestionPanel(true)}
                    disabled={!selectedRoadmapId}
                    data-testid="expand-suggestion-panel-btn"
                  >
                    <Sparkles size={16} />
                    Generate Milestone Ideas
                  </button>
                </div>
              )
            ) : (
              <div className="roadmap-suggestion-section">
                <div className="roadmap-suggestion-header">
                  <h3 className="roadmap-suggestion-title">Generate Milestone Ideas</h3>
                </div>
                <div className="roadmap-suggestion-form">
                  <textarea
                    className="roadmap-suggestion-input"
                    value={goalPrompt}
                    onChange={(e) => setGoalPrompt(e.target.value)}
                    placeholder="Describe your roadmap goal (e.g., 'Build a user authentication system with OAuth, profiles, and admin dashboard')"
                    rows={2}
                    disabled={isGeneratingSuggestions || !selectedRoadmapId}
                    data-testid="goal-prompt-input"
                  />
                  <div className="roadmap-suggestion-actions">
                    <button
                      className="roadmap-suggestion-generate-btn"
                      onClick={handleGenerateSuggestions}
                      disabled={!goalPrompt.trim() || isGeneratingSuggestions || !selectedRoadmapId}
                      data-testid="generate-suggestions-btn"
                    >
                      {isGeneratingSuggestions ? "Generating..." : "Generate Milestones"}
                    </button>
                    {milestoneSuggestions.length > 0 && (
                      <>
                        <button
                          className="roadmap-suggestion-accept-all-btn"
                          onClick={handleAcceptAllSuggestions}
                          data-testid="accept-all-suggestions-btn"
                        >
                          Accept All ({milestoneSuggestions.length})
                        </button>
                        <button
                          className="roadmap-suggestion-clear-btn"
                          onClick={handleClearSuggestions}
                          title="Clear suggestions"
                          aria-label="Clear suggestions"
                          data-testid="clear-suggestions-btn"
                        >
                          <X size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Suggestion Cards */}
                {milestoneSuggestions.length > 0 && (
                  <div className="roadmap-suggestion-list">
                    {milestoneSuggestions.map((suggestion) => (
                      <MilestoneSuggestionCard
                        key={suggestion.id}
                        suggestion={suggestion}
                        onUpdateDraft={(patch) => updateMilestoneSuggestionDraft(suggestion.id, patch)}
                        onAccept={() => handleAcceptSuggestion(suggestion.id)}
                        testIdPrefix="suggestion"
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Milestone lanes */}
            <div className="roadmaps-view__milestone-lanes">
              {createForm.type === "milestone" && (
                <CreateMilestoneForm
                  onSave={handleCreateMilestone}
                  onCancel={() => setCreateForm({ type: null, parentId: undefined, title: "", description: "" })}
                />
              )}

              {milestones.length === 0 && createForm.type !== "milestone" ? (
                <div className="roadmaps-view__empty-milestones">
                  <p>This roadmap has no milestones.</p>
                  <button
                    className="roadmaps-view__add-milestone-btn"
                    onClick={() => setCreateForm({ type: "milestone", title: "", description: "" })}
                    data-testid="add-milestone-btn-empty"
                  >
                    <Plus size={14} />
                    <span>Add Milestone</span>
                  </button>
                </div>
              ) : (
                <>
                  {createForm.type !== "milestone" && (
                    <button
                      className="roadmaps-view__add-milestone-fab"
                      onClick={() => setCreateForm({ type: "milestone", title: "", description: "" })}
                      data-testid="add-milestone-btn"
                    >
                      <Plus size={14} />
                      <span>Add Milestone</span>
                    </button>
                  )}
                  {milestones.map((milestone) => (
                    <MilestoneCard
                      key={milestone.id}
                      milestone={milestone}
                      features={featuresByMilestoneId[milestone.id] || []}
                      onEditMilestone={() => handleStartMilestoneEdit(milestone)}
                      onDeleteMilestone={() => handleDeleteMilestone(milestone.id)}
                      onAddFeature={() => setCreateForm({ type: "feature", parentId: milestone.id, title: "", description: "" })}
                      onEditFeature={(featureId) => {
                        const feature = featuresByMilestoneId[milestone.id]?.find((f) => f.id === featureId);
                        if (feature) {
                          handleStartFeatureEdit(featureId, feature.title, feature.description);
                        }
                      }}
                      onDeleteFeature={handleDeleteFeature}
                      milestoneEdit={milestoneEdit}
                      onStartMilestoneEdit={() => handleStartMilestoneEdit(milestone)}
                      onCancelMilestoneEdit={handleCancelMilestoneEdit}
                      onSaveMilestoneEdit={handleSaveMilestoneEdit}
                      featureEdit={featureEdit}
                      onStartFeatureEdit={handleStartFeatureEdit}
                      onCancelFeatureEdit={handleCancelFeatureEdit}
                      onSaveFeatureEdit={handleSaveFeatureEdit}
                      projectId={projectId}
                      addToast={addToast}
                      // Milestone drag-and-drop props
                      isMilestoneDragging={milestoneDrag.draggingId === milestone.id}
                      isMilestoneDropTarget={milestoneDrag.dropTargetId === milestone.id}
                      milestoneDropPosition={milestoneDrag.dropTargetId === milestone.id ? milestoneDrag.dropPosition : null}
                      onMilestoneDragStart={handleMilestoneDragStart}
                      onMilestoneDragEnd={handleMilestoneDragEnd}
                      onMilestoneDragOver={handleMilestoneDragOver}
                      onMilestoneDrop={handleMilestoneDrop}
                      onMilestoneDragLeave={handleMilestoneDragLeave}
                      // Feature drag-and-drop props
                      isFeatureDragging={isFeatureDragging}
                      isFeatureDropTarget={featureDrag.dropTargetMilestoneId === milestone.id}
                      featureDropIndex={featureDrag.dropTargetMilestoneId === milestone.id ? featureDrag.dropTargetIndex : null}
                      onFeatureDragStart={handleFeatureDragStart}
                      onFeatureDragEnd={handleFeatureDragEnd}
                      onFeatureDragOver={handleFeatureDragOver}
                      onFeatureDrop={handleFeatureDrop}
                      onFeatureDragLeave={handleFeatureDragLeave}
                      onFeatureDropOnMilestone={handleFeatureDropOnMilestone}
                      // Feature suggestion props
                      featureSuggestions={featureSuggestionsByMilestoneId[milestone.id]}
                      isGeneratingFeatureSuggestions={isGeneratingFeatureSuggestions(milestone.id)}
                      onGenerateFeatureSuggestions={() => handleGenerateFeatureSuggestions(milestone.id)}
                      onAcceptFeatureSuggestion={(index) => handleAcceptFeatureSuggestion(milestone.id, index)}
                      onAcceptAllFeatureSuggestions={() => handleAcceptAllFeatureSuggestions(milestone.id)}
                      onUpdateFeatureSuggestionDraft={(milestoneId, draftId, patch) => handleUpdateFeatureSuggestionDraft(milestoneId, draftId, patch)}
                      onClearFeatureSuggestions={() => handleClearFeatureSuggestions(milestone.id)}
                    />
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </main>

      {/* Feature create form overlay */}
      {createForm.type === "feature" && createForm.parentId && (
        <div className="roadmaps-view__feature-create-overlay">
          <CreateFeatureForm
            onSave={(input) => handleCreateFeature(createForm.parentId!, input)}
            onCancel={() => setCreateForm({ type: null, parentId: undefined, title: "", description: "" })}
          />
        </div>
      )}

      {/* Handoff export modal */}
      <HandoffModal
        isOpen={handoffModalOpen}
        onClose={handleCloseHandoffModal}
        roadmapId={handoffRoadmapId || ""}
        roadmapTitle={handoffRoadmapTitle}
        handoffPayload={handoffPayload}
        isLoading={isFetchingHandoff}
        error={handoffError}
        onFetchHandoff={handleFetchHandoff}
        onCopyToClipboard={handleCopyHandoffToClipboard}
      />
    </div>
  );
}
