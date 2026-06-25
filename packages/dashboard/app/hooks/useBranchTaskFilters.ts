/*
FNXC:BoardFilters 2026-06-24-00:00:
Working/base branch filters for the board, persisted per-project via scoped storage, plus the derived branch-option lists and the filtered task set (including the NO_BRANCH_FILTER_VALUE "no branch" sentinel that excludes tasks which have a branch). Extracted from AppInner.
*/

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Task } from "@fusion/core";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import {
  BASE_BRANCH_FILTER_STORAGE_KEY,
  NO_BRANCH_FILTER_VALUE,
  WORKING_BRANCH_FILTER_STORAGE_KEY,
} from "../utils/appLifecycle";

export interface UseBranchTaskFiltersOptions {
  boardSourceTasks: Task[];
  currentProjectId: string | undefined;
}

export interface UseBranchTaskFiltersResult {
  branchFilter: string;
  baseBranchFilter: string;
  branchOptions: string[];
  baseBranchOptions: string[];
  filteredBoardTasks: Task[];
  onBranchFilterChange: (value: string) => void;
  onBaseBranchFilterChange: (value: string) => void;
}

export function useBranchTaskFilters({
  boardSourceTasks,
  currentProjectId,
}: UseBranchTaskFiltersOptions): UseBranchTaskFiltersResult {
  const [branchFilter, setBranchFilter] = useState("");
  const [baseBranchFilter, setBaseBranchFilter] = useState("");

  useEffect(() => {
    setBranchFilter(getScopedItem(WORKING_BRANCH_FILTER_STORAGE_KEY, currentProjectId) ?? "");
    setBaseBranchFilter(getScopedItem(BASE_BRANCH_FILTER_STORAGE_KEY, currentProjectId) ?? "");
  }, [currentProjectId]);

  const onBranchFilterChange = useCallback((value: string) => {
    setBranchFilter(value);
    setScopedItem(WORKING_BRANCH_FILTER_STORAGE_KEY, value, currentProjectId);
  }, [currentProjectId]);

  const onBaseBranchFilterChange = useCallback((value: string) => {
    setBaseBranchFilter(value);
    setScopedItem(BASE_BRANCH_FILTER_STORAGE_KEY, value, currentProjectId);
  }, [currentProjectId]);

  const branchOptions = useMemo(() => {
    return Array.from(
      new Set(
        boardSourceTasks
          .map((task) => task.branch?.trim())
          .filter((branch): branch is string => Boolean(branch && branch.length > 0)),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [boardSourceTasks]);

  const baseBranchOptions = useMemo(() => {
    return Array.from(
      new Set(
        boardSourceTasks
          .map((task) => task.baseBranch?.trim())
          .filter((baseBranch): baseBranch is string => Boolean(baseBranch && baseBranch.length > 0)),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [boardSourceTasks]);

  const filteredBoardTasks = useMemo(() => {
    return boardSourceTasks.filter((task) => {
      const taskBranch = task.branch?.trim() ?? "";
      const taskBaseBranch = task.baseBranch?.trim() ?? "";
      if (branchFilter === NO_BRANCH_FILTER_VALUE) {
        if (taskBranch.length > 0) {
          return false;
        }
      } else if (branchFilter.length > 0 && taskBranch !== branchFilter) {
        return false;
      }
      if (baseBranchFilter === NO_BRANCH_FILTER_VALUE) {
        if (taskBaseBranch.length > 0) {
          return false;
        }
      } else if (baseBranchFilter.length > 0 && taskBaseBranch !== baseBranchFilter) {
        return false;
      }
      return true;
    });
  }, [boardSourceTasks, branchFilter, baseBranchFilter]);

  return {
    branchFilter,
    baseBranchFilter,
    branchOptions,
    baseBranchOptions,
    filteredBoardTasks,
    onBranchFilterChange,
    onBaseBranchFilterChange,
  };
}
