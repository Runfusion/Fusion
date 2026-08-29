# Even Realities Integration Research (FN-3737)

## 1. Summary & Recommendation
Recommend **Option A** for v1: a **Fusion plugin + Even companion app bridge**. The companion app (or Even Hub-hosted webview app) handles device/app bridge APIs and forwards minimal HTTP calls to Fusion (`fn serve`/dashboard API). This aligns with currently visible Even SDK positioning (WebView ↔ Even App bridge, not direct glasses→LAN HTTP) and lets Fusion reuse existing task/agent REST APIs and plugin route hosting.

### Implementation status (FN-3970)
- Implemented in Fusion plugin: canonical `fusion-plugin-even-realities-glasses` route surface now includes board/task card endpoints, quick capture, actions, notifications, and transport status/reconnect routes.
- Production transport path now uses webhook-based `WebhookGlassesTransport` (`companionWebhookUrl`) instead of a stub transport.
- Companion app delivery remains out of scope for this document/task chain; this doc still defines the recommended topology and open ecosystem questions.

## 2. Even Realities Platform Overview

### 2.1 Developer surface (SDKs, docs, supported hosts)
- Public package: `@evenrealities/even_hub_sdk` (TypeScript SDK).
- SDK describes itself as a **WebView developer bridge to Even App** and EvenHub protocol APIs.
- Available evidence indicates app/webview-hosted integration (phone-hosted app shell), not direct firmware SDK for arbitrary host networking.
- Official web property reachable: `https://www.evenrealities.com/`.
- Unverified (open): canonical developer portal URL/subdomain (common guesses like `developer.*`/`docs.*` were not resolvable in this environment).

### 2.2 On-device UI/card capabilities and limits
From `@evenrealities/even_hub_sdk` README/API docs:
- Must call `createStartUpPageContainer` before other custom UI operations.
- `containerTotalNum`: **1–12**.
- `textObject`: up to **8** items.
- `imageObject`: max **4** (per changelog note).
- `ListContainerProperty.itemCount`: **1–20**.
- Exactly one container can have `isEventCapture=1` in a page.
These are effectively the card/container budget constraints for v1 payload shaping.

### 2.3 Input modalities
Evidence in SDK API surface:
- List/text/system events via `onEvenHubEvent`.
- Audio path via `audioControl(true/false)` and `audioEvent` PCM stream delivery.
- IMU feed via `imuControl` and `sysEvent.imuData` stream.
- Launch source signal (`appMenu` vs `glassesMenu`).
Unverified (open): production gesture taxonomy, physical buttons, and official STT API availability/quality guarantees.

### 2.4 Connectivity, pairing, and auth model
- SDK framing is **WebView ↔ Even App bridge**, implying glasses traffic is mediated by the Even App host runtime.
- No authoritative evidence found for direct glasses-to-LAN HTTP sessions; treat direct host HTTP as unsupported until confirmed.
- For Fusion integration, assume companion runtime holds Fusion endpoint + API key/session token and performs authenticated API calls.

### 2.5 Notification & background-execution model
- SDK changelog references “enhanced WebView background keepalive,” suggesting background execution exists but is constrained by host mobile OS policies.
- No authoritative wake/push SLA found for third-party apps; v1 should assume polling is required.
- Unverified (open): hard background cadence caps on iOS/Android for the Even host container.

### 2.6 Distribution & policy considerations
- SDK is npm-distributed (`@evenrealities/even_hub_sdk`) and appears web-app oriented.
- v1 likely ships as companion app/web bundle rather than Fusion-only plugin.
- App-store compliance, sideload policy, and Even-specific review constraints are currently unverified.

## 3. Fusion Side: Existing APIs & Plugin Surface

### 3.1 REST endpoints reusable for v1 capabilities (table: capability → endpoint)

| Capability | Existing Fusion endpoint(s) |
|---|---|
| Board/task read | `GET /api/tasks`, `GET /api/tasks/:id` |
| Create task | `POST /api/tasks` |
| Update status | `POST /api/tasks/:id/move` |
| Task comments/quick notes | `POST /api/tasks/:id/comments` |
| Trigger agent action | `POST /api/agents/:id/runs`, `POST /api/agents/:id/heartbeat` |
| Poll run status | `GET /api/agents/:id/runs`, `GET /api/agents/:id/runs/:runId` |
| Task docs/summary fetch | `GET /api/tasks/:id/documents/:key` |

(Endpoints confirmed from `packages/dashboard/src/routes/register-task-workflow-routes.ts` and `packages/dashboard/src/routes/register-agent-runtime-routes.ts`.)

### 3.2 Plugin SDK capabilities relevant here (onSchemaInit, routes, views, createAiSession)
From `docs/PLUGIN_AUTHORING.md` and plugin SDK exports:
- `onSchemaInit` for plugin-local schema/data setup.
- Plugin routes for custom endpoints (mounted under plugin namespace via plugin route registration flow).
- Dashboard view/slot registration for pairing/config UI.
- AI/session-related context APIs are available in plugin context surface (for orchestrating Fusion-side flows rather than device-side BLE logic).

### 3.3 Auth: API key / session model reuse
Reuse existing Fusion auth model:
- Dashboard/serve API auth + daemon token model (`docs/settings-reference.md`).
- Remote/tokenized login patterns (`docs/remote-access.md`) for off-device entry links.
No new auth mechanism should be introduced for v1.

## 4. Capability Mapping (MVP)

| MVP capability | Fusion endpoint(s) | Glasses UI/card pattern | Constraints |
|---|---|---|---|
| Read board/task status | `GET /api/tasks`, `GET /api/tasks/:id` | paged list container + short detail text cards | list item limits (1–20 per container), text budget/legibility |
| Create task | `POST /api/tasks` | quick-capture text card + confirm action | likely needs phone text/voice assist; validation/latency feedback |
| Update task (move) | `POST /api/tasks/:id/move` | action card (Done/In Review/etc.) | avoid dense workflow options on-device |
| Quick capture note/comment | `POST /api/tasks/:id/comments` | single-input capture card | STT availability uncertain; fallback to templated snippets |
| Poll notifications | `GET /api/tasks?limit=...` + `GET /api/agents/:id/runs` | inbox/alert card with unread counters | background polling limits on host platform |
| Trigger agent actions | `POST /api/agents/:id/runs` | confirm card (“Run now”) + status follow-up | require explicit confirmation and run-state polling |

## 5. Integration Topology Options

### 5.1 Option A / B / C with pros/cons
- **A) Fusion plugin + companion bridge app (recommended)**  
  - Pros: matches observed Even SDK app-bridge model; keeps Fusion extensibility in-plugin; minimal core-server change.  
  - Cons: requires companion app ownership and release workflow.
- **B) Fusion plugin + direct glasses→host HTTP**  
  - Pros: simpler architecture if supported.  
  - Cons: currently unsupported/unverified by available SDK evidence; high risk.
- **C) External companion service only (no plugin)**  
  - Pros: decoupled deployment.  
  - Cons: weaker Fusion-native UX/config surface; harder multi-project/operator setup.

### 5.2 Recommendation and rationale
Choose **Option A**. It is the only approach consistent with currently visible Even developer surface and allows Fusion-side pairing/config, auth reuse, and optional plugin-scoped helper routes without modifying core transport/auth.

**Companion app ownership for v1:** the companion app implementation is **out of scope** for this FN-3738→FN-3747 Fusion chain; the chain should deliver Fusion plugin/API-side integration points that a companion owner can consume.

**Polling cadence recommendation (v1):**
- Task/board refresh: **30–60s** via `GET /api/tasks` (or filtered variants).
- Active agent-run refresh: **10–20s** while run is active via `GET /api/agents/:id/runs` and `GET /api/agents/:id/runs/:runId`.
- Idle/background mode: degrade to **60–120s** to respect mobile/background constraints.

## 6. Constraints, Risks, and v1 Scope Guards
- Keep v1 strictly to task read/create/update, quick capture, polling alerts, and basic agent triggers.
- Do **not** include missions/roadmaps/search/multi-project interaction on-device in v1.
- Major risk: unresolved official documentation on direct networking/background wake; mitigate via conservative polling model.
- Payload-shaping risk: container/list/text limits require terse card design and pagination.

## 7. API/Server Gaps to Address in FN-3745
- Potential thin endpoint needed for **notification aggregation** (single compact payload for glasses) to reduce multi-call polling overhead.
- Potential plugin-scoped endpoint for **quick-capture normalization** (e.g., text template expansion, source tagging).
- If existing endpoints suffice after prototype latency tests, FN-3745 can explicitly close with “none required.”

## 8. Open Questions
1. What is the canonical official Even developer portal/docs URL for G2 app developers?
2. Is direct device/network HTTP officially supported, or only app-bridge mediated calls?
3. What are hard background polling/wake limits on iOS/Android Even host environments?
4. Is first-party STT officially exposed to third-party Even Hub apps, or must PCM be sent to external STT?
5. Are there formal payload size/rate limits for bridge messages and UI refresh frequency?
6. Who owns companion app delivery in FN-3738+ (Fusion team vs separate mobile team)?

## 9. Sources
- Even official site: https://www.evenrealities.com/
- npm package metadata: https://www.npmjs.com/package/@evenrealities/even_hub_sdk
- SDK README/API details (via npm package readme): https://www.npmjs.com/package/@evenrealities/even_hub_sdk?activeTab=readme
- Fusion plugin authoring: `docs/PLUGIN_AUTHORING.md`
- Fusion plugin lifecycle/management: `docs/plugin-management.md`
- Fusion architecture/API context: `docs/architecture.md`
- Fusion remote/auth model: `docs/remote-access.md`, `docs/settings-reference.md`
- Fusion task routes source: `packages/dashboard/src/routes/register-task-workflow-routes.ts`
- Fusion agent runtime routes source: `packages/dashboard/src/routes/register-agent-runtime-routes.ts`
- Community ecosystem signal (non-authoritative): GitHub search results for “even realities sdk” (example repos surfaced via GitHub Search API).