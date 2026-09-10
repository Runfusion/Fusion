/*
FNXC:AuthTokenRecovery 2026-07-14-00:00:
App-level open state for the auth-token recovery page follows the daemon's auth-failure event and its latch. Cold PWA and bare-URL 401s can fire before React mounts this listener, so the mount-time latch read must open recovery for that missed one-shot event.

FNXC:AuthTokenRecovery 2026-09-10-21:41:
A latched daemon-auth failure must initialize recovery synchronously so the blocking fullscreen page is the first painted surface instead of briefly exposing the first-boot loader. The effect still subscribes before re-reading the latch to close the event/subscription race.
*/

import { useEffect, useState } from "react";
import { AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, hasDaemonAuthFailure } from "../auth";

export interface UseAuthTokenRecoveryResult {
  open: boolean;
}

export function useAuthTokenRecovery(): UseAuthTokenRecoveryResult {
  const [open, setOpen] = useState(hasDaemonAuthFailure);

  useEffect(() => {
    const handleDaemonAuthFailure = () => {
      setOpen(true);
    };

    window.addEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, handleDaemonAuthFailure);
    if (hasDaemonAuthFailure()) {
      setOpen(true);
    }

    return () => {
      window.removeEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, handleDaemonAuthFailure);
    };
  }, []);

  return { open };
}
