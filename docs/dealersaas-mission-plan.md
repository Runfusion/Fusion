# DealersSaaS → Carcuro mission plan

**Plan of record · proposed / awaiting approval**

[← Documentation index](./README.md) · [Capability inventory](./carcuro-capability-inventory.md) · [Product specification](./carcuro-product-spec.md)

## Executive decision

At measured revision `f772db2c901b5b24aba2eaf1a6f617f53f039210`, this checkout is the Fusion orchestration monorepo and contains no reachable DealersSaaS, Carcuro, or `scrapeui` dealership substrate. The [inventory](./carcuro-capability-inventory.md) records the bounded code/history evidence; the [product specification](./carcuro-product-spec.md) separates repository observations, dated vendor claims, planning inference, unknowns, and proposed outcomes.

The first approval decision is therefore architectural: implement an isolated dealer domain in this repository using its extension seams, identify and authorize the intended separate substrate repository, or revise the mission. The hierarchy below remains **proposed / awaiting approval** and creates no persisted milestone, slice, feature, goal link, or implementation task.

## Scope and non-goals

### Proposed scope

- Establish tenant, identity, authorization, audit, money, localization, document/media, privacy, and operational-recovery foundations.
- Deliver acceptance-bearing outcomes for inventory P&L, invoicing, CRM, sales channels, storefront, BI, and valuation.
- Preserve source facts and provenance so financial, publication, reporting, and valuation conclusions remain explainable.
- Verify critical journeys on desktop and mobile and prove failure/recovery behavior with automated tests.

### Proposed non-goals / deferrals

- Copying Carcuro branding, proprietary internals, testimonials, pricing, or unverified behavior.
- Claiming DACH legal/tax compliance without qualified primary-source validation.
- Native iOS/Android applications, workshop/parts operations, AI photo enhancement, and broad provider coverage in the first program unless separately approved.
- Treating generic Fusion tasks, reports, artifacts, plugins, or mobile navigation as delivered dealer functionality.

## Approval decisions

1. **Repository/substrate:** Fusion plugin/domain package, an identified separate `scrapeui` repository, or revised mission.
2. **Tenant topology:** whether one Fusion project equals one dealer tenant and how sites/branches are isolated.
3. **DACH launch boundary:** initial countries, tax schemes, invoice/e-invoice/cash-register rules, currencies, retention, and qualified reviewers.
4. **Integration boundary:** first marketplace, storefront hosting/domain model, valuation provider, accounting export, and their contracts/licences.
5. **Delivery boundary:** which proposed deferrals become required parity and what quantitative freshness/convergence/SLO limits apply.

Unresolved evidence remains unresolved; approval must not silently convert vendor claims into implementation guarantees.

## Dependency order and parallelism

The dependency graph is intentionally acyclic. Foundation decisions gate all stateful work. Canonical vehicle/customer/deal facts precede finance and publication. Acquisition/cost facts precede P&L. CRM/deal/document flow precedes invoice generation. Correctable invoice/payment facts precede financial BI. Canonical inventory/media precedes channel/storefront publication. Trusted operational/financial facts and an approved source/freshness policy precede BI and valuation conclusions.

After `F-FOUND-04`, vehicle and CRM slices may proceed in parallel. After canonical vehicle/media and publication semantics exist, the reference channel and storefront projection may proceed in parallel. BI metric work can begin against versioned contracts while invoice implementation proceeds, but financial BI acceptance remains gated on reconciled invoice/payment facts. Valuation provider work may begin after canonical vehicle snapshots and provider policy, independently of storefront rendering.

## Proposed Mission hierarchy

**Mission `M-MSNR87BW-0001-SQEL`: DealersSaaS — Carcuro feature parity — proposed / awaiting approval**

### Milestone `M-FOUND` — Architecture and safety foundations — proposed / awaiting approval

#### Slice `S-FOUND-1` — Substrate, tenancy, and control plane — proposed / awaiting approval

##### Feature `F-FOUND-01` — Resolve repository and runtime substrate — proposed / awaiting approval

- **Outcome:** A signed architecture decision identifies the owning repository/package, deployable boundaries, extension strategy, and environments before feature code begins.
- **Prerequisites:** none.
- **Affected domains/surfaces:** All domains; repository layout, plugin/API composition, deployment.
- **Blast radius:** Cross-cutting architecture and delivery pipeline.
- **Principal risks:** Building in the wrong repository, accidental coupling to Fusion internals, or inaccessible substrate.
- **Acceptance evidence:** Architecture decision, executable boot skeleton in the approved repository, dependency diagram, rollback boundary, and repository access proof.
- **Deferred discovery:** Exact package names and hosting topology await the repository decision.

##### Feature `F-FOUND-02` — Establish tenant, site, and canonical identity boundaries — proposed / awaiting approval

- **Outcome:** Tenant/site and canonical IDs for vehicle, party, deal, invoice, payment, listing, document, and valuation are specified with project-scoping rules.
- **Prerequisites:** `F-FOUND-01`.
- **Affected domains/surfaces:** All domains; APIs, persistence, jobs, caches, search, imports.
- **Blast radius:** Every key, query, relationship, credential, and asynchronous message.
- **Principal risks:** Cross-tenant leakage, unstable aliases, and irreversible schema choices.
- **Acceptance evidence:** Isolation tests across two tenants/sites; uniqueness/foreign-key contracts; provider-alias and migration tests.
- **Deferred discovery:** One-project-per-tenant and multi-site policy require approval.

##### Feature `F-FOUND-03` — Define authorization, audit, privacy, and retention — proposed / awaiting approval

- **Outcome:** Dealer roles and permissions protect PII, costs/margins, invoice actions, publication, export, correction, force, and administration with append-only business audit.
- **Prerequisites:** `F-FOUND-02`.
- **Affected domains/surfaces:** All UI/API/job entry points; audit, support, privacy operations.
- **Blast radius:** Authentication/session context, every mutation, logs, exports, backup/retention.
- **Principal risks:** Privilege escalation, sensitive logging, unaudited overrides, and unlawful retention.
- **Acceptance evidence:** Deny-by-default permission matrix tests, tenant/role integration tests, redaction tests, subject export/delete/hold scenarios, immutable audit assertions.
- **Deferred discovery:** Qualified privacy policy and administrator/support access model.

#### Slice `S-FOUND-2` — Shared value, document, and recovery semantics — proposed / awaiting approval

##### Feature `F-FOUND-04` — Establish money, tax, localization, documents, and recovery contracts — proposed / awaiting approval

- **Outcome:** Shared currency/rounding/time-zone primitives, jurisdiction hooks, document/media lifecycle, idempotent outbox/jobs, dead letters, and one recovery owner per side effect are specified and tested.
- **Prerequisites:** `F-FOUND-02`, `F-FOUND-03`.
- **Affected domains/surfaces:** All domains; persistence, worker runtime, blob storage, observability.
- **Blast radius:** Financial correctness, every asynchronous integration, and all rendered business documents.
- **Principal risks:** Rounding drift, unsupported legal assumptions, orphaned blobs, duplicate side effects, and competing recovery.
- **Acceptance evidence:** Precision/property tests; document authorization/checksum/cleanup tests; stale-job cancellation, idempotency, retry/dead-letter, and recovery-race tests.
- **Deferred discovery:** Launch locales/currencies, qualified tax sources, storage provider, and quantitative retry/SLO limits.

### Milestone `M-CORE` — Canonical dealer operations — proposed / awaiting approval

#### Slice `S-CORE-1` — Vehicle inventory facts — proposed / awaiting approval

##### Feature `F-INV-01` — Create canonical vehicle and inventory lifecycle — proposed / awaiting approval

- **Outcome:** Users create/import, validate, search, update, acquire, hold, reserve, sell, and withdraw a tenant-scoped vehicle without losing source history.
- **Prerequisites:** `F-FOUND-04`.
- **Affected domains/surfaces:** Inventory P&L, sales channels, storefront, BI, valuation; desktop/mobile vehicle UI, API, persistence/import.
- **Blast radius:** Central dealer aggregate used by every downstream domain.
- **Principal risks:** VIN duplication, status races, destructive imports, and ambiguous sale/withdraw boundaries.
- **Acceptance evidence:** Lifecycle/state-machine tests, duplicate/import mutation tests, two-tenant isolation, desktop/mobile journeys, concurrent reserve/sell/withdraw tests.
- **Deferred discovery:** Vehicle classes, VIN data provider, required fields, and bulk migration format.

##### Feature `F-INV-02` — Preserve vehicle documents, media, and condition — proposed / awaiting approval

- **Outcome:** Authorized users attach versioned, typed vehicle media/documents and condition facts that downstream publication can reference safely.
- **Prerequisites:** `F-INV-01`.
- **Affected domains/surfaces:** Inventory P&L, sales channels, storefront, valuation; camera/upload, storage, delivery.
- **Blast radius:** Blob lifecycle, bandwidth, privacy, publication and mobile experience.
- **Principal risks:** Orphaned or malicious files, ordering drift, inaccessible media, and unauthorized delivery.
- **Acceptance evidence:** Type/size/malware/checksum tests, staging rollback cleanup, authorization and signed-delivery tests, ordering/version tests, mobile upload evidence.
- **Deferred discovery:** Image transformations, condition schema, quotas, and AI photo features.

#### Slice `S-CORE-2` — CRM and deal facts — proposed / awaiting approval

##### Feature `F-CRM-01` — Manage canonical parties and CRM history — proposed / awaiting approval

- **Outcome:** Users create, deduplicate, merge, search, export, rectify, retain/delete, and audit customer/organization records and interaction history.
- **Prerequisites:** `F-FOUND-04`.
- **Affected domains/surfaces:** CRM, invoicing, storefront leads, BI; desktop/mobile CRM, API, search/import/export.
- **Blast radius:** PII, identity links, privacy operations, and every customer-facing transaction.
- **Principal risks:** False merges, duplicates, cross-tenant disclosure, unlawful deletion/retention, and orphaned references.
- **Acceptance evidence:** Alias/merge concurrency tests, import dedupe tests, privacy workflows, two-tenant search/export isolation, desktop/mobile history journeys.
- **Deferred discovery:** Matching policy, consent purposes, retention schedule, and legacy migration format.

##### Feature `F-DEAL-01` — Record acquisition and sales deal lifecycle — proposed / awaiting approval

- **Outcome:** Users create and progress acquisition/sales deals linking canonical vehicle and party facts, preserving offers, contracts, status transitions, and cancellation history.
- **Prerequisites:** `F-INV-01`, `F-CRM-01`.
- **Affected domains/surfaces:** Inventory P&L, CRM, invoicing, BI; deal UI/API, contracts/documents.
- **Blast radius:** Vehicle availability, customer history, document generation, financial facts.
- **Principal risks:** Conflicting deals, stale vehicle state, mutable signed facts, and partial cancellation.
- **Acceptance evidence:** Lock-order and reentrancy tests, concurrent deal/sale tests, immutable snapshot/correction tests, cancellation compensation, contract authorization evidence.
- **Deferred discovery:** Offer/approval stages, e-signature provider, contract templates, and jurisdiction variants.

### Milestone `M-FIN` — Financial truth and profitability — proposed / awaiting approval

#### Slice `S-FIN-1` — Inventory cost and P&L — proposed / awaiting approval

##### Feature `F-PNL-01` — Capture acquisition and lifecycle cost facts — proposed / awaiting approval

- **Outcome:** Authorized users/imports append categorized acquisition, preparation, carrying, warranty, and disposal costs with source documents and corrections.
- **Prerequisites:** `F-INV-01`, `F-DEAL-01`.
- **Affected domains/surfaces:** Inventory P&L, BI; cost entry/import, documents, audit.
- **Blast radius:** Money/tax facts, accounting reconciliation, margin confidentiality.
- **Principal risks:** Duplicate costs, tax/currency ambiguity, destructive edits, and period-close drift.
- **Acceptance evidence:** Idempotent import tests, precision/tax fixtures approved by qualified reviewers, append/correction/close tests, role and audit assertions.
- **Deferred discovery:** Cost taxonomy, accounting dimensions, close policy, and initial migration.

##### Feature `F-PNL-02` — Reconcile per-vehicle realized profitability — proposed / awaiting approval

- **Outcome:** Users see explainable revenue, included costs, margin, and reconciliation status for each sold vehicle.
- **Prerequisites:** `F-PNL-01`, `F-INV-01`.
- **Affected domains/surfaces:** Inventory P&L, BI; vehicle detail, reports/exports.
- **Blast radius:** Financial queries, permissions, corrections, operational decisions.
- **Principal risks:** Hidden inclusion rules, double counting, late correction, and disclosure of margin.
- **Acceptance evidence:** Golden-ledger reconciliation fixtures, correction/void propagation, role-filter tests, freshness/lineage display, export equality tests.
- **Deferred discovery:** Management versus statutory margin definitions and warranty reserve treatment.

#### Slice `S-FIN-2` — Invoices and payment facts — proposed / awaiting approval

##### Feature `F-INVCE-01` — Draft and issue immutable invoices — proposed / awaiting approval

- **Outcome:** An authorized user drafts from canonical deal/customer/vehicle facts, validates jurisdiction rules, allocates a number once, and issues a frozen document.
- **Prerequisites:** `F-DEAL-01`, `F-FOUND-04`.
- **Affected domains/surfaces:** Invoicing, CRM, inventory P&L, BI; invoice UI/API, numbering, document rendering.
- **Blast radius:** Legal/financial records, numbering, PDF/e-invoice, audit and accounting export.
- **Principal risks:** Duplicate issue, number gaps, invalid tax logic, mutable issued data, and renderer divergence.
- **Acceptance evidence:** Concurrent issue/idempotency tests, frozen-snapshot assertions, approved country fixtures, rendered semantic checks, permission/audit tests.
- **Deferred discovery:** Numbering scope, launch tax schemes, e-invoice formats, cash-register and qualified legal requirements.

##### Feature `F-INVCE-02` — Record payment, correction, void, and accounting export — proposed / awaiting approval

- **Outcome:** Users reconcile payments and create traceable corrections/voids while exports are retry-safe and never rewrite issued originals.
- **Prerequisites:** `F-INVCE-01`.
- **Affected domains/surfaces:** Invoicing, inventory P&L, BI; payment UI/API, accounting connector, recovery tools.
- **Blast radius:** Financial status, close/reconciliation, external accounting and audit.
- **Principal risks:** Payment divergence, destructive correction, duplicate export, and manual force without evidence.
- **Acceptance evidence:** Payment reconciliation tests, reversal chains, retry/dead-letter/export idempotency tests, privileged force/bypass audit, failure cleanup.
- **Deferred discovery:** Payment providers, DATEV/other export boundary, bad-debt and refund policy.

### Milestone `M-PUB` — Reach and public commerce — proposed / awaiting approval

#### Slice `S-PUB-1` — Reference marketplace channel — proposed / awaiting approval

##### Feature `F-CHAN-01` — Publish and reconcile one reference sales channel — proposed / awaiting approval

- **Outcome:** Users map, publish, inspect, retry, and withdraw canonical vehicle/media on one approved marketplace with visible remote state.
- **Prerequisites:** `F-INV-02`, `F-FOUND-04`.
- **Affected domains/surfaces:** Sales channels, inventory, observability; channel settings/UI, connector, worker, secrets.
- **Blast radius:** External credentials, provider quotas, vehicle availability, asynchronous recovery.
- **Principal risks:** Duplicate/stale listings, mapping loss, leaked credentials, throttling, and competing repair.
- **Acceptance evidence:** Contract sandbox/recorded fixtures, desired-version and stale-completion tests, idempotent publish/withdraw, rate-limit/dead-letter tests, credential redaction and operator recovery evidence.
- **Deferred discovery:** First provider, commercial/API access, field/media constraints, and polling/webhook model.

#### Slice `S-PUB-2` — Tenant storefront and lead handoff — proposed / awaiting approval

##### Feature `F-STOREFRONT-01` — Publish a responsive tenant storefront — proposed / awaiting approval

- **Outcome:** Approved inventory renders on a tenant-branded public catalog/detail surface with accessible media and freshness-visible availability.
- **Prerequisites:** `F-INV-02`, `F-FOUND-04`.
- **Affected domains/surfaces:** Storefront, inventory; public desktop/mobile web, projection API, cache/CDN, domains.
- **Blast radius:** Public exposure, SEO/cache, tenant routing, availability and media delivery.
- **Principal risks:** Tenant leakage, stale sold stock, inaccessible/mobile-poor pages, and cache invalidation failure.
- **Acceptance evidence:** Two-tenant domain/isolation tests, publish/withdraw convergence test, desktop/mobile accessibility and performance evidence, cache-version tests, unavailable-state behavior.
- **Deferred discovery:** Hosting/CDN, custom domains, SEO/schema requirements, branding and convergence SLO.

##### Feature `F-STOREFRONT-02` — Capture storefront leads into CRM exactly once — proposed / awaiting approval

- **Outcome:** A privacy-aware public inquiry creates one attributed CRM interaction and exposes delivery/retry state to authorized users.
- **Prerequisites:** `F-STOREFRONT-01`, `F-CRM-01`.
- **Affected domains/surfaces:** Storefront, CRM; public form, anti-abuse, consent, CRM inbox/history.
- **Blast radius:** Public PII intake, spam controls, notifications, privacy/audit.
- **Principal risks:** Duplicate/lost leads, forged consent, PII in logs, abuse, and cross-tenant routing.
- **Acceptance evidence:** Idempotent submission and transactional outbox tests, consent/audit assertion, tenant-route isolation, redaction, abuse controls, failure/replay evidence.
- **Deferred discovery:** Notification channels, consent wording, anti-abuse provider and lead assignment.

### Milestone `M-INSIGHT` — Trusted decisions — proposed / awaiting approval

#### Slice `S-INSIGHT-1` — Reconciled operational and financial BI — proposed / awaiting approval

##### Feature `F-BI-01` — Deliver versioned operational dashboards — proposed / awaiting approval

- **Outcome:** Authorized users inspect stock, days-in-stock, source, sales performance, and freshness with drill-through to source facts.
- **Prerequisites:** `F-INV-01`, `F-DEAL-01`.
- **Affected domains/surfaces:** BI, inventory, CRM; desktop/mobile dashboards, query/projection/export.
- **Blast radius:** Aggregation performance, metric governance, confidential operational data.
- **Principal risks:** Definition drift, stale projections, time-zone errors, unbounded queries, and misleading totals.
- **Acceptance evidence:** Versioned metric catalog, source-total reconciliation, late-fact rebuild and freshness tests, role/tenant filtering, desktop/mobile and export checks.
- **Deferred discovery:** Approved metric definitions, period/calendar policy, performance budgets and export formats.

##### Feature `F-BI-02` — Deliver reconciled financial BI — proposed / awaiting approval

- **Outcome:** Authorized users inspect revenue, investment, cost, realized margin, payment, and correction-aware trends reconciled to financial facts.
- **Prerequisites:** `F-PNL-02`, `F-INVCE-02`, `F-BI-01`.
- **Affected domains/surfaces:** BI, inventory P&L, invoicing; dashboards, projections, exports.
- **Blast radius:** Financial truth, close/correction propagation, permissions and executive decisions.
- **Principal risks:** Double counting, late corrections, currency/rounding drift, and margin disclosure.
- **Acceptance evidence:** Golden-ledger dashboard reconciliation, correction/rebuild tests, close/freshness labels, currency precision and role-filter checks.
- **Deferred discovery:** Statutory versus management views, targets/forecasting and external accounting comparison.

#### Slice `S-INSIGHT-2` — Source-attributed valuation — proposed / awaiting approval

##### Feature `F-VAL-01` — Integrate one governed valuation source — proposed / awaiting approval

- **Outcome:** Users request and review source-attributed, freshness-bounded vehicle guidance tied to an immutable vehicle snapshot and clearly distinct from asking/sale price.
- **Prerequisites:** `F-INV-01`, `F-FOUND-04`.
- **Affected domains/surfaces:** Valuation, inventory, BI; vehicle UI, provider connector/cache, observability.
- **Blast radius:** External licensing/cost, pricing decisions, vehicle facts and audit.
- **Principal risks:** Stale/opaque guidance, mismatched vehicle, forbidden storage, provider outage, and false certainty.
- **Acceptance evidence:** Provider contract fixtures, snapshot-hash/dedup tests, freshness/expiry and stale-completion tests, provenance UI, outage/rate-limit/dead-letter behavior, override audit.
- **Deferred discovery:** Provider/licence, methodology disclosure, comparable-data rights, currencies and freshness threshold.

## Participant and failure-ordering appendix

```text
Desktop dealer UI ─┐
Mobile dealer UI  ─┼─> authorized domain API ─> domain service/locks
Public storefront ─┘             │                    │
                                 │                    ├─> project/tenant-scoped facts
                                 │                    ├─> append-only business audit
                                 │                    └─> transactional outbox
                                 │                                  │
                                 └─> documents/media                 v
                                                        jobs/sync workers
                                                          │       │
                                            channels/storefront   valuation/accounting
                                                          │       │
                                                          └─ observability/dead letter/recovery
```

| Proposed invariant | Surfaces that must preserve it | Expected automated evidence in implementation tasks |
|---|---|---|
| Tenant context is explicit and cannot be caller-overridden. | Desktop/mobile/public hosts, APIs, services, tables, search, cache, jobs, credentials, audit. | Two-tenant positive/negative integration tests and query/key inventory guards. |
| Canonical IDs outlive provider aliases and merges. | Vehicle/CRM/deal/invoice/listing/valuation APIs and persistence. | Alias/merge/import migration, uniqueness, referential-integrity and replay tests. |
| Lock order is vehicle → party/deal → invoice/payment and writers are non-reentrant. | Domain services, issue/sale/correction endpoints, workers and recovery tools. | Concurrent race/deadlock tests across sale, invoice, payment, correction and withdrawal. |
| Facts and outbox intent commit atomically; consumers are idempotent. | Sale/cost/invoice/payment/publication/lead/valuation transactions and workers. | Crash-before/after-commit, replay, duplicate-delivery and exactly-once-effect assertions. |
| Newer desired state defeats stale completion. | Channel and storefront publication, BI projections, valuation cache. | Deliberately reordered worker completions and version-fence tests. |
| Correction/void/withdraw/force/bypass preserve originals and rationale. | Financial UI/API, channel controls, admin/recovery and audit. | Permission, immutable-history, reversal-chain and audit metadata tests. |
| One recovery owner handles each external side effect. | Worker retry, self-healing/operator tools, webhooks, dead letters. | Competing-recovery race tests and lease/fence expiry tests. |
| Failures expose freshness and clean only uncommitted resources. | UI status, projections, files, leases, caches, connectors and observability. | Fault injection, temporary artifact cleanup, last-known-good/freshness and redaction tests. |
| Critical outcomes work on desktop and mobile. | Vehicle, CRM, deal, invoice, publication, BI and valuation surfaces. | Shared journey assertions at desktop and mobile breakpoints, including empty/error/duplicate states. |

## Risk register

| Risk | Current evidence | Mitigation / gate |
|---|---|---|
| Repository/substrate mismatch | `code-verified absent` in measured checkout; named substrate unavailable. | `F-FOUND-01` blocks implementation hierarchy handoff until resolved. |
| Legal/tax overclaim | Homepage statements are vendor claims only. | Qualified DE/AT/CH validation and approved fixtures before financial acceptance. |
| Cross-tenant or sensitive-data exposure | Generic `projectId` exists but no dealer model/roles. | Tenant/authorization foundation plus isolation/redaction tests before domain data. |
| Financial inconsistency | No canonical vehicle/deal/invoice/payment facts exist. | Immutable/correctable facts, lock/transaction order, reconciliation and close tests. |
| External side-effect divergence | Providers/contracts are unknown. | One reference integration, version fencing, idempotency, rate limits, dead letter and one recovery owner. |
| Scope inflation from marketing claims | Only homepage claims were observed. | Rubric requires observable acceptance evidence; defer unsupported breadth. |
| Mobile/public quality gaps | Fusion host responsiveness is not dealer workflow evidence. | Shared desktop/mobile/public journey and accessibility checks per slice. |

## Coordination boundary

FX-011 owns the mission-goal linking defect for active goal `G-MR6PYWXZ-0001-H2AW` and mission `M-MSNR87BW-0001-SQEL`. This plan neither duplicates that work nor attempts a link. If the defect remains, FX-011 must be resolved before the active goal is linked during a later, approved persistence handoff.

## Approval gate

Workflow review and product approval are separate decisions. A workflow reviewer can approve or revise whether this task faithfully produced the evidence-grounded planning artifact without choosing a product direction. The three choices below are reserved for the user after delivery; workflow review must not treat the still-pending product decision as missing proof about this task's implementation.

Choose exactly one:

- **Approve**
- **Approve with changes**
- **Revise**

Approval authorizes only a later interaction to persist the agreed Mission hierarchy and hand it to Engineering. It does not authorize retroactive feature implementation, task creation/delegation, slice activation, or goal linking. Until an explicit choice is received, every proposal label above remains **proposed / awaiting approval**.
