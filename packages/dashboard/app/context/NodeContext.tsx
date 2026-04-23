/**
 * NodeContext provides React context for tracking which node the dashboard is currently viewing.
 * This enables seamless routing of API calls through the proxy when viewing remote nodes.
 * Persists the selected node ID to global settings (server-backed) instead of localStorage.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { NodeConfig } from "@fusion/core";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";

// Legacy localStorage key for migration - no longer used as primary storage
const LEGACY_STORAGE_KEY = "fusion-dashboard-current-node";

export interface NodeContextValue {
  /** Currently selected node or null if viewing local node */
  currentNode: NodeConfig | null;
  /** Currently selected node ID or null if viewing local node */
  currentNodeId: string | null;
  /** Whether the current view is a remote node */
  isRemote: boolean;
  /** Set the current node to view */
  setCurrentNode: (node: NodeConfig | null) => void;
  /** Clear the current node selection (return to local view) */
  clearCurrentNode: () => void;
}

const NodeContext = createContext<NodeContextValue | null>(null);

export interface NodeProviderProps {
  children: React.ReactNode;
}

/**
 * Provider component that manages the current node state.
 * Persists the selected nodeId to global settings and derives isRemote from node type.
 * This enables PWA fresh sessions to restore the correct node context.
 */
export function NodeProvider({ children }: NodeProviderProps) {
  const [currentNode, setCurrentNodeState] = useState<NodeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  // Track if we've hydrated from global settings
  const hydratedRef = useRef(false);
  // Cache of current settings to avoid repeated fetches
  const settingsCacheRef = useRef<string | undefined>(undefined);

  // Load from global settings on mount
  useEffect(() => {
    let cancelled = false;

    async function loadFromGlobalSettings() {
      try {
        const settings = await fetchGlobalSettings();

        if (cancelled) return;

        // Cache the current node ID
        settingsCacheRef.current = settings.dashboardCurrentNodeId;

        const savedNodeId = settings.dashboardCurrentNodeId;
        if (savedNodeId) {
          // We don't have the full NodeConfig from settings, just the ID
          // The App.tsx will resolve the full node from the nodes list
          // We just need to indicate that a remote node is selected
          hydratedRef.current = true;
        }

        // Also migrate legacy localStorage if no global settings entry exists
        if (!savedNodeId) {
          try {
            const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacy) {
              const parsed = JSON.parse(legacy) as NodeConfig;
              if (parsed?.id && parsed?.type === "remote") {
                // Migrate to global settings
                settingsCacheRef.current = parsed.id;
                await updateGlobalSettings({ dashboardCurrentNodeId: parsed.id }).catch(() => {
                  // Non-critical - migration failed
                });
              }
            }
          } catch {
            // Ignore legacy localStorage errors
          }
        }
      } catch {
        // Global settings fetch failed - non-critical
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadFromGlobalSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  // Sync remote node selection to global settings
  useEffect(() => {
    if (loading) return;

    // Only persist if we've hydrated and have a remote node
    if (currentNode && currentNode.type === "remote" && currentNode.id) {
      const newId = currentNode.id;
      if (settingsCacheRef.current !== newId) {
        settingsCacheRef.current = newId;
        updateGlobalSettings({ dashboardCurrentNodeId: newId }).catch(() => {
          // Non-critical - persistence failed
        });
      }
    } else if (currentNode === null && settingsCacheRef.current !== undefined) {
      // Clear the node selection
      settingsCacheRef.current = undefined;
      updateGlobalSettings({ dashboardCurrentNodeId: undefined }).catch(() => {
        // Non-critical - persistence failed
      });
    }
  }, [currentNode, loading]);

  const setCurrentNode = useCallback((node: NodeConfig | null) => {
    setCurrentNodeState(node);
  }, []);

  const clearCurrentNode = useCallback(() => {
    setCurrentNodeState(null);
    // Clear from cache immediately for responsiveness
    settingsCacheRef.current = undefined;
    updateGlobalSettings({ dashboardCurrentNodeId: undefined }).catch(() => {
      // Non-critical - persistence failed
    });
  }, []);

  const value: NodeContextValue = {
    currentNode,
    currentNodeId: currentNode?.id ?? null,
    isRemote: currentNode !== null && currentNode.type === "remote",
    setCurrentNode,
    clearCurrentNode,
  };

  return <NodeContext.Provider value={value}>{children}</NodeContext.Provider>;
}

/**
 * Hook to access the current node context.
 * @throws Error if used outside of NodeProvider
 */
export function useNodeContext(): NodeContextValue {
  const context = useContext(NodeContext);
  if (context === null) {
    throw new Error("useNodeContext must be used within a NodeProvider");
  }
  return context;
}
