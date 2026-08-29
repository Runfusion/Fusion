# Auto-Label Plugin

Automatically labels tasks based on their description content using keyword matching. Also provides an AI agent tool for manual text classification.

## Features

- **Automatic Classification**: Labels tasks as they're created based on keywords in the description
- **Multiple Categories**: Supports bug, feature, documentation, testing, refactor, and performance labels
- **AI Agent Tool**: Provides `auto_label_classify` tool for AI agents to classify text
- **Event Emission**: Emits `auto-label:classified` events for integration with other plugins

## Installation

### Option 1: Copy to plugins directory

```bash
cp -r fusion-plugin-auto-label ~/.fusion/plugins/
```

### Option 2: Install via CLI

```bash
fn plugin install /path/to/fusion-plugin-auto-label
```

## Categories

The plugin classifies text into the following categories:

| Category | Keywords |
|---------|----------|
| `bug` | bug, fix, broken, crash, error |
| `feature` | feature, add, new, implement |
| `documentation` | docs, documentation, readme, guide |
| `testing` | test, testing, spec, coverage |
| `refactor` | refactor, cleanup, clean up, reorganize |
| `performance` | perf, performance, optimize, slow |

## How It Works

### Automatic Classification (onTaskCreated hook)

When a task is created, the plugin:
1. Scans the task description for keywords
2. Matches against category rules
3. Logs the matched labels
4. Emits an `auto-label:classified` event with the task ID and labels

### AI Agent Tool

The plugin provides an `auto_label_classify` tool that AI agents can use:

```javascript
{
  name: "auto_label_classify",
  description: "Classify a text description into categories...",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to classify" }
    },
    required: ["text"]
  }
}
```

Example usage:
```
Use auto_label_classify with text: "Fix the login bug"
```

## Configuration

This plugin has no required settings. It works out of the box with its built-in keyword rules.

## Events

The plugin emits the following events:

| Event | Data | Description |
|-------|------|-------------|
| `auto-label:classified` | `{ taskId, labels }` | Emitted when a task is classified |

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build
```

## License

MIT
