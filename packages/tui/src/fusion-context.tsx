/**
 * FusionContext - React context provider for Fusion TaskStore access in TUI.
 *
 * Provides a centralized way to initialize and access the TaskStore
 * across the TUI application, with automatic project detection and
 * clean lifecycle management.
 */

import React, { createContext, useContext, useState, useEffect } from "react";
import { Text } from "ink";
import { TaskStore } from "@fusion/core";
import { detectProjectDir } from "./project-detect.js";

/**
 * The shape of the value provided by FusionContext.
 */
export interface FusionContextValue {
  /** The initialized TaskStore instance */
  store: TaskStore;
  /** Absolute path to the project directory */
  projectPath: string;
}

/**
 * React context for Fusion TaskStore access.
 * Use `useFusion()` hook to access the context value.
 */
export const FusionContext = createContext<FusionContextValue | null>(null);

/**
 * Props for the FusionProvider component.
 */
export interface FusionProviderProps {
  /**
   * Explicit project directory override.
   * When provided, skips auto-detection and uses this path directly.
   * Useful for `--project` flag support in future CLI integration.
   */
  projectDir?: string;
  /** Child components that will have access to the Fusion context */
  children: React.ReactNode;
}

/**
 * Internal state shape for the provider's state management.
 */
interface ProviderState {
  store: TaskStore | null;
  projectPath: string;
  error: string | null;
  ready: boolean;
}

/**
 * FusionProvider initializes a TaskStore and provides it via React context.
 *
 * On mount, it either uses an explicit `projectDir` prop or auto-detects
 * the project by walking up from the current working directory.
 *
 * - If no project is found, renders a red error message
 * - If a project is found, initializes the TaskStore and provides it
 * - On unmount, closes the SQLite connection
 *
 * @example
 * ```tsx
 * import { FusionProvider, useFusion } from "./fusion-context";
 *
 * function MyApp() {
 *   return (
 *     <FusionProvider>
 *       <TaskList />
 *     </FusionProvider>
 *   );
 * }
 *
 * function TaskList() {
 *   const { store, projectPath } = useFusion();
 *   // Use store to interact with tasks...
 * }
 * ```
 */
export function FusionProvider({ projectDir, children }: FusionProviderProps): React.ReactNode {
  const [state, setState] = useState<ProviderState>({
    store: null,
    projectPath: "",
    error: null,
    ready: false,
  });

  useEffect(() => {
    let store: TaskStore | null = null;
    let cancelled = false;

    async function initialize() {
      // Determine project directory
      const detectedPath = projectDir ?? detectProjectDir();

      if (!detectedPath) {
        setState({
          store: null,
          projectPath: "",
          error:
            "No Fusion project found in current directory. Run 'fn init' to initialize one, or navigate to a project directory.",
          ready: true,
        });
        return;
      }

      if (cancelled) return;

      // Create and initialize the TaskStore
      store = new TaskStore(detectedPath);

      try {
        await store.init();
      } catch (err) {
        if (cancelled) return;
        setState({
          store: null,
          projectPath: detectedPath,
          error: `Failed to initialize TaskStore: ${err instanceof Error ? err.message : String(err)}`,
          ready: true,
        });
        return;
      }

      if (cancelled) {
        // Clean up if we were cancelled after init
        await store.close();
        return;
      }

      setState({
        store,
        projectPath: detectedPath,
        error: null,
        ready: true,
      });
    }

    initialize();

    // Cleanup function: close the store on unmount
    return () => {
      cancelled = true;
      if (store) {
        store.close();
      }
    };
  }, [projectDir]);

  // Render null during initialization
  if (!state.ready) {
    return null;
  }

  // Render error message if initialization failed
  if (state.error) {
    return <Text color="red">{state.error}</Text>;
  }

  // Render the provider with context value
  return (
    <FusionContext.Provider value={{ store: state.store!, projectPath: state.projectPath }}>
      {children}
    </FusionContext.Provider>
  );
}

/**
 * Hook to access the Fusion context.
 *
 * @throws Error if used outside of a FusionProvider
 * @returns The FusionContextValue containing the TaskStore and project path
 *
 * @example
 * ```tsx
 * function TaskList() {
 *   const { store, projectPath } = useFusion();
 *   const [tasks, setTasks] = useState<Task[]>([]);
 *
 *   useEffect(() => {
 *     store.listTasks().then(setTasks);
 *   }, [store]);
 *
 *   return (
 *     <Box>
 *       <Text>Project: {projectPath}</Text>
 *       {tasks.map(task => (
 *         <Text key={task.id}>{task.id}: {task.description}</Text>
 *       ))}
 *     </Box>
 *   );
 * }
 * ```
 */
export function useFusion(): FusionContextValue {
  const ctx = useContext(FusionContext);
  if (!ctx) {
    throw new Error("useFusion must be used within a <FusionProvider>");
  }
  return ctx;
}
