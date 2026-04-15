/**
 * useInsights hook - Dashboard hook for managing project insights
 *
 * Provides a unified interface for:
 * - Fetching insights grouped by category
 * - Triggering manual insight generation runs
 * - Dismissing individual insights
 * - Converting insights to tasks
 */

import { useState, useCallback, useMemo } from "react";
import type { Insight, InsightCategory, InsightStatus, InsightRun } from "@fusion/core";
import {
  fetchInsights,
  dismissInsight,
  triggerInsightRun,
  fetchInsightRuns,
  fetchInsightRun,
  getInsightCreateTaskData,
  type InsightsListResponse,
  type RunsListResponse,
} from "../api";

// Canonical insight categories (in display order)
export const INSIGHT_CATEGORIES: InsightCategory[] = [
  "features",
  "architecture",
  "competitive_analysis",
  "research",
  "trends",
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
  runInsights: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  createTask: (id: string) => Promise<{ title: string; description: string } | null>;

  // Per-insight action states
  dismissStates: Map<string, InsightActionState>;
  createTaskStates: Map<string, InsightActionState>;

  // Dismissed/filtered counts
  totalCount: number;
  dismissedCount: number;
}

/**
 * Hook for managing project insights.
 *
 * @param projectId - Optional project ID for scoped insights
 * @returns Insights data and action handlers
 */
export function useInsights(projectId?: string): UseInsightsResult {
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

      // Group by category
      const grouped = new Map<InsightCategory, Insight[]>();

      // Initialize all categories
      for (const category of INSIGHT_CATEGORIES) {
        grouped.set(category, []);
      }

      // Group non-dismissed insights
      for (const insight of response.insights) {
        if (insight.status !== "dismissed") {
          const existing = grouped.get(insight.category) ?? [];
          grouped.set(insight.category, [...existing, insight]);
        }
      }

      // Update sections
      setSections(
        INSIGHT_CATEGORIES.map((category) => ({
          category,
          label: CATEGORY_LABELS[category] ?? category,
          items: grouped.get(category) ?? [],
          isLoading: false,
          error: null,
        })),
      );

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

  // Run insights generation
  const runInsights = useCallback(async () => {
    setIsRunInFlight(true);
    setRunError(null);

    try {
      const run = await triggerInsightRun("manual", undefined, projectId);
      setLatestRun(run);

      // Poll for completion (simple approach)
      const pollInterval = setInterval(async () => {
        try {
          const updatedRun = await fetchInsightRun(run.id, projectId);
          if (updatedRun.status === "completed" || updatedRun.status === "failed") {
            clearInterval(pollInterval);
            setLatestRun(updatedRun);
            if (updatedRun.status === "failed" && updatedRun.error) {
              setRunError(updatedRun.error);
            }
            // Refresh insights list
            await refresh();
          }
        } catch {
          // Ignore polling errors
        }
      }, 2000);

      // Fallback: stop polling after 60 seconds
      setTimeout(() => {
        clearInterval(pollInterval);
      }, 60000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start insight generation";
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
        setSections((prev) =>
          prev.map((section) => ({
            ...section,
            items: section.items.filter((item) => item.id !== id),
          })),
        );

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

  // Computed counts
  const totalCount = useMemo(() => {
    return sections.reduce((sum, section) => sum + section.items.length, 0);
  }, [sections]);

  const dismissedCount = useMemo(() => {
    // This would need to be tracked separately if needed
    return 0;
  }, [sections]);

  // Initial load - intentionally runs once on mount
  // eslint-disable-next-line
  useMemo(() => {
    void refresh();
  }, []);

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
    dismissStates,
    createTaskStates,
    totalCount,
    dismissedCount,
  };
}
