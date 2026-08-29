import { useCallback, useEffect, useState } from "react";
import { clearPositions, loadPositions, savePositions, type NodePositions } from "../utils/graphPositionStorage.js";

function filterVisiblePositions(positions: NodePositions, visibleTaskIds: Set<string>): NodePositions {
  const filtered: NodePositions = {};
  for (const [taskId, position] of Object.entries(positions)) {
    if (visibleTaskIds.has(taskId)) {
      filtered[taskId] = position;
    }
  }
  return filtered;
}

export function useGraphPositions({
  projectId,
  visibleTaskIds,
}: {
  projectId: string | undefined;
  visibleTaskIds: Set<string>;
}): {
  savedPositions: NodePositions | null;
  persistPositions: (positions: NodePositions) => void;
  clearSavedPositions: () => void;
} {
  const [savedPositions, setSavedPositions] = useState<NodePositions | null>(null);

  useEffect(() => {
    setSavedPositions(loadPositions(projectId));
  }, [projectId]);

  const persistPositions = useCallback(
    (positions: NodePositions) => {
      savePositions(positions, visibleTaskIds, projectId);
      setSavedPositions(filterVisiblePositions(positions, visibleTaskIds));
    },
    [projectId, visibleTaskIds],
  );

  const clearSavedPositions = useCallback(() => {
    clearPositions(projectId);
    setSavedPositions(null);
  }, [projectId]);

  return { savedPositions, persistPositions, clearSavedPositions };
}
