---
"@runfusion/fusion": patch
---

summary: Shrink oversized icon-only buttons so back, create, and close match the rest of the app on mobile.
category: fix
dev: Adds `--icon-button-size` (28px) and `--icon-button-size-mobile` (36px), moves the borderless `.btn-icon` base out of `Header.css` into `styles.css` at unchanged 0,1,0 specificity (declared before `.btn`, so the bordered variant no longer depends on stylesheet injection order) and adds a border-only `.btn.btn-icon`. Removes bespoke 40/44px icon squares from ViewActionButton, TerminalModal, FileBrowser, SettingsModal, ScriptsModal, TaskCard, TaskDetailModal, AgentsView, AgentDetailView, PluginManager, DevServerView, and MailboxModal; the create button drops `btn-primary` in favour of `view-action-button--create`. Labelled controls keep `--touch-target-min-size`. Guarded by `icon-only-button-canon.test.tsx`.
