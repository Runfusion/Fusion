/*
FNXC:AuthTokenRecovery 2026-06-24-00:00:
App-level open state for the auth-token recovery dialog, opened when the daemon signals auth failure (AUTH_TOKEN_RECOVERY_REQUIRED_EVENT). Extracted verbatim from AppInner.
*/

import { useEffect, useState } from "react";
import { AUTH_TOKEN_RECOVERY_REQUIRED_EVENT } from "../auth";

export interface UseAuthTokenRecoveryResult {
  open: boolean;
}

export function useAuthTokenRecovery(): UseAuthTokenRecoveryResult {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleDaemonAuthFailure = () => {
      setOpen(true);
    };

    window.addEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, handleDaemonAuthFailure);
    return () => {
      window.removeEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, handleDaemonAuthFailure);
    };
  }, []);

  return { open };
}
