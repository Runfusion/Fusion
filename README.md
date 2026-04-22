# Fusion

AI-orchestrated task board — specify, execute, and deliver tasks automatically.

MIT licensed.

Like Trello, but your tasks get specified, executed, and delivered by AI — powered by [pi](https://github.com/badlogic/pi-mono).

![Fusion dashboard board](demo/screenshot.png)

_Fusion dashboard board view_

Fusion is built on the great work of [dustinbyrne/kb](https://github.com/dustinbyrne/kb).

**Fusion** turns rough ideas into production code. Describe a task, and an AI agent writes the spec, plans the implementation, writes the code in an isolated git worktree, and merges it — with automatic code review at every step. Manage a single project or coordinate across multiple repositories from one dashboard.

## Documentation

For detailed guides, see the [Documentation Index](./docs/README.md).

| Guide | What it covers |
|---|---|
| [Getting Started](./docs/getting-started.md) | Installation and onboarding |
| [Dashboard Guide](./docs/dashboard-guide.md) | Board/list views, terminal, git manager |
| [Task Management](./docs/task-management.md) | Task lifecycle and CLI commands |
| [Settings Reference](./docs/settings-reference.md) | Configuration options |
| [Architecture](./docs/architecture.md) | System internals |
| [Agents](./docs/agents.md) | Agent management, spawning, heartbeat |
| [Workflow Steps](./docs/workflow-steps.md) | Quality gates, templates, phases |
| [Missions](./docs/missions.md) | Mission hierarchy, planning, autopilot |
| [Multi-Project](./docs/multi-project.md) | Central registry, isolation modes |

For Docker deployment, see [docs/docker.md](./docs/docker.md).

## Quick Start

Start the local dashboard:

```bash
pnpm dev dashboard
```

Then click the `Open:` URL printed in the terminal. It embeds a bearer token
(`http://localhost:4040/?token=fn_...`) that the browser captures to
`localStorage` on first visit and reuses automatically thereafter. See
[CLI reference → fn dashboard → Authentication](./docs/cli-reference.md#fn-dashboard)
for how to pin a stable token via `FUSION_DASHBOARD_TOKEN` or opt out with
`--no-auth`.

### First-run Setup

On first launch, Fusion automatically opens the **onboarding wizard** with three guided steps:

1. **AI Setup** — Connect an AI provider and choose a default model
2. **GitHub (Optional)** — Connect GitHub for issue import and PR management
3. **First Task** — Create your first task or import from GitHub

The wizard is **dismissible and non-blocking** — click **Skip for now** to dismiss it and use the dashboard immediately. You can also re-trigger onboarding later from **Settings → Authentication → Reopen onboarding guide**.

### Mobile

For Capacitor + PWA workflow, see [MOBILE.md](./MOBILE.md).

## Workflow

```mermaid
graph TD
    H((You)) -->|rough idea| T["Triage\n<i>auto-specification</i>"]
    T --> TD["Todo\n<i>scheduled for execution</i>"]
    TD --> IP["In Progress\n<i>for each step:\nplan, review, execute, review </i>"]

    subgraph IP["In Progress"]
        direction TD
        NS([Begin step]) --> P[Plan]
        P[Plan] --> R1{Review}
        R1 -->|revise| P
        R1 -->|approve| E[Execute]
        E --> R2{Review}
        R2 -->|revise| E
        R2 -->|next step| NS
        R2 -->|rethink| P
    end

    R2 -->|done| IR["In Review\n<i>ready to merge,\nor auto-complete</i>"]
    IR -->|direct squash merge\nor merged PR| D["Done"]

    style H fill:#161b22,stroke:#8b949e,color:#e6edf3
    style T fill:#2d2006,stroke:#d29922,color:#d29922
    style TD fill:#0d2044,stroke:#58a6ff,color:#58a6ff
    style IP fill:#1a0d2e,stroke:#bc8cff,color:#bc8cff
    style P fill:#1a0d2e,stroke:#bc8cff,color:#e6edf3
    style R1 fill:#1a0d2e,stroke:#bc8cff,color:#e6edf3
    style E fill:#1a0d2e,stroke:#bc8cff,color:#e6edf3
    style R2 fill:#1a0d2e,stroke:#bc8cff,color:#e6edf3
    style NS fill:#1a0d2e,stroke:#bc8cff,color:#bc8cff
    style IR fill:#0d2d16,stroke:#3fb950,color:#3fb950
    style D fill:#1a1a1a,stroke:#8b949e,color:#8b949e
```

Tasks with dependencies are processed sequentially. Independent tasks run in parallel.

In **Triage**, an AI agent reads your project, understands context, and writes a full `PROMPT.md` specification — steps, file scope, acceptance criteria. Optionally require manual approval before tasks move to **Todo** (`requirePlanApproval` setting).

## Core Features

- **AI Specification** — Triage agent generates detailed `PROMPT.md` with steps, file scope, and acceptance criteria
- **Step-by-step Execution** — Plan → Review → Execute → Review cycle for each task step
- **Git Worktree Isolation** — Each task runs in its own worktree (`fusion/{task-id}` branch)
- **Workflow Steps** — Configurable quality gates (pre-merge: blocks merge; post-merge: informational)
- **GitHub Integration** — Import issues, create PRs, real-time PR/issue badges
- **Dashboard** — Real-time kanban board, agent management, terminal, git manager, mission planner
- **Missions** — Hierarchical planning (Mission → Milestone → Slice → Feature → Task) with autopilot, validation contracts, fix-feature retries, and blocked-handoff semantics for systematic feature delivery.
- **Multi-Project** — Manage multiple projects from a single installation with project isolation
- **Inter-Agent Messaging** — Built-in messaging for coordination between agents and users

### Provider Authentication

Fusion supports OAuth-based authentication for AI providers configured via **Settings → Authentication**. When the dashboard is accessed via a non-localhost host (remote node, LAN host/IP, or reverse proxy), provider login URLs are automatically rewritten to route OAuth callbacks through a bridge endpoint (`/api/auth/openai-codex/callback`), ensuring the redirect reaches the active browser session.

- **OpenAI Codex** — Authenticates via Settings OAuth flow with secure state validation
- **Other providers** — Authenticate via API key entry in Settings
- **pi authentication** — Handled separately via the `pi` CLI (`/login`) or `ANTHROPIC_API_KEY` environment variable

### Model System

Fusion uses a dual-scope model hierarchy with five independent lanes. Global settings define baseline defaults, and project settings provide per-project overrides.

**Lanes:**

| Lane | Purpose | Global Baseline Keys | Project Override Keys |
|------|---------|---------------------|----------------------|
| Executor | Task execution agent | `executionGlobalProvider` + `executionGlobalModelId` | `executionProvider` + `executionModelId` |
| Planning/Triage | Task specification agent | `planningGlobalProvider` + `planningGlobalModelId` | `planningProvider` + `planningModelId` |
| Validator | Plan/code reviewer | `validatorGlobalProvider` + `validatorGlobalModelId` | `validatorProvider` + `validatorModelId` |
| Title Summarization | Auto-title generation | `titleSummarizerGlobalProvider` + `titleSummarizerGlobalModelId` | `titleSummarizerProvider` + `titleSummarizerModelId` |
| Workflow Step Refinement | AI prompt refinement | (uses `defaultProvider`/`defaultModelId`) | (uses `modelProvider`/`modelId` on WorkflowStep) |

**Per-Task Overrides:** Tasks can override the executor, validator, and planning lanes with per-task model fields (`modelProvider`/`modelId`, `validatorModelProvider`/`validatorModelId`, `planningModelProvider`/`planningModelId`).

**Precedence:** Per-task → Project override → Global lane → `defaultProvider`/`defaultModelId` → Automatic resolution.

For full settings documentation, see [Settings Reference](./docs/settings-reference.md).

### Scheduled Tasks / Automations

Fusion supports scheduled task automation via the `/api/automations` endpoints. Automations can run shell commands or multi-step workflows on a configurable schedule.

#### Scheduling Scope

Automations and routines can run in two scopes:

- **Global** — Runs across all projects. Use this for cross-project maintenance, backups, or unified reporting.
- **Project** — Runs only within a specific project. Use this for project-specific CI, testing, or deployment tasks.

When you create a schedule without choosing a scope, Fusion defaults to **project scope** with the `default` project ID for backward compatibility. This ensures existing setups keep working exactly as before.

To explicitly target a scope:
- In the dashboard **Scheduled Tasks** modal, use the **Global / Project** toggle.
- Via the API, pass `?scope=global` or `?scope=project&projectId=<id>` on automation/routine endpoints.

**Scope resolution rules:**
- `scope=global` always resolves to the global automation/routine lane, independent of the active project.
- `scope=project` requires a `projectId`. If omitted, it falls back to `"default"`.
- CRUD, run, toggle, and webhook operations are strictly scope-isolated: a global schedule cannot be mutated from a project-scoped request, and vice versa.

**Operational guidance for multi-project setups:**
- Prefer **global** schedules for shared infrastructure (e.g., nightly backups, memory insight extraction).
- Prefer **project** schedules for per-repository automation (e.g., per-project test runners, deployment hooks).
- Global and project lanes are polled independently by the engine, so due runs in one lane do not block the other.

#### Automations

**Dashboard UI:** The Scheduled Tasks modal in the dashboard provides a Global/Project scope toggle in the header. When a project is active, the scope defaults to "Project"; otherwise it defaults to "Global". Schedules display a scope badge indicating their scope (global vs project). Project-scoped entries require an active project context.

| Endpoint | Method | Description |
|---------|--------|-------------|
| `/api/automations` | GET | List all automations (filtered by scope if specified) |
| `/api/automations` | POST | Create automation (scope defaults to `project`) |
| `/api/automations/:id` | GET | Get automation by ID |
| `/api/automations/:id` | PATCH | Update automation |
| `/api/automations/:id` | DELETE | Delete automation |
| `/api/automations/:id/run` | POST | Trigger manual run |
| `/api/automations/:id/toggle` | POST | Toggle enabled/disabled |
| `/api/automations/:id/steps/reorder` | POST | Reorder automation steps |

#### Routines

Routines are AI agent tasks triggered by cron schedules, webhooks, or manual execution. Routines share the same global/project scope model as automations.

**Dashboard UI:** The Scheduled Tasks modal in the dashboard provides a Global/Project scope toggle in the header. When a project is active, the scope defaults to "Project"; otherwise it defaults to "Global". Routines display a scope badge indicating their scope (global vs project). Project-scoped entries require an active project context.

| Endpoint | Method | Description |
|---------|--------|-------------|
| `/api/routines` | GET | List all routines (filtered by scope if specified) |
| `/api/routines` | POST | Create routine (scope defaults to `project`) |
| `/api/routines/:id` | GET | Get routine by ID |
| `/api/routines/:id` | PATCH | Update routine |
| `/api/routines/:id` | DELETE | Delete routine |
| `/api/routines/:id/run` | POST | Manual trigger |
| `/api/routines/:id/trigger` | POST | Canonical manual trigger |
| `/api/routines/:id/runs` | GET | Get execution history |
| `/api/routines/:id/webhook` | POST | Webhook trigger (signature verification supported) |

### Quick Examples

```bash
fn task create "Fix the login bug"                    # Quick entry → triage
fn task plan "Build auth system"                      # AI-guided planning
fn task import owner/repo --labels bug               # Import GitHub issues
fn task show FN-001                                  # View task details
fn task logs FN-001 --follow                         # Stream execution logs
fn task steer FN-001 "Use TypeScript"               # Guide the agent mid-execution

fn project add my-app /path/to/app                   # Register a project
fn project list                                      # List all projects

fn settings set maxConcurrent 4                      # Configure settings
fn settings export                                   # Export configuration

fn mission create "Auth System" "Build auth"         # Create mission
fn mission activate-slice <slice-id>                # Activate a slice

fn skills search react                              # Search skills.sh
fn skills install firebase/agent-skills             # Install agent skills
```

## Packages

| Package | Description |
|---------|-------------|
| `@fusion/core` | Domain model — tasks, board columns, SQLite store |
| `@fusion/dashboard` | Web UI — Express server + kanban board with SSE |
| `@fusion/engine` | AI engine — triage, execution, scheduling, workflow steps |
| `@fusion/tui` | Terminal UI — Ink-based CLI components |
| `@gsxdsm/fusion` | CLI + pi extension — published to npm |

## Development

```bash
pnpm install                  # Install dependencies
pnpm build                    # Build all packages
pnpm dev dashboard            # Run dashboard + AI engine
pnpm dev:ui                   # Dashboard only (no AI engine)
pnpm lint                     # Lint all packages
pnpm typecheck                # Type-check all packages
pnpm test                     # Run all tests
```

### Building a Standalone Executable

Build a single self-contained `fn` binary using [Bun](https://bun.sh/):

```bash
pnpm build:exe                # Build for current platform
pnpm build:exe:all            # Cross-compile for all platforms
```

## Releases

Packages are published to npm automatically via GitHub Actions and [changesets](https://github.com/changesets/changesets).

```bash
npm install -g @gsxdsm/fusion
```

See [RELEASING.md](./RELEASING.md) for the full workflow.

## License

ISC
