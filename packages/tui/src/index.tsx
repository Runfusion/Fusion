/**
 * @fusion/tui — Terminal UI components for fn
 *
 * This package provides Ink-based React components for building terminal
 * user interfaces that interact with Fusion task management.
 */

// Re-export FusionContext components and hooks
export { FusionProvider, useFusion, FusionContext } from "./fusion-context.js";
export type { FusionContextValue, FusionProviderProps } from "./fusion-context.js";

// Re-export project detection utility
export { detectProjectDir } from "./project-detect.js";

// Re-export components
export {
  ScreenRouter,
  SCREENS,
  getScreenById,
  getScreenIndex,
  type ScreenId,
  type Screen,
  type ScreenRouterProps,
  type ScreenComponentProps,
} from "./components/screen-router.js";

export {
  ResponsiveHeader,
  ResponsiveTable,
  ResponsiveTaskRow,
  ResponsiveStatusBar,
  type TableColumn,
  type ResponsiveTableProps,
  type ResponsiveTaskRowProps,
} from "./components/responsive-layout.js";

// Re-export global shortcuts hooks
export {
  useGlobalShortcuts,
  HelpOverlay,
  FocusGuardRef,
  type UseGlobalShortcutsOptions,
  type UseGlobalShortcutsResult,
  type HelpOverlayProps,
} from "./hooks/use-global-shortcuts.js";

import React, { useState } from "react";
import { render, Box, Text } from "ink";
import { FusionProvider, useFusion } from "./fusion-context.js";
import { ScreenRouter, type ScreenId } from "./components/screen-router.js";
import { useGlobalShortcuts, HelpOverlay } from "./hooks/use-global-shortcuts.js";
import { ResponsiveHeader, ResponsiveTable, ResponsiveStatusBar } from "./components/responsive-layout.js";
import { fileURLToPath } from "url";

/**
 * Demo application showing FusionProvider + ScreenRouter usage.
 * Renders the screen router with placeholder screens for each tab.
 * This demo only runs when the file is executed directly (not when imported).
 */
function DemoApp() {
  const { projectPath } = useFusion();
  const [activeScreen, setActiveScreen] = useState<ScreenId>("board");

  // Global keyboard shortcuts - handles Ctrl+C, q, ?/h, 1-5
  const { helpVisible, toggleHelp } = useGlobalShortcuts({
    onScreenChange: setActiveScreen,
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Help Overlay - shown when toggled, displayed at top */}
      {helpVisible && (
        <Box marginBottom={1}>
          <HelpOverlay onClose={toggleHelp} />
        </Box>
      )}

      {/* Responsive Header */}
      <ResponsiveHeader title={`Fusion TUI | Project: ${projectPath}`} />

      {/* Screen Router */}
      <ScreenRouter
        activeScreen={activeScreen}
        onScreenChange={setActiveScreen}
      >
        {({ activeScreen }) => (
          <Box flexDirection="column" flexGrow={1}>
            {activeScreen === "board" && (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Board Screen</Text>
                <Text dimColor>View and manage tasks on the kanban board</Text>

                {/* Demo: Responsive Task Table */}
                <Box marginTop={1}>
                  <ResponsiveTable
                    columns={[
                      { header: "ID", minWidth: 10 },
                      { header: "Description", minWidth: 30, canGrow: true, preferredWidth: 60 },
                      { header: "Status", minWidth: 12 },
                      { header: "Size", minWidth: 6 },
                    ]}
                    rows={[
                      ["FN-001", "Implement user authentication with OAuth 2.0 integration", "todo", "M"],
                      ["FN-002", "Fix memory leak in data processing pipeline caused by missing cleanup handlers", "in-progress", "L"],
                      ["FN-003", "Update documentation", "done", "S"],
                      ["FN-004", "Refactor API endpoints to use REST conventions and add proper error handling with retry logic", "review", "M"],
                    ]}
                  />
                </Box>
              </Box>
            )}
            {activeScreen === "detail" && (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Detail Screen</Text>
                <Text dimColor>View and edit individual task details</Text>
              </Box>
            )}
            {activeScreen === "activity" && (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Activity Screen</Text>
                <Text dimColor>View recent activity and events</Text>
              </Box>
            )}
            {activeScreen === "agents" && (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Agents Screen</Text>
                <Text dimColor>Manage AI agents and their configurations</Text>
              </Box>
            )}
            {activeScreen === "settings" && (
              <Box flexDirection="column" paddingY={1}>
                <Text bold>Settings Screen</Text>
                <Text dimColor>Configure project settings and preferences</Text>
              </Box>
            )}
          </Box>
        )}
      </ScreenRouter>

      {/* Responsive Status Bar */}
      <ResponsiveStatusBar />
    </Box>
  );
}

// Guard: only render if this file is being executed directly (not imported)
const currentFile = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] !== undefined && currentFile === process.argv[1];
const isDevRun = process.argv[1]?.includes("index.tsx");

if (isMainModule || isDevRun) {
  render(
    <FusionProvider>
      <DemoApp />
    </FusionProvider>
  );
}
