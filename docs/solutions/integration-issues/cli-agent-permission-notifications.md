---
category: integration-issues
module: engine/cli-agent
tags: [cli-agent, notifications, permissions, ntfy, webhook]
problem_type: runtime-wiring
applies_when: CLI-agent sessions enter waitingOnInput but external notification providers do not receive permission/input alerts
---

# CLI-agent permission prompts must wire `TelemetryHub.onNotification`

CLI adapters normalize tool-permission and terminal-input prompts to `TelemetryHub.ingest(..., { kind: "waitingOnInput" })`. The hub updates session state for the in-app banner and invokes the optional `onNotification` callback for external delivery.

If a runtime constructs `createCliAgentRuntime(...)` without `onNotification`, the dashboard can still show `waiting_on_input`, but ntfy/webhook providers never receive the alert. Wire runtime construction to dispatch `cli-agent-awaiting-input` through `getActiveNotificationService()?.dispatch(...)`, include task/session metadata, and provide a `notificationDedupeKey` so duplicate waiting telemetry does not spam providers.
