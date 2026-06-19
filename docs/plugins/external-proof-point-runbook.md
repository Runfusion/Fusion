<!--
FNXC:Plugins 2026-06-14-13:36:
Task FN-6438 requires a reusable proof-point runbook for validating that an externally authored plugin runs against a released Fusion build. Keep this document tied to task-document evidence, especially FN-6437's proof-point-report, so future agents repeat the validation from durable docs instead of task-local scratch files.
-->

# External Plugin Proof-Point Runbook

This runbook validates the v1 ecosystem signal for goal **G-MPS8FPMK-0001-SAWD**: an externally authored Fusion plugin can be scaffolded, built, tested, loaded, enabled, and listed against a **released** `@runfusion/fusion` build without using the Fusion monorepo.

Use the step-by-step authoring guide for command details: [External Plugin Authoring](./external-authoring.md). This runbook adds release selection, evidence capture, and pass/fail criteria for proof-point validation.

## Purpose & when to run

Run this proof point when Fusion claims support for external plugin authors, especially before or after a release that changes any of these surfaces:

- `fn plugin new`
- `fn plugin dev`
- `fn plugin install`
- `fn plugin enable`
- `fn plugin list`
- `@runfusion/fusion/plugin-sdk`
- bundled CLI/runtime dependencies that the released package must resolve without monorepo `workspace:*` links

The proof point must use the public release artifact. Do not validate with a local workspace build unless the task is explicitly about pre-release smoke testing.

## Prerequisites

- Node.js 18+
- `pnpm` and `npm`
- Public registry/network access for `npm view`, `npx`, and package installation
- A clean temporary workspace **outside** the Fusion repo, for example:

  ```bash
  export FUSION_PLUGIN_PROOF_DIR="$(mktemp -d)"
  cd "$FUSION_PLUGIN_PROOF_DIR"
  ```

- Do **not** start or kill anything on port 4040. Port 4040 is reserved for the production dashboard. If a command needs a server port, use a random/free port option such as `--port 0`.
- Do **not** run an unbounded recursive `find` rooted at `/tmp`, `$TMPDIR`, or macOS `/var/folders/...`. If you need to inspect the temp workspace, list only the known proof directory.

## Released version selection

Capture the released package version and integrity before running the proof point:

```bash
npm view @runfusion/fusion version
npm view @runfusion/fusion dist.integrity
```

For this runbook update, registry provenance was recaptured on 2026-06-14:

```text
@runfusion/fusion version: 0.43.0
dist.integrity: sha512-kvxicT+e8ulc7FDhBVP9NsgaioZv6NDW81N8cXNS/X8M32Eo3Y33xT6JFW2DrSiFXsJmAaib/GnpQE0nYQYApQ==
```

The proof point should target a release that includes the external-author fixes tracked by FN-6409, FN-6410, and FN-6435. Before running, confirm the release notes or consumed changeset state include `.changeset/fn-5844-external-plugin-authoring.md`; if that changeset has not been consumed into the published package, record a release-gate failure rather than patching locally.

Use the concrete release tarball URL for the version under test:

```text
https://registry.npmjs.org/@runfusion/fusion/-/fusion-<version>.tgz
```

Replace `<version>` only with the value returned by `npm view @runfusion/fusion version` for the run being reported.

## Plugin source selection

Prefer the released scaffold path because it validates the public author experience end to end:

```bash
npx @runfusion/fusion@latest plugin new proof-point-plugin
cd proof-point-plugin
```

The scaffolded package should be standalone:

- package name like `fusion-plugin-proof-point-plugin`
- imports SDK helpers from `@runfusion/fusion/plugin-sdk`
- no private `@fusion/*` imports
- no `workspace:*` dependencies
- no references to the Fusion monorepo checkout

If the task requires testing an already-authored external plugin instead of the scaffold, record its canonical repository, docs/homepage, release/download artifact, binary/CLI if any, and checksum or `upstream-pending-verification` marker before running it.

## Execution commands

Follow [External Plugin Authoring](./external-authoring.md) for detailed command behavior. The validated loop is:

```bash
fn plugin new proof-point-plugin
cd proof-point-plugin
pnpm install
pnpm build
pnpm test
fn plugin dev . --once
fn plugin list
```

If the proof point uses the packaged-install path instead of `plugin dev`, run the equivalent install/enable/list loop:

<!--
FNXC:Plugins 2026-06-15-02:57:
FN-6474 reconciles the packaged-install proof path with CLI behavior discovered in FN-6471: `fn plugin install` rejects raw tarballs as non-JS file entrypoints, so proof runs must extract the package and install the built plugin directory.
-->

```bash
pnpm build
pnpm test
pnpm pack
tar -xzf fusion-plugin-proof-point-plugin-0.1.0.tgz
fn plugin install ./package
fn plugin enable fusion-plugin-proof-point-plugin
fn plugin list
```

Troubleshooting: FN-6471 found that `npx @runfusion/fusion@0.43.1 plugin install ./fusion-plugin-proof-point-plugin-0.1.0.tgz` fails with `Plugin entry file must end with .js, .mjs, or .cjs: <abs>/fusion-plugin-proof-point-plugin-0.1.0.tgz`. The failure is expected for a raw tarball because `fn plugin install` accepts a built plugin directory (or installed package name), not a packed `.tgz`; extract first and install from `./package`. This corrects the packaged-install snippet originally added by FN-6438.

Record the exact commands actually run. Do not summarize a command as successful unless its transcript shows exit code 0 or equivalent success output.

## Evidence to capture

Store evidence in a task document named `proof-point-report`. Evidence must **not** live only in task-local scratch files.

The report should start with a top-level verdict line:

```text
VERDICT: MET
```

or:

```text
VERDICT: NOT MET — <short reason>
```

Capture at least:

1. Released `@runfusion/fusion` version.
2. `dist.integrity` from `npm view @runfusion/fusion dist.integrity`.
3. The concrete release/download URL for the tested version.
4. Evidence that `.changeset/fn-5844-external-plugin-authoring.md` has been consumed into the release, or a release-gate failure if it has not.
5. Full command transcript for scaffold, install, build, test, load/install, enable, and list.
6. `fn plugin list` output proving the plugin is present and enabled.
7. Any failure signature and the follow-up task IDs filed for it.

A minimal report shape:

````markdown
VERDICT: MET

## Released package
- Package: @runfusion/fusion
- Version: <npm view version>
- dist.integrity: <npm view dist.integrity>
- Release URL: https://registry.npmjs.org/@runfusion/fusion/-/fusion-<version>.tgz

## Commands
```bash
<exact commands>
```

## Evidence
```text
<important excerpts, including fn plugin list enabled-state proof>
```

## Follow-ups
- None, or task IDs for gaps found
````

## Expected pass/fail signals

### MET

A proof point is **MET** when a standalone external plugin:

- is created or selected without monorepo-only dependencies,
- installs dependencies from the public registry,
- builds and tests successfully,
- loads/enables through the released `fn` CLI path, and
- appears in `fn plugin list` as enabled.

### NOT MET

A proof point is **NOT MET** when any required public-author step fails against the released build. File focused follow-up tasks for release-gate gaps instead of patching product code inside the validation run.

Known failure signatures to watch:

- `TS2307: Cannot find module '@fusion/core'` — private SDK typing leakage; tracked by FN-6409.
- `ERR_MODULE_NOT_FOUND` for `@earendil-works/pi-*` — released CLI dependency packaging/resolution gap; tracked by FN-6410.
- `TS2345` with `Property 'state' is missing` — scaffold or SDK type mismatch; tracked by FN-6435.

If a known signature reappears in a release that should contain its fix, file a new regression task that links the original task and includes the transcript.

## External integration evidence

This runbook installs and runs the released third-party-distributed Fusion CLI (`@runfusion/fusion`) from the public npm registry. Provenance recaptured via `npm view @runfusion/fusion version dist.integrity --json` on 2026-06-14:

- Canonical upstream repo URL: https://github.com/Runfusion/Fusion
- Docs / homepage URL: https://www.npmjs.com/package/@runfusion/fusion; in-repo author guide `docs/plugins/external-authoring.md`; in-repo SDK guide `docs/PLUGIN_AUTHORING.md`
- Release / download URL: https://registry.npmjs.org/@runfusion/fusion/-/fusion-0.43.0.tgz
- Binary / CLI name: `fn` (provided by the published `@runfusion/fusion` package; also invokable via `npx @runfusion/fusion@latest`)
- Checksum (`dist.integrity` for 0.43.0): `sha512-kvxicT+e8ulc7FDhBVP9NsgaioZv6NDW81N8cXNS/X8M32Eo3Y33xT6JFW2DrSiFXsJmAaib/GnpQE0nYQYApQ==`

For future proof-point runs, replace the release URL and checksum only with values returned by `npm view` for the tested version. If the checksum cannot be verified, write `upstream-pending-verification` and do not fabricate a hash.

## Reference: concrete validated path (FN-6437)

<!--
FNXC:Plugins 2026-06-14-14:11:
FN-6452 backfills FN-6437's concrete proof-point evidence from FN-6449's restored report and FN-6437's surviving notes revisions. The historical result is NOT MET against released @runfusion/fusion 0.43.0 because the plugin scaffold omitted the required state field; keep absent list/enable evidence explicit instead of inventing a successful transcript.
-->

**VERDICT: NOT MET — blocked-on-release because the released `@runfusion/fusion@0.43.0` package still scaffolded a plugin missing the required `state` field, matching the FN-6435 release-gate signature.**

Provenance: FN-6449 restored this reference from FN-6437's surviving `task_document_revisions` (`notes`, revisions 1–3; latest revision 3) plus the archived FN-6437 task row. FN-6449's `proof-point-report` / `docs` task document is the canonical restored report; this section transcribes its supported values only.

### Released package tested

- Package: `@runfusion/fusion@0.43.0`
- Release URL: `https://registry.npmjs.org/@runfusion/fusion/-/fusion-0.43.0.tgz`
- `dist.integrity`: `sha512-kvxicT+e8ulc7FDhBVP9NsgaioZv6NDW81N8cXNS/X8M32Eo3Y33xT6JFW2DrSiFXsJmAaib/GnpQE0nYQYApQ==`
- Changeset consumption check: `.changeset/fn-5844-external-plugin-authoring.md` present in repo: `no`

### Environment

- node: `v26.3.0`
- pnpm: `10.33.0`
- npm: `11.16.0`
- os: `Darwin fusionstudio-8339.local 25.1.0 Darwin Kernel Version 25.1.0: Mon Oct 20 19:30:01 PDT 2025; root:xnu-12377.41.6~2/RELEASE_ARM64_T6031 arm64`
- scratch workspace: `/var/folders/zp/fjh8794n7bl61c_pn1gmdt200000gn/T/tmp.zLiu2nRpx8`
- scratch workspace under repo tree: `no`

### Commands and outcomes

```bash
npm view @runfusion/fusion version
npm view @runfusion/fusion dist.integrity
npx @runfusion/fusion@latest --help
npx @runfusion/fusion@latest plugin --help
npx @runfusion/fusion@latest plugin new proof-point-plugin
cd proof-point-plugin
pnpm install
pnpm build
# pnpm test was not attempted after the blocking compile failure.
```

- `npm view @runfusion/fusion version` returned `0.43.0`.
- `npm view @runfusion/fusion dist.integrity` returned `sha512-kvxicT+e8ulc7FDhBVP9NsgaioZv6NDW81N8cXNS/X8M32Eo3Y33xT6JFW2DrSiFXsJmAaib/GnpQE0nYQYApQ==`.
- `npx @runfusion/fusion@latest --help` and `npx @runfusion/fusion@latest plugin --help` passed and showed the expected plugin subcommands, including `list`, `install`, `enable`, `new`, and `dev`.
- `npx @runfusion/fusion@latest plugin new proof-point-plugin` generated `fusion-plugin-proof-point-plugin@0.1.0`.
- `pnpm install` passed.
- `pnpm build` failed with the FN-6435 release-gate signature below.
- `pnpm test` was not attempted after the released scaffold failed to compile.
- Install/enable/load-run and `fn plugin list` were not attempted because the plugin never built.

### Scaffold evidence

The generated `package.json` used the published package and did not show monorepo-only dependency leakage:

```json
{
  "name": "fusion-plugin-proof-point-plugin",
  "version": "0.1.0",
  "type": "module",
  "description": "A standalone Fusion plugin",
  "keywords": [
    "fusion-plugin"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "manifest.json"
  ],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "@runfusion/fusion": "^0.43.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.0"
  }
}
```

The generated `src/index.ts` imported the public SDK path but omitted the required `state` field:

```ts
import { definePlugin } from "@runfusion/fusion/plugin-sdk";

export default definePlugin({
  manifest: {
    id: "proof-point-plugin",
    name: "Proof Point Plugin",
    version: "0.1.0",
    description: "A standalone Fusion plugin",
  },
  hooks: {
    onLoad: async (ctx) => {
      ctx.logger.info("Proof Point Plugin plugin loaded");
    },
  },
});
```

Dependency checks recorded by FN-6437:

- `@fusion/*` imports in scaffolded source: `none observed`
- `workspace:*` dependency ranges in scaffolded `package.json`: `none observed`
- SDK import surface: `@runfusion/fusion/plugin-sdk` as expected

### Blocking failure transcript

```text
> fusion-plugin-proof-point-plugin@0.1.0 build /private/var/folders/zp/fjh8794n7bl61c_pn1gmdt200000gn/T/tmp.zLiu2nRpx8/proof-point-plugin
> tsc

src/index.ts(3,29): error TS2345: Argument of type '{ manifest: { id: string; name: string; version: string; description: string; }; hooks: { onLoad: (ctx: PluginContext) => Promise<void>; }; }' is not assignable to parameter of type 'FusionPlugin'.
  Property 'state' is missing in type '{ manifest: { id: string; name: string; version: string; description: string; }; hooks: { onLoad: (ctx: PluginContext) => Promise<void>; }; }' but required in type 'FusionPlugin'.
 ELIFECYCLE  Command failed with exit code 2.
```

### Gaps and follow-up

- Release-gate blocker: FN-6435 (the scaffold `state` fix had not reached released `@runfusion/fusion@0.43.0`).
- `fn plugin list` enabled-state proof: **not produced — VERDICT NOT MET (blocked at `pnpm build` by the unreleased FN-6435 scaffold-`state` fix)**.
- FN-6409 and FN-6410 remained known checks for released SDK typing and CLI dependency resolution, but FN-6437 did not reach those later surfaces after the FN-6435 compile failure.
