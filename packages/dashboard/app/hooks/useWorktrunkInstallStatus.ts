import { useCallback, useEffect, useState } from "react";
import { subscribeSse } from "../sse-bus";

export type WorktrunkInstallUiStatus = "installed" | "missing" | "pending-approval" | "installing" | "denied" | "failed";

interface WorktrunkInstallStatusResponse {
  status: WorktrunkInstallUiStatus;
  version?: string;
  installPath?: string;
  pendingApprovalId?: string;
  error?: string;
}

function withProjectId(path: string, projectId?: string): string {
  if (!projectId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json()) as T;
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  return payload;
}

/*
FNXC:WindowsTerminalStartup 2026-07-03-16:25:
The worktrunk status probe must NOT run automatically on Settings/dashboard mount. `GET /api/worktrunk/status` resolves + probes the `wt` binary server-side, and on Windows `wt` collides with Windows Terminal (`wt.exe`), so an automatic probe pops Windows Terminal's native version/Help dialog just from opening Settings (field report Issue 4). Only auto-refresh when worktrunk integration is enabled — i.e. the user has opted in / requested it. `refresh` stays exposed so explicit UI actions can still check on demand. Backstop: probeWorktrunk (engine) also refuses to launch the Windows Terminal alias.
*/
export function useWorktrunkInstallStatus(projectId?: string, options?: { enabled?: boolean }) {
  const enabled = options?.enabled === true;
  const [status, setStatus] = useState<WorktrunkInstallStatusResponse>({ status: "missing" });
  const [requesting, setRequesting] = useState(false);

  // Returns the freshly-fetched status so callers (e.g. Save) can act on a
  // definitive result instead of the async-lagging `status` state — this closes
  // the enable-then-save race where a save fired before the probe returned would
  // otherwise read a stale "not verified" and silently drop the user's enable.
  const refresh = useCallback(async (): Promise<WorktrunkInstallStatusResponse> => {
    try {
      const next = await requestJson<WorktrunkInstallStatusResponse>(withProjectId("/api/worktrunk/status", projectId));
      setStatus(next);
      return next;
    } catch (err) {
      const failed: WorktrunkInstallStatusResponse = {
        status: "failed",
        error: err instanceof Error ? err.message : "Failed to load worktrunk status",
      };
      setStatus(failed);
      return failed;
    }
  }, [projectId]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    const unsubscribe = subscribeSse(withProjectId("/api/events", projectId), {
      events: {
        "approval:updated": () => {
          if (status.pendingApprovalId) void refresh();
        },
        "approval:decided": () => {
          if (status.pendingApprovalId) void refresh();
        },
      },
    });
    return unsubscribe;
  }, [projectId, refresh, status.pendingApprovalId]);

  const requestInstall = useCallback(async () => {
    setRequesting(true);
    setStatus((current) => ({ ...current, status: "installing", error: undefined }));
    try {
      const result = await requestJson<WorktrunkInstallStatusResponse & { approvalRequestId?: string }>(
        withProjectId("/api/worktrunk/install-request", projectId),
        { method: "POST", body: JSON.stringify({}) },
      );
      setStatus({
        status: result.status,
        version: result.version,
        installPath: result.installPath,
        pendingApprovalId: result.pendingApprovalId ?? result.approvalRequestId,
        error: result.error,
      });
    } catch (err) {
      setStatus({ status: "failed", error: err instanceof Error ? err.message : "Failed to request install" });
    } finally {
      setRequesting(false);
    }
  }, [projectId]);

  return {
    ...status,
    refresh,
    requestInstall,
    requesting,
  };
}
