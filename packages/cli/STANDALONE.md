# Standalone CLI

Fusion works as a standalone CLI without pi. This is useful for CI environments, scripting, or if you prefer working from the terminal.

## Installation

```bash
npm install -g @dustinbyrne/kb
```

## Authentication

Fusion uses [pi](https://github.com/badlogic/pi-mono) for AI agent sessions and reuses your existing pi authentication. You can also authenticate directly through the dashboard UI.

If you don't have pi set up yet: `npm i -g @mariozechner/pi-coding-agent && pi` then `/login`.

## Usage

### Start the dashboard

Launch the web UI and AI engine:

```bash
fn dashboard
fn dashboard --port 8080
fn dashboard --interactive     # Interactive port selection (prompts for port)
fn dashboard --paused        # Start with automation paused (review before work begins)
fn dashboard --dev           # Start web UI only (no AI engine)
```

### Multi-Instance Deployments

When deploying the dashboard behind a load balancer with multiple instances, configure Redis pub/sub for real-time badge updates across instances:

```bash
# Set Redis URL for cross-instance badge synchronization
export KB_BADGE_PUBSUB_REDIS_URL="redis://redis.example.com:6379"

# Optional: customize the pub/sub channel (default: kb:badge-updates)
export KB_BADGE_PUBSUB_CHANNEL="my-app-badge-updates"

fn dashboard
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
fn task create "Fix the login redirect bug"
fn task create "Update hero section" --attach screenshot.png --attach design.pdf
```

### Manage tasks

```bash
fn task list                        # List all tasks
fn task show KB-001                 # Show task details, steps, and log
fn task move KB-001 todo            # Move a task to a column
fn task merge KB-001                # Merge an in-review task and close it
fn task log KB-001 "Added context"  # Add a log entry
fn task pause KB-001                # Pause a task (stops automation)
fn task unpause KB-001              # Resume a paused task
fn task attach KB-001 ./error.log   # Attach a file to a task
fn task import owner/repo           # Import GitHub issues as tasks
fn task import owner/repo --limit 10 --labels "bug,enhancement"
```

### Typical workflow

```bash
# 1. Create a task — it lands in triage
fn task create "Add dark mode support"

# 2. Start the dashboard — AI specs the task and begins working
fn dashboard

# 3. Check progress
fn task list
fn task show KB-042

# 4. When it reaches "in-review", review the changes and merge
fn task merge KB-042
```

## Standalone binary

Prebuilt standalone binaries are available that require no Node.js runtime. You can also build one yourself with [Bun](https://bun.sh/):

```bash
bun run build.ts
```

### Runtime Assets

When using standalone binaries, the dashboard's integrated terminal requires native platform assets that must be co-located with the binary:

```
dist/
├── kb                    # Binary (or kb-darwin-arm64, kb-linux-x64, etc.)
├── client/               # Dashboard web assets (required)
└── runtime/              # Native terminal assets (required for terminal)
    └── darwin-arm64/     # Platform-specific subdirectory
        ├── pty.node      # Native PTY module
        └── spawn-helper  # Unix spawn helper (macOS/Linux only)
```

**Platform-specific subdirectories:**
- `darwin-arm64/` - macOS Apple Silicon
- `darwin-x64/` - macOS Intel  
- `linux-arm64/` - Linux ARM64
- `linux-x64/` - Linux x64
- `win32-x64/` - Windows x64

**Important:** When distributing or moving the binary, ensure the `client/` and `runtime/` directories are copied alongside it. Terminal functionality will be unavailable if runtime assets are missing.

See the [GitHub repository](https://github.com/dustinbyrne/kb) for platform-specific binaries and build instructions.
