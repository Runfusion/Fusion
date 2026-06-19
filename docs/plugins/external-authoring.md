# External Plugin Authoring

This guide is for plugin authors using an installed `@runfusion/fusion` CLI. You do not need access to the Fusion monorepo.

## Prerequisites

- Node.js 18+
- `pnpm` (or use the equivalent `npm` commands where noted)
- An installed Fusion CLI available as `fn`

## 1. Scaffold a standalone plugin

```bash
fn plugin new my-plugin
cd my-plugin
pnpm install
```

The scaffold creates a standalone package named `fusion-plugin-my-plugin`. It depends on the published `@runfusion/fusion` package and imports SDK helpers from `@runfusion/fusion/plugin-sdk`; it must not contain private `@fusion/*` imports or `workspace:*` dependencies.

## 2. Develop locally with hot reload

Start Fusion locally, then run the plugin dev loop from the plugin directory:

```bash
fn plugin dev .
```

`fn plugin dev .`:

1. Runs the plugin build script (`pnpm build`, with `npm run build` fallback).
2. Resolves the compiled JavaScript entry from `package.json` exports/main or `dist/index.js`.
3. Reads and validates the root `manifest.json`.
4. Installs and enables the plugin into the local Fusion plugin store.
5. Watches `src/` and, on save, rebuilds and hot-reloads with the Fusion plugin loader.

For a single CI-safe build/install/load pass without a watcher, use:

```bash
fn plugin dev . --once
```

You can also run the build yourself:

```bash
pnpm build
```

Troubleshooting: plugin entrypoints must be compiled JavaScript. `fn plugin install` and `fn plugin dev` reject `.ts` source entrypoints, so run the build before installing if you are not using the dev loop. A raw `*.tgz` is not a valid `fn plugin install` argument; extract it first with `tar -xzf` and install from the unpacked `./package` directory.

## 3. Test

```bash
pnpm test
```

If you prefer npm for a scaffold that supports it:

```bash
npm test
```

## 4. Package

Build first, then create an npm tarball:

```bash
pnpm build
pnpm pack
```

For `my-plugin` version `0.1.0`, the tarball is named like:

```text
fusion-plugin-my-plugin-0.1.0.tgz
```

The scaffolded package publishes only the files declared in `package.json` (`dist`, `manifest.json`, and package metadata) and exposes the plugin through:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

Before sharing the tarball, confirm the artifact does not include private monorepo-only strings:

- no `@fusion/*` imports or dependencies
- no `workspace:*` dependency ranges
- SDK imports come from `@runfusion/fusion/plugin-sdk`

## 5. Install elsewhere

On another machine with Fusion installed, extract or install the tarball, then point Fusion at the extracted plugin directory:

```bash
tar -xzf fusion-plugin-my-plugin-0.1.0.tgz
fn plugin install ./package
fn plugin enable fusion-plugin-my-plugin
```

If the plugin directory is already available, install it directly:

```bash
fn plugin install /path/to/fusion-plugin-my-plugin
fn plugin enable fusion-plugin-my-plugin
```

Use `fn plugin list` to confirm the plugin is installed and enabled for the current project.
