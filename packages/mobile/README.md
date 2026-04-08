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

## Native Sharing & Deep Links

### ShareManager

`ShareManager` opens platform-native sharing when available and always includes a Fusion deep link in the shared payload.

```ts
import { ShareManager } from "@fusion/mobile";

const manager = new ShareManager();
await manager.initialize();

await manager.shareTask({
  id: "FN-1118",
  title: "Mobile Plugins - Native Sharing & Deep Links",
  description: "Implements native share sheet support and deep link parsing.",
});
```

#### Share behavior + fallbacks

- Builds a payload with:
  - `title`: `task.title` or fallback `Task {id}`
  - `text`: task description (truncated to 200 chars with `...` when needed)
  - `url`: `${deepLinkBaseUrl}{task.id}` (default base: `fusion://task/`)
- **Native (Capacitor)**: uses `@capacitor/share`
- **Web fallback**: uses `navigator.share(...)` when available
- **Final fallback**: copies the deep-link URL to `navigator.clipboard.writeText(...)`

#### Share events

- `share:success` → `{ taskId }`
- `share:cancelled` → `{ taskId }`
- `share:error` → `{ taskId, error }`

### DeepLinkManager

`DeepLinkManager` handles incoming links and emits parsed payloads for app-level navigation.

```ts
import { DeepLinkManager } from "@fusion/mobile";

const deepLinks = new DeepLinkManager({
  scheme: "fusion://",
  universalLinkHosts: ["app.fusion.dev"],
});

await deepLinks.initialize();

deepLinks.on("deeplink:received", (payload) => {
  // route to screen/task/project in app UI
  console.log(payload);
});
```

#### Supported URL patterns

- `fusion://task/{taskId}`
- `fusion://project/{projectId}`
- `fusion://project/{projectId}/task/{taskId}`
- `fusion://settings`
- `fusion://agents`
- Query params are preserved in `payload.params` for custom-scheme links

Universal links are supported when the host is allowed in `universalLinkHosts`, e.g.:

- `https://app.fusion.dev/?task=FN-123`
- `https://app.fusion.dev/?project=my-project&task=FN-123&target=task`

#### Deep link events

- `deeplink:received` → parsed `DeepLinkPayload`
- `deeplink:error` → `{ url, error }`

Use `handleUrl(url)` for programmatic handling (for example, push-notification tap flows that already provide a URL string).

### Integration flow: share -> open -> navigate

A common flow is:

1. Use `ShareManager.shareTask(...)` to share a task link like `fusion://task/FN-123`
2. Recipient opens that link on mobile
3. `DeepLinkManager` receives/parses the URL
4. Your UI listens to `deeplink:received` and navigates to the matching task view

### Capacitor deep-link scheme registration

The Fusion mobile app registers the custom URL scheme in `packages/dashboard/capacitor.config.ts`:

- `server.iosScheme = "fusion"`
- `server.androidScheme = "fusion"`

### Browser hash listener (development/testing)

On non-native platforms, `DeepLinkManager` listens for hash changes in the form:

- `#deeplink=<encoded-url>`

This hash-based behavior is intended for development/testing only and is not a production universal-link replacement.
