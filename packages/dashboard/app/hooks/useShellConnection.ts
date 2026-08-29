import { useCallback, useMemo } from "react";
import { useShellContext } from "../context/ShellContext";
import {
  createOrUpdateProfile,
  deleteProfile,
  normalizeShellState,
  selectActiveProfile,
} from "../utils/shell-connection-settings";
import type { ShellConnectionProfileInput } from "../types/native-shell";

export function useShellConnection() {
  const context = useShellContext();

  // Memoize the normalized state. normalizeShellState rebuilds the object and
  // its profiles array on every call, so without this any consumer that puts
  // `state.profiles` in a useEffect dep array (see AppInner) re-runs the
  // effect every render — which can pin the main thread on iOS Safari.
  const state = useMemo(() => normalizeShellState(context.state), [context.state]);

  const saveProfile = useCallback((profile: ShellConnectionProfileInput) => createOrUpdateProfile(context.shellApi, profile), [context.shellApi]);
  const removeProfile = useCallback((profileId: string) => deleteProfile(context.shellApi, profileId), [context.shellApi]);
  const setActiveProfile = useCallback((profileId: string | null) => selectActiveProfile(context.shellApi, profileId), [context.shellApi]);

  return {
    ...context,
    state,
    saveProfile,
    removeProfile,
    setActiveProfile,
  };
}
