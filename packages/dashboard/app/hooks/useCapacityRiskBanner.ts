/*
FNXC:CapacityRisk 2026-06-24-00:00:
Capacity-risk banner signal + per-project dismiss, with a settings-hydrate guard so the banner doesn't flash on first load or on project change, and a re-enable-clears-dismissal behavior (re-enabling the banner or changing the threshold resurrects a previously-dismissed banner). Extracted from AppInner.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeCapacityRisk,
  DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
  type CapacityRiskSignal,
} from "@fusion/core";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";
import { CAPACITY_RISK_DISMISSED_KEY } from "../utils/appLifecycle";

export interface UseCapacityRiskBannerOptions {
  agentStats: { todoTaskCount?: number; idleNonEphemeralCount?: number } | null | undefined;
  inProgressCount: number;
  inReviewCount: number;
  capacityRiskBannerEnabled: boolean | undefined;
  capacityRiskTodoThreshold: number | undefined;
  settingsLoaded: boolean;
  currentProjectId: string | undefined;
}

export interface UseCapacityRiskBannerResult {
  signal: CapacityRiskSignal;
  dismissed: boolean;
  dismiss: () => void;
}

export function useCapacityRiskBanner({
  agentStats,
  inProgressCount,
  inReviewCount,
  capacityRiskBannerEnabled,
  capacityRiskTodoThreshold,
  settingsLoaded,
  currentProjectId,
}: UseCapacityRiskBannerOptions): UseCapacityRiskBannerResult {
  const [dismissed, setDismissed] = useState(
    () => getScopedItem(CAPACITY_RISK_DISMISSED_KEY, currentProjectId) === "true",
  );

  useEffect(() => {
    setDismissed(getScopedItem(CAPACITY_RISK_DISMISSED_KEY, currentProjectId) === "true");
  }, [currentProjectId]);

  const signal = useMemo(
    () =>
      computeCapacityRisk({
        todoCount: agentStats?.todoTaskCount ?? 0,
        inProgressCount,
        inReviewCount,
        idleNonEphemeralAgentCount: agentStats?.idleNonEphemeralCount ?? 0,
        threshold: capacityRiskTodoThreshold ?? DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
      }),
    [agentStats?.todoTaskCount, agentStats?.idleNonEphemeralCount, inProgressCount, inReviewCount, capacityRiskTodoThreshold],
  );

  const previousBannerEnabledRef = useRef(capacityRiskBannerEnabled);
  const previousThresholdRef = useRef(capacityRiskTodoThreshold);
  const previousProjectIdRef = useRef(currentProjectId);
  const settingsHydratedRef = useRef(false);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }

    if (!settingsHydratedRef.current || previousProjectIdRef.current !== currentProjectId) {
      settingsHydratedRef.current = true;
      previousProjectIdRef.current = currentProjectId;
      previousBannerEnabledRef.current = capacityRiskBannerEnabled;
      previousThresholdRef.current = capacityRiskTodoThreshold;
      return;
    }

    const wasEnabled = previousBannerEnabledRef.current;
    const previousThreshold = previousThresholdRef.current;
    const bannerEnabledChangedToTrue = !wasEnabled && capacityRiskBannerEnabled;
    const thresholdChanged = previousThreshold !== capacityRiskTodoThreshold;

    if (bannerEnabledChangedToTrue || thresholdChanged) {
      removeScopedItem(CAPACITY_RISK_DISMISSED_KEY, currentProjectId);
      setDismissed(false);
    }

    previousProjectIdRef.current = currentProjectId;
    previousBannerEnabledRef.current = capacityRiskBannerEnabled;
    previousThresholdRef.current = capacityRiskTodoThreshold;
  }, [settingsLoaded, capacityRiskBannerEnabled, capacityRiskTodoThreshold, currentProjectId]);

  const dismiss = useCallback(() => {
    setScopedItem(CAPACITY_RISK_DISMISSED_KEY, "true", currentProjectId);
    setDismissed(true);
  }, [currentProjectId]);

  return { signal, dismissed, dismiss };
}
