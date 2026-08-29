---
date: 2026-06-02
topic: open-ideation
focus: open-ended (surprise-me)
mode: repo-grounded
---

# Ideation: Fusion (open / surprise-me)

## Grounding Context

**Codebase Context.** Fusion (`@runfusion/fusion`, MIT) is a multi-node AI-agent orchestrator — a Kanban board where tasks are planned, executed, reviewed, and merged by AI agents in isolated git worktrees, controllable from laptop, server, or phone. TypeScript pnpm monorepo: `core` (domain, mission-store), `engine` (executor 11k / merger 12k / self-healing 8.5k / mission autopilot + validation loop / workflow-IR graph executor), `dashboard` (React), `cli` (only published package), `desktop` (Electron), `mobile` (Capacitor), `plugin-sdk`, runtime adapters (cursor/droid/claude-cli/llama-cpp), and feature plugins.

**Strategy (STRATEGY.md).** Model- and surface-agnostic orchestration layer, neutral by design, plugin ecosystem. Persona: solo dev juggling 10 Claude Code + 5 Codex terminals across laptop and phone. Metrics: concurrent agent sessions, active nodes, ecosystem breadth (unique models+plugins), task completion rate, LOC shipped via Fusion. Tracks: (1) Multi-node orchestration, (2) Surface coverage, (3) Ecosystem & adaptability, (4) Pluggable multi-user.

**Known pain (internal docs).** Multi-node checkout is local-row CAS only (no central claim authority; 120s gossip wake; node-unreachable emits free-text logs not typed events; passphrase setup has no UX — FN-4984). Executor↔merger lifecycle coupling causes rebound churn (FN-5719 RFC, ratified). Lost-work incident (work attributed by loose git-grep; auto-finalize destroyed audit). Triage duplicate-detection blind spot. Dashboard perf (composite indexes, viewport gating). No structured learnings store / no CONCEPTS.md.

**External landscape.** Competitors: Conductor, Vibe Kanban, Gastown (7 agent roles, merge-queue "Refinery"), Bridge ACE (lateral agent bus, scope locks), GitHub Agent HQ, Devin/Windsurf "Glass", xpander.ai. MCP + A2A converging under Linux Foundation AAIF (joint spec ~Q3 2026); authorization/capability-delegation unsolved. Sandboxes pluggable (E2B/Daytona). OTel GenAI semantic conventions (`gen_ai.*`) emerging but nobody ships observability across model-agnostic multi-node fleets. Top user-reported pains: no shared task state, cost opacity, stuck/looping agents with no watchdog, verification bottleneck, rollback/checkpoint unsolved. Solo-dev multi-machine use case underserved.

## Topic Axes

Decomposition skipped — surprise-me mode.

## Ranked Ideas

### 1. Cost as a first-class signal — ledger → live economic dispatch
**Description:** Token usage is already persisted per task (`TaskTokenUsage`) but has no pricing layer, no USD, no cost surface. Add a pluggable model-pricing table → live $/agent/task/mission/node, then graduate it into a control loop: route cheap drafts to small models, throttle fan-out under a budget, load-shed speculative agents before mission-critical ones.
**Basis:** `direct:` `packages/core/src/types.ts:1598` `TaskTokenUsage` has tokens but no cost; only a token-usage test route exists. Cost opacity is a top-3 external pain (Bridge ACE, Redmonk, Replit/Cursor incidents). Cross-domain: power-grid merit-order dispatch + load-shedding.
**Rationale:** The raw signal already exists — a thin pricing/aggregation layer with outsized payoff; makes model-swapping economic (feeds ecosystem-breadth metric); makes silent looping-agent burn visible and gateable.
**Downsides:** Pricing tables drift with vendor rates; the dispatch/load-shed control loop is materially more complex than the ledger.
**Confidence:** 88% · **Complexity:** Low (ledger) → High (dispatch) · **Status:** Unexplored

### 2. Progress-derivative self-watchdog + checkpoint/escape
**Description:** Heartbeat/self-healing detect liveness, not progress — a looping agent looks alive. Require each agent to emit a monotonic progress token (new commits, diff convergence, tests-changed, acceptance delta). Two flat iterations → auto-checkpoint, then escalate to human or roll back to last good state. The single-agent-alone case forces the design; it then works at any fleet size.
**Basis:** `direct:` "stuck/looping agents with no escape/watchdog" + "rollback/checkpoint unsolved" (3+ sources); signals already in-tree (`agent-heartbeat.ts`, `session-token-usage.ts`, commit history) — only the fusing policy is missing. Cross-domain: anesthesia/rail dead-man's vigilance (prove progress, not presence).
**Rationale:** A looping agent burns budget (#1) and holds a concurrent-session slot (a headline metric). Converts a silent-failure mode into a recoverable event.
**Downsides:** "Progress" is hard to define for genuinely-thinking-but-quiet agents → false aborts; needs tuning to avoid alarm fatigue.
**Confidence:** 82% · **Complexity:** Medium · **Status:** Unexplored

### 3. Attribution-by-construction + completed-work index
**Description:** Two incidents share one root cause: work attributed after the fact by loose `git --grep` (lost-work: 14 Done tasks missing from main) and done-tasks invisible to dedup (3 agents did the same fix). Stamp every commit with a cryptographic task/agent/node trailer at write time, build an authoritative task→commit→files index keyed by SHA, and have both dedup and merge-target resolution consult it. Auto-finalize refuses to run on commits lacking a verifiable trailer.
**Basis:** `direct:` `docs/incidents/2026-05-23-lost-work-tasks.md`; `branch-attribution.ts` already parses a `"none"` (guessing) case; standing anti-patterns "never attribute by substring match," "never let auto-finalize destroy the audit trail."
**Rationale:** One index retires both a data-loss class and a duplicate-work leak — directly protecting task-completion-rate and trust in autonomous merge.
**Downsides:** Trailer discipline must hold across every runtime adapter (incl. third-party); migrating existing history is messy.
**Confidence:** 86% · **Complexity:** Medium · **Status:** Unexplored

### 4. Fleet observability — `gen_ai.*` OTel spans via one SDK shim
**Description:** No OpenTelemetry anywhere; engine emits free-text logs. Add one tracing shim in `plugin-sdk` so every runtime adapter (claude-cli, cursor, droid, llama-cpp, codex) emits standard `gen_ai.*` spans stamped with node-id + model + task, exportable to any OTLP backend. Instrument once; every present and future adapter inherits it — and cost (#1) becomes one span attribute.
**Basis:** `external:` OpenTelemetry GenAI semantic conventions converging but "nobody ships observability across model-agnostic, multi-node fleets" — the exact axis competitors can't reach. `direct:` confirmed absent (`grep gen_ai|opentelemetry` finds only `logger.ts`).
**Rationale:** Fusion's differentiator is neutrality across models and nodes; standards-aligned fleet tracing is a defensible moat and the substrate both watchdog (#2) and cost (#1) want.
**Downsides:** OTel GenAI attributes still "Development"-stability (names may churn); instrumenting every adapter is broad surface work.
**Confidence:** 80% · **Complexity:** Medium · **Status:** Unexplored

### 5. Capability-delegation broker / portable passports
**Description:** MCP/A2A are consolidating under the Linux Foundation AAIF (joint spec ~Q3 2026) but leave authorization/capability-delegation unsolved. Fusion already has the substrate nobody else does — agent identities (`soul`/`memory`), an action-gate with exempt-tool registries, `reportsTo` org trees. Issue signed, scoped, revocable, attenuatable capability passports (which repos/secrets/models/spend-ceiling/expiry) that travel across nodes; delegation = minting a narrower child passport.
**Basis:** `external:` protocol convergence leaves authz at the app layer (Zylos protocol analysis); macaroons-style attenuation (Google macaroons paper). `direct:` `docs/agents.md` action-gate + exempt-tool registry + manager relationships.
**Rationale:** The most strategically-aligned wedge: Pluggable multi-user (Track 4) and cross-node execution (Track 1) both require a portable authz model. Owning it turns neutrality into a moat for the A2A era.
**Downsides:** Security-critical surface — easy to get subtly wrong; higher design cost; value partly depends on the external spec landing as expected.
**Confidence:** 72% · **Complexity:** High · **Status:** Unexplored

### 6. Consequence-tiered + concurrent verification
**Description:** The persona runs ~15 agents against one human reviewer — review, not generation, is the throughput ceiling. (a) A risk-ranked review queue (diff size, files touched, no-op/empty-diff flags, conflict probability from `branch-conflicts.ts`) that auto-fast-paths trivial merges and routes blast-radius changes to humans. (b) Concurrent "pre-mortem" shadow reviewers that run while an agent works, so review is amortized, not serial. A corrections log feeds back into routing.
**Basis:** `direct:` "verification bottleneck" (3+ sources); `reviewer.ts` + `branch-conflicts.ts` already compute the raw risk signals but nothing prioritizes by them. Cross-domain: newsroom copydesk vs standards-desk tiering.
**Rationale:** Attacks the real cap on task-completion-rate by allocating scarce human attention by consequence rather than generating more.
**Downsides:** Mis-scoring risk auto-fast-paths a dangerous merge; concurrent reviewers multiply token spend (interacts with #1).
**Confidence:** 78% · **Complexity:** Medium · **Status:** Unexplored

### 7. Zero-UX multi-node onboarding — QR/PAKE pairing
**Description:** Multi-node passphrase setup has no dashboard UX (FN-4984), yet the persona is "solo dev across laptop and phone." Adding the second machine currently means hand-editing config. Ship a pairing flow: an existing node (or the phone) scans a QR / short-code, a PAKE handshake derives the shared secret — no passphrase typed. Trust is transferred, not configured.
**Basis:** `direct:` FN-4984 + "solo-dev multi-machine underserved"; plumbing already exists (`mesh-config-generator.ts`, `node-discovery.ts`, `node-connection.ts`) — the gap is purely the onboarding surface. `reasoned:` one operator owning all nodes makes this device-pairing (like adding a Chromecast), not enterprise key-management.
**Rationale:** "Active nodes" is a headline metric; if standing up node #2 needs a text editor, the multi-node thesis dies at activation. The backend is built; the funnel leaks at the UI.
**Downsides:** Phone-surface QR scanning adds mobile/Capacitor work; PAKE done wrong undermines the security it provides.
**Confidence:** 84% · **Complexity:** Medium · **Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Decouple execution- vs merge-ownership (reconcilers) | Already CEO-ratified in FN-5719 RFC — covered, not net-new |
| 2 | Disposable per-task ephemeral nodes | Tension with own-machine persona + reaffirmed multi-node non-goals; better as a brainstorm variant |
| 3 | Invariant ledger + compiled CONCEPTS.md | Strong DX compounding but internal-facing; slot went to product-facing ideas |
| 4 | Adapter conformance suite | Good ecosystem-breadth flywheel; honorable mention, overlaps #4's SDK-shim leverage |
| 5 | Earned-autonomy trust ledger | Folds into #6 verification/autonomy theme |
| 6 | Persistent territorial agents / pull-based intent / bottom-up missions / novice conductor | Bold reframes — brainstorm-grade direction changes, not single improvements |
| 7 | Continuous-rebase integration worktree | Overlaps FN-5719 territory; high-risk to merge invariants |
| 8 | Stigmergy / surgical-count / flight-deck / bill-of-lading shared-state primitives | Compelling analogies converging on one "shared task state + file ownership" gap; brainstorm as a single theme |
