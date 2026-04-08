/** @fusion/tui — Terminal UI components for fn */

import { render, Text } from "ink";
import React from "react";

/** Main application component for dev mode */
function App() {
  return <Text>Hello from @fusion/tui!</Text>;
}

// When run directly via `pnpm dev`, render the app
render(<App />);
