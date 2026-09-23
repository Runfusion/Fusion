# Carcuro parity product specification

[← Documentation index](./README.md) · [Plan of record](./dealersaas-mission-plan.md) · [Capability inventory](./carcuro-capability-inventory.md)

## Status and evidence policy

This is a **proposed / awaiting approval** target specification. It does not describe implemented DealersSaaS behavior. Repository observations use the measured revision from the inventory; external statements are vendor claims, not independently verified behavior.

Evidence labels used here:

- **`observed`** — directly present in cited repository code or visible at a cited URL on its retrieval date.
- **`inferred`** — a planning interpretation derived from observations; never presented as observed behavior.
- **`unknown`** — evidence is unavailable or the decision is unresolved.
- **`proposed`** — a target requirement subject to approval and implementation discovery.

## Sources and limitations

| Label | Claim | URL | Retrieved |
|---|---|---|---|
| `observed` | The Carcuro homepage is titled “Carcuro - die Software für Autohändler” and makes vendor claims for vehicle stock, contracts/customers, invoicing, listings/website, accounting, analytics, roles, and mobile use. | https://www.carcuro.com/ | 2026-09-23 |
| `observed` | Requesting the apex URL resolved to the `www` homepage during this task. | https://carcuro.com | 2026-09-23 |
| `observed` | The measured Fusion checkout contains no reachable dealership workflow for any requested domain. | ./carcuro-capability-inventory.md | 2026-09-23 |
| `unknown` | Deeper vendor journeys, APIs, data contracts, legal compliance, operational behavior, and the `scrapeui` substrate were not independently exercised or inspected. | https://www.carcuro.com/ | 2026-09-23 |

Testimonials and broad legal/marketing statements are excluded as acceptance evidence. No uncited search snippets are used. Country-specific compliance remains a qualified-review decision even where the homepage claims support.

## Parity decision rubric

| Decision | Meaning | Required evidence before delivery |
|---|---|---|
| Required parity | Necessary user outcome for the approved first program. | Executable acceptance test, traceable domain facts, desktop/mobile evidence, authorization/audit and failure-path checks. |
| Explicitly deferred | Valuable but intentionally outside an approved slice. | Named rationale, dependency, owner decision, and no hidden prerequisite for required parity. |
| Unsupported/unknown | Vendor or architecture evidence cannot establish behavior. | Discovery result or primary-source/qualified validation before promotion to required parity. |
| Non-goal | Deliberately not reproduced. | Approval record and proof that required journeys do not depend on it. |

## Domain requirements

### Inventory P&L

- **User outcome:** A dealer records acquisition, preparation, carrying, warranty, and disposal facts for a canonical vehicle and can reconcile realized margin to source transactions.
- **Evidence classification:** `observed` repository absence in [the inventory](./carcuro-capability-inventory.md); `observed` vendor homepage claims vehicle management, purchase/sale, profit, margin, stock analysis, and days in stock; `proposed` outcome below.
- **Acceptance outcome:** Given authorized source facts, the per-vehicle P&L reconciles exactly to immutable/correctable cost and sale entries, exposes inclusion rules, currency and tax treatment, and never changes silently after period close.
- **Dependencies:** Tenant/project decision; canonical vehicle, party and deal identities; money/tax policy; documents/media; authorization and audit.
- **Risks:** Retroactive edits, duplicate imports, ambiguous tax-inclusive amounts, currency rounding, and sale cancellation can invalidate profit.
- **Source references:** https://www.carcuro.com/ (retrieved 2026-09-23); `packages/core/src/postgres/schema/project.ts` (`projectId` is generic substrate only).
- **Ordering/failure semantics:** `proposed` one lock order for vehicle → deal → invoice facts; atomic acquisition/sale/cost posting boundaries; idempotency keys for imports; correction/reversal rather than destructive overwrite; cleanup of staged documents on rollback; explicit force/bypass permission and audit.

### Invoicing

- **User outcome:** An authorized user drafts an invoice from canonical customer/deal/vehicle facts, issues it once, records payment, and corrects or voids it without erasing history.
- **Evidence classification:** `observed` repository absence; `observed` vendor homepage claims automatic tax handling, e-invoice/register/accounting capabilities; legal correctness is `unknown`; target behavior is `proposed`.
- **Acceptance outcome:** Issuance allocates a tenant/jurisdiction-scoped immutable number exactly once, freezes rendered facts, records payment separately, and produces traceable correction/void documents under approved country rules.
- **Dependencies:** CRM/deal flow; inventory sale facts; tax/legal validation; numbering policy; document rendering/storage; accounting export.
- **Risks:** Number gaps, duplicate issue requests, invalid tax rules, mutable issued documents, payment/invoice divergence, and privacy leakage.
- **Source references:** https://www.carcuro.com/ (retrieved 2026-09-23); bounded absence in `packages/dashboard/src/routes/create-api-routes-mount-sequence.ts`.
- **Ordering/failure semantics:** `proposed` lock vehicle → deal → invoice; one transaction for issue number plus frozen invoice facts and audit outbox; payment posts independently but reconciles atomically; retry-safe rendering; correction/void/force paths never rewrite the original; dead-letter failed exports and clean temporary artifacts.

### CRM

- **User outcome:** A dealer manages people/organizations, contacts, consent, documents, interaction history, and linked deals with deduplication and tenant isolation.
- **Evidence classification:** `observed` repository absence; `observed` vendor homepage claims centralized customer data and history; exact identity, privacy, and retention behavior is `unknown`; target is `proposed`.
- **Acceptance outcome:** Authorized users can create, merge, search, export, rectify, and retain/delete customer records according to an approved policy while every relationship and sensitive-field access remains tenant scoped and auditable.
- **Dependencies:** Tenant/role model; party identity; privacy/retention policy; search/import/export; documents; deal lifecycle.
- **Risks:** False merges, duplicates, cross-tenant disclosure, unlawful retention, consent ambiguity, and orphaned deal/document links.
- **Source references:** https://www.carcuro.com/ (retrieved 2026-09-23); `packages/core/src/postgres/schema/project.ts` contains no dealer customer/deal table.
- **Ordering/failure semantics:** `proposed` canonical party IDs survive merge via aliases; lock party before deal mutation; import upserts use source keys; merge/delete/correction paths are transactional, reversible where policy permits, and audit before side effects; failed document writes leave no dangling reference.

### Sales channels

- **User outcome:** A dealer publishes one approved vehicle representation to selected marketplaces, observes remote status/errors, and withdraws sold or unpublished stock reliably.
- **Evidence classification:** `observed` repository absence; `observed` vendor homepage names mobile.de, AutoScout24, Google Vehicle Ads and import/export; connector contracts and behavior are `unknown`; target is `proposed`.
- **Acceptance outcome:** Publication is idempotent per tenant/vehicle/channel/version, stale work cannot overwrite newer intent, remote IDs and field mappings are traceable, and withdrawal convergence is visible and alertable.
- **Dependencies:** Canonical vehicle/media; publication approval; secrets; connector transport/rate limits; durable jobs; observability.
- **Risks:** Duplicate/stale listings, leaked credentials, partial media upload, provider throttling, schema drift, and competing retries.
- **Source references:** https://www.carcuro.com/ (retrieved 2026-09-23); no channel registrar in `packages/dashboard/src/routes/create-api-routes-mount-sequence.ts`.
- **Ordering/failure semantics:** `proposed` persist desired state/version before enqueue; cancel or supersede stale sync; idempotency keys and provider cursors; bounded retry with jitter and dead letter; per-vehicle/channel lease; withdrawal wins over older publish; compensating media cleanup; no force-success without auditable remote evidence.

### Storefront

- **User outcome:** A tenant publishes a branded, responsive public catalog with accurate vehicle availability, media, details, and privacy-aware lead capture.
- **Evidence classification:** `observed` repository absence; `observed` vendor homepage claims an own website and mobile availability; rendering, lead, SEO, cache, and tenancy details are `unknown`; target is `proposed`.
- **Acceptance outcome:** Only approved inventory is public, sold/withdrawn state converges within an approved bound, URLs and structured content are tenant isolated, and leads enter CRM exactly once with consent evidence.
- **Dependencies:** Canonical vehicle/media; publication state; tenant domains/branding; CRM; privacy; accessible responsive delivery.
- **Risks:** Stale sold stock, tenant/domain leakage, cache inconsistency, spam/PII exposure, broken mobile UX, and inaccessible media.
- **Source references:** https://www.carcuro.com/ (retrieved 2026-09-23); `packages/dashboard/app/App.tsx` is an operator UI, not a public dealer storefront.
- **Ordering/failure semantics:** `proposed` storefront projection follows committed inventory versions; stale jobs cannot republish; cache invalidation follows publish/withdraw commit; lead submission is idempotent and transactionally records consent plus CRM handoff intent; failures retain retriable outbox state and redact PII from logs.

### BI

- **User outcome:** Authorized users understand stock, sales, margin, investment, days in stock, source, and sales performance from explainable facts.
- **Evidence classification:** `observed` repository absence of dealer facts; `observed` vendor homepage claims real-time profit/investment/days-in-stock and broader analytics; metric definitions are `unknown`; target is `proposed`.
- **Acceptance outcome:** Every metric has a versioned definition, lineage to operational/financial facts, period/time-zone/currency rules, role filtering, freshness timestamp, and reconciliation test against source totals.
- **Dependencies:** Trusted inventory/deal/invoice/payment facts; dimensions; close/correction policy; authorization; export and observability.
- **Risks:** Double counting, late corrections, time-zone drift, currency errors, unbounded queries, and exposure of confidential margin.
- **Source references:** https://www.carcuro.com/ (retrieved 2026-09-23); generic Fusion reports are not dealership BI per `docs/carcuro-capability-inventory.md`.
- **Ordering/failure semantics:** `proposed` facts append/correct under the source transaction; projections checkpoint by committed version; retries are idempotent; late facts trigger bounded recomputation; failed refresh preserves last-known freshness and never labels stale data current; force rebuild is privileged and audited.

### Valuation

- **User outcome:** A dealer requests vehicle value guidance and sees amount/range, currency, source, assumptions, comparable context where licensed, and freshness.
- **Evidence classification:** `observed` repository absence; `observed` vendor homepage claims market-price estimation and marketplace statistics; provider, methodology, licensing, and accuracy are `unknown`; target is `proposed`.
- **Acceptance outcome:** A valuation is bound to a canonical vehicle snapshot and provider response, expires under approved freshness policy, distinguishes guidance from asking/sale price, and remains reproducible/auditable without overstating certainty.
- **Dependencies:** Canonical vehicle identity/attributes; approved provider and license; transport/rate limits; currency/locale; provenance and observability.
- **Risks:** Stale/biased data, provider outage, forbidden storage, opaque methodology, mismatched vehicle, and guidance treated as guaranteed price.
- **Source references:** https://www.carcuro.com/ (retrieved 2026-09-23); repository census in `docs/carcuro-capability-inventory.md`.
- **Ordering/failure semantics:** `proposed` hash the vehicle snapshot before request; dedupe concurrent requests; cache only within provider/license limits; record provider timestamp and response identity; bounded retries/dead letter; never replace a fresher result with stale completion; privileged override carries rationale and audit.

## Cross-cutting target invariants and approval decisions

All items below are **`proposed` required target invariants** or **`unknown` approval decisions**, not current guarantees.

1. **Repository/substrate (`unknown`):** approve implementation in this Fusion monorepo as a plugin/domain package, identify and authorize a separate `scrapeui` repository, or revise the mission. No feature slice should start before this choice.
2. **Canonical identities (`proposed`):** stable tenant, site, vehicle, party/customer, deal, invoice, payment, listing, document/media, and valuation IDs; provider aliases never become canonical keys.
3. **Tenant boundary (`unknown`):** decide whether Fusion `projectId` maps one-to-one to a dealer tenant and how multi-site dealers work. Every API, job, cache key, search index, audit event, and external credential must carry the resolved tenant.
4. **Authorization/audit (`proposed`):** least-privilege roles for cost/margin, customer PII, invoice issue/correction, publication, export, override, and administration. Business audit is append-only, redacted, attributable, and separate from diagnostic prose.
5. **Transaction and lock order (`proposed`):** document a single vehicle → party/deal → invoice/payment order; prohibit reentrant conflicting writers; commit domain facts and outbox intent together; make consumers idempotent.
6. **Sync and recovery (`proposed`):** version desired state, cancel/supersede stale work, bound transport/rate-limit retries, dead-letter with operator visibility, and nominate exactly one recovery owner per side effect to avoid competing repair.
7. **Correction paths (`proposed`):** corrections, voids, withdrawals, merges, force and bypass operations preserve originals, require explicit permission/rationale, and emit audit evidence. Failure cleanup removes temporary blobs/leases but not committed evidence.
8. **DACH legal/tax (`unknown`):** DE/AT/CH invoicing, VAT/margin schemes, e-invoice, cash register, retention, consumer, AML and vehicle-advertising obligations require qualified primary-source review. Vendor claims are not acceptance truth.
9. **Privacy/retention (`unknown`):** approve purposes, consent evidence, subject access/export/deletion, retention/legal hold, encryption, backups, and processor/provider contracts before production data.
10. **Documents/media (`proposed`):** typed ownership, content validation, malware controls, checksums, versioning, retention, authorized signed delivery, and cleanup after failed staging.
11. **Search/import/export (`proposed`):** tenant-filtered queries, explicit schemas, dry-run validation, source-key dedupe, resumable batches, row-level error reports, and authorized/redacted exports.
12. **Localization/currency (`unknown`):** approve locales, time zones, EUR/CHF and any other currencies, decimal/rounding/exchange rules, translations, and jurisdiction-specific templates.
13. **Responsive/mobile (`proposed`):** equivalent critical outcomes on desktop and mobile, including camera/photo workflows where approved; offline/native app parity is explicitly deferred unless separately approved.
14. **Observability (`proposed`):** redacted correlation IDs, domain metrics, connector lag/failure, projection freshness, reconciliation alerts, SLOs, runbooks, and audit-safe recovery actions.

## Scope and non-goals

- **Required parity candidate:** the seven acceptance outcomes above plus the cross-cutting safety foundations they require.
- **Explicitly deferred candidate:** native iOS/Android applications, workshop/parts operations, AI photo enhancement, and arbitrary provider breadth until the core facts and one reference integration are proven.
- **Unsupported/unknown:** exact Carcuro workflow equivalence, private APIs, legal compliance, provider contracts, and the separate substrate.
- **Non-goal candidate:** copying Carcuro branding, proprietary implementation, testimonials, pricing, or unverified behavior.

Approval of the plan may reclassify these candidates. Implementation evidence—not this document—must prove delivery.
