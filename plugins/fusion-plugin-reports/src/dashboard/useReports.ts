import { useCallback, useEffect, useMemo, useState } from "react";
import { getReport, listReports } from "./api.js";
import type { ReportFilters, ReportRecord, ToastType } from "./types.js";

const DEFAULT_FILTERS: ReportFilters = { cadence: "all", status: "all", from: "", to: "", q: "", agentId: "" };

export function useReports({ projectId, addToast }: { projectId?: string; addToast: (message: string, type?: ToastType) => void }) {
  const [filters, setFilters] = useState<ReportFilters>(DEFAULT_FILTERS);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [selectedReport, setSelectedReport] = useState<ReportRecord | undefined>();
  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState<string | undefined>();
  const [compareB, setCompareB] = useState<string | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listReports({
      cadence: filters.cadence === "all" ? undefined : filters.cadence,
      status: filters.status === "all" ? undefined : filters.status,
      from: filters.from || undefined,
      to: filters.to || undefined,
      q: filters.q || undefined,
      agentId: filters.agentId || undefined,
      projectId,
    }).then((items) => {
      if (controller.signal.aborted) return;
      setReports(items);
      if (!selectedId && items[0]) setSelectedId(items[0].id);
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      addToast(err instanceof Error ? err.message : "Failed to load reports", "error");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [filters, projectId, addToast, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    getReport(selectedId, projectId).then(setSelectedReport).catch((err: unknown) => {
      addToast(err instanceof Error ? err.message : "Failed to load report", "error");
    });
  }, [selectedId, projectId, addToast]);

  const selectId = useCallback((id: string) => setSelectedId(id), []);
  const enterCompareMode = useCallback(() => setCompareMode(true), []);
  const closeCompareMode = useCallback(() => setCompareMode(false), []);
  const setCompareSlot = useCallback((slot: "a" | "b", id: string) => {
    if (slot === "a") setCompareA(id);
    else setCompareB(id);
  }, []);

  return useMemo(() => ({
    filters,
    setFilters,
    reports,
    loading,
    selectedId,
    selectedReport,
    selectId,
    compareMode,
    compareA,
    compareB,
    enterCompareMode,
    closeCompareMode,
    setCompareSlot,
  }), [filters, reports, loading, selectedId, selectedReport, selectId, compareMode, compareA, compareB, enterCompareMode, closeCompareMode, setCompareSlot]);
}
