# Standalone CLI

kb works as a standalone CLI without pi. This is useful for CI environments, scripting, or if you prefer working from the terminal.

## Installation

```bash
npm install -g @dustinbyrne/kb
```

## Authentication

kb uses [pi](https://github.com/badlogic/pi-mono) for AI agent sessions and reuses your existing pi authentication. You can also authenticate directly through the dashboard UI.

If you don't have pi set up yet: `npm i -g @mariozechner/pi-coding-agent && pi` then `/login`.

## Usage

### Start the dashboard

Launch the web UI and AI engine:

```bash
kb dashboard
kb dashboard --port 8080
kb dashboard --interactive     # Interactive port selection (prompts for port)
kb dashboard --paused        # Start with automation paused (review before work begins)
kb dashboard --dev           # Start web UI only (no AI engine)
```

### Multi-Instance Deployments

When deploying the dashboard behind a load balancer with multiple instances, configure Redis pub/sub for real-time badge updates across instances:

```bash
# Set Redis URL for cross-instance badge synchronization
export KB_BADGE_PUBSUB_REDIS_URL="redis://redis.example.com:6379"

# Optional: customize the pub/sub channel (default: kb:badge-updates)
export KB_BADGE_PUBSUB_CHANNEL="my-app-badge-updates"

kb dashboard
```

With this configuration, PR/issue badge updates received via webhook on one instance are delivered to subscribed WebSocket clients on all instances.

### GitHub App Webhook Setup

For real-time PR/issue badge updates, configure a GitHub App to push updates to the dashboard:

**Required Environment Variables:**
```bash
export KB_GITHUB_APP_ID="123456"
export KB_GITHUB_APP_PRIVATE_KEY_PATH="/path/to/private-key.pem"
# Or: export KB_GITHUB_APP_PRIVATE_KEY="$(cat /path/to/private-key.pem)"
export KB_GITHUB_WEBHOOK_SECRET="your-webhook-secret"
```

**GitHub App Configuration:**
1. Create a GitHub App at Settings → Developer settings → GitHub Apps
2. Set the **Webhook URL** to `https://your-domain/api/github/webhooks`
3. Generate and download a **Private Key**
4. Configure these **Permissions**:
   - Metadata: Read
   - Pull requests: Read
   - Issues: Read
5. Subscribe to these **Webhook Events**:
   - Pull request
   - Issues
   - Issue comment

**Minimum Permissions Summary:**
| Permission | Level | Purpose |
|------------|-------|---------|
| Metadata | Read | Access repository metadata |
| Pull requests | Read | Fetch PR status, title, comments |
| Issues | Read | Fetch issue status, title, state |

**Fallback Behavior:**
When webhooks are not configured or delivery fails, the dashboard falls back to the 5-minute background refresh on the PR/issue status endpoints. The 5-minute staleness window ensures reasonably fresh data even without webhooks.

### Create a task

```bash
kb task create "Fix the login redirect bug"
kb task create "Update hero section" --attach screenshot.png --attach design.pdf
```

### Manage tasks

```bash
kb task list                        # List all tasks
kb task show KB-001                 # Show task details, steps, and log
kb task move KB-001 todo            # Move a task to a column
kb task merge KB-001                # Merge an in-review task and close it
kb task log KB-001 "Added context"  # Add a log entry
kb task pause KB-001                # Pause a task (stops automation)
kb task unpause KB-001              # Resume a paused task
kb task attach KB-001 ./error.log   # Attach a file to a task
kb task import owner/repo           # Import GitHub issues as tasks
kb task import owner/repo --limit 10 --labels "bug,enhancement"
```

### Typical workflow

```bash
# 1. Create a task — it lands in triage
kb task create "Add dark mode support"

# 2. Start the dashboard — AI specs the task and begins working
kb dashboard

# 3. Check progress
kb task list
kb task show KB-042

# 4. When it reaches "in-review", review the changes and merge
kb task merge KB-042
```

## Standalone binary

Prebuilt standalone binaries are available that require no Node.js runtime. You can also build one yourself with [Bun](https://bun.sh/):

```bash
bun run build.ts
```

See the [GitHub repository](https://github.com/dustinbyrne/kb) for platform-specific binaries and build instructions.
