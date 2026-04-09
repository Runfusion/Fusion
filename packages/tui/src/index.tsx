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

import React from "react";
import { render, Box, Text } from "ink";
import { FusionProvider, useFusion } from "./fusion-context.js";

/**
 * Demo application showing FusionProvider + useFusion usage.
 * Displays the detected project path when run directly.
 */
function DemoApp() {
  const { projectPath } = useFusion();
  return (
    <Box flexDirection="column">
      <Text>Project: {projectPath}</Text>
    </Box>
  );
}

// When run directly via `pnpm dev`, render the app
render(
  <FusionProvider>
    <DemoApp />
  </FusionProvider>
);
