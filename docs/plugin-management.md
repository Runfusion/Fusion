# Plugin Management Guide

[← Docs index](./README.md)

This guide is the canonical end-user workflow for managing Fusion plugins across the full lifecycle: discover, install, enable/disable, configure, use, update, uninstall, and troubleshoot.

> Plugin author/developer details (manifest, SDK APIs, hooks, routes, and runtime implementation) live in [Plugin Authoring](./PLUGIN_AUTHORING.md).

## 1) Plugin basics

Fusion uses two plugin surfaces in Settings:

- **Fusion Plugins** (`Settings → Plugins → Fusion Plugins`): extend Fusion behavior (tools, routes, UI slots/views, runtimes)
- **Pi Extensions** (`Settings → Plugins → Pi Extensions`): manage pi extension packages/sources

These are related but different systems; do not treat Pi Extensions as Fusion Plugins.

### Lifecycle states

| State | Meaning |
|---|---|
| `installed` | Registered but not started yet |
| `started` | Loaded and active |
| `stopped` | Disabled/stopped |
| `error` | Failed to load or failed at runtime |

### Setup status vs lifecycle state (Settings behavior)

Setup-capable plugins (for example **Agent Browser**) expose an additional **setup** check that is separate from lifecycle state.

- A plugin may be `installed`/`stopped` without being broken.
- When a plugin is not `started`, Settings shows setup check as deferred ("Start plugin to check setup") instead of treating it as an error.
- Error styling is reserved for true plugin lifecycle failures (`state = error`) or true setup-check failures returned while the plugin is running.

### Common locations

| Location | Purpose |
|---|---|
| `~/.fusion/plugins/` | Default local plugin install location |
| Bundled plugin manifests (shipped with Fusion) | Discoverable/installable from Plugin Manager |
| Custom local path (absolute path) | Install plugin from a local directory |

### Plugin scope

Plugin persistence is split across global and project scopes:

- Plugin installs are **global**. Installation metadata is registered in `~/.fusion/fusion-central.db` and shared across all projects on this machine.
- Enable/disable is **project-scoped**. The same globally installed plugin can be enabled in one project and disabled in another. Per-project activation/runtime state is tracked in `project_plugin_states`.
- `fn plugin list` shows the global install set plus enabled/disabled state for the current project context.

For full multi-project details, see [Plugin Scope in Multi-Project Mode](./multi-project.md#plugin-scope-in-multi-project-mode).

## 2) Discover available plugins

### Dashboard

1. Open **Settings → Plugins → Fusion Plugins**.
2. Review bundled entries in **Bundled Plugins** and currently installed entries.
3. Check each plugin’s status/state in the manager.

First-party bundled entries include runtime plugins plus integrations like **Dependency Graph**, **Reports**, **Roadmap**, **WhatsApp Chat**, and **CLI Printing Press**.

Expected outcome: You can see what is already installed, what is bundled and available, and each plugin’s current lifecycle state.

### CLI

1. Run:
   ```bash
   fn plugin list
   ```
2. Review installed plugin IDs and status.

Expected outcome: You have a terminal view of installed plugins for scripting/remote workflows.

## 3) Install plugins

### Install bundled plugin (dashboard)

1. Go to **Settings → Plugins → Fusion Plugins**.
2. In **Bundled Plugins**, click **Install** for the plugin.

> Install/uninstall are global operations and affect plugin availability for every project on this machine.

Expected outcome: Plugin is registered and appears with an initial state (typically `installed` then `started` when enabled/loaded).

> WhatsApp Chat plugin note: Pair it directly to WhatsApp Web (multi-device) via QR (`/api/plugins/fusion-plugin-whatsapp-chat/qr`) or pairing code (`/api/plugins/fusion-plugin-whatsapp-chat/pair-code`). No public webhook endpoint or Meta Cloud credentials are required. Keep `allowedSenders` populated (empty list blocks all inbound messages), and use `/logout` to force re-pairing.

### Install from local path (dashboard)

1. Go to **Settings → Plugins → Fusion Plugins**.
2. Use **Install** and provide an absolute plugin path.
3. Confirm installation.

> Install/uninstall are global operations and affect plugin availability for every project on this machine.

Expected outcome: Plugin is added to your local plugin set and appears in the manager.

### Install from local path (CLI)

1. Run:
   ```bash
   fn plugin install <path>
   ```
2. Confirm the plugin appears in:
   ```bash
   fn plugin list
   ```

> `fn plugin install` and `fn plugin uninstall` are global operations and affect every project on this machine.

Expected outcome: Plugin is installed from the specified path and visible in plugin listings.

## 4) Enable, disable, and reload plugins

### Dashboard

1. Open **Settings → Plugins → Fusion Plugins**.
2. Toggle plugin enable/disable controls.
3. Use reload controls when available.

> Enable/disable is project-scoped and only affects the current project.

Expected outcome: Plugin transitions between runtime states (`started` / `stopped`) and reflects transitions in the manager.

### CLI

```bash
fn plugin enable <id>
fn plugin disable <id>
```

> `fn plugin enable` and `fn plugin disable` are project-scoped operations and only affect the current project context.

Expected outcome: Plugin is enabled or disabled by ID.

## 5) Configure plugin settings

1. Go to **Settings → Plugins → Fusion Plugins**.
2. Open the plugin settings editor (gear/settings action).
3. Update fields and save.

Expected outcome: Plugin-defined settings are persisted and used by that plugin at runtime.

## 6) Use post-install plugin capabilities

After a plugin is installed/enabled, these are the current user-visible capability surfaces.

### A) Plugin-contributed skills (runtime behavior)

Plugin-contributed skills are merged into agent sessions automatically at runtime when enabled.

1. Install + enable the plugin.
2. Run a task through an agent flow (triage/executor/reviewer/merger).
3. Check agent output/logs for skill-driven behavior from that plugin.

Expected outcome: plugin skills affect session behavior, but there is no dedicated "plugin skills" management panel in Fusion Plugins.

> Note: **Skills view** shows discovered execution skills and toggles, but plugin-contributed skills are documented as runtime session behavior here (not a plugin-manager-specific skills UI).

### B) Plugin-contributed workflow step templates (dashboard + API)

Plugin templates are visible in the workflow-step chooser.

1. Open **Settings → Workflow Steps**.
2. Click **Add Workflow Step**.
3. In the templates chooser, find plugin-contributed templates (grouped/labeled with plugin attribution).
4. Add the template and configure phase/mode as needed.

Expected outcome: plugin templates appear alongside built-in templates and run like any other workflow step.

See also: [Workflow Steps](./workflow-steps.md) and [Plugin Authoring §16](./PLUGIN_AUTHORING.md#16-registering-workflow-steps).

### C) Plugin prompt contributions (runtime-only)

Prompt contributions modify agent prompts at runtime on supported surfaces (for example executor/triage/reviewer/heartbeat).

1. Install + enable the plugin.
2. Run the relevant agent flow.
3. Validate behavior via agent output/logs (for example extra instructions being followed).

Expected outcome: prompt modifications apply during agent runs. There is no verified dedicated dashboard UI to inspect/edit plugin prompt contributions directly.

See: [Plugin Authoring §17](./PLUGIN_AUTHORING.md#17-contributing-prompt-modifications).

### D) Optional plugin binary setup (currently CLI-driven)

Some plugins expose optional setup hooks for managed binaries/runtimes.

1. Ensure the plugin is installed and enabled.
2. Check setup status:
   ```bash
   fn plugin setup-status <id>
   ```
3. Trigger install or uninstall:
   ```bash
   fn plugin setup <id> --action install
   fn plugin setup <id> --action uninstall
   ```

Expected outcome: setup status and setup actions run via CLI. Current behavior is CLI-driven; do not assume a dedicated dashboard setup control exists.

See: [Plugin Authoring §18](./PLUGIN_AUTHORING.md#18-plugin-binary-setup-hooks).

## 7) Verify plugin is working

After installing/enabling, verify success signals relevant to that plugin:

- Plugin state remains `started` (not `error`)
- Plugin tools/routes/UI/runtime contributions appear where that plugin declares them
- Plugin-contributed workflow templates are available in **Settings → Workflow Steps**
- Plugin-contributed skills and prompt contributions are observable during agent runtime behavior/logs
- Optional setup-capable plugins report expected setup status via CLI

If you need capability-level details for a specific plugin, check its README and [Plugin Authoring](./PLUGIN_AUTHORING.md).

## 8) Update plugins

Fusion does not use a dedicated `fn plugin update` command. Update by reinstalling the desired plugin version/source.

### Dashboard

1. Reinstall from the bundled entry or updated local path.
2. Re-check state and behavior in the plugin manager.

### CLI

1. Re-run install against the updated source path:
   ```bash
   fn plugin install <path>
   ```
2. Confirm with:
   ```bash
   fn plugin list
   ```

Expected outcome: Updated plugin build/version is installed and operational.

## 9) Uninstall plugins

### Dashboard

1. Open **Settings → Plugins → Fusion Plugins**.
2. Uninstall the target plugin.

Expected outcome: Plugin is removed from the installed list and no longer active.

### CLI

1. Run:
   ```bash
   fn plugin uninstall <id> --force
   ```
2. Verify removal:
   ```bash
   fn plugin list
   ```

Expected outcome: Plugin is removed by ID.

## 10) Dashboard vs CLI mapping

| Workflow | Dashboard path | CLI command |
|---|---|---|
| List installed plugins | Settings → Plugins → Fusion Plugins | `fn plugin list` |
| Install plugin | Settings → Plugins → Fusion Plugins → Install | `fn plugin install <path>` |
| Enable plugin | Settings → Plugins → Fusion Plugins → Enable toggle | `fn plugin enable <id>` |
| Disable plugin | Settings → Plugins → Fusion Plugins → Disable toggle | `fn plugin disable <id>` |
| Uninstall plugin | Settings → Plugins → Fusion Plugins → Uninstall | `fn plugin uninstall <id> --force` |
| Check plugin setup status | CLI-only in current user flow | `fn plugin setup-status <id>` |
| Install/uninstall plugin setup binary/runtime | CLI-only in current user flow | `fn plugin setup <id> --action install|uninstall` |
| Add plugin workflow step template | Settings → Workflow Steps → Add Workflow Step | `POST /api/workflow-step-templates/:id/create` (API) |
| Scaffold new plugin (authoring) | n/a (developer workflow) | `fn plugin create <name>` |

## 11) Troubleshooting

### Plugin is in `error` state

1. Open **Settings → Plugins → Fusion Plugins** and inspect state/transition feedback.
2. Disable then re-enable the plugin.
3. Confirm plugin source path and dependencies are valid.
4. If needed, uninstall and reinstall the plugin.

### Hermes runtime plugin loaded but Fusion skill is missing in Hermes

The Hermes runtime plugin auto-installs the bundled Fusion skill on plugin load.

1. Confirm the plugin is `started`.
2. Check the Hermes skill path:
   - default profile: `${HERMES_HOME:-~/.hermes}/skills/fusion`
   - named profile: `${HERMES_HOME:-~/.hermes}/profiles/<profile>/skills/fusion`
3. Review plugin warnings; startup continues even if skill mirroring fails.
4. Reload/disable+enable the plugin to re-run the self-healing install attempt.

Manual post-install skill setup is typically not required for Hermes runtime anymore.

### Plugin installed but features are not visible

1. Confirm plugin state is `started`.
2. Verify what that plugin actually contributes (tools/routes/UI/runtime/skills/workflow templates/prompt contributions/setup hooks) in plugin docs.
3. Confirm you are checking the correct surface:
   - Workflow templates: **Settings → Workflow Steps**
   - Skills/prompt contributions: runtime agent behavior/logs
   - Setup hooks: CLI commands (`setup-status`, `setup`)
   - UI routes/slots: dashboard nav/sections/cards according to plugin design

### Confusion between Fusion Plugins and Pi Extensions

1. Use **Fusion Plugins** for Fusion plugin lifecycle management.
2. Use **Pi Extensions** only for pi extension sources/extensions/skills/prompts/themes.

### Plugin has setup requirements but dashboard has no setup control

Use CLI setup commands:

```bash
fn plugin setup-status <id>
fn plugin setup <id> --action install
fn plugin setup <id> --action uninstall
```

### Need implementation/API details

Use [Plugin Authoring](./PLUGIN_AUTHORING.md) for manifest fields, lifecycle hook signatures, UI/runtime contribution contracts, and SDK examples.

For sections referenced in this guide:
- Skills: [§15](./PLUGIN_AUTHORING.md#15-registering-skills)
- Workflow templates: [§16](./PLUGIN_AUTHORING.md#16-registering-workflow-steps)
- Prompt contributions: [§17](./PLUGIN_AUTHORING.md#17-contributing-prompt-modifications)
- Binary setup hooks: [§18](./PLUGIN_AUTHORING.md#18-plugin-binary-setup-hooks)
