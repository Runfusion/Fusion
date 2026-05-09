/**
 * useInsights hook - Dashboard hook for managing project insights
 *
 * Provides a unified interface for:
 * - Fetching insights grouped by category
 * - Triggering manual insight generation runs
 * - Dismissing individual insights
 * - Converting insights to tasks
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import type { Insight, InsightCategory, InsightStatus, InsightRun } from "@fusion/core";
import {
  fetchInsights,
  dismissInsight,
  archiveInsight,
  unarchiveInsight,
  triggerInsightRun,
  fetchInsightRuns,
  getInsightCreateTaskData,
} from "../api";

// Canonical insight categories (in display order)
export const INSIGHT_CATEGORIES: InsightCategory[] = [
  "architecture",
  "quality",
  "workflow",
  "performance",
  "reliability",
  "security",
  "ux",
  "testability",
  "documentation",
  "dependency",
  "features",
  "competitive_analysis",
  "research",
  "trends",
  "other",
];

// Human-readable labels for categories
export const CATEGORY_LABELS: Record<InsightCategory, string> = {
  quality: "Quality",
  performance: "Performance",
  architecture: "Architecture",
  security: "Security",
  reliability: "Reliability",
  ux: "User Experience",
  testability: "Testability",
  documentation: "Documentation",
  dependency: "Dependencies",
  workflow: "Workflow",
  other: "Other",
  // Extended categories
  features: "Features",
  competitive_analysis: "Competitive Analysis",
  research: "Research",
  trends: "Trends",
};

// Status labels
export const STATUS_LABELS: Record<InsightStatus, string> = {
  generated: "Generated",
  confirmed: "Confirmed",
  stale: "Stale",
  dismissed: "Dismissed",
  archived: "Archived",
};

// Section data structure
export interface InsightSection {
  category: InsightCategory;
  label: string;
  items: Insight[];
  isLoading: boolean;
  error: string | null;
}

// Action state for tracking in-flight operations
export interface InsightActionState {
  running: boolean;
  error: string | null;
}

// Main hook result
export interface UseInsightsResult {
  // Section data
  sections: InsightSection[];

  // Loading/error state
  loading: boolean;
  error: string | null;

  // Run state
  latestRun: InsightRun | null;
  isRunInFlight: boolean;
  runError: string | null;

  // Actions
  refresh: () => Promise<void>;
  runInsights: (modelProvider?: string, modelId?: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  createTask: (id: string) => Promise<{ title: string; description: string } | null>;
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  toggleShowArchived: () => void;

  // Per-insight action states
  dismissStates: Map<string, InsightActionState>;
  createTaskStates: Map<string, InsightActionState>;
  archiveStates: Map<string, InsightActionState>;
  unarchiveStates: Map<string, InsightActionState>;

  // Dismissed/filtered counts
  totalCount: number;
  dismissedCount: number;
  archivedCount: number;
  showArchived: boolean;
}

/**
 * Hook for managing project insights.
 *
 * @param projectId - Optional project ID for scoped insights
 * @returns Insights data and action handlers
 */
export function useInsights(projectId?: string): UseInsightsResult {
  const [allInsights, setAllInsights] = useState<Insight[]>([]);

  // Section items (keyed by category)
  const [sections, setSections] = useState<InsightSection[]>(() =>
    INSIGHT_CATEGORIES.map((category) => ({
      category,
      label: CATEGORY_LABELS[category] ?? category,
      items: [],
      isLoading: false,
      error: null,
    })),
  );

  // Loading state
  const [loading, setLoading] = useState(true);

  // Top-level error
  const [error, setError] = useState<string | null>(null);

  // Run state
  const [latestRun, setLatestRun] = useState<InsightRun | null>(null);
  const [isRunInFlight, setIsRunInFlight] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Per-insight action states
  const [dismissStates, setDismissStates] = useState<Map<string, InsightActionState>>(new Map());
  const [createTaskStates, setCreateTaskStates] = useState<Map<string, InsightActionState>>(new Map());
  const [archiveStates, setArchiveStates] = useState<Map<string, InsightActionState>>(new Map());
  const [unarchiveStates, setUnarchiveStates] = useState<Map<string, InsightActionState>>(new Map());
  const [showArchived, setShowArchived] = useState(false);

  // Refresh function
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch all non-dismissed insights
      const response = await fetchInsights(
        { status: undefined, limit: 1000 }, // Fetch all non-dismissed
        projectId,
      );

      setAllInsights(response.insights.filter((insight) => insight.status !== "dismissed"));

      // Fetch latest run
      const runsResponse = await fetchInsightRuns(projectId);
      if (runsResponse.runs.length > 0) {
        setLatestRun(runsResponse.runs[0]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch insights";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const toggleShowArchived = useCallback(() => {
    setShowArchived((prev) => !prev);
  }, []);

  // Run insights generation
  const runInsights = useCallback(async (modelProvider?: string, modelId?: string) => {
    setIsRunInFlight(true);
    setRunError(null);

    try {
      const run = await triggerInsightRun("manual", undefined, projectId, modelProvider, modelId);
      setLatestRun(run);

      if (run.status === "completed") {
        await refresh();
      } else if (run.status === "failed" && run.error) {
        setRunError(run.error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate insights";
      setRunError(message);
      throw err;
    } finally {
      setIsRunInFlight(false);
    }
  }, [projectId, refresh]);

  // Dismiss an insight
  const dismiss = useCallback(
    async (id: string) => {
      setDismissStates((prev) => {
        const next = new Map(prev);
        next.set(id, { running: true, error: null });
        return next;
      });

      try {
        await dismissInsight(id, projectId);

        // Update local state
        setAllInsights((prev) => prev.filter((item) => item.id !== id));

        setDismissStates((prev) => {
          const next = new Map(prev);
          next.set(id, { running: false, error: null });
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to dismiss insight";
        setDismissStates((prev) => {
          const next = new Map(prev);
          next.set(id, { running: false, error: message });
          return next;
        });
        throw err;
      }
    },
    [projectId],
  );

  // Create task from insight
  const createTask = useCallback(
    async (id: string): Promise<{ title: string; description: string } | null> => {
      setCreateTaskStates((prev) => {
        const next = new Map(prev);
        next.set(id, { running: true, error: null });
        return next;
      });

      try {
        const data = await getInsightCreateTaskData(id, projectId);
        await archiveInsight(id, projectId);
        setAllInsights((prev) => prev.map((insight) =>
          insight.id === id
            ? {
                ...insight,
                status: "archived",
                updatedAt: new Date().toISOString(),
              }
            : insight,
        ));
        setCreateTaskStates((prev) => {
          const next = new Map(prev);
          next.set(id, { running: false, error: null });
          return next;
        });
        return {
          title: data.suggestedTitle,
          description: data.suggestedDescription,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create task";
        setCreateTaskStates((prev) => {
          const next = new Map(prev);
          next.set(id, { running: false, error: message });
          return next;
        });
        throw err;
      }
    },
    [projectId],
  );

  useEffect(() => {
    const grouped = new Map<InsightCategory, Insight[]>();

    for (const category of INSIGHT_CATEGORIES) {
      grouped.set(category, []);
    }

    for (const insight of allInsights) {
      if (!showArchived && insight.status === "archived") {
        continue;
      }
      const existing = grouped.get(insight.category) ?? [];
      grouped.set(insight.category, [...existing, insight]);
    }

    setSections(
      INSIGHT_CATEGORIES.map((category) => ({
        category,
        label: CATEGORY_LABELS[category] ?? category,
        items: grouped.get(category) ?? [],
        isLoading: false,
        error: null,
      })),
    );
  }, [allInsights, showArchived]);

  const archive = useCallback(
    async (id: string) => {
      setArchiveStates((prev) => {
        const next = new Map(prev);
        next.set(id, { running: true, error: null });
        return next;
      });

      try {
        await archiveInsight(id, projectId);
        setAllInsights((prev) => prev.map((insight) =>
          insight.id === id ? { ...insight, status: "archived", updatedAt: new Date().toISOString() } : insight,
        ));
        setArchiveStates((prev) => {
          const next = new Map(prev);
          next.set(id, { running: false, error: null });
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to archive insight";
        setArchiveStates((prev) => {
          const next = new Map(prev);
          next.set(id, { running: false, error: message });
          return next;
        });
        throw err;
      }
    },
    [projectId],
  );

  const unarchive = useCallback(
    async (id: string) => {
      setUnarchiveStates((prev) => {
        const next = new Map(prev);
        next.set(id, { running: true, error: null });
        return next;
      });

      try {
        await unarchiveInsight(id, projectId);
        setAllInsights((prev) => prev.map((insight) =>
          insight.id === id ? { ...insight, status: "confirmed", updatedAt: new Date().toISOString() } : insight,
        ));
        setUnarchiveStates((prev) => {
          const next = new Map(prev);
          next.set(id, { running: false, error: null });
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to unarchive insight";
        setUnarchiveStates((prev) => {
          const next = new Map(prev);
          next.set(id, { running: false, error: message });
          return next;
        });
        throw err;
      }
    },
    [projectId],
  );

  // Computed counts
  const totalCount = useMemo(() => {
    return sections.reduce((sum, section) => sum + section.items.length, 0);
  }, [sections]);

  const dismissedCount = useMemo(() => {
    return 0;
  }, []);

  const archivedCount = useMemo(() => {
    return allInsights.filter((insight) => insight.status === "archived").length;
  }, [allInsights]);

  // Initial load - intentionally runs once on mount
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    sections,
    loading,
    error,
    latestRun,
    isRunInFlight,
    runError,
    refresh,
    runInsights,
    dismiss,
    createTask,
    archive,
    unarchive,
    toggleShowArchived,
    dismissStates,
    createTaskStates,
    archiveStates,
    unarchiveStates,
    totalCount,
    dismissedCount,
    archivedCount,
    showArchived,
  };
}
