import { useState, useEffect, useCallback, useRef } from "react";
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
  RoadmapWithHierarchy,
  RoadmapMissionPlanningHandoff,
  RoadmapFeatureTaskPlanningHandoff,
} from "@fusion/core";
import * as api from "../api";

/**
 * A suggested milestone from AI generation with a stable local draft ID.
 * Draft IDs enable stable identity when drafts are reordered or edited.
 * Drafts are ephemeral and NOT persisted until explicit acceptance.
 */
export interface MilestoneSuggestion {
  /** Stable local draft ID for UI binding and identity */
  id: string;
  title: string;
  description?: string;
}

/**
 * A suggested feature from AI generation with a stable local draft ID.
 * Draft IDs enable stable identity when drafts are reordered or edited.
 * Drafts are ephemeral and NOT persisted until explicit acceptance.
 */
export interface FeatureSuggestion {
  /** Stable local draft ID for UI binding and identity */
  id: string;
  title: string;
  description?: string;
}

/** Patch type for updating a suggestion draft */
export type SuggestionDraftPatch = {
  title?: string;
  description?: string;
};

export interface UseRoadmapsOptions {
  /** When provided, fetches roadmaps for this project */
  projectId?: string;
}

export interface UseRoadmapsResult {
  /** All roadmaps for the current project */
  roadmaps: Roadmap[];
  /** Currently selected roadmap ID */
  selectedRoadmapId: string | null;
  /** Selected roadmap with full hierarchy (milestones and features) */
  selectedRoadmap: RoadmapWithHierarchy | null;
  /** Milestones for the selected roadmap */
  milestones: RoadmapMilestone[];
  /** Features by milestone ID */
  featuresByMilestoneId: Record<string, RoadmapFeature[]>;
  /** Loading state */
  loading: boolean;
  /** Error state */
  error: Error | null;

  // Roadmap CRUD callbacks
  /** Create a new roadmap */
  createRoadmap: (input: RoadmapCreateInput, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Update a roadmap */
  updateRoadmap: (roadmapId: string, updates: RoadmapUpdateInput, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Delete a roadmap */
  deleteRoadmap: (roadmapId: string, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Select a roadmap to view its details */
  selectRoadmap: (roadmapId: string | null) => void;

  // Milestone CRUD callbacks
  /** Create a milestone in the selected roadmap */
  createMilestone: (input: RoadmapMilestoneCreateInput, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Update a milestone */
  updateMilestone: (milestoneId: string, updates: RoadmapMilestoneUpdateInput, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Delete a milestone */
  deleteMilestone: (milestoneId: string, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;

  // Milestone ordering callbacks
  /** Reorder milestones within a roadmap */
  reorderMilestones: (roadmapId: string, orderedMilestoneIds: string[], opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;

  // Feature CRUD callbacks
  /** Create a feature in a milestone */
  createFeature: (milestoneId: string, input: RoadmapFeatureCreateInput, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Update a feature */
  updateFeature: (featureId: string, updates: RoadmapFeatureUpdateInput, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Delete a feature */
  deleteFeature: (featureId: string, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;

  // Feature ordering callbacks
  /** Reorder features within a milestone */
  reorderFeatures: (milestoneId: string, orderedFeatureIds: string[], opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Move a feature to a different milestone or position */
  moveFeature: (featureId: string, targetMilestoneId: string, targetIndex: number, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;

  // Milestone suggestion callbacks
  /** Current pending milestone suggestions (ephemeral, in-memory only) */
  milestoneSuggestions: MilestoneSuggestion[];
  /** Whether suggestions are currently being generated */
  isGeneratingSuggestions: boolean;
  /** Generate milestone suggestions from a goal prompt */
  generateMilestoneSuggestions: (goalPrompt: string, count?: number, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Update a milestone suggestion draft before acceptance */
  updateMilestoneSuggestionDraft: (draftId: string, patch: SuggestionDraftPatch) => void;
  /** Accept a single milestone suggestion and create it as a milestone */
  acceptMilestoneSuggestion: (draftId: string, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Accept all milestone suggestions and create them as milestones (sequentially, in draft order) */
  acceptAllMilestoneSuggestions: (opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Clear all pending milestone suggestions */
  clearMilestoneSuggestions: () => void;

  // Feature suggestion callbacks (ephemeral, scoped by milestone)
  /** Pending feature suggestions by milestone ID (ephemeral, in-memory only) */
  featureSuggestionsByMilestoneId: Record<string, FeatureSuggestion[]>;
  /** Whether feature suggestions are being generated for a specific milestone */
  isGeneratingFeatureSuggestions: (milestoneId: string) => boolean;
  /** Generate feature suggestions for a specific milestone */
  generateFeatureSuggestions: (milestoneId: string, input?: { prompt?: string; count?: number }, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Update a feature suggestion draft before acceptance */
  updateFeatureSuggestionDraft: (milestoneId: string, draftId: string, patch: SuggestionDraftPatch) => void;
  /** Accept a single feature suggestion and create it as a feature */
  acceptFeatureSuggestion: (milestoneId: string, draftId: string, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Accept all feature suggestions for a milestone (sequentially, in draft order) */
  acceptAllFeatureSuggestions: (milestoneId: string, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Clear pending feature suggestions for a specific milestone */
  clearFeatureSuggestions: (milestoneId: string) => void;

  // Handoff / Export callbacks
  /** Current handoff payload (mission + feature handoffs) */
  handoffPayload: { mission: RoadmapMissionPlanningHandoff; features: RoadmapFeatureTaskPlanningHandoff[] } | null;
  /** Whether handoff is currently being fetched */
  isFetchingHandoff: boolean;
  /** Error from the last handoff fetch attempt */
  handoffError: Error | null;
  /** Fetch handoff payload for a roadmap */
  fetchHandoff: (roadmapId: string, opts?: { onSuccess?: () => void; onError?: (err: Error) => void }) => Promise<void>;
  /** Clear the current handoff payload */
  clearHandoff: () => void;

  /** Refresh all roadmaps */
  refresh: () => Promise<void>;
}

export function useRoadmaps(options?: UseRoadmapsOptions): UseRoadmapsResult {
  const projectId = options?.projectId;
  const [roadmaps, setRoadmaps] = useState<Roadmap[]>([]);
  const [selectedRoadmapId, setSelectedRoadmapId] = useState<string | null>(null);
  const [selectedRoadmap, setSelectedRoadmap] = useState<RoadmapWithHierarchy | null>(null);
  const [milestones, setMilestones] = useState<RoadmapMilestone[]>([]);
  const [featuresByMilestoneId, setFeaturesByMilestoneId] = useState<Record<string, RoadmapFeature[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Handoff state
  const [handoffPayload, setHandoffPayload] = useState<{ mission: RoadmapMissionPlanningHandoff; features: RoadmapFeatureTaskPlanningHandoff[] } | null>(null);
  const [isFetchingHandoff, setIsFetchingHandoff] = useState(false);
  const [handoffError, setHandoffError] = useState<Error | null>(null);

  // Ephemeral milestone suggestion state (in-memory only, not persisted)
  const [milestoneSuggestions, setMilestoneSuggestions] = useState<MilestoneSuggestion[]>([]);
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);

  // Ephemeral feature suggestion state keyed by milestone ID (in-memory only, not persisted)
  const [featureSuggestionsByMilestoneId, setFeatureSuggestionsByMilestoneId] = useState<Record<string, FeatureSuggestion[]>>({});
  const [generatingFeatureSuggestions, setGeneratingFeatureSuggestions] = useState<Record<string, boolean>>({});

  // Refs for feature suggestion state
  const featureSuggestionsByMilestoneIdRef = useRef(featureSuggestionsByMilestoneId);
  const generatingFeatureSuggestionsRef = useRef(generatingFeatureSuggestions);
  const milestoneSuggestionsRef = useRef(milestoneSuggestions);

  featureSuggestionsByMilestoneIdRef.current = featureSuggestionsByMilestoneId;
  generatingFeatureSuggestionsRef.current = generatingFeatureSuggestions;
  milestoneSuggestionsRef.current = milestoneSuggestions;

  // Track previous projectId to detect changes
  const previousProjectIdRef = useRef<string | undefined>(projectId);
  // Project context version for stale-response protection
  const projectContextVersionRef = useRef(0);
  // Handoff fetch version for stale-response discard
  const handoffFetchVersionRef = useRef(0);
  // Refs to access latest state in callbacks
  const roadmapsRef = useRef(roadmaps);
  const selectedRoadmapIdRef = useRef(selectedRoadmapId);
  const milestonesRef = useRef(milestones);
  const featuresByMilestoneIdRef = useRef(featuresByMilestoneId);
  const projectIdRef = useRef(projectId);
  const handoffPayloadRef = useRef(handoffPayload);

  roadmapsRef.current = roadmaps;
  selectedRoadmapIdRef.current = selectedRoadmapId;
  milestonesRef.current = milestones;
  featuresByMilestoneIdRef.current = featuresByMilestoneId;
  projectIdRef.current = projectId;
  handoffPayloadRef.current = handoffPayload;

  // Clear selection and suggestions when project changes
  useEffect(() => {
    if (previousProjectIdRef.current !== projectId) {
      previousProjectIdRef.current = projectId;
      projectContextVersionRef.current++;
      setSelectedRoadmapId(null);
      setSelectedRoadmap(null);
      setMilestones([]);
      setFeaturesByMilestoneId({});
      // Clear handoff state
      setHandoffPayload(null);
      setHandoffError(null);
      // Clear ephemeral suggestion state
      setMilestoneSuggestions([]);
      setIsGeneratingSuggestions(false);
      setFeatureSuggestionsByMilestoneId({});
      setGeneratingFeatureSuggestions({});
    }
  }, [projectId]);

  // Fetch roadmaps on mount and when projectId changes
  const fetchRoadmaps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetchedRoadmaps = await api.fetchRoadmaps(projectId);
      setRoadmaps(fetchedRoadmaps);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch roadmaps"));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Fetch selected roadmap with full hierarchy
  const fetchSelectedRoadmap = useCallback(async (roadmapId: string) => {
    try {
      const roadmap = await api.fetchRoadmap(roadmapId, projectId);
      setSelectedRoadmap(roadmap);
      setMilestones(roadmap.milestones || []);

      // Build features by milestone ID
      const featuresMap: Record<string, RoadmapFeature[]> = {};
      for (const milestone of roadmap.milestones || []) {
        featuresMap[milestone.id] = milestone.features || [];
      }
      setFeaturesByMilestoneId(featuresMap);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch roadmap"));
    }
  }, [projectId]);

  // Initial fetch
  useEffect(() => {
    void fetchRoadmaps();
  }, [fetchRoadmaps]);

  // Fetch selected roadmap when selection changes
  useEffect(() => {
    if (selectedRoadmapId) {
      void fetchSelectedRoadmap(selectedRoadmapId);
    } else {
      setSelectedRoadmap(null);
      setMilestones([]);
      setFeaturesByMilestoneId({});
    }
  }, [selectedRoadmapId, fetchSelectedRoadmap]);

  // Roadmap CRUD
  const createRoadmap = useCallback(async (
    input: RoadmapCreateInput,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    try {
      const newRoadmap = await api.createRoadmap(input, projectIdRef.current);
      setRoadmaps((prev) => [...prev, newRoadmap]);
      opts?.onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to create roadmap");
      opts?.onError?.(error);
      throw error;
    }
  }, []); // No dependencies needed - uses refs

  const updateRoadmap = useCallback(async (
    roadmapId: string,
    updates: RoadmapUpdateInput,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    try {
      const updated = await api.updateRoadmap(roadmapId, updates, projectIdRef.current);
      setRoadmaps((prev) => prev.map((r) => (r.id === roadmapId ? updated : r)));
      if (selectedRoadmapIdRef.current === roadmapId) {
        setSelectedRoadmap((prev) => prev ? { ...prev, ...updated } : null);
      }
      opts?.onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to update roadmap");
      opts?.onError?.(error);
      throw error;
    }
  }, []); // No dependencies needed - uses refs

  const deleteRoadmap = useCallback(async (
    roadmapId: string,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    try {
      await api.deleteRoadmap(roadmapId, projectIdRef.current);
      setRoadmaps((prev) => prev.filter((r) => r.id !== roadmapId));
      if (selectedRoadmapIdRef.current === roadmapId) {
        setSelectedRoadmapId(null);
        setSelectedRoadmap(null);
        setMilestones([]);
        setFeaturesByMilestoneId({});
      }
      opts?.onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to delete roadmap");
      opts?.onError?.(error);
      throw error;
    }
  }, []); // No dependencies needed - uses refs

  const selectRoadmap = useCallback((roadmapId: string | null) => {
    setSelectedRoadmapId(roadmapId);
  }, []);

  // Milestone CRUD
  const createMilestone = useCallback(async (
    input: RoadmapMilestoneCreateInput,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    const currentRoadmapId = selectedRoadmapIdRef.current;
    if (!currentRoadmapId) {
      const error = new Error("No roadmap selected");
      opts?.onError?.(error);
      throw error;
    }
    try {
      const newMilestone = await api.createRoadmapMilestone(currentRoadmapId, input, projectIdRef.current);
      setMilestones((prev) => [...prev, newMilestone]);
      setFeaturesByMilestoneId((prev) => ({ ...prev, [newMilestone.id]: [] }));
      // Refresh the full roadmap to get updated hierarchy
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }
      opts?.onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to create milestone");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]);

  const updateMilestone = useCallback(async (
    milestoneId: string,
    updates: RoadmapMilestoneUpdateInput,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    try {
      const updated = await api.updateRoadmapMilestone(milestoneId, updates, projectIdRef.current);
      setMilestones((prev) => prev.map((m) => (m.id === milestoneId ? updated : m)));
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }
      opts?.onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to update milestone");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]); // Uses refs internally

  const deleteMilestone = useCallback(async (
    milestoneId: string,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    try {
      await api.deleteRoadmapMilestone(milestoneId, projectIdRef.current);
      setMilestones((prev) => prev.filter((m) => m.id !== milestoneId));
      setFeaturesByMilestoneId((prev) => {
        const updated = { ...prev };
        delete updated[milestoneId];
        return updated;
      });
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }
      opts?.onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to delete milestone");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]); // Uses refs internally

  // Feature CRUD
  const createFeature = useCallback(async (
    milestoneId: string,
    input: RoadmapFeatureCreateInput,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    try {
      const newFeature = await api.createRoadmapFeature(milestoneId, input, projectIdRef.current);
      setFeaturesByMilestoneId((prev) => ({
        ...prev,
        [milestoneId]: [...(prev[milestoneId] || []), newFeature],
      }));
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }
      opts?.onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to create feature");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]); // Uses refs internally

  const updateFeature = useCallback(async (
    featureId: string,
    updates: RoadmapFeatureUpdateInput,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    try {
      const updated = await api.updateRoadmapFeature(featureId, updates, projectIdRef.current);
      setFeaturesByMilestoneId((prev) => {
        const updatedMap: Record<string, RoadmapFeature[]> = {};
        for (const [milestoneId, features] of Object.entries(prev)) {
          updatedMap[milestoneId] = features.map((f) => (f.id === featureId ? updated : f));
        }
        return updatedMap;
      });
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }
      opts?.onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to update feature");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]); // Uses refs internally

  const deleteFeature = useCallback(async (
    featureId: string,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    try {
      await api.deleteRoadmapFeature(featureId, projectIdRef.current);
      setFeaturesByMilestoneId((prev) => {
        const updatedMap: Record<string, RoadmapFeature[]> = {};
        for (const [milestoneId, features] of Object.entries(prev)) {
          updatedMap[milestoneId] = features.filter((f) => f.id !== featureId);
        }
        return updatedMap;
      });
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }
      opts?.onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to delete feature");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]); // Uses refs internally

  // Milestone ordering
  const reorderMilestones = useCallback(async (
    roadmapId: string,
    orderedMilestoneIds: string[],
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    // Save snapshot for rollback
    const snapshot = milestonesRef.current;

    // Optimistic update
    const reordered = orderedMilestoneIds
      .map((id) => snapshot.find((m) => m.id === id))
      .filter((m): m is RoadmapMilestone => m !== undefined)
      .map((m, index) => ({ ...m, orderIndex: index }));

    setMilestones(reordered);

    try {
      await api.reorderRoadmapMilestones(roadmapId, orderedMilestoneIds, projectIdRef.current);
      // Refresh to get server state
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }
      opts?.onSuccess?.();
    } catch (err) {
      // Rollback to snapshot
      setMilestones(snapshot);
      const error = err instanceof Error ? err : new Error("Failed to reorder milestones");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]); // Uses refs internally

  // Feature ordering
  const reorderFeatures = useCallback(async (
    milestoneId: string,
    orderedFeatureIds: string[],
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    // No-op suppression: if IDs are already in the same order, skip API call
    const currentFeatures = featuresByMilestoneIdRef.current[milestoneId] || [];
    const currentIds = currentFeatures.map((f) => f.id);
    if (JSON.stringify(currentIds) === JSON.stringify(orderedFeatureIds)) {
      opts?.onSuccess?.();
      return;
    }

    // Save snapshot for rollback
    const snapshot = featuresByMilestoneIdRef.current;

    // Optimistic update
    const reordered = orderedFeatureIds
      .map((id) => currentFeatures.find((f) => f.id === id))
      .filter((f): f is RoadmapFeature => f !== undefined)
      .map((f, index) => ({ ...f, orderIndex: index }));

    setFeaturesByMilestoneId((prev) => ({
      ...prev,
      [milestoneId]: reordered,
    }));

    try {
      await api.reorderRoadmapFeatures(milestoneId, orderedFeatureIds, projectIdRef.current);
      // Refresh to get server state
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }
      opts?.onSuccess?.();
    } catch (err) {
      // Rollback to snapshot
      setFeaturesByMilestoneId(snapshot);
      const error = err instanceof Error ? err : new Error("Failed to reorder features");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]); // Uses refs internally

  const moveFeature = useCallback(async (
    featureId: string,
    targetMilestoneId: string,
    targetIndex: number,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    // Save snapshot for rollback
    const snapshot = featuresByMilestoneIdRef.current;

    // Find which milestone the feature is currently in
    let sourceMilestoneId: string | null = null;
    for (const [milestoneId, features] of Object.entries(snapshot)) {
      if (features.some((f) => f.id === featureId)) {
        sourceMilestoneId = milestoneId;
        break;
      }
    }

    if (!sourceMilestoneId) {
      const error = new Error("Feature not found");
      opts?.onError?.(error);
      throw error;
    }

    // No-op suppression: if already at target position in same milestone, skip
    if (sourceMilestoneId === targetMilestoneId) {
      const currentFeatures = snapshot[sourceMilestoneId] || [];
      const clampedIndex = Math.max(0, Math.min(targetIndex, currentFeatures.length - 1));
      const currentIndex = currentFeatures.findIndex((f) => f.id === featureId);
      if (currentIndex === clampedIndex) {
        opts?.onSuccess?.();
        return;
      }
    }

    // Optimistic update
    const sourceFeatures = snapshot[sourceMilestoneId] || [];
    const targetFeatures = snapshot[targetMilestoneId] || [];
    const feature = sourceFeatures.find((f) => f.id === featureId);

    if (!feature) {
      const error = new Error("Feature not found");
      opts?.onError?.(error);
      throw error;
    }

    // Remove from source
    const newSourceFeatures = sourceFeatures
      .filter((f) => f.id !== featureId)
      .map((f, index) => ({ ...f, orderIndex: index }));

    // Add to target at correct position
    const updatedFeature = { ...feature, milestoneId: targetMilestoneId, orderIndex: targetIndex };
    const newTargetFeatures = [...targetFeatures];
    newTargetFeatures.splice(targetIndex, 0, updatedFeature);
    // Renormalize target
    const normalizedTargetFeatures = newTargetFeatures.map((f, index) => ({ ...f, orderIndex: index }));

    // If moving within same milestone, update source with the new order
    if (sourceMilestoneId === targetMilestoneId) {
      setFeaturesByMilestoneId((prev) => ({
        ...prev,
        [sourceMilestoneId]: normalizedTargetFeatures,
      }));
    } else {
      // Renormalize source after removal
      setFeaturesByMilestoneId((prev) => ({
        ...prev,
        [sourceMilestoneId]: newSourceFeatures,
        [targetMilestoneId]: normalizedTargetFeatures,
      }));
    }

    try {
      await api.moveRoadmapFeature(featureId, targetMilestoneId, targetIndex, projectId);
      // Refresh to get server state
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }
      opts?.onSuccess?.();
    } catch (err) {
      // Rollback to snapshot
      setFeaturesByMilestoneId(snapshot);
      const error = err instanceof Error ? err : new Error("Failed to move feature");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap, projectId]);

  // ── Milestone Suggestion Actions (Ephemeral) ───────────────────────────────────

  /**
   * Generate a stable draft ID for suggestions.
   * Uses crypto.randomUUID() for browser environments with a counter fallback.
   */
  function generateDraftId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // Fallback for environments without crypto.randomUUID
    return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  const generateMilestoneSuggestions = useCallback(async (
    goalPrompt: string,
    count: number = 5,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    const currentRoadmapId = selectedRoadmapIdRef.current;
    if (!currentRoadmapId) {
      const error = new Error("No roadmap selected");
      opts?.onError?.(error);
      throw error;
    }

    // Capture project context version for stale-response protection
    const contextVersionAtStart = projectContextVersionRef.current;
    const requestProjectId = projectIdRef.current;

    setIsGeneratingSuggestions(true);

    try {
      const response = await api.generateMilestoneSuggestions(
        currentRoadmapId,
        goalPrompt,
        count,
        requestProjectId
      );

      // Check for stale response
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        // Project context changed during fetch - discard response
        return;
      }

      // Assign stable draft IDs to suggestions for UI binding and identity
      const suggestionsWithIds: MilestoneSuggestion[] = response.suggestions.map((s) => ({
        id: generateDraftId(),
        title: s.title,
        description: s.description,
      }));
      setMilestoneSuggestions(suggestionsWithIds);
      opts?.onSuccess?.();
    } catch (err) {
      // Check for stale response
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        // Project context changed during fetch - discard error
        return;
      }

      const error = err instanceof Error ? err : new Error("Failed to generate suggestions");
      opts?.onError?.(error);
      throw error;
    } finally {
      // Only clear loading state if context hasn't changed
      if (projectContextVersionRef.current === contextVersionAtStart) {
        setIsGeneratingSuggestions(false);
      }
    }
  }, []);

  const updateMilestoneSuggestionDraft = useCallback((draftId: string, patch: SuggestionDraftPatch) => {
    // Update ref first for immediate visibility to acceptAll
    const currentSuggestions = milestoneSuggestionsRef.current;
    const updatedSuggestions = currentSuggestions.map((s) => (s.id === draftId ? { ...s, ...patch } : s));
    milestoneSuggestionsRef.current = updatedSuggestions;
    // Then update state for re-render
    setMilestoneSuggestions((prev) =>
      prev.map((s) => (s.id === draftId ? { ...s, ...patch } : s))
    );
  }, []);

  const acceptMilestoneSuggestion = useCallback(async (
    draftId: string,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    const currentRoadmapId = selectedRoadmapIdRef.current;
    if (!currentRoadmapId) {
      const error = new Error("No roadmap selected");
      opts?.onError?.(error);
      throw error;
    }

    // Capture state for stale-response protection
    const contextVersionAtStart = projectContextVersionRef.current;
    const currentSuggestions = milestoneSuggestionsRef.current;

    // Find the suggestion by draft ID
    const index = currentSuggestions.findIndex((s) => s.id === draftId);
    if (index === -1) {
      const error = new Error("Suggestion draft not found");
      opts?.onError?.(error);
      throw error;
    }

    const suggestion = currentSuggestions[index];

    // Validate: title must not be empty/whitespace-only
    if (!suggestion.title.trim()) {
      const error = new Error("Title cannot be empty");
      opts?.onError?.(error);
      throw error;
    }

    // Optimistic update: remove from suggestions immediately
    setMilestoneSuggestions((prev) => prev.filter((s) => s.id !== draftId));

    try {
      await api.createRoadmapMilestone(
        currentRoadmapId,
        { title: suggestion.title, description: suggestion.description },
        projectIdRef.current
      );

      // Check for stale response
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        // Project context changed - re-add to suggestions (optimistic rollback)
        setMilestoneSuggestions((prev) => {
          const updated = [...prev];
          updated.splice(index, 0, suggestion);
          return updated;
        });
        return;
      }

      // Refresh the roadmap to get the new milestone
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }

      opts?.onSuccess?.();
    } catch (err) {
      // Rollback: re-add to suggestions
      setMilestoneSuggestions((prev) => {
        const updated = [...prev];
        updated.splice(index, 0, suggestion);
        return updated;
      });

      const error = err instanceof Error ? err : new Error("Failed to accept suggestion");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]);

  const acceptAllMilestoneSuggestions = useCallback(async (
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    const currentRoadmapId = selectedRoadmapIdRef.current;
    if (!currentRoadmapId) {
      const error = new Error("No roadmap selected");
      opts?.onError?.(error);
      throw error;
    }

    // Read from ref - it's updated synchronously by updateMilestoneSuggestionDraft
    const suggestionsToAccept = [...milestoneSuggestionsRef.current];
    if (suggestionsToAccept.length === 0) {
      return;
    }

    // Validate all titles before accepting any
    const emptyTitleIndex = suggestionsToAccept.findIndex((s) => !s.title.trim());
    if (emptyTitleIndex !== -1) {
      const error = new Error(`Title cannot be empty at position ${emptyTitleIndex + 1}`);
      opts?.onError?.(error);
      throw error;
    }

    // Clear suggestions immediately (optimistic)
    setMilestoneSuggestions([]);

    // Capture state for stale-response protection
    const contextVersionAtStart = projectContextVersionRef.current;

    // Accept sequentially to preserve order
    for (let i = 0; i < suggestionsToAccept.length; i++) {
      // Check for stale response
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        // Project context changed - stop accepting
        break;
      }

      const suggestion = suggestionsToAccept[i];

      try {
        await api.createRoadmapMilestone(
          currentRoadmapId,
          { title: suggestion.title, description: suggestion.description },
          projectIdRef.current
        );
      } catch (err) {
        // On error, stop accepting and report
        const error = err instanceof Error ? err : new Error("Failed to accept all suggestions");
        opts?.onError?.(error);
        throw error;
      }
    }

    // Check for stale response
    if (projectContextVersionRef.current !== contextVersionAtStart) {
      return;
    }

    // Refresh the roadmap to get all new milestones
    if (selectedRoadmapIdRef.current) {
      void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
    }

    opts?.onSuccess?.();
  }, [fetchSelectedRoadmap]);

  // ── Feature Suggestion Actions (Ephemeral, Milestone-Scoped) ───────────────────────────────────

  const isGeneratingFeatureSuggestions = useCallback((milestoneId: string): boolean => {
    return generatingFeatureSuggestionsRef.current[milestoneId] ?? false;
  }, []);

  const generateFeatureSuggestions = useCallback(async (
    milestoneId: string,
    input?: { prompt?: string; count?: number },
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    // Capture project context version for stale-response protection
    const contextVersionAtStart = projectContextVersionRef.current;
    const requestProjectId = projectIdRef.current;

    // Set loading state for this milestone
    setGeneratingFeatureSuggestions((prev) => ({ ...prev, [milestoneId]: true }));

    try {
      const response = await api.generateFeatureSuggestions(
        milestoneId,
        input,
        requestProjectId
      );

      // Check for stale response
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        // Project context changed during fetch - discard response
        return;
      }

      // Assign stable draft IDs to suggestions for UI binding and identity
      const suggestionsWithIds: FeatureSuggestion[] = response.suggestions.map((s) => ({
        id: generateDraftId(),
        title: s.title,
        description: s.description,
      }));
      setFeatureSuggestionsByMilestoneId((prev) => ({
        ...prev,
        [milestoneId]: suggestionsWithIds,
      }));
      opts?.onSuccess?.();
    } catch (err) {
      // Check for stale response
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        // Project context changed during fetch - discard error
        return;
      }

      const error = err instanceof Error ? err : new Error("Failed to generate feature suggestions");
      opts?.onError?.(error);
      throw error;
    } finally {
      // Only clear loading state if context hasn't changed
      if (projectContextVersionRef.current === contextVersionAtStart) {
        setGeneratingFeatureSuggestions((prev) => ({ ...prev, [milestoneId]: false }));
      }
    }
  }, []);

  const updateFeatureSuggestionDraft = useCallback((milestoneId: string, draftId: string, patch: SuggestionDraftPatch) => {
    // Update ref first for immediate visibility to acceptAll
    const currentSuggestions = featureSuggestionsByMilestoneIdRef.current[milestoneId] || [];
    const updatedSuggestions = currentSuggestions.map((s) => (s.id === draftId ? { ...s, ...patch } : s));
    featureSuggestionsByMilestoneIdRef.current = {
      ...featureSuggestionsByMilestoneIdRef.current,
      [milestoneId]: updatedSuggestions,
    };
    // Then update state for re-render
    setFeatureSuggestionsByMilestoneId((prev) => ({
      ...prev,
      [milestoneId]: prev[milestoneId]?.map((s) => (s.id === draftId ? { ...s, ...patch } : s)) || [],
    }));
  }, []);

  const acceptFeatureSuggestion = useCallback(async (
    milestoneId: string,
    draftId: string,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    // Capture state for stale-response protection
    const contextVersionAtStart = projectContextVersionRef.current;
    const currentSuggestions = featureSuggestionsByMilestoneIdRef.current[milestoneId] || [];

    // Find the suggestion by draft ID
    const index = currentSuggestions.findIndex((s) => s.id === draftId);
    if (index === -1) {
      const error = new Error("Suggestion draft not found");
      opts?.onError?.(error);
      throw error;
    }

    const suggestion = currentSuggestions[index];

    // Validate: title must not be empty/whitespace-only
    if (!suggestion.title.trim()) {
      const error = new Error("Title cannot be empty");
      opts?.onError?.(error);
      throw error;
    }

    // Optimistic update: remove from suggestions immediately
    setFeatureSuggestionsByMilestoneId((prev) => ({
      ...prev,
      [milestoneId]: prev[milestoneId]?.filter((s) => s.id !== draftId) || [],
    }));

    try {
      await api.createRoadmapFeature(
        milestoneId,
        { title: suggestion.title, description: suggestion.description },
        projectIdRef.current
      );

      // Check for stale response
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        // Project context changed - re-add to suggestions (optimistic rollback)
        setFeatureSuggestionsByMilestoneId((prev) => {
          const milestoneSuggestions = prev[milestoneId] || [];
          const updated = [...milestoneSuggestions];
          updated.splice(index, 0, suggestion);
          return { ...prev, [milestoneId]: updated };
        });
        return;
      }

      // Refresh the roadmap to get the new feature
      if (selectedRoadmapIdRef.current) {
        void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
      }

      opts?.onSuccess?.();
    } catch (err) {
      // Rollback: re-add to suggestions
      setFeatureSuggestionsByMilestoneId((prev) => {
        const milestoneSuggestions = prev[milestoneId] || [];
        const updated = [...milestoneSuggestions];
        updated.splice(index, 0, suggestion);
        return { ...prev, [milestoneId]: updated };
      });

      const error = err instanceof Error ? err : new Error("Failed to accept suggestion");
      opts?.onError?.(error);
      throw error;
    }
  }, [fetchSelectedRoadmap]);

  const acceptAllFeatureSuggestions = useCallback(async (
    milestoneId: string,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    // Read from ref - it's updated synchronously by updateFeatureSuggestionDraft
    const suggestionsToAccept = [...(featureSuggestionsByMilestoneIdRef.current[milestoneId] || [])];
    if (suggestionsToAccept.length === 0) {
      return;
    }

    // Validate all titles before accepting any
    const emptyTitleIndex = suggestionsToAccept.findIndex((s) => !s.title.trim());
    if (emptyTitleIndex !== -1) {
      const error = new Error(`Title cannot be empty at position ${emptyTitleIndex + 1}`);
      opts?.onError?.(error);
      throw error;
    }

    // Clear suggestions for this milestone immediately (optimistic)
    setFeatureSuggestionsByMilestoneId((prev) => ({
      ...prev,
      [milestoneId]: [],
    }));

    // Capture state for stale-response protection
    const contextVersionAtStart = projectContextVersionRef.current;

    // Accept sequentially to preserve order
    for (let i = 0; i < suggestionsToAccept.length; i++) {
      // Check for stale response
      if (projectContextVersionRef.current !== contextVersionAtStart) {
        // Project context changed - stop accepting
        break;
      }

      const suggestion = suggestionsToAccept[i];

      try {
        await api.createRoadmapFeature(
          milestoneId,
          { title: suggestion.title, description: suggestion.description },
          projectIdRef.current
        );
      } catch (err) {
        // On error, stop accepting and report
        const error = err instanceof Error ? err : new Error("Failed to accept all suggestions");
        opts?.onError?.(error);
        throw error;
      }
    }

    // Check for stale response
    if (projectContextVersionRef.current !== contextVersionAtStart) {
      return;
    }

    // Refresh the roadmap to get all new features
    if (selectedRoadmapIdRef.current) {
      void fetchSelectedRoadmap(selectedRoadmapIdRef.current);
    }

    opts?.onSuccess?.();
  }, [fetchSelectedRoadmap]);

  const clearMilestoneSuggestions = useCallback(() => {
    setMilestoneSuggestions([]);
    setIsGeneratingSuggestions(false);
  }, []);

  const clearFeatureSuggestions = useCallback((milestoneId: string) => {
    setFeatureSuggestionsByMilestoneId((prev) => {
      const updated = { ...prev };
      delete updated[milestoneId];
      return updated;
    });
    setGeneratingFeatureSuggestions((prev) => {
      const updated = { ...prev };
      delete updated[milestoneId];
      return updated;
    });
  }, []);

  // ── Handoff / Export Functions ────────────────────────────────────────

  const fetchHandoff = useCallback(async (
    roadmapId: string,
    opts?: { onSuccess?: () => void; onError?: (err: Error) => void }
  ) => {
    const requestVersion = ++handoffFetchVersionRef.current;
    const requestProjectId = projectId; // Capture projectId at request time

    setIsFetchingHandoff(true);
    setHandoffError(null);

    try {
      const data = await api.fetchRoadmapHandoff(roadmapId, requestProjectId);

      // Reject stale responses: check if project changed or version is stale
      if (handoffFetchVersionRef.current !== requestVersion || projectId !== requestProjectId) {
        return; // Stale response, discard
      }

      setHandoffPayload(data);
      opts?.onSuccess?.();
    } catch (err) {
      // Reject stale errors: check if project changed or version is stale
      if (handoffFetchVersionRef.current !== requestVersion || projectId !== requestProjectId) {
        return; // Stale error, discard
      }

      const error = err instanceof Error ? err : new Error(String(err));
      setHandoffError(error);
      setHandoffPayload(null);
      opts?.onError?.(error);
    } finally {
      // Only clear loading if this is still the current request
      if (handoffFetchVersionRef.current === requestVersion) {
        setIsFetchingHandoff(false);
      }
    }
  }, [projectId]);

  const clearHandoff = useCallback(() => {
    setHandoffPayload(null);
    setHandoffError(null);
    setIsFetchingHandoff(false);
  }, []);

  const refresh = useCallback(async () => {
    await fetchRoadmaps();
    if (selectedRoadmapIdRef.current) {
      await fetchSelectedRoadmap(selectedRoadmapIdRef.current);
    }
  }, [fetchRoadmaps, fetchSelectedRoadmap]);

  return {
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
    reorderMilestones,
    createFeature,
    updateFeature,
    deleteFeature,
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
    refresh,
  };
}
