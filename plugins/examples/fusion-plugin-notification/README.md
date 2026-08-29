# Notification Plugin

Sends webhook notifications on Fusion task lifecycle events (task completed, task moved, errors).

## Features

- **Webhook Notifications**: Send notifications to Slack, Discord, or generic HTTP endpoints
- **Event Filtering**: Configure which events trigger notifications
- **Multiple Webhook Formats**: Native support for Slack and Discord webhook payloads

## Installation

### Option 1: Copy to plugins directory

```bash
cp -r fusion-plugin-notification ~/.fusion/plugins/
```

### Option 2: Install via CLI

```bash
fn plugin install /path/to/fusion-plugin-notification
```

## Configuration

After installation, configure the plugin through the Fusion dashboard:

1. Go to **Settings → Plugins**
2. Find "Notification Plugin" and click the settings icon
3. Set your webhook URL and preferred webhook type
4. Optionally filter which events trigger notifications

### Settings Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `webhookUrl` | string | Yes | — | URL to send webhook notifications to |
| `webhookType` | enum | No | `generic` | Webhook payload format: `slack`, `discord`, or `generic` |
| `events` | string | No | (all) | Comma-separated list of events: `task-completed`, `task-moved`, `task-failed`. Empty = all events |

### Example Settings (JSON)

```json
{
  "webhookUrl": "https://hooks.slack.com/services/XXX/YYY/ZZZ",
  "webhookType": "slack",
  "events": "task-completed,task-moved"
}
```

## Webhook Payload Formats

### Slack

```json
{
  "text": "✅ Task completed: Fix login bug"
}
```

### Discord

```json
{
  "content": "✅ Task completed: Fix login bug"
}
```

### Generic

```json
{
  "event": "task-completed",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "task": {
    "id": "FN-001",
    "title": "Fix login bug",
    "from": "todo",
    "to": "done"
  }
}
```

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
