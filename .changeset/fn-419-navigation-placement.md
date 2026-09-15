---
"@runfusion/fusion": minor
---

summary: Choose where the main menu lives — bottom bar or left sidebar — and never see both at once.
category: feature
dev: New project setting `navigationPlacement` ("footer" | "sidebar", default "footer") declared in `DEFAULT_PROJECT_SETTINGS` and edited from Settings → Appearance. `packages/dashboard/app/utils/navigationPlacement.ts` owns `resolveNavigationSurfaces`/`resolveChatHost`; App.tsx consumes it as the sole decider, so footer and sidebar are mutually exclusive on every breakpoint (the tablet tier previously mounted both). Sidebar placement hosts `EngineControlMenu` plus the Terminal action, omits `DashboardWindowVisibilityToggle`, emits no `--with-footer` reservations, and routes Chat to the main keep-alive page instead of the right dock.
