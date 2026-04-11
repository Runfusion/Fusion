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
