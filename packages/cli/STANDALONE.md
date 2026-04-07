# Standalone CLI

Fusion works as a standalone CLI without pi. This is useful for CI environments, scripting, or if you prefer working from the terminal.

## Installation

```bash
npm install -g @gsxdsm/fusion
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
export FUSION_BADGE_PUBSUB_REDIS_URL="redis://redis.example.com:6379"

# Optional: customize the pub/sub channel (default: fusion:badge-updates)
export FUSION_BADGE_PUBSUB_CHANNEL="my-app-badge-updates"

fn dashboard
```

With this configuration, PR/issue badge updates received via webhook on one instance are delivered to subscribed WebSocket clients on all instances.

### GitHub App Webhook Setup

For real-time PR/issue badge updates, configure a GitHub App to push updates to the dashboard:

**Required Environment Variables:**
```bash
export FUSION_GITHUB_APP_ID="123456"
export FUSION_GITHUB_APP_PRIVATE_KEY_PATH="/path/to/private-key.pem"
# Or: export FUSION_GITHUB_APP_PRIVATE_KEY="$(cat /path/to/private-key.pem)"
export FUSION_GITHUB_WEBHOOK_SECRET="your-webhook-secret"
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
fn task pr-create KB-001            # Create a GitHub PR for an in-review task
fn task pr-create KB-001 --title "Custom PR title" --base develop --body "PR description"
fn task log KB-001 "Added context"  # Add a log entry
fn task pause KB-001                # Pause a task (stops automation)
fn task unpause KB-001              # Resume a paused task
fn task attach KB-001 ./error.log   # Attach a file to a task
fn task import owner/repo           # Import GitHub issues as tasks
fn task import owner/repo --limit 10 --labels "bug,enhancement"
```

### Agent control

```bash
fn agent stop <agent-id>            # Stop (pause) a running agent
fn agent start <agent-id>           # Start (resume) a stopped agent
fn agent mailbox <agent-id>         # View an agent's mailbox
```

### Messaging

```bash
fn message inbox                    # List inbox messages
fn message outbox                   # List sent messages
fn message send <agent-id> <msg>    # Send a message to an agent
fn message read <id>                # Read a specific message
fn message delete <id>              # Delete a message
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

**Important:** When distributing or moving the binary, ensure the `client/` and `runtime/` directories are copied alongside it. Terminal functionality will gracefully degrade (return HTTP 503) if runtime assets are missing — the dashboard will continue to work but terminal sessions won't be available.

**How it works:**
When the dashboard starts from a Bun-compiled binary, it attempts to set up native module resolution so `node-pty` can find its platform-specific `.node` files. This involves:
1. Copying native assets to a temp directory (`/tmp/kb-bunfs-<pid>/kb/prebuilds/<platform>/`)
2. Attempting to create a symlink at `/$bunfs/root` pointing to the temp directory (Unix platforms)
3. If the symlink can't be created (e.g., macOS permissions), pre-loading the native module via `process.dlopen()`

If all resolution methods fail, terminal creation gracefully returns `null`, which the HTTP layer converts to a 503 Service Unavailable response.

**Cross-compilation:** Native assets are staged per-platform during build. When cross-compiling, only the target platform's assets are included. PTY functionality requires running on a platform with matching native assets.

### Known Bun `node:sqlite` Limitation

Bun-compiled standalone binaries may encounter a `No such built-in module: node:sqlite` error at startup. This happens because Bun's compiler does not include the full `node:sqlite` built-in module in all compilation targets.

**Impact:** When this error occurs, the binary exits immediately. This affects any command that initializes the SQLite-backed task store, including `dashboard`, `task list`, and `task create`. Commands that don't need the store (like `--help`) continue to work.

**Detection:** The startup validation test suite treats this specific error as an expected limitation — it is not misinterpreted as a generic dashboard startup failure. The test probe distinguishes between:

| Outcome | Behavior |
|---------|----------|
| Startup banner detected | Full test proceeds (PTY endpoint verification) |
| `node:sqlite` error in output | Test skips cleanly (known Bun limitation) |
| Other early exit | Test fails with diagnostic output |

Only the exact `node:sqlite` built-in module error is handled specially. Any other exit or crash during startup is treated as a real regression and fails the test with full process output for debugging.
