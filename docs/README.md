# Fusion Documentation

[← Back to repository root](../README.md)

Fusion is an AI-orchestrated task board that turns ideas into reviewed, merged code using a structured workflow: **triage → todo → in-progress → in-review → done**.

![Fusion Dashboard Overview](screenshots/dashboard-overview.png)

## Quick Start

Install Fusion globally, run `fn dashboard`, then create your first task from the board or CLI.

For a full walkthrough (installation, onboarding, first task, and daily workflow basics):

➡️ **[Getting Started](./getting-started.md)**

## Documentation Index

### Getting Started
| Guide | Description |
|---|---|
| [Getting Started](./getting-started.md) | Installation, first-run, first task, and daily workflow basics |
| [Dashboard Guide](./dashboard-guide.md) | Board/list views, terminal, git manager, files, planning, and UI tools |
| [CLI Reference](./cli-reference.md) | Complete `fn` command reference with subcommands, flags, and examples |

### Task & Project Management
| Guide | Description |
|---|---|
| [Task Management](./task-management.md) | Task creation modes, lifecycle, prompt specs, comments, archiving, and GitHub integration |
| [Missions](./missions.md) | Mission hierarchy, planning flow, activation, progress tracking, and autopilot behavior |
| [Workflow Steps](./workflow-steps.md) | Reusable quality gates, templates, pre/post-merge phases, and workflow execution results |
| [Multi-Project](./multi-project.md) | Central registry architecture, project management, isolation modes, and migration paths |

### Configuration & Agents
| Guide | Description |
|---|---|
| [Settings Reference](./settings-reference.md) | Global and project settings, defaults, API endpoints, and model selection hierarchy |
| [Agents](./agents.md) | Agent management, presets, prompts, heartbeat behavior, spawning, and mailbox workflows |

### Architecture & Development
| Guide | Description |
|---|---|
| [Architecture](./architecture.md) | System architecture, package layout, storage model, and engine execution flow |
| [Storage](./storage.md) | Storage architecture, migration, archive system, and SQLite schema |
| [Contributing](./contributing.md) | Local development setup, testing, release flow, and contributor conventions |
| [Docker](./docker.md) | Container builds, deployment, and persistence configuration |
| [Code Signing](./CODE_SIGNING.md) | macOS and Windows code signing configuration for release binaries |
| [Mobile](../MOBILE.md) | Capacitor/PWA mobile development setup and workflow |

### Plugin Development
| Guide | Description |
|---|---|
| [Plugin Authoring](./PLUGIN_AUTHORING.md) | Creating Fusion plugins with the plugin system |
| [Memory Plugin Contract](./memory-plugin-contract.md) | Pluggable memory backend architecture, interface contract, and migration strategy |

### Audit Reports
| Report | Description |
|---|---|
| [UX Audit Report](./ux-audit-report.md) | Comprehensive UX audit with prioritized recommendations for dashboard improvements |
| [Codebase Improvement Audit](./codebase-improvement-audit.md) | Evidence-based technical debt and reliability gap audit with prioritized recommendations |
| [Gap Analysis](./gap-analysis.md) | System completeness analysis comparing Fusion to Paperclip feature set |
| [Agent Sandbox Research](./agent-sandboxing-research.md) | Research on agent isolation, capability enforcement, and sandboxing approaches |
| [Agent Gap Analysis](./agent-paperclip-gap-analysis.md) | Gap analysis for agent Paperclip integration |
| [Test Audit Report](./test-audit-report.md) | Test coverage and effectiveness audit with recommendations |
| [Skipped Test Inventory](./skipped-test-inventory.md) | Current intentional test-skip inventory and reconciliation status for older skip follow-ups |
| [Dev Server Module Boundary Audit](./dev-server-module-boundary-audit.md) | Boundary/ownership audit for parallel `dev-server-*` vs `devserver-*` dashboard modules and FN-2212 prioritization guidance |
| [Dashboard Load Performance](./performance/dashboard-load.md) | SQLite index analysis and optimization for dashboard boot path queries |

## External Resources

- GitHub repository: https://github.com/gsxdsm/fusion
- npm package: https://www.npmjs.com/package/@gsxdsm/fusion
- pi agent framework: https://github.com/badlogic/pi-mono

## Suggested Reading Paths

- **New user:** Getting Started → Dashboard Guide → Task Management
- **Power user / automation owner:** Settings Reference → Workflow Steps → Agents
- **Maintainer / contributor:** Architecture → Multi-Project → Contributing
