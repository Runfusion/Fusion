# @fusion/tui

Terminal UI components for fn, built with [Ink](https://github.com/vadimdemedes/ink) (React for the command line).

## Status

This package is under active development and not yet published.

## Installation

This package is part of the fn workspace and is not installed separately. It is available as a private workspace package.

## API Reference

### FusionProvider

The `FusionProvider` component initializes a `TaskStore` and provides it via React context.

```tsx
import { FusionProvider } from "@fusion/tui";

function App() {
  return (
    <FusionProvider>
      <MyComponent />
    </FusionProvider>
  );
}
```

#### Props

| Prop | Type | Description |
|------|------|-------------|
| `projectDir` | `string` (optional) | Explicit project directory override. When provided, skips auto-detection. |
| `children` | `React.ReactNode` | Child components that will have access to the Fusion context. |

#### Behavior

- On mount, auto-detects the Fusion project by walking up from `process.cwd()` looking for `.fusion/fusion.db`
- If no project is found, renders a red error message
- On unmount, calls `store.close()` to cleanly shut down the SQLite connection

### useFusion

Hook to access the Fusion context. Must be used within a `FusionProvider`.

```tsx
import { useFusion } from "@fusion/tui";

function TaskList() {
  const { store, projectPath } = useFusion();

  useEffect(() => {
    store.listTasks().then((tasks) => {
      // Render tasks...
    });
  }, [store]);

  return <Text>Project: {projectPath}</Text>;
}
```

#### Returns

| Property | Type | Description |
|----------|------|-------------|
| `store` | `TaskStore` | The initialized TaskStore instance |
| `projectPath` | `string` | Absolute path to the project directory |

#### Throws

`Error` if used outside of a `FusionProvider`.

### detectProjectDir

Detect the Fusion project root directory by walking up from a starting path.

```typescript
import { detectProjectDir } from "@fusion/tui";

// Find project from current directory
const projectPath = detectProjectDir();

// Find project from a specific directory
const projectPath = detectProjectDir("/Users/me/code/my-project/src");
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `startPath` | `string` (optional) | Starting directory for the search (defaults to `process.cwd()`) |

#### Returns

The absolute path to the project root, or `null` if no project directory is detected.

## Example

```tsx
import React from "react";
import { render, Box, Text } from "ink";
import { FusionProvider, useFusion } from "@fusion/tui";

function ProjectInfo() {
  const { store, projectPath } = useFusion();
  const [tasks, setTasks] = React.useState<Task[]>([]);

  React.useEffect(() => {
    store.listTasks().then(setTasks);
  }, [store]);

  return (
    <Box flexDirection="column">
      <Text>Project: {projectPath}</Text>
      <Text>Tasks: {tasks.length}</Text>
    </Box>
  );
}

render(
  <FusionProvider>
    <ProjectInfo />
  </FusionProvider>
);
```
