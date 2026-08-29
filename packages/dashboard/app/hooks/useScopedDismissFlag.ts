/*
FNXC:ScopedDismissFlag 2026-06-24-00:00:
A per-project dismissable boolean banner flag (e.g. setup-warning, capacity-risk) backed by scoped storage. Owns the initial scoped read, the project-change re-read (so a dismissal in one project does not leak into another), and the dismiss action. Extracted from AppInner.
*/

import { useCallback, useEffect, useState } from "react";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";

export interface UseScopedDismissFlagResult {
  dismissed: boolean;
  dismiss: () => void;
}

export function useScopedDismissFlag(
  storageKey: string,
  currentProjectId: string | undefined,
): UseScopedDismissFlagResult {
  const [dismissed, setDismissed] = useState(
    () => getScopedItem(storageKey, currentProjectId) === "true",
  );

  useEffect(() => {
    setDismissed(getScopedItem(storageKey, currentProjectId) === "true");
  }, [storageKey, currentProjectId]);

  const dismiss = useCallback(() => {
    setScopedItem(storageKey, "true", currentProjectId);
    setDismissed(true);
  }, [storageKey, currentProjectId]);

  return { dismissed, dismiss };
}
