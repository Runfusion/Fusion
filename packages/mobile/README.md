# @fusion/mobile

## Push Notifications

`PushNotificationManager` supports two complementary notification channels:

1. **Native push notifications** via Capacitor Push Notifications (`@capacitor/push-notifications`) for FCM/APNs token registration and notification tap handling.
2. **ntfy.sh streaming subscription** via polling-driven topic management, so the app can receive in-app notifications without server-side FCM/APNs setup.

### Initialization

```ts
import { PushNotificationManager } from "@fusion/mobile";

const manager = new PushNotificationManager({
  settingsFetcher: fetchGlobalSettings,
});

await manager.start();
```

You can also initialize through `initializePlugins({ pushNotifications: { ... } })` if you want plugin bootstrapping from a single entrypoint.

### Event API

```ts
manager.on("notification:tapped", ({ taskId }) => {
  if (taskId) {
    navigateToTask(taskId);
  }
});

manager.on("notification:received", ({ title, body }) => {
  console.log("Foreground notification", title, body);
});

manager.on("ntfy:message", ({ taskId, message }) => {
  console.log("ntfy message", taskId, message);
});
```

### ntfy.sh Integration Behavior

When `settingsFetcher()` returns:

- `ntfyEnabled: true`
- `ntfyTopic: "<topic>"`

…the manager starts (or switches) a live subscription to `{ntfyBaseUrl}/{topic}/json`.

If settings disable ntfy or clear the topic, the subscription is automatically stopped.

### Device Token Access

Use `manager.getDeviceToken()` after registration to retrieve the native device token for future server-side FCM/APNs integration work.

### Out of Scope

This package currently handles **receiving** push notifications and in-app routing events only.

Server-side FCM/APNs delivery infrastructure (token storage, provider credentials, push sending services) is intentionally out of scope for this feature.
