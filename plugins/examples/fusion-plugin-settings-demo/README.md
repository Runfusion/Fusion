# Settings Demo Plugin

Example Fusion plugin demonstrating settings schema, hooks, and tools with configurable behavior.

## Features

- **Settings Schema**: Four different setting types (string, number, boolean, enum)
- **Lifecycle Hooks**: `onLoad`, `onTaskCreated`, `onTaskCompleted` that read settings at runtime
- **Plugin Tools**: Two AI-agent-callable tools that expose settings-driven functionality

## Installation via Dashboard Settings

### Method 1: Settings → Plugins (Recommended)

1. Open the Fusion dashboard
2. Navigate to **Settings** (gear icon in header)
3. Click **Plugins** in the sidebar
4. Click the **Install** button
5. Enter the absolute path to this plugin directory:
   ```
   /absolute/path/to/plugins/examples/fusion-plugin-settings-demo
   ```
6. Click **Install** to register the plugin
7. The plugin will appear in the list with state "installed"
8. Click the toggle to enable the plugin
9. Click the **Settings** (gear) icon to configure the plugin:
   - **Greeting Message**: Custom message shown when plugin loads
   - **Max Tags**: Maximum tags to suggest per task (1-10)
   - **Enable Logging**: Toggle console logging on/off
   - **Log Level**: Minimum log level (debug, info, warn, error)
10. Click **Save Settings** to apply configuration
11. The plugin will reload with the new settings

### Method 2: Manual Installation

```bash
# Clone the repository
git clone https://github.com/gsxdsm/fusion.git
cd fusion/plugins/examples/fusion-plugin-settings-demo
```

Then use the dashboard Settings → Plugins UI to install from the local path.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `greetingMessage` | string | "Hello from Settings Demo!" | Custom greeting shown on load |
| `maxTags` | number | 3 | Maximum tags to suggest per task |
| `enableLogging` | boolean | true | Enable/disable console logging |
| `logLevel` | enum | "info" | Minimum log level: debug, info, warn, error |

## Tools

### `settings_demo_suggest_tags`

Analyze a task description and suggest relevant tags based on keyword matching.

**Parameters:**
- `taskDescription` (string, required): The task description to analyze

**Returns:** Suggested tags separated by commas

### `settings_demo_status`

Get the current plugin configuration status.

**Parameters:** None

**Returns:** Current settings values

## Hooks

| Hook | When | What it does |
|------|------|--------------|
| `onLoad` | Plugin starts | Logs greeting message and configuration |
| `onTaskCreated` | New task created | Suggests tags for tasks with descriptions |
| `onTaskCompleted` | Task reaches "done" | Logs completion message |

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build (if needed)
pnpm build
```

## Project Structure

```
fusion-plugin-settings-demo/
├── manifest.json           # Plugin metadata and settings schema
├── package.json            # Package configuration
├── tsconfig.json           # TypeScript configuration
├── vitest.config.ts        # Test configuration
├── README.md               # This file
└── src/
    ├── index.ts            # Plugin implementation
    └── __tests__/
        └── index.test.ts    # Plugin tests
```

## Testing

The plugin includes unit tests that verify:

- Manifest correctness and metadata consistency
- Plugin export validity
- Settings schema definition
- Hook behavior with different configuration values
- Tool execution with settings-driven output

Run tests:
```bash
pnpm test
```

## Example Usage

After installing and configuring the plugin:

1. Create a new task with description mentioning keywords like "bug", "fix", "performance"
2. The plugin will suggest relevant tags based on the content
3. Check the console logs (if enabled) to see plugin activity
4. Use the `/settings_demo_suggest_tags` tool to get tag suggestions
5. Use the `/settings_demo_status` tool to see current configuration

## Notes

- The plugin uses `src/index.ts` as the entrypoint for local installation
- Settings changes trigger a plugin reload automatically
- Hook errors are isolated and won't crash the host system
- Tools use the current settings values at execution time
