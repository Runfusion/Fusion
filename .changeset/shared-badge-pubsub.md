---
"@dustinbyrne/kb": patch
---

Add shared badge pub/sub support for multi-instance dashboard deployments

The dashboard now supports cross-instance badge update delivery via Redis pub/sub. When running multiple dashboard instances behind a load balancer, badge updates detected on one instance are now delivered to subscribed WebSocket clients on other instances.

**Configuration:**
- `KB_BADGE_PUBSUB_REDIS_URL` - Redis connection URL (enables multi-instance mode)
- `KB_BADGE_PUBSUB_CHANNEL` - Pub/sub channel name (default: `kb:badge-updates`)

**Features:**
- Badge snapshots are fanned out across instances while preserving per-instance focused polling
- Echo loop prevention via source instance deduplication
- Structured snapshot cache for late subscription replay
- Graceful fallback to in-memory mode when Redis is not configured
- Clean adapter shutdown without connection leaks

**API Changes:**
- `ServerOptions` now accepts optional `badgePubSub` and `githubPoller` for dependency injection
- Package exports include `GitHubPollingService` and badge pub/sub interfaces
