/**
 * useRemoteNodeEvents hook - subscribes to SSE events from a remote node via the proxy.
 */

import { useEffect, useState } from "react";
import { subscribeSse } from "../sse-bus";

export interface RemoteNodeEvent {
  type: string;
  data: unknown;
}

export interface UseRemoteNodeEventsResult {
  /** Whether the SSE connection is currently active */
  isConnected: boolean;
  /** The last received event, or null if no events received */
  lastEvent: RemoteNodeEvent | null;
}

/**
 * Hook for subscribing to SSE events from a remote node via the proxy.
 * Uses the shared SSE bus for connection multiplexing, heartbeat, and reconnection.
 */
export function useRemoteNodeEvents(nodeId: string | null): UseRemoteNodeEventsResult {
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<RemoteNodeEvent | null>(null);

  useEffect(() => {
    if (!nodeId) {
      setIsConnected(false);
      setLastEvent(null);
      return;
    }

    const url = `/api/proxy/${encodeURIComponent(nodeId)}/events`;

    return subscribeSse(url, {
      events: {
        "task:created": (e: MessageEvent) => {
          setLastEvent({ type: "task:created", data: e.data });
        },
        "task:moved": (e: MessageEvent) => {
          setLastEvent({ type: "task:moved", data: e.data });
        },
        "task:updated": (e: MessageEvent) => {
          setLastEvent({ type: "task:updated", data: e.data });
        },
        // FN-5135: dashboard treats deletedAt-bearing task events as delete-equivalent,
        // so task:deleted remains a load-bearing remote signal for cross-node refreshes.
        "task:deleted": (e: MessageEvent) => {
          setLastEvent({ type: "task:deleted", data: e.data });
        },
        "task:merged": (e: MessageEvent) => {
          setLastEvent({ type: "task:merged", data: e.data });
        },
      },
      onOpen: () => setIsConnected(true),
      onError: () => setIsConnected(false),
      /*
      FNXC:RemoteNodeEvents 2026-07-26-15:10:
      Explicit opt-out of the sse-bus resync contract. This hook is a pure relay: it holds no
      accumulated state a missed event could corrupt — only `isConnected` (re-derived by onOpen/
      onError) and `lastEvent`, which is a transient "something changed on the remote node" nudge
      with no proxy endpoint to refetch. Consumers that need authoritative remote state must fetch it
      themselves; if this hook ever accumulates a list or count, it needs a real onReconnect instead.
      */
      replaySafe: { reason: "relay-only: no accumulated state, isConnected re-derived on open" },
    });
  }, [nodeId]);

  return {
    isConnected,
    lastEvent,
  };
}
