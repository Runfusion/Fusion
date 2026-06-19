<div align="center">

<img src="./demo/assets/fusion-logo.png" alt="Fusion" width="120" />

# Fusion

### From rough idea to production code — automatically.

**Multi-node agent orchestrator** — tasks, agents, missions, git, files, and worktrees, with any model, local or cloud.

[**runfusion.ai →**](https://runfusion.ai) · [Docs](./docs/README.md) · [GitHub](https://github.com/Runfusion/Fusion) · [npm](https://www.npmjs.com/package/@runfusion/fusion) · [Discord](https://discord.gg/ksrfuy7WYR)

**English** · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Français](./README.fr.md) · [Español](./README.es.md) · [한국어](./README.ko.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@runfusion/fusion.svg?color=58a6ff)](https://www.npmjs.com/package/@runfusion/fusion)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/ksrfuy7WYR)
![Status](https://img.shields.io/badge/status-early%20preview-d29922.svg)
![Shipping](https://img.shields.io/badge/shipping-weekly-bc8cff.svg)

<br />

<img src="./demo/assets/fusion-reel.gif" alt="Fusion reel: from rough idea to production code" width="900" />

<br />
<br />

<a href="https://runfusion.ai">
  <img src="https://runfusion.ai/fusion-dashboard.png" alt="Fusion dashboard: Planning, Todo, In Progress, In Review, Done kanban columns with active task cards" width="900" />
</a>

</div>

---

## Your entire dev environment. On a single pane of glass.

Describe a task in plain language. A planning agent reads your project, understands context, and writes a full `PROMPT.md` plan — steps, file scope, acceptance criteria. Then Fusion plans, reviews, executes, and reviews again, in an isolated git worktree, with a human approval gate wherever you want one.

One board. Controlled from anywhere. Laptop, Mac mini, Linux server, cloud VM, phone — all connected.

> Like Trello, but your tasks get specified, executed, and delivered by AI. Built on the great work of [dustinbyrne/kb](https://github.com/dustinbyrne/kb).

---

## The flow

```
  ①  Describe          ②  Planning             ③  The board           ④  Isolated worktree
  ─────────────        ─────────────         ─────────────          ─────────────────────
  "Add dark mode   →   Agent writes    →   Plan → Review →    →   fusion/FN-123 branch
   toggle to           PROMPT.md           Execute → Review        concurrent, zero
   settings panel"     (steps, scope,      (per step, until        file conflicts
                       acceptance)         done)
```

### See every step, before the merge

<div align="center">
  <img src="https://runfusion.ai/screenshot-task-detail.png" alt="Fusion task detail: workflow steps visible on an in-progress task with diffs and file changes" width="820" />
</div>

Every task shows its plan, its reviews, its diffs, and its file changes in real time. Jump into an active task and nudge direction, tighten constraints, pause, or re-prompt.

---

## What makes it different

|  |  |
|---|---|
| 🧠 **AI planning** | Describe a task in plain language. Planning agents turn it into a `PROMPT.md` plan with steps, file scope, and acceptance criteria. |
| 🔁 **Selectable workflows** | Built-ins cover coding, quick fixes, review-heavy work, stepwise execution, plugin-gated Compound Engineering, and PR lifecycle fragments. Pick a workflow per task or author custom ones in the [Workflow Editor](./docs/workflow-editor.md). |
| 🌳 **Worktree isolation** | Each task runs in its own branch and worktree (`fusion/{task-id}`). Parallel tasks. Zero conflicts. Optional [worktrunk](https://github.com/max-sixty/worktrunk) delegation via [`worktrunk.enabled`](./docs/settings-reference.md#worktree-backend-settings) (see [WorktreeBackend abstraction](./docs/architecture.md#worktreebackend-abstraction)). |
| ⚡ **Smart merge controls** | Passing every gate? Fusion squash-merges and moves on. Opt into manual approval anywhere, inherit the live global auto-merge default, or set explicit per-task auto/manual overrides. |
| 🛰️ **Multi-node mesh** | Laptop, Mac mini, Linux server, cloud VM, phone — all synced. Desktop, mobile, web. |
| 🧩 **Any model** | Anthropic, OpenAI, Ollama, Google Generative AI, Z.ai, local runtimes, and user-defined [custom providers](./docs/dashboard-guide.md#custom-providers). Local and cloud coexist, with workflow model/fallback lanes configurable per project. |
| 🏢 **Agent companies** | Import pre-built teams — 440+ agents across 16 companies — and run them autonomously for weeks. |
| 📬 **Inter-agent messaging** | Built-in mailbox between agents. Delegate, clarify, coordinate; engineer-role agents can opt into backlog auto-claim when you want implementation help beyond executor-only pickup. |
| 🗨️ **Agent chat** | Direct chat, task chat, attachments, in-chat question cards, resumable streams, and experimental multi-agent Chat Rooms where mentioned members respond directly and ambient members can join up to a cap. ([Chat docs](./docs/dashboard-guide.md#chat-view)) |
| 🗺️ **Missions** | Hierarchical planning (Mission → Milestone → Slice → Feature → Task) with autopilot and validation contracts. |
| 🔬 **Research** | Bounded research runs with web search, GitHub, local docs, and LLM synthesis (plus runtime builtin WebSearch/WebFetch support in planning + synthesis flows when available). Turn findings into tasks. ([Docs](./docs/research.md)) |
| 🧪 **Self-improvement** | Agents reflect on their own output and update their prompts as they learn your codebase. |
| 🔓 **Open source. MIT.** | No vendor lock-in. Run it on your own hardware. Shipping weekly. |

---

## How it works

```mermaid
graph TD
    H((You)) -->|rough idea| T["Planning<br/><i>auto-planning</i>"]
    T --> TD["Todo<br/><i>scheduled for execution</i>"]
    TD --> IP["In Progress<br/><i>for each step:<br/>plan, review, execute, review</i>"]

    subgraph IP["In Progress"]
        direction TD
        NS([Begin step]) --> P[Plan]
        P --> R1{Review}
        R1 -->|revise| P
        R1 -->|approve| E[Execute]
        E --> R2{Review}
        R2 -->|revise| E
        R2 -->|next step| NS
        R2 -->|rethink| P
    end

    R2 -->|done| IR["In Review<br/><i>ready to merge,<br/>or auto-complete</i>"]
    IR -->|direct squash merge<br/>or merged PR| D["Done"]

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

Tasks with dependencies are processed sequentially. Independent tasks run in parallel. Optionally require manual approval before tasks move from Planning to Todo (`requirePlanApproval` setting).

---

## Workflow overview

<!--
FNXC:Docs 2026-06-16-23:10:
Fusion now exposes workflow selection and authoring as public product surfaces, so the README must explain the high-level lifecycle and link to the canonical Workflow Steps and Workflow Editor docs instead of duplicating editor internals here.
-->

Fusion workflows define how a task moves from idea to delivery. The default coding path is still the familiar **Plan/Triage → Execute → Workflow steps → Review → Merge** loop, but the policy now lives in a selectable workflow rather than being only hard-coded engine behavior.

- **Select per task:** choose a workflow from the dashboard task/board workflow controls, or assign one through `fn_workflow_select` / `workflow_id` when creating tasks.
- **Built-in catalog:** Coding (`builtin:coding`), Quick fix (`builtin:quick-fix`), Review-heavy (`builtin:review-heavy`), Compound engineering (`builtin:compound-engineering`, plugin-gated), Stepwise coding (`builtin:stepwise-coding`), and the PR lifecycle (`builtin:pr-workflow`, a reusable PR graph fragment).
- **Customize safely:** inspect built-ins, duplicate them, or author custom workflows in the visual [Workflow Editor](./docs/workflow-editor.md). Workflow-specific settings cover model lanes, review/approval policy, step execution knobs, task fields, and columns.

Read [Workflow Steps](./docs/workflow-steps.md) for runtime semantics, built-in workflow behavior, and workflow-step templates; read [Workflow Editor](./docs/workflow-editor.md) for the dashboard authoring guide.

---

## Multi-node. One board. Every platform.

<div align="center">

<img src="./demo/assets/fusion-mesh.gif" alt="Fusion mesh: laptop, Mac mini, Linux server, cloud VM, phone — all synced" width="820" />

<br />

![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
![Web](https://img.shields.io/badge/Web-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)
![iOS](https://img.shields.io/badge/iOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![Android](https://img.shields.io/badge/Android-3DDC84?style=for-the-badge&logo=android&logoColor=white)

</div>

Laptop, Mac mini, Linux server, cloud VM, phone — every node is a peer. Your task state, agents, logs, and diffs stay synchronized across the mesh. The same Fusion ships as:

- 🖥️ **Desktop app** — Electron for **macOS** (Intel + Apple Silicon), **Windows** 10/11, and **Linux**
- 📱 **Mobile app** — Capacitor for **iOS/iPadOS** and **Android** ([MOBILE.md](./MOBILE.md))
- 🌐 **Web dashboard** — any modern browser, served from the `fn dashboard` daemon
- 🔌 **CLI** — `fn` binary + extension for terminal-first workflows

Start the daemon on any node, connect your other devices, and the board follows you everywhere.

---

## Run an agent company

<div align="center">

<img src="./demo/assets/fusion-company-reel.gif" alt="Fusion agent company: import a team, run it autonomously for weeks" width="820" />

</div>

Import a team. Run it autonomously for weeks. **440+ agents across 16 companies**, wired for missions, mailboxes, and inter-agent delegation.

```bash
npx companies.sh add paperclipai/companies/gstack
```

---

## Compatible with the tools you already use.

Fusion integrates with the tools you love. **Hermes**, **Paperclip**, and **OpenClaw** all ship as first-class plugins — route any workspace to whichever runtime fits the task. And any Paperclip agent-company imports with a single command.

<div align="center">
  <img src="./demo/assets/hermes-logo.svg" alt="Hermes" height="56" />
</div>

### [Hermes](https://hermes-agent.nousresearch.com) <sub>`experimental`</sub>

<sub>Nous Research</sub>

The open-source autonomous agent from **Nous Research**. Install the Hermes plugin and run agents through Hermes for long-running, context-growing work — route any Fusion workspace to it.

### OpenClaw <sub>`experimental`</sub>

OpenClaw runtime support is available as an experimental plugin (`fusion-plugin-openclaw-runtime`) for runtime discovery/configuration parity. Configure agents with `runtimeConfig.runtimeHint: "openclaw"` after installing the plugin.

<br />

<div align="center">
  <img src="./demo/assets/paperclip-logo.svg" alt="Paperclip" height="56" />
</div>

### [Paperclip](https://paperclip.ing) <sub>`experimental`</sub>

<sub>paperclip.ing</sub>

The human control plane for AI labor. Install the Paperclip plugin to run agents through Paperclip inside Fusion.

Fusion also natively supports the **[`companies.sh`](https://github.com/paperclipai/companies)** agent-company standard: import a prebuilt team — **440+ agents across 16 companies** — and let them coordinate over Fusion's mailbox, missions, and workflow gates for weeks of autonomous work. Same company format, same agents, same skills as Paperclip.

```bash
npx companies.sh add paperclipai/companies/gstack
```

<br />

> **Hermes**, **Paperclip**, and **OpenClaw** are **experimental** runtime plugins — APIs and wire formats may shift between minor releases.

---

## Quick start

**Zero install, straight from npm:**

```bash
npx runfusion.ai
```

That launches the dashboard. Subcommands forward through: `npx runfusion.ai task create "fix X"`, `npx runfusion.ai --help`, etc. (Or verbosely: `npx @runfusion/fusion dashboard`.)

**One-line installer** (macOS & Linux — auto-picks Homebrew, falls back to npm):

```bash
curl -fsSL https://runfusion.ai/install.sh | sh
fusion dashboard
```

**Homebrew** (macOS & Linux):

```bash
brew tap runfusion/fusion
brew install fusion
fusion dashboard            # or: fn dashboard
```

Or as a one-liner (auto-taps): `brew install runfusion/fusion/fusion`.

**npm global**:

```bash
npm install -g @runfusion/fusion
fn dashboard                # or: fusion dashboard
```

**From a clone** (for development):

```bash
pnpm dev dashboard
```

Then click the `Open:` URL printed in the terminal. It embeds a bearer token
(`http://localhost:4040/?token=fn_...`) that the browser captures to
`localStorage` on first visit and reuses automatically thereafter. On the
server side, Fusion now persists the dashboard/daemon token in
`~/.fusion/settings.json` on first authenticated run and reuses it on later
starts unless you override it (`--token`, `FUSION_DASHBOARD_TOKEN`,
`FUSION_DAEMON_TOKEN`) or disable auth with `--no-auth`. See
[CLI reference → fn dashboard → Authentication](./docs/cli-reference.md#fn-dashboard)
for full precedence and reset/revocation options.

### First-run setup

On first launch, Fusion opens the **onboarding wizard** with three guided steps:

1. **AI Setup** — Use a simplified quick-start provider list (recommended providers plus any already-connected providers), then expand **Advanced provider settings** only if you need additional providers or setup details. You only need one provider to get started. Deprecated Google Gemini CLI / Antigravity provider entries are intentionally hidden; Google/Gemini API key, Google Generative AI, Vertex, and Cloud Code paths remain supported.
2. **GitHub (Optional)** — Connect GitHub for issue import and PR management
3. **First Task** — Create your first task or import from GitHub (if no project is active, onboarding first prompts you to register/select a project directory)

The wizard is **dismissible and non-blocking** — click **Skip for now** to use the dashboard immediately. Re-trigger it later from **Settings → Authentication → Reopen onboarding guide**.

### Mobile

For Capacitor + PWA workflow, see [MOBILE.md](./MOBILE.md).

---

## Documentation

| Guide | What it covers |
|---|---|
| [Getting Started](./docs/getting-started.md) | Installation, onboarding, first task, and workflow-selection basics |
| [Dashboard Guide](./docs/dashboard-guide.md) | Board/list views, chat, workflow editor, git manager, settings, and UI tools |
| [Task Management](./docs/task-management.md) | Task lifecycle, prompt specs, comments, archiving, and GitHub integration |
| [CLI Reference](./docs/cli-reference.md) | Full `fn` command and daemon reference |
| [Settings Reference](./docs/settings-reference.md) | Global/project settings, model hierarchy, workflow settings, and custom providers |
| [Workflow Steps](./docs/workflow-steps.md) | Workflow runtime, built-in workflows, gates, templates, and phases |
| [Workflow Editor](./docs/workflow-editor.md) | Visual authoring, importing/exporting, custom fields/columns/settings, and mobile editor |
| [Research](./docs/research.md) | Bounded research runs, findings, exports, and task integration |
| [Agents](./docs/agents.md) | Agent management, spawning, heartbeat, and mailbox workflows |
| [Missions](./docs/missions.md) | Mission hierarchy, planning, autopilot, and validation contracts |
| [Plugin Management](./docs/plugin-management.md) | Discovering, installing, enabling, configuring, and troubleshooting plugins |
| [Plugin Authoring](./docs/PLUGIN_AUTHORING.md) | Building plugins with lifecycle hooks, routes, tools, runtimes, and dashboard surfaces |
| [Remote Access](./docs/remote-access.md) | Tokenized remote dashboard access, Tailscale/Cloudflare setup, and troubleshooting |
| [Multi-Project](./docs/multi-project.md) | Central registry, isolation modes, and migration paths |
| [Docker](./docs/docker.md) | Container deployment |

---

## Core features

- **AI Planning** — Planning agent generates detailed `PROMPT.md` with steps, file scope, and acceptance criteria
- **Step-by-step Execution** — Plan → Review → Execute → Review cycle for each task step, with graph-mode workflows able to model per-step parse/execute/review/rework explicitly
- **Git Worktree Isolation** — Each task runs in its own worktree (`fusion/{task-id}` branch)
- **Selectable workflows** — Pick Coding, Quick fix, Review-heavy, Stepwise coding, plugin-gated Compound Engineering, custom workflows, or PR lifecycle fragments where appropriate ([overview](#workflow-overview); [Workflow Steps](./docs/workflow-steps.md#workflow-overview))
- **Visual Workflow Editor** — Inspect read-only built-ins, duplicate/customize workflows, and edit graph nodes, columns, task fields, typed settings, and per-project values ([Workflow Editor](./docs/workflow-editor.md))
- **Workflow Steps** — Configurable quality gates (pre-merge: blocks merge; post-merge: informational), plus workflow-declared optional steps such as opt-in [Browser Verification](./docs/workflow-steps.md#workflow-declared-optional-steps)
- **Workflow-native policy** — Fast-mode planning (`leanPlanning` / `autoApproveSpec`), typed triage thresholds, review/approval, step execution, and model/fallback lanes are workflow settings, not hard-coded engine constants ([Settings Reference](./docs/settings-reference.md#workflow-native-triage-policy-settings); [workflow settings](./docs/settings-reference.md#workflow-settings))
- **GitHub + PR lifecycle** — Import issues, create PRs, display real-time PR/issue badges, and use workflow-mode PR lifecycle graph fragments where enabled
- **Dashboard** — Real-time kanban/list/graph views, agent management, terminal, git manager, mission planner, chat, workflow editor, custom provider setup, and one-click update action
- **Missions** — Hierarchical planning (Mission → Milestone → Slice → Feature → Task) with autopilot, validation contracts, fix-feature retries, mission-goal linking, and blocked-handoff semantics
- **Multi-Project** — Manage multiple projects from a single installation with project isolation
- **Custom Providers** — Add OpenAI-compatible, OpenAI Responses, Anthropic-compatible, or Google Generative AI providers; saved models appear in Project Models and workflow model dropdowns ([Dashboard Guide](./docs/dashboard-guide.md#custom-providers); [settings shape](./docs/settings-reference.md#customproviders))
- **Smart merge controls** — Global auto-merge stays live for default tasks, while explicit per-task overrides can force auto/manual behavior ([Settings Reference](./docs/settings-reference.md#project-settings))
- **Inter-Agent Messaging** — Built-in messaging for coordination between agents and users; engineer-role agents can opt into backlog auto-claim for implementation tasks ([Settings Reference](./docs/settings-reference.md#project-settings))
- **Agent Chat + Chat Rooms** — Direct/task chat supports attachments, resumable streams, question response cards, and renameable conversations; experimental rooms route mentioned members as direct responders with optional ambient replies ([Dashboard Guide → Chat View](./docs/dashboard-guide.md#chat-view))

### Provider authentication

Fusion supports OAuth-based authentication for AI providers configured via **Settings → Authentication**. For most OAuth providers, when the dashboard is accessed via a non-localhost host (remote node, LAN host/IP, or reverse proxy), provider login URLs are rewritten to route OAuth callbacks through a bridge endpoint (`/api/auth/oauth-callback`) so redirects reach the active browser session.

- **Anthropic (Claude)** — Uses a pasted authorization-code flow in Settings/onboarding: sign in, then paste the final redirect URL (or code) back into Fusion to complete login
- **OpenAI Codex** — Uses the same pasted authorization-code flow with secure state validation
- **Factory AI — via Droid CLI** *(optional)* — requires local Droid CLI install + `droid auth login`; detection follows the effective runtime binary path (default `droid`, or plugin `droidBinaryPath` when configured), then enable in **Settings → Authentication** and restart Fusion
- **llama.cpp — via HTTP server** *(optional)* — configure your llama.cpp server URL (default `http://127.0.0.1:8080`) and optional API key, then enable in **Settings → Authentication**
- **Other providers** — Authenticate via API key entry in Settings (including Google/Gemini API key, Google Generative AI, Vertex, and Cloud Code aliases)
- **Custom providers** — Add user-defined OpenAI-compatible, OpenAI Responses, Anthropic-compatible, or Google Generative AI endpoints from **Settings → Authentication → Custom Providers**; saved model IDs become selectable in project and workflow model lanes ([Dashboard Guide](./docs/dashboard-guide.md#custom-providers))

### Model system

Fusion uses a dual-scope model hierarchy with five independent lanes. Global settings define baseline defaults; project settings provide per-project overrides.

| Lane | Purpose | Global Baseline Keys | Project Override Keys |
|------|---------|---------------------|----------------------|
| Executor | Task execution agent | `executionGlobalProvider` + `executionGlobalModelId` | `executionProvider` + `executionModelId` |
| Planning | Task planning agent | `planningGlobalProvider` + `planningGlobalModelId` | `planningProvider` + `planningModelId` |
| Validator | Plan/code reviewer | `validatorGlobalProvider` + `validatorGlobalModelId` | `validatorProvider` + `validatorModelId` |
| Title Summarization | Auto-title generation | `titleSummarizerGlobalProvider` + `titleSummarizerGlobalModelId` | `titleSummarizerProvider` + `titleSummarizerModelId` |
| Workflow Step Refinement | AI prompt refinement | (uses `defaultProvider`/`defaultModelId`) | (uses `modelProvider`/`modelId` on WorkflowStep) |

**Workflow lanes:** The default workflow exposes Plan/Triage, Executor, Reviewer, and fallback model lanes in **Settings → Project Models**, and advanced workflow settings can declare additional typed model/policy values ([Settings Reference](./docs/settings-reference.md#workflow-settings)).

**Per-Task Overrides:** Tasks can override the executor, validator, and planning lanes with per-task model fields (`modelProvider`/`modelId`, `validatorModelProvider`/`validatorModelId`, `planningModelProvider`/`planningModelId`).

**Precedence:** Per-task → Project override → Global lane → `defaultProvider`/`defaultModelId` → Automatic resolution.

For full settings documentation, see [Settings Reference](./docs/settings-reference.md).

### Scheduled tasks / automations

Fusion supports scheduled task automation via the `/api/automations` endpoints. Automations can run shell commands or multi-step workflows on a configurable schedule.

#### Scheduling scope

Automations and routines can run in two scopes:

- **Global** — Runs across all projects. Use this for cross-project maintenance, backups, or unified reporting.
- **Project** — Runs only within a specific project. Use this for project-specific CI, testing, or deployment tasks.

When you create a schedule without choosing a scope, Fusion defaults to **project scope** with the `default` project ID for backward compatibility.

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

---

## CLI quick examples

```bash
fn task create "Fix the login bug"                    # Quick entry → planning
fn task plan "Build auth system"                      # AI-guided planning
fn task import owner/repo --labels bug                # Import GitHub issues
fn task show FN-001                                   # View task details
fn task logs FN-001 --follow                          # Stream execution logs
fn task steer FN-001 "Use TypeScript"                 # Guide the agent mid-execution

fn project add my-app /path/to/app                    # Register a project
fn project list                                       # List all projects

fn settings set maxConcurrent 4                       # Configure settings
fn settings export                                    # Export configuration

fn mission create "Auth System" "Build auth"          # Create mission
fn mission activate-slice <slice-id>                  # Activate a slice

fn skills search react                                # Search skills.sh
fn skills install firebase/agent-skills               # Install agent skills
```

---

## Packages

| Package | Description |
|---------|-------------|
| `@fusion/core` | Domain model — tasks, board columns, SQLite store |
| `@fusion/dashboard` | Web UI — Express server + kanban board with SSE |
| `@fusion/engine` | AI engine — planning, execution, scheduling, workflow steps |
| `@runfusion/fusion` | CLI + extension — published to npm |

---

## Development

```bash
pnpm install                  # Install dependencies
pnpm local                    # Start local dashboard/API on a non-4040 port
pnpm local -- --engine        # Start local dashboard with the AI engine
pnpm build                    # Build default workspace packages (excludes desktop/mobile)
pnpm build:all                # Build all packages (including desktop/mobile)
pnpm dev dashboard            # Run dashboard + AI engine
pnpm dev:ui                   # Dashboard only (no AI engine)
pnpm lint                     # Lint all packages
pnpm typecheck                # Type-check all packages
pnpm test                     # Run all tests
```

### Build a standalone executable

Build a single self-contained `fn` binary using [Bun](https://bun.sh/):

```bash
pnpm build:exe                # Build for current platform
pnpm build:exe:all            # Cross-compile for all platforms
```

---

## License

MIT — open source, no vendor lock-in. See [LICENSE](./LICENSE).

<div align="center">

**[runfusion.ai →](https://runfusion.ai)**

</div>
