# Fusion Documentation

[← Back to repository root](../README.md)

Fusion is an AI-orchestrated task board that turns ideas into reviewed, merged code using a structured workflow: **triage → todo → in-progress → in-review → done**.

![Fusion Dashboard Overview](screenshots/dashboard-overview.png)

## Quick Start

Install Fusion globally, run `fn dashboard`, then create your first task from the board or CLI.

For a full walkthrough (installation, onboarding, first task, and lifecycle), start here:

➡️ **[Getting Started](./getting-started.md)**

## Documentation Index

| Guide | What it covers |
|---|---|
| [Getting Started](./getting-started.md) | Installation, first-run onboarding, first task, and daily workflow basics. |
| [Architecture](./architecture.md) | System architecture, package layout, storage model, and engine execution flow. |
| [Memory Plugin Contract](./memory-plugin-contract.md) | Pluggable memory backend architecture, interface contract, and migration strategy. |
| [CLI Reference](./cli-reference.md) | Complete `fn` command reference with subcommands, flags, and examples. |
| [Dashboard Guide](./dashboard-guide.md) | Detailed guide to board/list views, terminal, git manager, files, planning, and UI tools. |
| [Task Management](./task-management.md) | Task creation modes, lifecycle, prompt specs, comments, archiving, and GitHub integration. |
| [Missions](./missions.md) | Mission hierarchy, planning flow, activation, progress tracking, and autopilot behavior. |
| [Agents](./agents.md) | Agent management, presets, prompts, heartbeat behavior, spawning, and mailbox workflows. |
| [Workflow Steps](./workflow-steps.md) | Reusable quality gates, templates, pre/post-merge phases, and workflow execution results. |
| [Settings Reference](./settings-reference.md) | Global and project settings, defaults, API endpoints, and model selection hierarchy. |
| [Multi-Project](./multi-project.md) | Central registry architecture, project management, isolation modes, and migration paths. |
| [UX Audit Report](./ux-audit-report.md) | Comprehensive UX audit with prioritized recommendations for dashboard improvements. |
| [Codebase Improvement Audit](./codebase-improvement-audit.md) | Evidence-based technical debt and reliability gap audit with prioritized recommendations. |
| [Dashboard Load Performance](./performance/dashboard-load.md) | SQLite index analysis and optimization for dashboard boot path queries. |
| [Contributing](./contributing.md) | Local development setup, testing, release flow, and contributor conventions. |
| [Code Signing Setup](./CODE_SIGNING.md) | macOS and Windows code signing configuration for release binaries. |

## External Resources

- GitHub repository: https://github.com/gsxdsm/fusion
- npm package: https://www.npmjs.com/package/@gsxdsm/fusion
- pi agent framework: https://github.com/badlogic/pi-mono

## Suggested Reading Paths

- **New user:** Getting Started → Dashboard Guide → Task Management
- **Power user / automation owner:** Settings Reference → Workflow Steps → Agents
- **Maintainer / contributor:** Architecture → Multi-Project → Contributing
