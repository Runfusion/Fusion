---
"@runfusion/fusion": patch
---

summary: Settings authentication now uses the same persistent sign-in dialog as first-run onboarding.
category: fix
dev: Wires `ProviderLoginDialog` into SettingsModal/AuthenticationSection for `requiresManualCode` OAuth flows. Settings keys every flow by `stateKey` (`providerId`, or `providerId[instance]` for a named credential instance), so `loginDialog` carries `{ stateKey, providerId, instanceId, providerName }` and the row suppresses its own instructions/paste field only for the key the dialog owns — a sibling account keeps its inline field. Rendered outside `renderModalShell` because the modal presentation is a FloatingWindow and a portaled dialog inside its React subtree lifts the window above itself on first click.
