import { useState, useEffect, useCallback } from "react";
import {
  X,
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  Target,
  Layers,
  Package,
  Box,
  Check,
  Loader2,
  Link,
  Unlink,
  Play,
} from "lucide-react";
import type {
  Mission,
  MissionWithHierarchy,
  Milestone,
  Slice,
  MissionFeature,
  MissionStatus,
  MilestoneStatus,
  SliceStatus,
  FeatureStatus,
  MilestoneWithSlices,
  SliceWithFeatures,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import {
  fetchMissions,
  createMission,
  fetchMission,
  updateMission,
  deleteMission,
  createMilestone,
  updateMilestone,
  deleteMilestone,
  createSlice,
  updateSlice,
  deleteSlice,
  activateSlice,
  createFeature,
  updateFeature,
  deleteFeature,
  linkFeatureToTask,
  unlinkFeatureFromTask,
} from "../api";

interface MissionManagerProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  onSelectTask?: (taskId: string) => void;
  availableTasks?: Array<{ id: string; title?: string }>;
}

// Status badge colors
const missionStatusColors: Record<MissionStatus, { bg: string; text: string }> = {
  planning: { bg: "rgba(234, 179, 8, 0.15)", text: "#eab308" },
  active: { bg: "rgba(34, 197, 94, 0.15)", text: "#22c55e" },
  blocked: { bg: "rgba(239, 68, 68, 0.15)", text: "#ef4444" },
  complete: { bg: "rgba(59, 130, 246, 0.15)", text: "#3b82f6" },
  archived: { bg: "var(--bg-tertiary)", text: "var(--text-secondary)" },
};

const milestoneStatusColors: Record<MilestoneStatus, { bg: string; text: string }> = {
  planning: { bg: "rgba(234, 179, 8, 0.15)", text: "#eab308" },
  active: { bg: "rgba(34, 197, 94, 0.15)", text: "#22c55e" },
  blocked: { bg: "rgba(239, 68, 68, 0.15)", text: "#ef4444" },
  complete: { bg: "rgba(59, 130, 246, 0.15)", text: "#3b82f6" },
};

const sliceStatusColors: Record<SliceStatus, { bg: string; text: string }> = {
  pending: { bg: "rgba(234, 179, 8, 0.15)", text: "#eab308" },
  active: { bg: "rgba(34, 197, 94, 0.15)", text: "#22c55e" },
  complete: { bg: "rgba(59, 130, 246, 0.15)", text: "#3b82f6" },
};

const featureStatusColors: Record<FeatureStatus, { bg: string; text: string }> = {
  defined: { bg: "rgba(234, 179, 8, 0.15)", text: "#eab308" },
  triaged: { bg: "rgba(168, 85, 247, 0.15)", text: "#a855f7" },
  "in-progress": { bg: "rgba(34, 197, 94, 0.15)", text: "#22c55e" },
  done: { bg: "rgba(59, 130, 246, 0.15)", text: "#3b82f6" },
};

// Form types
interface MissionFormData {
  title: string;
  description: string;
  status: MissionStatus;
  autoAdvance: boolean;
}

interface MilestoneFormData {
  title: string;
  description: string;
  status: MilestoneStatus;
  dependencies: string[];
}

interface SliceFormData {
  title: string;
  description: string;
  status: SliceStatus;
}

interface FeatureFormData {
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: FeatureStatus;
}

const EMPTY_MISSION_FORM: MissionFormData = {
  title: "",
  description: "",
  status: "planning",
  autoAdvance: true,
};

const EMPTY_MILESTONE_FORM: MilestoneFormData = {
  title: "",
  description: "",
  status: "planning",
  dependencies: [],
};

const EMPTY_SLICE_FORM: SliceFormData = {
  title: "",
  description: "",
  status: "pending",
};

const EMPTY_FEATURE_FORM: FeatureFormData = {
  title: "",
  description: "",
  acceptanceCriteria: "",
  status: "defined",
};

export function MissionManager({ isOpen, onClose, addToast, onSelectTask, availableTasks = [] }: MissionManagerProps) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selectedMission, setSelectedMission] = useState<MissionWithHierarchy | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  // Form states
  const [isCreatingMission, setIsCreatingMission] = useState(false);
  const [editingMissionId, setEditingMissionId] = useState<string | null>(null);
  const [missionForm, setMissionForm] = useState<MissionFormData>(EMPTY_MISSION_FORM);
  const [saving, setSaving] = useState(false);

  const [expandedMilestones, setExpandedMilestones] = useState<Set<string>>(new Set());
  const [expandedSlices, setExpandedSlices] = useState<Set<string>>(new Set());

  // Editing states for nested items
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);
  const [milestoneForm, setMilestoneForm] = useState<MilestoneFormData>(EMPTY_MILESTONE_FORM);
  const [isCreatingMilestone, setIsCreatingMilestone] = useState(false);

  const [editingSliceId, setEditingSliceId] = useState<string | null>(null);
  const [sliceForm, setSliceForm] = useState<SliceFormData>(EMPTY_SLICE_FORM);
  const [isCreatingSlice, setIsCreatingSlice] = useState(false);
  const [selectedMilestoneIdForNewSlice, setSelectedMilestoneIdForNewSlice] = useState<string | null>(null);

  const [editingFeatureId, setEditingFeatureId] = useState<string | null>(null);
  const [featureForm, setFeatureForm] = useState<FeatureFormData>(EMPTY_FEATURE_FORM);
  const [isCreatingFeature, setIsCreatingFeature] = useState(false);
  const [selectedSliceIdForNewFeature, setSelectedSliceIdForNewFeature] = useState<string | null>(null);

  // Link task modal state
  const [linkTaskFeatureId, setLinkTaskFeatureId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("");

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<{ type: string; id: string } | null>(null);

  const loadMissions = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchMissions();
      setMissions(data);
    } catch (err: any) {
      addToast(err.message || "Failed to load missions", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const loadMissionDetail = useCallback(async (missionId: string) => {
    try {
      setDetailLoading(true);
      const data = await fetchMission(missionId);
      setSelectedMission(data);
      // Auto-expand first milestone and slice
      if (data.milestones.length > 0) {
        setExpandedMilestones(new Set([data.milestones[0].id]));
        if (data.milestones[0].slices.length > 0) {
          setExpandedSlices(new Set([data.milestones[0].slices[0].id]));
        }
      }
    } catch (err: any) {
      addToast(err.message || "Failed to load mission details", "error");
    } finally {
      setDetailLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    if (isOpen) {
      loadMissions();
      setSelectedMission(null);
    }
  }, [isOpen, loadMissions]);

  // Mission handlers
  const handleCreateMission = useCallback(() => {
    setIsCreatingMission(true);
    setEditingMissionId(null);
    setMissionForm(EMPTY_MISSION_FORM);
  }, []);

  const handleEditMission = useCallback((mission: Mission) => {
    setEditingMissionId(mission.id);
    setIsCreatingMission(false);
    setMissionForm({
      title: mission.title,
      description: mission.description || "",
      status: mission.status,
      autoAdvance: mission.autoAdvance ?? true,
    });
  }, []);

  const handleCancelMission = useCallback(() => {
    setEditingMissionId(null);
    setIsCreatingMission(false);
    setMissionForm(EMPTY_MISSION_FORM);
  }, []);

  const handleSaveMission = useCallback(async () => {
    if (!missionForm.title.trim()) {
      addToast("Mission title is required", "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingMission) {
        await createMission({
          title: missionForm.title.trim(),
          description: missionForm.description.trim() || undefined,
        });
        addToast("Mission created", "success");
      } else if (editingMissionId) {
        await updateMission(editingMissionId, {
          title: missionForm.title.trim(),
          description: missionForm.description.trim() || undefined,
          status: missionForm.status,
          autoAdvance: missionForm.autoAdvance,
        });
        addToast("Mission updated", "success");
        // Refresh detail view if viewing this mission
        if (selectedMission?.id === editingMissionId) {
          await loadMissionDetail(editingMissionId);
        }
      }
      await loadMissions();
      handleCancelMission();
    } catch (err: any) {
      addToast(err.message || "Failed to save mission", "error");
    } finally {
      setSaving(false);
    }
  }, [missionForm, isCreatingMission, editingMissionId, addToast, loadMissions, loadMissionDetail, selectedMission, handleCancelMission]);

  const handleDeleteMission = useCallback(async (missionId: string) => {
    try {
      await deleteMission(missionId);
      addToast("Mission deleted", "success");
      if (selectedMission?.id === missionId) {
        setSelectedMission(null);
      }
      await loadMissions();
      setDeleteConfirmId(null);
    } catch (err: any) {
      addToast(err.message || "Failed to delete mission", "error");
    }
  }, [addToast, loadMissions, selectedMission]);

  // Milestone handlers
  const handleCreateMilestone = useCallback(() => {
    setIsCreatingMilestone(true);
    setEditingMilestoneId(null);
    setMilestoneForm(EMPTY_MILESTONE_FORM);
  }, []);

  const handleEditMilestone = useCallback((milestone: Milestone) => {
    setEditingMilestoneId(milestone.id);
    setIsCreatingMilestone(false);
    setMilestoneForm({
      title: milestone.title,
      description: milestone.description || "",
      status: milestone.status,
      dependencies: milestone.dependencies,
    });
  }, []);

  const handleCancelMilestone = useCallback(() => {
    setEditingMilestoneId(null);
    setIsCreatingMilestone(false);
    setMilestoneForm(EMPTY_MILESTONE_FORM);
  }, []);

  const handleSaveMilestone = useCallback(async () => {
    if (!milestoneForm.title.trim()) {
      addToast("Milestone title is required", "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingMilestone && selectedMission) {
        await createMilestone(selectedMission.id, {
          title: milestoneForm.title.trim(),
          description: milestoneForm.description.trim() || undefined,
          dependencies: milestoneForm.dependencies,
        });
        addToast("Milestone created", "success");
      } else if (editingMilestoneId) {
        await updateMilestone(editingMilestoneId, {
          title: milestoneForm.title.trim(),
          description: milestoneForm.description.trim() || undefined,
          status: milestoneForm.status,
          dependencies: milestoneForm.dependencies,
        });
        addToast("Milestone updated", "success");
      }
      await loadMissionDetail(selectedMission!.id);
      handleCancelMilestone();
    } catch (err: any) {
      addToast(err.message || "Failed to save milestone", "error");
    } finally {
      setSaving(false);
    }
  }, [milestoneForm, isCreatingMilestone, editingMilestoneId, selectedMission, addToast, loadMissionDetail, handleCancelMilestone, missionForm.title]);

  const handleDeleteMilestone = useCallback(async (milestoneId: string) => {
    try {
      await deleteMilestone(milestoneId);
      addToast("Milestone deleted", "success");
      await loadMissionDetail(selectedMission!.id);
      setDeleteConfirmId(null);
    } catch (err: any) {
      addToast(err.message || "Failed to delete milestone", "error");
    }
  }, [addToast, loadMissionDetail, selectedMission]);

  const toggleMilestoneExpanded = useCallback((milestoneId: string) => {
    setExpandedMilestones((prev) => {
      const next = new Set(prev);
      if (next.has(milestoneId)) {
        next.delete(milestoneId);
      } else {
        next.add(milestoneId);
      }
      return next;
    });
  }, []);

  // Slice handlers
  const handleCreateSlice = useCallback((milestoneId: string) => {
    setSelectedMilestoneIdForNewSlice(milestoneId);
    setIsCreatingSlice(true);
    setEditingSliceId(null);
    setSliceForm(EMPTY_SLICE_FORM);
  }, []);

  const handleEditSlice = useCallback((slice: Slice) => {
    setEditingSliceId(slice.id);
    setIsCreatingSlice(false);
    setSliceForm({
      title: slice.title,
      description: slice.description || "",
      status: slice.status,
    });
  }, []);

  const handleCancelSlice = useCallback(() => {
    setEditingSliceId(null);
    setIsCreatingSlice(false);
    setSelectedMilestoneIdForNewSlice(null);
    setSliceForm(EMPTY_SLICE_FORM);
  }, []);

  const handleSaveSlice = useCallback(async () => {
    if (!sliceForm.title.trim()) {
      addToast("Slice title is required", "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingSlice && selectedMilestoneIdForNewSlice) {
        await createSlice(selectedMilestoneIdForNewSlice, {
          title: sliceForm.title.trim(),
          description: sliceForm.description.trim() || undefined,
        });
        addToast("Slice created", "success");
      } else if (editingSliceId) {
        await updateSlice(editingSliceId, {
          title: sliceForm.title.trim(),
          description: sliceForm.description.trim() || undefined,
          status: sliceForm.status,
        });
        addToast("Slice updated", "success");
      }
      await loadMissionDetail(selectedMission!.id);
      handleCancelSlice();
    } catch (err: any) {
      addToast(err.message || "Failed to save slice", "error");
    } finally {
      setSaving(false);
    }
  }, [sliceForm, isCreatingSlice, editingSliceId, selectedMilestoneIdForNewSlice, selectedMission, addToast, loadMissionDetail, handleCancelSlice]);

  const handleDeleteSlice = useCallback(async (sliceId: string) => {
    try {
      await deleteSlice(sliceId);
      addToast("Slice deleted", "success");
      await loadMissionDetail(selectedMission!.id);
      setDeleteConfirmId(null);
    } catch (err: any) {
      addToast(err.message || "Failed to delete slice", "error");
    }
  }, [addToast, loadMissionDetail, selectedMission]);

  const handleActivateSlice = useCallback(async (sliceId: string) => {
    try {
      await activateSlice(sliceId);
      addToast("Slice activated", "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err: any) {
      addToast(err.message || "Failed to activate slice", "error");
    }
  }, [addToast, loadMissionDetail, selectedMission]);

  const toggleSliceExpanded = useCallback((sliceId: string) => {
    setExpandedSlices((prev) => {
      const next = new Set(prev);
      if (next.has(sliceId)) {
        next.delete(sliceId);
      } else {
        next.add(sliceId);
      }
      return next;
    });
  }, []);

  // Feature handlers
  const handleCreateFeature = useCallback((sliceId: string) => {
    setSelectedSliceIdForNewFeature(sliceId);
    setIsCreatingFeature(true);
    setEditingFeatureId(null);
    setFeatureForm(EMPTY_FEATURE_FORM);
  }, []);

  const handleEditFeature = useCallback((feature: MissionFeature) => {
    setEditingFeatureId(feature.id);
    setIsCreatingFeature(false);
    setFeatureForm({
      title: feature.title,
      description: feature.description || "",
      acceptanceCriteria: feature.acceptanceCriteria || "",
      status: feature.status,
    });
  }, []);

  const handleCancelFeature = useCallback(() => {
    setEditingFeatureId(null);
    setIsCreatingFeature(false);
    setSelectedSliceIdForNewFeature(null);
    setFeatureForm(EMPTY_FEATURE_FORM);
  }, []);

  const handleSaveFeature = useCallback(async () => {
    if (!featureForm.title.trim()) {
      addToast("Feature title is required", "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingFeature && selectedSliceIdForNewFeature) {
        await createFeature(selectedSliceIdForNewFeature, {
          title: featureForm.title.trim(),
          description: featureForm.description.trim() || undefined,
          acceptanceCriteria: featureForm.acceptanceCriteria.trim() || undefined,
        });
        addToast("Feature created", "success");
      } else if (editingFeatureId) {
        await updateFeature(editingFeatureId, {
          title: featureForm.title.trim(),
          description: featureForm.description.trim() || undefined,
          acceptanceCriteria: featureForm.acceptanceCriteria.trim() || undefined,
          status: featureForm.status,
        });
        addToast("Feature updated", "success");
      }
      await loadMissionDetail(selectedMission!.id);
      handleCancelFeature();
    } catch (err: any) {
      addToast(err.message || "Failed to save feature", "error");
    } finally {
      setSaving(false);
    }
  }, [featureForm, isCreatingFeature, editingFeatureId, selectedSliceIdForNewFeature, selectedMission, addToast, loadMissionDetail, handleCancelFeature]);

  const handleDeleteFeature = useCallback(async (featureId: string) => {
    try {
      await deleteFeature(featureId);
      addToast("Feature deleted", "success");
      await loadMissionDetail(selectedMission!.id);
      setDeleteConfirmId(null);
    } catch (err: any) {
      addToast(err.message || "Failed to delete feature", "error");
    }
  }, [addToast, loadMissionDetail, selectedMission]);

  const handleLinkTask = useCallback(async () => {
    if (!linkTaskFeatureId || !selectedTaskId.trim()) {
      addToast("Task ID is required", "error");
      return;
    }

    try {
      await linkFeatureToTask(linkTaskFeatureId, selectedTaskId.trim());
      addToast("Feature linked to task", "success");
      await loadMissionDetail(selectedMission!.id);
      setLinkTaskFeatureId(null);
      setSelectedTaskId("");
    } catch (err: any) {
      addToast(err.message || "Failed to link feature to task", "error");
    }
  }, [linkTaskFeatureId, selectedTaskId, addToast, loadMissionDetail, selectedMission]);

  const handleUnlinkTask = useCallback(async (featureId: string) => {
    try {
      await unlinkFeatureFromTask(featureId);
      addToast("Feature unlinked from task", "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err: any) {
      addToast(err.message || "Failed to unlink feature", "error");
    }
  }, [addToast, loadMissionDetail, selectedMission]);

  const handleSelectMission = useCallback((mission: Mission) => {
    loadMissionDetail(mission.id);
  }, [loadMissionDetail]);

  const handleBackToList = useCallback(() => {
    setSelectedMission(null);
    loadMissions();
  }, [loadMissions]);

  // Keyboard handler for mission form
  const handleMissionFormKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveMission();
    }
  }, [handleSaveMission]);

  const handleMilestoneFormKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveMilestone();
    }
  }, [handleSaveMilestone]);

  const handleSliceFormKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveSlice();
    }
  }, [handleSaveSlice]);

  const handleFeatureFormKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveFeature();
    }
  }, [handleSaveFeature]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-content mission-manager-modal">
        <div className="modal-header">
          <div className="modal-title-row">
            {selectedMission ? (
              <button className="icon-btn" onClick={handleBackToList} title="Back to missions">
                <ChevronLeft size={20} />
              </button>
            ) : null}
            <h2>
              <Target size={20} />
              Missions
            </h2>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={20} />
          </button>
        </div>

        <div className="modal-body mission-manager-body">
          {loading ? (
            <div className="loading-state">
              <Loader2 size={24} className="spinner" />
              <span>Loading missions...</span>
            </div>
          ) : detailLoading ? (
            <div className="loading-state">
              <Loader2 size={24} className="spinner" />
              <span>Loading mission details...</span>
            </div>
          ) : selectedMission ? (
            // Mission detail view
            <div className="mission-detail-view">
              <div className="mission-detail-header">
                <div className="mission-detail-title">
                  <h3>{selectedMission.title}</h3>
                  <span
                    className="status-badge"
                    style={{
                      backgroundColor: missionStatusColors[selectedMission.status].bg,
                      color: missionStatusColors[selectedMission.status].text,
                    }}
                  >
                    {selectedMission.status}
                  </span>
                </div>
                {selectedMission.description && (
                  <p className="mission-description">{selectedMission.description}</p>
                )}
                <div className="mission-meta">
                  {selectedMission.autoAdvance && (
                    <span className="meta-badge">
                      <Play size={12} /> Auto-advance
                    </span>
                  )}
                  <span className="meta-info">
                    {selectedMission.milestones.length} milestones
                  </span>
                </div>
              </div>

              <div className="milestone-list">
                {selectedMission.milestones.map((milestone) => (
                  <div key={milestone.id} className="milestone-item">
                    <div className="milestone-header" onClick={() => toggleMilestoneExpanded(milestone.id)}>
                      <button className="expand-btn">
                        {expandedMilestones.has(milestone.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                      <Layers size={16} />
                      <span className="milestone-title">{milestone.title}</span>
                      <span
                        className="status-badge small"
                        style={{
                          backgroundColor: milestoneStatusColors[milestone.status].bg,
                          color: milestoneStatusColors[milestone.status].text,
                        }}
                      >
                        {milestone.status}
                      </span>
                      <span className="item-count">{milestone.slices.length} slices</span>
                      <div className="item-actions">
                        <button
                          className="icon-btn small"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCreateSlice(milestone.id);
                          }}
                          title="Add slice"
                        >
                          <Plus size={14} />
                        </button>
                        <button
                          className="icon-btn small"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditMilestone(milestone);
                          }}
                          title="Edit milestone"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon-btn small danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirmId({ type: "milestone", id: milestone.id });
                          }}
                          title="Delete milestone"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {expandedMilestones.has(milestone.id) && (
                      <div className="milestone-content">
                        {/* Create milestone form */}
                        {(isCreatingMilestone || editingMilestoneId === milestone.id) && (
                          <div className="inline-form">
                            <input
                              type="text"
                              placeholder="Milestone title"
                              value={milestoneForm.title}
                              onChange={(e) => setMilestoneForm({ ...milestoneForm, title: e.target.value })}
                              onKeyDown={handleMilestoneFormKeyDown}
                              autoFocus
                            />
                            <textarea
                              placeholder="Description (optional)"
                              value={milestoneForm.description}
                              onChange={(e) => setMilestoneForm({ ...milestoneForm, description: e.target.value })}
                              rows={2}
                            />
                            <div className="form-actions">
                              <button className="btn btn-primary" onClick={handleSaveMilestone} disabled={saving}>
                                {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                {editingMilestoneId ? "Update" : "Create"}
                              </button>
                              <button className="btn btn-ghost" onClick={handleCancelMilestone}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Slices */}
                        <div className="slice-list">
                          {milestone.slices.map((slice) => (
                            <div key={slice.id} className="slice-item">
                              <div className="slice-header" onClick={() => toggleSliceExpanded(slice.id)}>
                                <button className="expand-btn">
                                  {expandedSlices.has(slice.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                </button>
                                <Package size={16} />
                                <span className="slice-title">{slice.title}</span>
                                <span
                                  className="status-badge small"
                                  style={{
                                    backgroundColor: sliceStatusColors[slice.status].bg,
                                    color: sliceStatusColors[slice.status].text,
                                  }}
                                >
                                  {slice.status}
                                </span>
                                <span className="item-count">{slice.features?.length || 0} features</span>
                                <div className="item-actions">
                                  {slice.status === "pending" && (
                                    <button
                                      className="icon-btn small success"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleActivateSlice(slice.id);
                                      }}
                                      title="Activate slice"
                                    >
                                      <Play size={14} />
                                    </button>
                                  )}
                                  <button
                                    className="icon-btn small"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCreateFeature(slice.id);
                                    }}
                                    title="Add feature"
                                  >
                                    <Plus size={14} />
                                  </button>
                                  <button
                                    className="icon-btn small"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleEditSlice(slice);
                                    }}
                                    title="Edit slice"
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  <button
                                    className="icon-btn small danger"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDeleteConfirmId({ type: "slice", id: slice.id });
                                    }}
                                    title="Delete slice"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>

                              {expandedSlices.has(slice.id) && (
                                <div className="slice-content">
                                  {/* Create slice form */}
                                  {(isCreatingSlice && selectedMilestoneIdForNewSlice === milestone.id && !editingSliceId) && (
                                    <div className="inline-form">
                                      <input
                                        type="text"
                                        placeholder="Slice title"
                                        value={sliceForm.title}
                                        onChange={(e) => setSliceForm({ ...sliceForm, title: e.target.value })}
                                        onKeyDown={handleSliceFormKeyDown}
                                        autoFocus
                                      />
                                      <textarea
                                        placeholder="Description (optional)"
                                        value={sliceForm.description}
                                        onChange={(e) => setSliceForm({ ...sliceForm, description: e.target.value })}
                                        rows={2}
                                      />
                                      <div className="form-actions">
                                        <button className="btn btn-primary" onClick={handleSaveSlice} disabled={saving}>
                                          {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                          Create
                                        </button>
                                        <button className="btn btn-ghost" onClick={handleCancelSlice}>
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* Edit slice form */}
                                  {editingSliceId === slice.id && (
                                    <div className="inline-form">
                                      <input
                                        type="text"
                                        placeholder="Slice title"
                                        value={sliceForm.title}
                                        onChange={(e) => setSliceForm({ ...sliceForm, title: e.target.value })}
                                        onKeyDown={handleSliceFormKeyDown}
                                        autoFocus
                                      />
                                      <textarea
                                        placeholder="Description (optional)"
                                        value={sliceForm.description}
                                        onChange={(e) => setSliceForm({ ...sliceForm, description: e.target.value })}
                                        rows={2}
                                      />
                                      <select
                                        value={sliceForm.status}
                                        onChange={(e) => setSliceForm({ ...sliceForm, status: e.target.value as SliceStatus })}
                                      >
                                        <option value="pending">Pending</option>
                                        <option value="active">Active</option>
                                        <option value="complete">Complete</option>
                                      </select>
                                      <div className="form-actions">
                                        <button className="btn btn-primary" onClick={handleSaveSlice} disabled={saving}>
                                          {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                          Update
                                        </button>
                                        <button className="btn btn-ghost" onClick={handleCancelSlice}>
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* Features */}
                                  <div className="feature-list">
                                    {slice.features?.map((feature) => (
                                      <div key={feature.id} className="feature-item">
                                        <div className="feature-header">
                                          <Box size={14} />
                                          <span className="feature-title">{feature.title}</span>
                                          <span
                                            className="status-badge small"
                                            style={{
                                              backgroundColor: featureStatusColors[feature.status].bg,
                                              color: featureStatusColors[feature.status].text,
                                            }}
                                          >
                                            {feature.status}
                                          </span>
                                          {feature.taskId && (
                                            <span
                                              className="task-link-badge"
                                              onClick={() => onSelectTask?.(feature.taskId!)}
                                              title="Click to view task"
                                            >
                                              {feature.taskId}
                                            </span>
                                          )}
                                          <div className="item-actions">
                                            {feature.taskId ? (
                                              <button
                                                className="icon-btn small"
                                                onClick={() => handleUnlinkTask(feature.id)}
                                                title="Unlink task"
                                              >
                                                <Unlink size={14} />
                                              </button>
                                            ) : (
                                              <button
                                                className="icon-btn small"
                                                onClick={() => setLinkTaskFeatureId(feature.id)}
                                                title="Link to task"
                                              >
                                                <Link size={14} />
                                              </button>
                                            )}
                                            <button
                                              className="icon-btn small"
                                              onClick={() => handleEditFeature(feature)}
                                              title="Edit feature"
                                            >
                                              <Pencil size={14} />
                                            </button>
                                            <button
                                              className="icon-btn small danger"
                                              onClick={() => setDeleteConfirmId({ type: "feature", id: feature.id })}
                                              title="Delete feature"
                                            >
                                              <Trash2 size={14} />
                                            </button>
                                          </div>
                                        </div>

                                        {feature.description && (
                                          <p className="feature-description">{feature.description}</p>
                                        )}
                                        {feature.acceptanceCriteria && (
                                          <p className="feature-criteria">
                                            <strong>Acceptance:</strong> {feature.acceptanceCriteria}
                                          </p>
                                        )}

                                        {/* Edit feature form */}
                                        {editingFeatureId === feature.id && (
                                          <div className="inline-form">
                                            <input
                                              type="text"
                                              placeholder="Feature title"
                                              value={featureForm.title}
                                              onChange={(e) => setFeatureForm({ ...featureForm, title: e.target.value })}
                                              onKeyDown={handleFeatureFormKeyDown}
                                              autoFocus
                                            />
                                            <textarea
                                              placeholder="Description (optional)"
                                              value={featureForm.description}
                                              onChange={(e) => setFeatureForm({ ...featureForm, description: e.target.value })}
                                              rows={2}
                                            />
                                            <textarea
                                              placeholder="Acceptance criteria (optional)"
                                              value={featureForm.acceptanceCriteria}
                                              onChange={(e) => setFeatureForm({ ...featureForm, acceptanceCriteria: e.target.value })}
                                              rows={2}
                                            />
                                            <select
                                              value={featureForm.status}
                                              onChange={(e) => setFeatureForm({ ...featureForm, status: e.target.value as FeatureStatus })}
                                            >
                                              <option value="defined">Defined</option>
                                              <option value="triaged">Triaged</option>
                                              <option value="in-progress">In Progress</option>
                                              <option value="done">Done</option>
                                            </select>
                                            <div className="form-actions">
                                              <button className="btn btn-primary" onClick={handleSaveFeature} disabled={saving}>
                                                {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                                Update
                                              </button>
                                              <button className="btn btn-ghost" onClick={handleCancelFeature}>
                                                Cancel
                                              </button>
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    ))}

                                    {/* Create feature form */}
                                    {isCreatingFeature && selectedSliceIdForNewFeature === slice.id && (
                                      <div className="inline-form">
                                        <input
                                          type="text"
                                          placeholder="Feature title"
                                          value={featureForm.title}
                                          onChange={(e) => setFeatureForm({ ...featureForm, title: e.target.value })}
                                          onKeyDown={handleFeatureFormKeyDown}
                                          autoFocus
                                        />
                                        <textarea
                                          placeholder="Description (optional)"
                                          value={featureForm.description}
                                          onChange={(e) => setFeatureForm({ ...featureForm, description: e.target.value })}
                                          rows={2}
                                        />
                                        <textarea
                                          placeholder="Acceptance criteria (optional)"
                                          value={featureForm.acceptanceCriteria}
                                          onChange={(e) => setFeatureForm({ ...featureForm, acceptanceCriteria: e.target.value })}
                                          rows={2}
                                        />
                                        <div className="form-actions">
                                          <button className="btn btn-primary" onClick={handleSaveFeature} disabled={saving}>
                                            {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                            Create
                                          </button>
                                          <button className="btn btn-ghost" onClick={handleCancelFeature}>
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}

                          {milestone.slices.length === 0 && !isCreatingSlice && (
                            <div className="empty-state">
                              <Package size={16} />
                              <span>No slices yet</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Create milestone button/form */}
                {selectedMission && !isCreatingMilestone && editingMilestoneId === null && (
                  <button className="add-item-btn" onClick={handleCreateMilestone}>
                    <Plus size={16} />
                    Add Milestone
                  </button>
                )}

                {/* Global create milestone form */}
                {isCreatingMilestone && editingMilestoneId === null && (
                  <div className="inline-form">
                    <input
                      type="text"
                      placeholder="Milestone title"
                      value={milestoneForm.title}
                      onChange={(e) => setMilestoneForm({ ...milestoneForm, title: e.target.value })}
                      onKeyDown={handleMilestoneFormKeyDown}
                      autoFocus
                    />
                    <textarea
                      placeholder="Description (optional)"
                      value={milestoneForm.description}
                      onChange={(e) => setMilestoneForm({ ...milestoneForm, description: e.target.value })}
                      rows={2}
                    />
                    <div className="form-actions">
                      <button className="btn btn-primary" onClick={handleSaveMilestone} disabled={saving}>
                        {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                        Create
                      </button>
                      <button className="btn btn-ghost" onClick={handleCancelMilestone}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {selectedMission.milestones.length === 0 && !isCreatingMilestone && (
                  <div className="empty-state">
                    <Layers size={24} />
                    <span>No milestones yet. Add one to get started.</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Mission list view
            <div className="mission-list-view">
              {/* Create mission form */}
              {isCreatingMission && (
                <div className="inline-form">
                  <input
                    type="text"
                    placeholder="Mission title"
                    value={missionForm.title}
                    onChange={(e) => setMissionForm({ ...missionForm, title: e.target.value })}
                    onKeyDown={handleMissionFormKeyDown}
                    autoFocus
                  />
                  <textarea
                    placeholder="Description (optional)"
                    value={missionForm.description}
                    onChange={(e) => setMissionForm({ ...missionForm, description: e.target.value })}
                    rows={2}
                  />
                  <div className="form-actions">
                    <button className="btn btn-primary" onClick={handleSaveMission} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                      Create
                    </button>
                    <button className="btn btn-ghost" onClick={handleCancelMission}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Mission items */}
              {missions.map((mission) => (
                <div
                  key={mission.id}
                  className={`mission-item ${selectedMission?.id === mission.id ? "selected" : ""}`}
                  onClick={() => handleSelectMission(mission)}
                >
                  <div className="mission-item-content">
                    <div className="mission-item-header">
                      <Target size={16} />
                      <span className="mission-item-title">{mission.title}</span>
                      <span
                        className="status-badge small"
                        style={{
                          backgroundColor: missionStatusColors[mission.status].bg,
                          color: missionStatusColors[mission.status].text,
                        }}
                      >
                        {mission.status}
                      </span>
                    </div>
                    {mission.description && (
                      <p className="mission-item-description">{mission.description}</p>
                    )}
                  </div>
                  <div className="mission-item-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="icon-btn small"
                      onClick={() => handleEditMission(mission)}
                      title="Edit mission"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="icon-btn small danger"
                      onClick={() => setDeleteConfirmId({ type: "mission", id: mission.id })}
                      title="Delete mission"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}

              {/* Edit mission form */}
              {editingMissionId && (
                <div className="inline-form">
                  <input
                    type="text"
                    placeholder="Mission title"
                    value={missionForm.title}
                    onChange={(e) => setMissionForm({ ...missionForm, title: e.target.value })}
                    onKeyDown={handleMissionFormKeyDown}
                    autoFocus
                  />
                  <textarea
                    placeholder="Description (optional)"
                    value={missionForm.description}
                    onChange={(e) => setMissionForm({ ...missionForm, description: e.target.value })}
                    rows={2}
                  />
                  <div className="form-row">
                    <select
                      value={missionForm.status}
                      onChange={(e) => setMissionForm({ ...missionForm, status: e.target.value as MissionStatus })}
                    >
                      <option value="planning">Planning</option>
                      <option value="active">Active</option>
                      <option value="blocked">Blocked</option>
                      <option value="complete">Complete</option>
                      <option value="archived">Archived</option>
                    </select>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={missionForm.autoAdvance}
                        onChange={(e) => setMissionForm({ ...missionForm, autoAdvance: e.target.checked })}
                      />
                      Auto-advance slices
                    </label>
                  </div>
                  <div className="form-actions">
                    <button className="btn btn-primary" onClick={handleSaveMission} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                      Update
                    </button>
                    <button className="btn btn-ghost" onClick={handleCancelMission}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {missions.length === 0 && !isCreatingMission && (
                <div className="empty-state">
                  <Target size={32} />
                  <span>No missions yet. Create one to start planning.</span>
                </div>
              )}

              {!isCreatingMission && (
                <button className="add-item-btn" onClick={handleCreateMission}>
                  <Plus size={16} />
                  New Mission
                </button>
              )}
            </div>
          )}
        </div>

        {/* Delete confirmation dialog */}
        {deleteConfirmId && (
          <div className="confirm-dialog">
            <p>
              Delete this {deleteConfirmId.type}? This cannot be undone.
            </p>
            <div className="form-actions">
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (deleteConfirmId.type === "mission") {
                    await handleDeleteMission(deleteConfirmId.id);
                  } else if (deleteConfirmId.type === "milestone") {
                    await handleDeleteMilestone(deleteConfirmId.id);
                  } else if (deleteConfirmId.type === "slice") {
                    await handleDeleteSlice(deleteConfirmId.id);
                  } else if (deleteConfirmId.type === "feature") {
                    await handleDeleteFeature(deleteConfirmId.id);
                  }
                }}
              >
                Delete
              </button>
              <button className="btn btn-ghost" onClick={() => setDeleteConfirmId(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Link task dialog */}
        {linkTaskFeatureId && (
          <div className="confirm-dialog">
            <p>Link feature to task:</p>
            <input
              type="text"
              placeholder="Task ID (e.g., FN-001)"
              value={selectedTaskId}
              onChange={(e) => setSelectedTaskId(e.target.value)}
              autoFocus
            />
            {availableTasks.length > 0 && (
              <div className="task-suggestions">
                <small>Or select:</small>
                <div className="task-suggestion-list">
                  {availableTasks.slice(0, 5).map((task) => (
                    <button
                      key={task.id}
                      className="task-suggestion-btn"
                      onClick={() => setSelectedTaskId(task.id)}
                    >
                      {task.id}: {task.title || "Untitled"}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="form-actions">
              <button className="btn btn-primary" onClick={handleLinkTask}>
                Link
              </button>
              <button className="btn btn-ghost" onClick={() => { setLinkTaskFeatureId(null); setSelectedTaskId(""); }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
