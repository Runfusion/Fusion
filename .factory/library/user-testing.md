# User Testing

Testing surface, required testing skills/tools, and resource cost classification.

## Validation Surface

| Surface | Description | Tool |
|---------|-------------|------|
| Dashboard UI | Mission manager with assertions panel, loop states, validation controls | agent-browser |
| REST API | Assertion CRUD, validation trigger, loop state, runs, recovery | curl |
| CLI | Mission commands | Manual verification |

## Validation Concurrency

**Machine specs:** 28 CPU cores, 256 GB RAM

**agent-browser (lightweight app):**
- Dashboard is a lightweight web app (~200 MB with dev server)
- Each agent-browser instance: ~300 MB RAM
- Dev server: ~200 MB
- Usable headroom: 256 GB * 0.7 = ~179 GB (very generous)
- Max concurrent validators: **5** (standard max)

## Resource Cost Notes

- Dashboard dev server (`fn dashboard`) needs to be running for browser tests
- API tests via curl are very lightweight — no concurrency limit needed
- Tests should use a fresh `.fusion/fusion.db` to avoid state pollution

## Test Data Context

**Mission:** M-MNVT98HS-I8OG ("Integration Test Mission")
**Milestone:** MS-MNVT9VEC-70GM ("Validation Test Milestone")
**Slices:** SL-MNVTAC2B-49SK (Slice 1), SL-MNVTAC91-98T3 (Slice 2)

**Assertions:**
- CA-MNVTGDE4-YEGX: "Feature links correctly" (pending)
- CA-MNVTGDHD-8ZAJ: "Validation passes on success" (pending)
- CA-MNVTGDRD-QNBH: "Fix feature created on failure" (pending)

**Features with loop states:**
| ID | Title | Loop State | Status | Notes |
|----|-------|-----------|--------|-------|
| F-MNVTCGT6-Z6PM | Assertion Linking Test | idle | defined | First feature, no links |
| F-MNVTDFNW-NXSW | Assertion Linking Feature | idle | triaged | Linked to CA-...YEGX, CA-...8ZAJ |
| F-MNVTDFQ1-ED3P | Implementing State Feature | implementing | in-progress | No assertions |
| F-MNVTDG3I-YZCR | Validating State Feature | validating | in-progress | No assertions |
| F-MNVTDGC0-J3W3 | Needs Fix Feature | needs_fix | in-progress | Linked to CA-...QNBH, 1 failed run |
| F-MNVTDGJ7-N7QC | Passed Validation Feature | passed | done | Linked to CA-...YEGX, CA-...8ZAJ, 1 passed run |
| F-MNVTDGLC-G6TD | Blocked Feature | blocked | in-progress | No assertions, budget exhausted |
| F-MNVTDGXO-EU7E | Fix Feature from Lineage | passed | done | generatedFrom F-...J3W3, has lineage |
| F-MNVTDH2E-YYZD | Run History Feature | passed | done | 3 runs (2 failed, 1 passed) |

**Dashboard URL:** http://localhost:4040
**Navigation:** Click "Missions" in sidebar → find "Integration Test Mission" → expand

## Flow Validator Guidance: Dashboard UI

**Isolation:** All browser validators share the same dashboard and test data. No mutations needed — validators observe existing state. Concurrent execution is safe.

**Navigation pattern:**
1. Go to http://localhost:4040
2. Click "Missions" tab in sidebar navigation
3. Find "Integration Test Mission" and click to expand
4. The mission detail shows milestones, slices, features, and assertions

**Key selectors and patterns:**
- Mission list items: `.mission-item` or similar
- Milestone expand/collapse: click milestone header
- Feature cards: look for feature titles and loop state indicators
- Assertions panel: within milestone detail, look for assertions section
- Validation rollup: milestone header area

**Constraints:**
- Do NOT create/delete any data through the browser — only observe
- Do NOT modify the test mission data
- Each validator should take screenshots as evidence
- Use `--session` flag for all agent-browser calls to avoid session conflicts

## Flow Validator Guidance: REST API

**Isolation:** API tests can run freely alongside browser tests. No shared browser session.

**Base URL:** http://localhost:4040

**Key endpoints:**
- `GET /api/missions` — list all missions
- `GET /api/missions/:id` — mission detail with milestones/slices/features
- `GET /api/missions/milestones/:id/assertions` — assertions for milestone
- `GET /api/missions/features/:id/assertions` — linked assertions for feature
- `GET /api/missions/features/:id/validation-loop` — loop state snapshot
- `GET /api/missions/features/:id/validation-runs` — validator run history
- `GET /api/missions/milestones/:id/validation` — milestone rollup
- `GET /api/missions/validation-runs/:id` — single run detail

**Constraints:**
- Read-only testing preferred
- If creating test data, clean up afterward
