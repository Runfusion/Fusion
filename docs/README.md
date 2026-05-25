# Fusion Documentation

[← Back to repository root](../README.md)

Fusion is an AI-orchestrated task board that turns ideas into reviewed, merged code using a structured workflow: **planning → todo → in-progress → in-review → done**.

![Fusion Dashboard Overview](screenshots/dashboard-overview.png)

## Quick Start

Start the local dashboard with `pnpm dev dashboard`, then create your first task from the board or CLI.

For a full walkthrough (installation, onboarding, first task, and daily workflow basics):

➡️ **[Getting Started](./getting-started.md)**

## Documentation Index

### Getting Started
| Guide | Description |
|---|---|
| [Getting Started](./getting-started.md) | Installation, first-run, first task, and daily workflow basics |
| [Dashboard Guide](./dashboard-guide.md) | Board/list views, terminal, git manager, files, planning, and UI tools |
| [CLI Reference](./cli-reference.md) | Complete `fn` command reference with subcommands, flags, and examples |
| [Remote Access](./remote-access.md) | Operator runbook for Tailscale/Cloudflare setup, tokenized login links, security caveats, and troubleshooting |
| [Native Shell Connection Guide](./native-shell.md) | Canonical mobile/desktop shell onboarding, profile management, QR/manual setup, and remote handoff behavior |

### Task & Project Management
| Guide | Description |
|---|---|
| [Task Management](./task-management.md) | Task creation modes, lifecycle, prompt specs, comments, archiving, and GitHub integration |
| [Todo View](./todo-view.md) | Canonical guide for the experimental Todo View, including enablement, usage, API routes, and storage |
| [Missions](./missions.md) | Mission hierarchy, planning flow, activation, progress tracking, and autopilot behavior |
| [Research](./research.md) | Research runs, provider setup, dashboard/CLI usage, findings, exports, and task integration |
| [Research View UX Spec](./research-view-ux-spec.md) | Canonical layout and capability-state messaging spec for the Research dashboard view (FN-4138, informs FN-4134/FN-4135) |
| [Workflow Steps](./workflow-steps.md) | Reusable quality gates, templates, pre/post-merge phases, and workflow execution results |
| [Task Evaluations](./evals.md) | Eval scoring contract, evidence persistence, score categories, and evaluation pipeline |
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
| [Secrets Store (`SecretsStore`)](./architecture.md#secrets-store-secretsstore) | Core encrypted secret subsystem overview: scopes, AES-256-GCM at-rest model, policy semantics, and public store API surface |
| [Dashboard Real-Time](./dashboard-realtime.md) | Canonical event-stream architecture contract (shared `/api/events` bus + dedicated stream boundaries), with project/node scoping, reconnect/cleanup behavior, and realtime pitfalls |
| [Storage](./storage.md) | Storage architecture, migration, archive system, and SQLite schema |
| [DAG Architecture Deliverables](./dag/) | Milestone A DAG architecture documents plus Milestone B prototype scaffold docs (schema migration plan, DagCoordinator design, implementation checklist) |
| [Dev Server Module Audit](./dev-server-modules.md) | Analysis of parallel dashboard dev-server module families, production wiring, and consolidation guidance |
| [Beads and Dolt Evaluation for Fusion Node Sync](./beads-dolt-sync-evaluation.md) | Evaluation of Beads and Dolt for node sync, with a recommendation for Fusion-native sync design |
| [Shared Mesh Replication Protocol](./shared-mesh-protocol.md) | Canonical multi-leader replication/write-coordination contract (versioning, quorum, leases/fencing, queue/replay, reconciliation, and degraded-read semantics) |
| [Multi-Project Sequencing and Dependency Analysis](./multi-project-sequencing.md) | Sequencing guidance for FN-3448/FN-3449/FN-3503/FN-3182, including identity boundaries and recommended board dependency edges |
| [Contributing](./contributing.md) | Local development setup, testing, release flow, and contributor conventions |
| [Docker](./docker.md) | Container builds, deployment, and persistence configuration |
| [Code Signing](./CODE_SIGNING.md) | macOS and Windows code signing configuration for release binaries |
| [Diagnostics](./diagnostics.md) | Engine diagnostic logging subsystems, structured log keys, and key diagnostic points catalog |
| [Sandbox Backends](./sandbox.md) | Pluggable sandbox backends for executor command isolation (bubblewrap, spawn-based) |
| [Secrets](./secrets.md) | Encrypted secrets storage, per-secret access policies, scopes, and agent tool wiring |
| [Testing](./testing.md) | Full testing lanes, worker fanout guidance, test taxonomy, and file organization |
| [Mobile](../MOBILE.md) | Capacitor/PWA mobile development setup and workflow |

### Plugins
| Guide | Description |
|---|---|
| [Plugin Management](./plugin-management.md) | End-user guide for discovering, installing, enabling, configuring, updating, uninstalling, and troubleshooting Fusion plugins |
| [Plugin Authoring](./PLUGIN_AUTHORING.md) | Developer guide for building Fusion plugins (manifest, SDK hooks, routes, UI/runtime contributions) |
| [Even Realities Glasses Plugin](../plugins/fusion-plugin-even-realities-glasses/README.md) | Task-focused Even Realities glasses bridge with quick capture, polling notifications, and agent actions |
| [Reports Plugin](./plugins/reports.md) | Reports plugin rendering, export, standalone HTML generation, and section configuration |
| [Even Realities Plugin API](./even-realities-plugin-api.md) | Even Realities plugin API endpoint reference and test coverage matrix |
| [Memory Plugin Contract](./memory-plugin-contract.md) | Pluggable memory backend architecture, interface contract, and migration strategy |

### Audit Reports
| Report | Description |
|---|---|
| [UX Audit Report](./ux-audit-report.md) | Comprehensive UX audit with prioritized recommendations for dashboard improvements |
| [Codebase Improvement Audit](./codebase-improvement-audit.md) | Evidence-based technical debt and reliability gap audit with prioritized recommendations |
| [Gap Analysis](./gap-analysis.md) | System completeness analysis comparing Fusion to Paperclip feature set |
| [Agent Sandbox Research](./agent-sandboxing-research.md) | Research on agent isolation, capability enforcement, and sandboxing approaches |
| [Even Realities Integration Research (FN-3737)](./even-realities-integration-research.md) | Research summary and recommended integration topology for Even Realities glasses + Fusion |
| [Agent Gap Analysis](./agent-paperclip-gap-analysis.md) | Gap analysis for agent Paperclip integration |
| [pi-autoresearch Analysis for Fusion Port](./research/pi-autoresearch-analysis.md) | Upstream architecture/license analysis and Fusion integration mapping for autoresearch capabilities |
| [pi-autoresearch Audit vs Fusion Research](./research/pi-autoresearch-audit-2026-05.md) | Audit comparing Fusion's research subsystem against upstream pi-autoresearch capabilities and parity gaps (FN-4136) |
| [Research Hardening Preflight Baseline](./research/research-hardening-preflight.md) | Verified research subsystem baseline, lifecycle contracts, and hardening pressure points |
| [Test Audit Report](./test-audit-report.md) | Test coverage and effectiveness audit with recommendations |
| [Skipped Test Inventory](./skipped-test-inventory.md) | Current intentional test-skip inventory and reconciliation status for older skip follow-ups |
| [Dev Server Module Boundary Audit](./dev-server-module-boundary-audit.md) | Boundary/ownership audit for parallel `dev-server-*` vs `devserver-*` dashboard modules and FN-2212 prioritization guidance |
| [spawn_agent Approval Evaluation (FN-3973)](./spawn-agent-approval-evaluation.md) | Decision to keep fn_spawn_agent under generic action-gate governance rather than durable agent provisioning policy |
| [Task Lineage Reconciliation Notes](./task-lineage-reconciliation.md) | Historical task-ID reuse patterns, confidence semantics for commit attribution, and reconciliation methodology (FN-3953, FN-3998) |
| [Dashboard Load Performance](./performance/dashboard-load.md) | SQLite index analysis and optimization for dashboard boot path queries |
| [CLI Printing Press Plugin Design](./design/cli-printing-press-plugin.md) | Architecture design for the CLI printing press bundled plugin (FN-3762) |
| [CLI Printing Press Research](./research/cli-printing-press.md) | Upstream `cli-printing-press` analysis and Fusion integration mapping (FN-3761) |
| [Research vs Experiment Session Naming Decision](./research/naming-decision-2026-05.md) | Naming decision record: hybrid approach retaining `research_*` for cited-search/synthesis and adding `experiment_session_*` for upstream parity (FN-4223) |
| [Experiment Executor Design](./research/experiment-executor.md) | Experiment executor architecture: lifecycle, run state machine, and worktree isolation model |
| [Experiment Finalize Flow](./research/experiment-finalize.md) | Experiment finalize contract: branch grouping, dry-run planning, and session completion semantics |
| [Experiment Session Model](./research/experiment-session-model.md) | Experiment session data model: state transitions, iteration tracking, and persisted run state |
| [Experiment Session MVP Spec](./research/experiment-session-mvp-spec.md) | MVP specification for the experiment session feature: scope, invariants, and delivery milestones |
| [Sandbox Options Research (FN-4635)](./research/sandbox-options.md) | Pluggable sandbox options research: threat model, backend evaluation, and spawn-based isolation design |
| [Triage Duplicate Detection Postmortem](./triage-duplicate-detection-postmortem.md) | Postmortem on duplicate task detection gaps and scheduler dedup hardening |
| [Multi-Node Runtime Readiness (FN-4814)](./design/fn-4814-multi-node-runtime-readiness.md) | Runtime readiness assessment for multi-node distributed coordination |
| [Distributed Multi-Node Coordination Gap (FN-4819)](./design/fn-4819-distributed-multi-node-coordination-gap.md) | Gap analysis for distributed multi-node agent coordination and cross-node task assignment |
| [Cross-Node Assignment Wake Contract (FN-4824)](./design/fn-4824-cross-node-assignment-wake-contract.md) | Contract specification for cross-node task assignment wake signaling |
| [Multi-Node Coordination Validation Findings (FN-4820)](./findings/fn-4820-multi-node-coordination-validation.md) | Validation findings from multi-node coordination testing and edge-case analysis |
| [Secrets Sync Auth Parity Review (FN-4886)](./reviews/fn-4886-secrets-sync-auth-parity.md) | Review of node secrets sync API authentication parity and security boundaries |
| [Test Speed Audit (FN-5048)](./test-speed-audit-FN-5048.md) | Measured baseline test performance, offender list, and optimization priorities |
| [Soft-Delete Verification Matrix](./soft-delete-verification-matrix.md) | Authoritative checklist for the FN-5105 → FN-5143 soft-delete stream: scenario × layer coverage |
| [Self-Healing Backward Move Audit](./self-healing-backward-move-audit.md) | Audit of self-healing backward-move safety checks and edge-case validation |

| [Lost-Work Tasks Incident (2026-05-23)](./incidents/2026-05-23-lost-work-tasks.md) | Incident catalog of 9 lost-work tasks from no-op finalize and reuse-handoff bugs |

## External Resources

- GitHub repository: https://github.com/Runfusion/Fusion
- npm package: https://www.npmjs.com/package/@runfusion/fusion
- pi agent framework: https://github.com/badlogic/pi-mono

## Suggested Reading Paths

- **New user:** Getting Started → Dashboard Guide → Task Management
- **Power user / automation owner:** Settings Reference → Workflow Steps → Agents
- **Maintainer / contributor:** Architecture → Multi-Project → Contributing
