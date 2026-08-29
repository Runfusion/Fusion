/**
 * useNodeProxy hook - provides a proxy-aware fetch function that routes API calls
 * through the node proxy when viewing a remote node.
 */

import { useCallback } from "react";
import { proxyApi } from "../api";
import { useNodeContext } from "../context/NodeContext";

export interface UseNodeProxyResult {
  /**
   * Make an API request, optionally routing through the node proxy for remote nodes.
   * When a remote node is active, requests are routed through /api/proxy/:nodeId/...
   */
  proxyFetch: <T>(path: string, opts?: RequestInit) => Promise<T>;
  /** The current node ID or null if viewing local node */
  currentNodeId: string | null;
  /** Whether the current view is a remote node */
  isRemote: boolean;
}

/**
 * Hook that provides proxy-aware API fetching.
 * Returns a proxyFetch function that automatically routes requests through the
 * node proxy when viewing a remote node.
 */
export function useNodeProxy(): UseNodeProxyResult {
  const { currentNodeId, isRemote } = useNodeContext();

  const proxyFetch = useCallback(
    <T>(path: string, opts?: RequestInit): Promise<T> => {
      // Only route through proxy when viewing a remote node
      // When local or no node set, proxyApi will call the direct API
      return proxyApi<T>(path, {
        ...opts,
        nodeId: isRemote ? currentNodeId ?? undefined : undefined,
      });
    },
    [currentNodeId, isRemote],
  );

  return {
    proxyFetch,
    currentNodeId,
    isRemote,
  };
}
