# Carcuro capability inventory

[← Documentation index](./README.md) · [Plan of record](./dealersaas-mission-plan.md) · [Product specification](./carcuro-product-spec.md)

## Measurement boundary

- **Measured revision:** `f98115ec8c967125fc9701b8bfed7f308b8be3ee`
- **Measured at:** 2026-09-23 08:42 UTC
- **Checkout:** branch `fusion/fx-010`, package `fusion-workspace@0.78.0-beta.6`
- **Scope:** tracked files and all refs reachable from this Fusion repository. This is not evidence about another repository, an unpushed branch, a deployed Carcuro system, or the mission description's named `scrapeui` substrate.

### Evidence vocabulary

| State | Meaning |
|---|---|
| `code-verified implemented` | A reachable dealership workflow is traced end to end in this checkout. |
| `code-verified partial` | A dealership workflow exists but one or more required participants are missing. |
| `code-verified absent` | The bounded repository census found no reachable dealership workflow or domain model. |
| `unknown/unavailable` | The evidence needed to decide is outside the measured checkout or inaccessible. |

No required dealership domain is `code-verified implemented` or `code-verified partial` at this revision. Generic Fusion facilities are possible substrate only; they do not establish dealership behavior.

## Reproducible repository census

Run from the repository root at the measured revision:

```bash
git grep -In -e DealersSaaS -e Carcuro -e scrapeui -- ':!pnpm-lock.yaml'
git log --all --oneline --regexp-ignore-case --grep='dealerssaas\|carcuro\|scrapeui'
git log --all --name-status --pretty='format:%H %s' -- \
  docs/dealersaas-mission-plan.md 'docs/carcuro-*.md'
git rev-list --objects --all | grep -Ei 'dealerssaas|carcuro|scrapeui'
git grep -Il -Ei 'invoice|storefront|sales channel|vehicle|dealership|customer relationship|valuation provider' -- ':!pnpm-lock.yaml'
```

Bounded results on 2026-09-23:

1. Tracked-content searches for the three names returned zero results before these planning files were added.
2. All-ref commit-message, requested-path history, and reachable object-name searches returned zero results.
3. The domain-content search returned only unrelated Fusion planning, merge, and dashboard-test files; manual inspection found no dealership entity, route, persistence table, connector, or UI.
4. Broad words such as `inventory`, `valuation`, `customer`, and `BI` occur in generic dependency, plugin, AI, task, or reporting contexts. They are not counted as dealer capabilities.

**History conclusion:** neither the requested plan/spec paths nor a DealersSaaS, Carcuro, or `scrapeui` substrate was observed in reachable history. The evidence cannot distinguish “never existed anywhere” from “exists in an unreachable repository/ref,” so no recovery or deletion claim is made.

## Current participant graph

The current repository provides a generic orchestration host:

```text
Desktop navigation: LeftSidebarNav
Mobile navigation: MobileNavBar
             ↓
Dashboard view host: App → MainContent / pluginViewRegistry
             ↓
HTTP composition: createApiRoutes → ordered domain registrars
             ↓
Generic services/stores: tasks, missions, goals, workflows, plugins
             ↓
Project-scoped PostgreSQL schema + run-audit events
```

Code evidence:

- UI composition: `packages/dashboard/app/App.tsx` (`App`, `registerBundledPluginViews`) and `packages/dashboard/app/components/dashboard/MainContent.tsx` (`MainContent`).
- Desktop/mobile hosts: `packages/dashboard/app/components/LeftSidebarNav.tsx` (`LeftSidebarNav`) and `packages/dashboard/app/components/MobileNavBar.tsx` (`MobileNavBar`). Neither declares a dealership view.
- Extension boundary: `packages/dashboard/app/plugins/types.ts` (`PluginDashboardViewRegistration`), `packages/plugin-sdk/src/index.ts` (`definePlugin`), and `docs/PLUGIN_AUTHORING.md`. These contracts show where an extension could attach, not that one exists.
- API composition: `packages/dashboard/src/routes.ts` (`createApiRoutes`) and `packages/dashboard/src/routes/create-api-routes-mount-sequence.ts` (`CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE`). No dealership registrar appears in the enforced sequence or `packages/dashboard/src/routes/`.
- Persistence boundary: `packages/core/src/postgres/schema/project.ts` exports project-scoped `tasks`, `missions`, `goals`, `missionGoals`, `milestones`, `slices`, and `runAuditEvents`; it exports no vehicle, customer, deal, invoice, channel listing, storefront, or valuation table.
- Mission writers (not dealer writers): `packages/core/src/missions/mission-store.ts` (`MissionStore.addMilestone`, `addSlice`, `addFeature`) and `packages/core/src/async-stores/async-mission-store.ts` (`AsyncMissionStore`).
- Real generic contract tests include `packages/dashboard/src/routes/__tests__/create-api-routes-mount-order.test.ts`, mission-store tests under `packages/core/src/__tests__/`, and dashboard navigation tests. They do not exercise dealer journeys.

### End-to-end dealership trace result

There is no genuinely matching workflow to trace through production entry point, desktop/mobile host, API/connector, writer/reader, project/tenant persistence, authorization/audit, failure recovery, and tests. Every requested domain therefore records bounded absence below. The generic plugin and project-scoping seams remain candidate substrate decisions and must be validated by an approved architecture slice.

## Capability matrix

Exactly one row is provided for each requested domain.

| Domain | User outcome | Evidence status | Path/symbol or bounded absence record | Shared dependencies | Blast radius | Principal risk | Confidence |
|---|---|---|---|---|---|---|---|
| Inventory P&L | Know per-vehicle acquisition, carrying, preparation, sale, and realized margin facts. | `code-verified absent` | Census found no vehicle/stock/cost/sale model or route; `packages/core/src/postgres/schema/project.ts` contains only generic project entities. | Tenant identity, vehicle/deal facts, money/tax model, audit | Data model, desktop/mobile UI, APIs, imports, reporting | Mutable costs or ambiguous sale boundaries corrupt margin. | High for this checkout |
| Invoicing | Generate, issue, correct, void, and account for invoices from canonical customer/deal facts. | `code-verified absent` | `git grep -Il -Ei 'invoice|rechn'` produced no production invoice module; no invoice registrar occurs in `CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE`. | Customer/deal identity, tax jurisdiction, immutable numbering, documents | Persistence, PDF/document output, permissions, audit, accounting export | Unsupported legal/tax assumptions or non-auditable corrections. | High for this checkout |
| CRM | Maintain customers, contacts, consent, history, and their deals without cross-tenant leakage. | `code-verified absent` | No dealership customer/deal entity, view, API, or table; generic goals/tasks in `packages/core/src/postgres/schema/project.ts` are not CRM. | Tenant/roles, privacy, search, documents, deal model | Identity, UI, import/export, retention, audit | Duplicate identities and unlawful retention/disclosure. | High for this checkout |
| Sales channels | Publish canonical vehicles to configured marketplaces and reconcile remote state. | `code-verified absent` | No marketplace connector, listing aggregate, sync worker, or dealership channel route found under `packages/dashboard/src/routes/` or tracked manifests. | Vehicle/media, credentials, jobs, idempotency, rate limits | Connectors, secrets, queues, monitoring, UI | Duplicate/stale listings and destructive competing recovery. | High for this checkout |
| Storefront | Present tenant-branded public inventory with accurate availability and lead capture. | `code-verified absent` | Census found no public dealership catalog, tenant storefront host, lead endpoint, or storefront persistence; `App` is the Fusion operator dashboard. | Vehicle/media, publication state, tenant branding, privacy | Public web delivery, cache/SEO, APIs, CRM handoff | Stale sold inventory, tenant leakage, inaccessible/mobile-poor pages. | High for this checkout |
| BI | Explain operational and financial performance from trusted dealer facts. | `code-verified absent` | Generic reports/insights are orchestration features; no dealer fact model or dealership metric definitions were found. | Inventory, deal, invoice/payment facts, dimensions, authorization | Queries, aggregations, dashboards, exports | Plausible but unreconcilable metrics and disclosure of margin. | High for this checkout |
| Valuation | Produce source-attributed, freshness-bounded vehicle valuation guidance. | `code-verified absent` | Census found that `valuation` matches generic AI/evaluation code only; no VIN/vehicle valuation provider, quote, or freshness policy exists. | Canonical vehicle identity, provider contract, provenance, currency | External integration, caching, UI, audit, observability | Stale or opaque values presented as authoritative prices. | High for this checkout |

## Cross-cutting matrix

| Concern | Evidence status | Current evidence and boundary | Required discovery / risk |
|---|---|---|---|
| Project/tenant identity | `code-verified partial` as generic substrate only | `packages/core/src/postgres/schema/project.ts` uses `projectId` on generic rows. | Decide whether a Fusion project equals a dealer tenant/site; prove isolation for every new row and job. |
| Authentication/roles | `unknown/unavailable` for dealer use | Generic dashboard auth routes exist, while `legacyProjectAuth*` tables are explicitly retained legacy schema. | Define dealer roles and field/action permissions; do not infer them from legacy tables. |
| Audit history | `code-verified partial` as generic substrate only | `runAuditEvents` and task/mission events exist, but no dealer mutation emits them. | Define immutable business audit vocabulary and sensitive-field policy. |
| DACH tax/legal variation | `unknown/unavailable` | No dealer tax/legal implementation or qualified legal evidence is present. | Qualified DE/AT/CH validation is mandatory before acceptance. |
| Privacy/retention | `unknown/unavailable` | No customer/lead records exist to trace. | Define purpose, consent, access/export/delete, retention, and legal holds. |
| Documents/media | `code-verified partial` as generic substrate only | Fusion task documents/artifacts exist, not vehicle photos, contracts, or invoices. | Define business ownership, malware/type/size controls, lifecycle, and signed delivery. |
| Search/import/export | `code-verified absent` for dealer data | Git/GitLab/Jira task import is unrelated to vehicle/customer import. | Define formats, validation, dedupe, resumability, and export authorization. |
| Localization/currency | `code-verified absent` for dealer data | No dealer money, locale, tax, or exchange model found. | Define locale/time zone/currency precision and cross-currency policy. |
| Responsive/mobile use | `code-verified partial` as host only | `LeftSidebarNav` and `MobileNavBar` prove responsive Fusion navigation, not dealer journeys. | Acceptance must exercise every dealer workflow at desktop and mobile breakpoints. |
| Observability | `code-verified partial` as generic substrate only | Generic diagnostics and run audit exist without dealer identifiers or SLOs. | Define redacted metrics, traces, alerts, replay/dead-letter visibility, and ownership. |

## Evidence reconciliation

- The mission description is a desired outcome, not implementation evidence.
- The plugin SDK is an extension option, not proof of a loaded DealersSaaS plugin.
- Generic task, mission, goal, report, artifact, and mobile-navigation capabilities are not classified as dealer functionality.
- Vendor claims and target outcomes are kept in [the product specification](./carcuro-product-spec.md); this inventory reports repository reality.
- Architecture choice, external providers, legal rules, and the location/availability of a separate `scrapeui` repository remain `unknown/unavailable` pending approval and discovery.
