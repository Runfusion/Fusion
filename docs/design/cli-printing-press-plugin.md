# CLI Printing Press Plugin — Fusion Integration Architecture

**Task:** FN-3762
**Date:** 2026-05-10
**Status:** Design (v1)
**Dependencies:** FN-3761 (research, delivered)

---

## 1. Summary

This document specifies how Fusion integrates `cli-printing-press` (a Go-based CLI generator) as a **bundled first-party plugin**. Key one-liners:

- **Package name:** `@fusion-plugin-examples/cli-printing-press`
- **Manifest ID:** `fusion-plugin-cli-printing-press`
- **Directory:** `plugins/fusion-plugin-cli-printing-press/`
- **Storage model:** Plugin-owned SQLite tables via `onSchemaInit` hook (mirrors `plugins/fusion-plugin-roadmap/src/roadmap-schema.ts`)
- **Dashboard views:** Wizard, service list, service detail, CLI detail, run/test panel (5 views, plugin-owned)
- **Runtime integration:** Generated CLIs invoked as child processes via `promisify(exec)` with timeout + maxBuffer; binaries discovered via PATH or explicit path config
- **Auth in v1:** Non-OAuth only (api_key, bearer_token, header injection, env-var); OAuth deferred with reserved `auth.kind: "oauth"` escape hatch
- **Upstream binary:** `cli-printing-press` is a **Go binary**, not an npm package — spawned as subprocess, never imported as JS

---

## 2. Goals and Non-Goals

### Goals

1. Guided wizard for defining external services and generating CLIs from OpenAPI specs or documentation URLs
2. Plugin-owned dashboard views for managing generated service CLIs
3. Plugin-owned dashboard actions to manually run/test generated CLIs
4. Generated CLIs available in workflow steps (script mode)
5. Generated CLIs available in executor runtime environments (PATH injection)
6. Non-OAuth credential management with secrets in SQLite, redacted in API responses
7. Bundled as a first-party plugin shipped with the published `@runfusion/fusion` CLI

### Non-Goals (v1)

- **OAuth flows** — upstream supports OAuth2 (authorization_code, client_credentials) but v1 does not implement the browser redirect/callback dance. `auth.kind: "oauth"` is reserved in the schema but returns an error if used.
- **Mesh credential propagation** — deferred to FN-3707 or equivalent follow-up task
- **Browser-sniff / traffic-analysis generation** — v1 scopes to `--spec` (OpenAPI URL/file) and `--docs` (documentation URL) input modes only
- **`--plan` mode** — markdown-plan-driven generation deferred to v2
- **In-process JS embedding of cli-printing-press** — it is a Go binary; subprocess boundary is mandatory

---

## 3. Packaging and Registration

### 3.1 Package Identity

| Field | Value |
|-------|-------|
| Package name | `@fusion-plugin-examples/cli-printing-press` |
| Manifest ID | `fusion-plugin-cli-printing-press` |
| Directory | `plugins/fusion-plugin-cli-printing-press/` |
| Private | `true` |
| Type | `module` |

Mirrors `plugins/fusion-plugin-roadmap/package.json` exactly: `@fusion/core` and `@fusion/plugin-sdk` as workspace `dependencies` (not `peerDependencies`).

### 3.2 Three Registration Points

The plugin must be registered at exactly three points to ship in the published CLI:

1. **`pnpm-workspace.yaml`** — add `"plugins/fusion-plugin-cli-printing-press"` to the explicit packages list (alongside other per-plugin entries). No glob — each plugin is enumerated individually.

2. **`packages/cli/src/plugins/bundled-plugin-install.ts`** — add `"fusion-plugin-cli-printing-press"` to the `BUNDLED_PLUGIN_IDS` array.

3. **`packages/cli/tsup.config.ts`** — add a `cpSync` copy block in the `onSuccess` handler that copies `manifest.json`, `package.json`, and `src/` to `dist/plugins/fusion-plugin-cli-printing-press/`. Mirrors the existing roadmap block exactly. Does NOT add the plugin to `RUNTIME_PLUGIN_IDS` — it is not a runtime plugin and does not need esbuild bundling.

All three edits are already in place from Step 1 of this task.

### 3.3 Bundling and Import Strategy

- The plugin uses **static** `import { definePlugin } from "@fusion/plugin-sdk"` — no dynamic imports.
- tsup's `noExternal: [/^@fusion\//]` inlines `@fusion/*` imports (per `AGENTS.md` "Importing across `@fusion/*` packages").
- The upstream `cli-printing-press` Go binary is **never bundled** — it is invoked as a child process at runtime.
- **Never** reintroduce the `engineModule = "@fusion/engine"` + `await import(/* @vite-ignore */ engineModule)` anti-pattern.

### 3.4 Upstream Binary Integration Mode

**Decision: spawn as child process.**

Rationale (grounded in FN-3761 research):
- `cli-printing-press` is a Go binary requiring `go 1.26.3+` toolchain to build from source
- No npm package exists on the registry
- Generation is a heavyweight operation (template rendering, Go validation gates)
- Must use `promisify(exec)` with `timeout` and `maxBuffer` per `AGENTS.md` "Engine Process Rules" — no `execSync`

**Binary availability:** v1 requires the user to have `printing-press` installed and accessible on PATH (or configured via plugin settings). The plugin's `onLoad` hook should probe for the binary and log a warning if missing. Future tasks may add a `setup` hook for automated installation.

### 3.5 tsup Copy Block (Reference Implementation)

The copy block in `packages/cli/tsup.config.ts` uses `cpSync` (not esbuild bundling):

```ts
const cliPrintingPressPluginSrc = join(__dirname, "..", "..", "plugins", "fusion-plugin-cli-printing-press");
const cliPrintingPressPluginDest = join(__dirname, "dist", "plugins", "fusion-plugin-cli-printing-press");
// ...inside onSuccess:
if (existsSync(cliPrintingPressPluginDest)) rmSync(cliPrintingPressPluginDest, { recursive: true, force: true });
if (existsSync(cliPrintingPressPluginSrc)) {
  mkdirSync(cliPrintingPressPluginDest, { recursive: true });
  cpSync(join(cliPrintingPressPluginSrc, "manifest.json"), join(cliPrintingPressPluginDest, "manifest.json"));
  cpSync(join(cliPrintingPressPluginSrc, "package.json"), join(cliPrintingPressPluginDest, "package.json"));
  cpSync(join(cliPrintingPressPluginSrc, "src"), join(cliPrintingPressPluginDest, "src"), { recursive: true });
  console.log("Copied cli-printing-press plugin to dist/plugins/fusion-plugin-cli-printing-press/");
}
```

---

## 4. Storage and Config Model

### 4.1 Storage Decision: SQLite via `onSchemaInit`

**Decision:** Plugin-owned SQLite tables in the project's `.fusion/fusion.db`, created via the `onSchemaInit` hook. Mirrors the roadmap plugin pattern (`plugins/fusion-plugin-roadmap/src/roadmap-schema.ts`).

Rationale:
- Consistent with `docs/storage.md` — structured metadata in SQLite, blobs on filesystem
- Leverages Fusion's existing WAL-mode SQLite infrastructure
- Per-project isolation is automatic (each project has its own `.fusion/fusion.db`)
- Credentials can be stored with clear redaction rules at the route layer

**Filesystem storage for generated artifacts:** Generated CLI projects are stored under `.fusion/plugins/cli-printing-press/library/<service-name>/`. This mirrors upstream's default `~/printing-press/library/<name>` but scopes it to the Fusion project.

### 4.2 Schema

#### Table: `cpp_services`

External service definitions — the user-configured inputs for CLI generation.

```sql
CREATE TABLE IF NOT EXISTS cpp_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  inputMode TEXT NOT NULL DEFAULT 'spec',
  specSource TEXT,
  docUrl TEXT,
  transport TEXT NOT NULL DEFAULT 'standard',
  clientPattern TEXT NOT NULL DEFAULT 'rest',
  status TEXT NOT NULL DEFAULT 'defined',
  generatedCliPath TEXT,
  generatedCliVersion TEXT,
  lastGeneratedAt TEXT,
  lastGenerationLog TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idxCppServicesStatus
  ON cpp_services(status, createdAt, id);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | UUID primary key |
| `name` | TEXT | Human-readable service name (max 200 chars) |
| `description` | TEXT | Optional description (max 5000 chars) |
| `inputMode` | TEXT | `"spec"` or `"docs"` — which upstream input mode |
| `specSource` | TEXT | URL or local path to OpenAPI spec (used when inputMode=spec) |
| `docUrl` | TEXT | URL to documentation (used when inputMode=docs) |
| `transport` | TEXT | `"standard"`, `"browser-http"`, etc. (v1: `"standard"` only) |
| `clientPattern` | TEXT | `"rest"`, `"graphql"`, etc. (v1: `"rest"` only) |
| `status` | TEXT | `"defined"`, `"generating"`, `"generated"`, `"error"` |
| `generatedCliPath` | TEXT | Absolute path to generated CLI project root |
| `generatedCliVersion` | TEXT | Upstream generation version/hash for change detection |
| `lastGeneratedAt` | TEXT | ISO timestamp of last successful generation |
| `lastGenerationLog` | TEXT | Stdout/stderr from last generation (truncated to 10KB) |
| `createdAt` | TEXT | ISO timestamp |
| `updatedAt` | TEXT | ISO timestamp |

#### Table: `cpp_credentials`

Non-OAuth credential storage per service. One row per credential type per service.

```sql
CREATE TABLE IF NOT EXISTS cpp_credentials (
  id TEXT PRIMARY KEY,
  serviceId TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  envVarName TEXT,
  envVarValue TEXT NOT NULL,
  headerName TEXT,
  headerValue TEXT,
  isSensitive INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (serviceId) REFERENCES cpp_services(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idxCppCredentialsService
  ON cpp_credentials(serviceId, kind, createdAt, id);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | UUID primary key |
| `serviceId` | TEXT | Foreign key to `cpp_services.id` |
| `kind` | TEXT | `"api_key"`, `"bearer_token"`, `"header"`, `"env_var"`, `"none"`, or `"oauth"` (unsupported, reserved) |
| `name` | TEXT | Human-readable label (e.g., "Stripe API Key") |
| `envVarName` | TEXT | Environment variable name to inject (e.g., `STRIPE_API_KEY`) |
| `envVarValue` | TEXT | The secret value (encrypted at rest in future; plaintext in v1) |
| `headerName` | TEXT | HTTP header name (for `kind="header"`) |
| `headerValue` | TEXT | HTTP header value (sensitive) |
| `isSensitive` | INTEGER | Whether to redact in API responses (default: 1) |
| `createdAt` | TEXT | ISO timestamp |
| `updatedAt` | TEXT | ISO timestamp |

### 4.3 TypeScript Types

```typescript
// src/types.ts

export type ServiceInputMode = "spec" | "docs";
export type ServiceTransport = "standard"; // v1: only standard
export type ServiceClientPattern = "rest"; // v1: only rest
export type ServiceStatus = "defined" | "generating" | "generated" | "error";
export type CredentialKind = "api_key" | "bearer_token" | "header" | "env_var" | "none" | "oauth";

export interface ExternalService {
  id: string;
  name: string;
  description?: string;
  inputMode: ServiceInputMode;
  specSource?: string;
  docUrl?: string;
  transport: ServiceTransport;
  clientPattern: ServiceClientPattern;
  status: ServiceStatus;
  generatedCliPath?: string;
  generatedCliVersion?: string;
  lastGeneratedAt?: string;
  lastGenerationLog?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceCredential {
  id: string;
  serviceId: string;
  kind: CredentialKind;
  name: string;
  envVarName?: string;
  envVarValue: string;   // redacted in GET responses
  headerName?: string;
  headerValue?: string;  // redacted in GET responses
  isSensitive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServiceInput {
  name: string;
  description?: string;
  inputMode: ServiceInputMode;
  specSource?: string;
  docUrl?: string;
  transport?: ServiceTransport;
  clientPattern?: ServiceClientPattern;
}

export interface UpdateServiceInput {
  name?: string;
  description?: string;
  inputMode?: ServiceInputMode;
  specSource?: string;
  docUrl?: string;
  transport?: ServiceTransport;
  clientPattern?: ServiceClientPattern;
}

export interface CreateCredentialInput {
  kind: CredentialKind;
  name: string;
  envVarName?: string;
  envVarValue: string;
  headerName?: string;
  headerValue?: string;
  isSensitive?: boolean;
}

export interface GenerationResult {
  success: boolean;
  cliPath: string;
  version: string;
  log: string;
  error?: string;
}
```

### 4.4 Credential Storage and Security

**Where secrets live:** In the plugin's SQLite tables (`.fusion/fusion.db`) within the `cpp_credentials` table.

**Redaction rules:**
- GET endpoints that return credentials MUST replace `envVarValue` and `headerValue` with `"***REDACTED***"` when `isSensitive === true`
- The full values are only available to the generation runner and executor runtime, never to dashboard API consumers
- Redaction happens at the route layer in `src/routes/cpp-routes.ts`, not in the store

**Encryption at rest:** v1 stores credentials in plaintext within SQLite. A follow-up task should add encryption using a project-local key. Document this as a known limitation.

**Mesh propagation:** Explicitly out of scope for v1. Refer to FN-3707 (Sync credentials across mesh nodes) for future work.

**OAuth escape hatch:** `kind: "oauth"` is a reserved value. If a user attempts to create a credential with `kind: "oauth"`, the route returns `400 Bad Request: OAuth credentials are not supported in v1. Use api_key, bearer_token, header, or env_var.`

---

## 5. Dashboard Surface

### 5.1 Dashboard Views

Five plugin-owned dashboard views, each registered in `manifest.json` `dashboardViews[]`:

| viewId | Label | Icon | Placement | Order | Component Path |
|--------|-------|------|-----------|-------|----------------|
| `cpp-wizard` | Add Service | `Plus` | modal | — | `./dashboard/WizardView` |
| `cpp-services` | CLI Services | `Terminal` | primary | 40 | `./dashboard/ServicesView` |
| `cpp-service-detail` | Service Detail | — | panel | — | `./dashboard/ServiceDetailView` |
| `cpp-cli-detail` | CLI Detail | — | panel | — | `./dashboard/CliDetailView` |
| `cpp-run-test` | Run / Test | `Play` | modal | — | `./dashboard/RunTestView` |

The wizard and run/test views are modals triggered from the services list or service detail views, not primary navigation destinations. The services list (`cpp-services`) is the primary navigation entry.

### 5.2 Route Design

All routes are under `/api/plugins/fusion-plugin-cli-printing-press/...`.

Route registration uses `createCliPrintingPressPluginRoutes()` returning `PluginRouteDefinition[]` from `@fusion/core`, attached via `definePlugin({ routes: ... })`. The dashboard host wraps these in Express (see `packages/dashboard/src/plugin-routes.ts` lines 280–340) — the plugin does NOT export its own Express router.

Project scoping uses `resolveProjectId(req)` reading `query.projectId` / `body.projectId`, mirroring the roadmap pattern.

#### Service Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/services` | List all services |
| POST | `/services` | Create a new service |
| GET | `/services/:id` | Get service with credentials (redacted) |
| PATCH | `/services/:id` | Update service definition |
| DELETE | `/services/:id` | Delete service and its credentials |
| POST | `/services/:id/generate` | Trigger CLI generation |
| POST | `/services/:id/regenerate` | Regenerate CLI (with force) |
| GET | `/services/:id/generation-status` | Poll generation status |

#### Credential Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/services/:id/credentials` | List credentials for a service (redacted) |
| POST | `/services/:id/credentials` | Add a credential |
| PATCH | `/credentials/:credId` | Update a credential |
| DELETE | `/credentials/:credId` | Delete a credential |

#### Run/Test Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/services/:id/run` | Execute a generated CLI command |
| POST | `/services/:id/test` | Run a test command (e.g., `--help`, `version`, `doctor`) |
| GET | `/services/:id/run-history` | List recent run results |

#### Health/Probe Route

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Check if `printing-press` binary is available and return version |

### 5.3 Component Files

```
src/
├── dashboard/
│   ├── WizardView.tsx        # Guided wizard: name, input mode, spec/docs URL, auth config
│   ├── ServicesView.tsx      # List view: cards for all services with status badges
│   ├── ServiceDetailView.tsx # Detail: service config + credential list + generation status
│   ├── CliDetailView.tsx     # Detail: generated CLI info, file tree preview, version
│   └── RunTestView.tsx       # Modal: command input, run button, output log viewer
├── routes/
│   └── cpp-routes.ts         # createCliPrintingPressPluginRoutes()
├── store/
│   └── cpp-store.ts          # CppStore class (mirrors RoadmapStore pattern)
├── generator/
│   └── generate.ts           # Generation runner (spawns printing-press subprocess)
├── types.ts                  # TypeScript type definitions
├── schema.ts                 # ensureCliPrintingPressSchema(db)
└── index.ts                  # definePlugin({...})
```

### 5.4 Styling Rules

All dashboard views MUST follow the `AGENTS.md` "Dashboard UI Styling Guide":
- Design tokens only (`var(--space-md)`, `var(--text-muted)`, `var(--radius-md)`, etc.)
- Reuse `.btn`, `.card`, `.input`, `.modal` primitives from `styles.css`
- Status-color tokens for service status badges
- Mobile breakpoints at 768px
- No hardcoded pixel values, colors, or rgba — use `color-mix` for translucent backgrounds
- Each component imports its co-located CSS file (`import "./WizardView.css"`)

### 5.5 Authentication/Authorization

**Plugin routes inherit dashboard host auth — no plugin-level middleware required.**

Confirmed by reading `packages/dashboard/src/plugin-routes.ts`: plugin-defined routes are wrapped in Express handlers at lines 280–340 with no additional auth middleware. The host's auth applies to all `/api/plugins/*` routes.

**Risk:** Credential-write endpoints (POST/PATCH/DELETE on `/credentials`) rely on whatever the host enforces. If the dashboard binds to a non-loopback address, downstream FN-3764 MUST surface a warning in the credential management UI. Document this as a security consideration in the credential view implementation.

---

## 6. Executor Runtime Integration

### 6.1 Generated CLI Availability in Worktrees

**Decision: Explicit PATH injection.**

When an executor session starts for a task, the plugin's runtime integration adds the directory containing generated CLI binaries to the worktree's PATH environment. This happens via:

1. The plugin exposes a `tools` registration (via `definePlugin({ tools: [...] })`) that lists available generated CLIs
2. The executor's runtime setup probes registered tools and adds their paths to the subprocess environment
3. Alternatively, generated CLIs are symlinked into the worktree's `.fusion/bin/` directory which is added to PATH

**v1 simplification:** Rather than implementing full tool registration, v1 uses a simpler approach:
- Generated CLIs are built as Go binaries and placed in `.fusion/plugins/cli-printing-press/bin/`
- The plugin exposes a `getBinPaths()` method that the executor can query
- The executor adds these paths to the PATH environment when spawning task processes
- This avoids modifying `packages/engine` — the plugin exposes its capabilities through existing plugin interfaces

### 6.2 CLI Invocation Model

All CLI invocations MUST use `promisify(exec)` with `timeout` and `maxBuffer`:

```typescript
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);

const { stdout, stderr } = await execAsync(command, {
  cwd: worktreePath,
  timeout: 120_000,
  maxBuffer: 10 * 1024 * 1024,
  env: { ...process.env, ...credentialEnvVars },
});
```

**Never** use `execSync` for any CLI invocation (per `AGENTS.md` "Engine Process Rules").

### 6.3 Generation Lifecycle

1. **On wizard completion:** Service created with `status: "defined"`
2. **On "Generate" button click:** Status → `"generating"`, spawn `printing-press generate --spec <url> --name <name> --output <path>` via `promisify(exec)`
3. **On generation success:** Status → `"generated"`, record `generatedCliPath`, `generatedCliVersion`, `lastGeneratedAt`, `lastGenerationLog`
4. **On generation failure:** Status → `"error"`, record error in `lastGenerationLog`
5. **Regeneration:** Uses `--force` flag to overwrite existing output. Detects stale artifacts by comparing upstream version hash with stored `generatedCliVersion`.

**Concurrent generation:** Only one generation per service at a time. The `status: "generating"` field acts as a lock — the `/generate` endpoint returns `409 Conflict` if the service is already in `"generating"` state.

### 6.4 Generated Artifact Location

```
.fusion/
└── plugins/
    └── cli-printing-press/
        ├── library/           # Generated Go project trees
        │   └── stripe/
        │       ├── cmd/
        │       ├── internal/
        │       ├── go.mod
        │       └── Makefile
        └── bin/               # Built CLI binaries (optional, post-build)
            └── stripe-pp-cli
```

The `library/` directory mirrors upstream's default output structure. The `bin/` directory is for pre-built binaries if the plugin builds generated CLIs automatically.

### 6.5 Credential Injection Model

**Decision: Environment variables only.**

When the executor or run/test panel invokes a generated CLI:
1. Load credentials for the service from `cpp_credentials` table
2. Construct an `env` object mapping `envVarName` → `envVarValue` for each credential
3. Pass as `env` option to `execAsync()` — merged over `process.env`
4. **Secrets MUST NOT appear in:** command arguments, run-audit logs, or API responses

The run-audit integration (per `docs/architecture.md`) must redact environment variable values in the `fs:exec` domain when the variable name matches a credential's `envVarName`.

### 6.6 Security Boundary

Generated CLIs run inside the worktree with the **same permissions** as other executor commands. No escalation, no privileged access.

**Command-injection guards on wizard inputs:**
- Service names are validated against `^[a-z][a-z0-9-]*$` (lowercase alphanumeric + hyphens)
- Spec URLs are validated as HTTP/HTTPS only
- No user input flows directly into shell commands — all values are passed as arguments via `execFile`-style argument arrays where possible, or properly escaped via `shell: false`

---

## 7. Workflow Step Integration

### 7.1 Step Types

Generated CLIs become available as **"script" mode workflow steps**. The plugin contributes a workflow step template that:

1. Accepts a service ID and CLI subcommand as parameters
2. Resolves the generated CLI binary path
3. Injects credentials as environment variables
4. Executes via `promisify(exec)` with timeout + maxBuffer

### 7.2 Step Manifest Shape

```typescript
interface CppWorkflowStep {
  type: "script";
  pluginId: "fusion-plugin-cli-printing-press";
  label: string;                  // e.g., "Run Stripe CLI: validate"
  config: {
    serviceId: string;            // References cpp_services.id
    command: string;              // Subcommand to run (e.g., "validate", "doctor")
    timeout?: number;             // Override default timeout (ms)
  };
}
```

This is registered via `definePlugin({ workflowSteps: [...] })` following `docs/PLUGIN_AUTHORING.md` Section 16.

> **Implemented in FN-4150:** the plugin now contributes `stepId: "run-service-cli"` as a script-mode pre-merge workflow step with `scriptName: "cli-printing-press:run-service-cli"`.

### 7.3 Execution Flow

1. Workflow step executor resolves the step template by `pluginId`
2. Delegates to the plugin's registered step handler
3. Handler loads the service, resolves binary path, injects credentials
4. Runs via `promisify(exec)` with appropriate timeout
5. Returns `{ success: boolean, stdout: string, stderr: string }`

---

## 8. Credentials and Security Model

### 8.1 v1 Credential Kinds

| Kind | Env Var | Description |
|------|---------|-------------|
| `api_key` | ✅ | API key passed as env var |
| `bearer_token` | ✅ | Bearer token passed as env var |
| `header` | ✅ | Custom HTTP header name + value |
| `env_var` | ✅ | Arbitrary env var with name + value |
| `none` | — | No authentication needed |
| `oauth` | ❌ | **Reserved, unsupported in v1** |

### 8.2 Credential Lifecycle

1. **Create:** Via wizard step or service detail credential form. Stored in `cpp_credentials` table.
2. **Read:** GET endpoints return redacted values (`"***REDACTED***"`) for sensitive fields.
3. **Update:** PATCH endpoint accepts new values; overwrites in SQLite.
4. **Delete:** DELETE endpoint removes the credential row.
5. **Cascade:** Deleting a service cascades to all its credentials (FK `ON DELETE CASCADE`).

### 8.3 Executor Credential Access

The executor runtime accesses credentials through the plugin's store:

```typescript
// In the generation runner or run/test handler:
const credentials = cppStore.getCredentialsForService(serviceId);
const env = Object.fromEntries(
  credentials.map(c => [c.envVarName, c.envVarValue])
);
```

Credentials are loaded at invocation time, never cached long-term.

### 8.4 Audit and Logging

- **Run-audit events:** Generation and CLI execution emit `fs:exec` audit events. Secret values in environment variables are redacted.
- **Generation logs:** `lastGenerationLog` in `cpp_services` captures stdout/stderr but the route layer must scrub credential patterns before returning.
- **Dashboard audit:** No separate audit trail beyond what Fusion's run-audit system already provides.

### 8.5 OAuth Deferral

OAuth is explicitly deferred from v1 with the following escape hatch:
- `kind: "oauth"` is a valid enum value in the TypeScript type
- The `cpp_credentials` table accepts `kind = "oauth"`
- The route layer rejects creation with `400 Bad Request` when `kind === "oauth"`
- When OAuth is implemented in a future version, the schema is already ready — only the route validation and UI need updating

---

## 9. Cross-Cutting Concerns

### 9.1 Plugin Lifecycle

| Hook | Implementation |
|------|----------------|
| `onSchemaInit` | `ensureCliPrintingPressSchema(db)` — creates `cpp_services` and `cpp_credentials` tables |
| `onLoad` | Probe for `printing-press` binary, log warning if not found, emit `cpp:loaded` event |
| `onUnload` | No persistent state to clean up |

**Settings registration:** The plugin registers a settings schema with fields:
- `printingPressBinaryPath`: Override path to `printing-press` binary (default: auto-detect from PATH)
- `defaultOutputDir`: Override output directory (default: `.fusion/plugins/cli-printing-press/library/`)
- `generationTimeout`: Timeout for generation commands in ms (default: 120000)

**Config migration:** Not needed in v1. Future versions can add a `onSettingsMigrate` hook if schema changes.

**Hot-reload:** Follows existing `plugin-hot-reload.test.ts` patterns. The plugin's store is stateless (reads from SQLite on each request), so hot-reload is safe.

### 9.2 Telemetry and Run-Audit

| Action | Audit Domain | Event |
|--------|-------------|-------|
| Service create/update/delete | `db` | `task:create`, `task:update` (via plugin store) |
| CLI generation | `fs` | `fs:exec` (printing-press subprocess invocation) |
| CLI run/test | `fs` | `fs:exec` (generated CLI invocation) |
| Credential write | `db` | `db:write` (credential row creation/update) |

### 9.3 Mesh / Multi-Project Considerations

**Decision: Per-project plugin DB.**

Each Fusion project has its own `.fusion/fusion.db` with its own `cpp_services` and `cpp_credentials` tables. This means:
- Services and credentials are isolated per project
- No cross-project sharing in v1
- Mesh propagation of credentials is deferred to FN-3707

This aligns with the existing pattern where each project has its own task store and plugin state.

### 9.4 Test Strategy Summary (for FN-3769)

| Category | Test Files | Description |
|----------|-----------|-------------|
| Unit | `src/__tests__/store.test.ts` | CppStore CRUD operations with in-memory SQLite |
| Unit | `src/__tests__/generator.test.ts` | Generation runner with mocked `exec` |
| Unit | `src/__tests__/routes.test.ts` | Route handler tests with mocked store |
| Plugin load | `src/__tests__/manifest.test.ts` | Manifest validation + plugin loads as no-op (already exists) |
| View | `src/__tests__/WizardView.test.tsx` | Wizard flow with mocked API |
| View | `src/__tests__/ServicesView.test.tsx` | Service list rendering |
| Integration | `src/__tests__/generation-integration.test.ts` | End-to-end generation with real printing-press (optional, gated on binary availability) |
| Workflow step | `src/__tests__/workflow-step.test.ts` | Step template execution with mocked CLI |

Reference test patterns:
- `packages/core/src/__tests__/plugin-store.test.ts` — plugin registration/loading
- `packages/core/src/__tests__/plugin-hot-reload.test.ts` — hot-reload behavior
- `packages/core/src/__tests__/plugin-types.test.ts` — type validation

### 9.5 Open Questions (Left to Downstream Tasks)

1. **FN-3763 (Wizard):** Exact wizard step sequence and form field validation UX
2. **FN-3763 (Wizard):** Whether to offer "test connection" during wizard before saving
3. **FN-3764 (Management views):** Real-time generation status polling interval and UI
4. **FN-3764 (Management views):** Credential form UX (masked inputs, reveal toggle)
5. **FN-3765 (Run/test):** Output log rendering (ANSI color support, streaming vs batch)
6. **FN-3766 (Storage):** Whether to add encryption-at-rest for credentials in v1 or defer
7. **FN-3766 (Storage):** Migration strategy if schema changes between plugin versions
8. **FN-3767 (Executor runtime):** Exact mechanism for PATH injection (plugin tools API vs direct worktree setup)
9. **FN-3767 (Executor runtime):** Whether to auto-build generated Go CLIs into binaries or require user to build
10. **FN-3768 (Workflow steps):** Whether to support prompt-mode steps or only script-mode in v1
11. **FN-3770 (Changeset):** Whether to bump `@runfusion/fusion` as minor (new bundled plugin) or patch

---

## 10. Mapping to Downstream Tasks

### FN-3763: Dashboard Wizard View

**Inputs from this design:**
- Section 5.1: `cpp-wizard` view definition (viewId, placement, component path)
- Section 5.3: `src/dashboard/WizardView.tsx` file location
- Section 4.3: `CreateServiceInput` TypeScript type
- Section 4.4: Credential creation via `CreateCredentialInput` type
- Section 8.1: Supported credential kinds and OAuth rejection
- Section 5.4: CSS styling rules (tokens, primitives, co-located CSS)
- Route: `POST /services` and `POST /services/:id/credentials`

**Deliverable:** `WizardView.tsx`, `WizardView.css`, wizard modal trigger from services list. Must implement multi-step wizard: service name → input mode selection → spec/docs URL → auth configuration → review → create.

### FN-3764: Management Views (Service List, Detail, CLI Detail)

**Inputs from this design:**
- Section 5.1: `cpp-services`, `cpp-service-detail`, `cpp-cli-detail` view definitions
- Section 5.3: Component file paths
- Section 5.2: All service and credential routes
- Section 4.2: Schema for `cpp_services` and `cpp_credentials`
- Section 5.5: Auth inheritance note (no plugin middleware needed)
- Section 5.4: CSS styling rules

**Deliverable:** `ServicesView.tsx`, `ServiceDetailView.tsx`, `CliDetailView.tsx`, plus route handlers in `cpp-routes.ts`, store methods in `cpp-store.ts`, and schema in `schema.ts`. Must also update `manifest.json` to add `dashboardViews[]` entries.

### FN-3765: Run/Test Actions

**Inputs from this design:**
- Section 5.1: `cpp-run-test` view definition
- Section 6.2: CLI invocation via `promisify(exec)` with timeout + maxBuffer
- Section 6.5: Credential injection via environment variables
- Section 6.6: Security boundary (no escalation, command-injection guards)
- Section 5.2: Run/test routes (`POST /services/:id/run`, `POST /services/:id/test`)
- Section 8.4: Audit event emission with secret redaction

**Deliverable:** `RunTestView.tsx`, run/test route handlers, generation runner in `generator/generate.ts`.

### FN-3766: Storage/Config Model Implementation

**Inputs from this design:**
- Section 4.2: Complete SQL schema (tables, indexes)
- Section 4.3: TypeScript type definitions
- Section 4.4: Credential storage and redaction rules
- Section 9.1: `onSchemaInit` hook with `ensureCliPrintingPressSchema(db)`
- Section 4.1: Storage decision rationale (SQLite + filesystem)

**Deliverable:** `schema.ts` (SQL schema creation), `store/cpp-store.ts` (CppStore class with CRUD methods), `types.ts` (TypeScript types). Must implement redaction in store methods or route layer.

### FN-3767: Executor Runtime Integration

**Inputs from this design:**
- Section 6.1: PATH injection approach for generated CLI binaries
- Section 6.2: `promisify(exec)` invocation pattern
- Section 6.3: Generation lifecycle (status transitions, concurrent locking)
- Section 6.4: Generated artifact directory structure
- Section 6.5: Credential injection via env vars
- Section 6.6: Security boundary documentation

**Deliverable:** Runtime adapter or tool registration that makes generated CLIs available in executor sessions. Generation runner integration. PATH setup logic.

### FN-3768: Workflow Step Integration

**Inputs from this design:**
- Section 7.1: Script-mode step type definition
- Section 7.2: `CppWorkflowStep` manifest shape
- Section 7.3: Execution flow (resolve → inject → run → return)
- Section 6.2: `promisify(exec)` pattern

**Deliverable:** Workflow step template registration via `definePlugin({ workflowStepTemplates: [...] })`, step execution handler.

### FN-3769: Tests

**Inputs from this design:**
- Section 9.4: Complete test strategy table
- All sections: TypeScript types, routes, store methods, and component contracts to test against

**Deliverable:** Test files per the test strategy table. Must achieve meaningful coverage of store, routes, generator, and workflow steps.

### FN-3770: Changeset

**Inputs from this design:**
- Section 3: Packaging and registration details
- Section 9.5, item 11: Minor vs patch decision

**Deliverable:** `.changeset` file describing the new bundled plugin addition. Likely a `minor` bump since it adds a new bundled plugin to the published package.

---

## 11. References

### Fusion Source Files

- `plugins/fusion-plugin-roadmap/manifest.json` — manifest pattern reference
- `plugins/fusion-plugin-roadmap/src/index.ts` — definePlugin pattern with hooks, routes, dashboardViews
- `plugins/fusion-plugin-roadmap/src/roadmap-schema.ts` — onSchemaInit pattern
- `plugins/fusion-plugin-roadmap/src/routes/roadmap-routes.ts` — PluginRouteDefinition pattern, resolveProjectId, routeHandler wrapper
- `plugins/fusion-plugin-roadmap/src/store/roadmap-store.ts` — store pattern
- `plugins/fusion-plugin-hermes-runtime/src/index.ts` — runtime plugin pattern with onLoad/onUnload
- `packages/dashboard/src/plugin-routes.ts` — dashboard host route mounting (auth inherited, no plugin middleware)
- `packages/cli/src/plugins/bundled-plugin-install.ts` — BUNDLED_PLUGIN_IDS
- `packages/cli/tsup.config.ts` — cpSync copy block for bundled plugins
- `packages/plugin-sdk/src/index.ts` — definePlugin, FusionPlugin types
- `packages/core/src/plugin-store.ts` — plugin registration
- `packages/core/src/types.ts` — PluginRouteDefinition, PluginContext, PluginManifest

### Documentation

- `docs/research/cli-printing-press.md` — FN-3761 research (upstream behavior, config model, runtime requirements)
- `docs/PLUGIN_AUTHORING.md` — plugin authoring contract (manifest fields, hooks, routes, workflow steps)
- `docs/storage.md` — Fusion storage architecture
- `docs/workflow-steps.md` — workflow step system
- `docs/architecture.md` — run-audit system, API reference
- `AGENTS.md` — Package Structure, Importing rules, Storage Model, Engine Process Rules, Dashboard UI Styling Guide

### Upstream References (from FN-3761)

- Repository: `https://github.com/mvanhorn/cli-printing-press`
- Examined commit: `ecb35ab0d585693aa48550f2087191a287b35f61`
- Go version: `1.26.3+`
- Auth types: `api_key`, `oauth2`, `bearer_token`, `cookie`, `composed`, `session_handshake`, `none`
- Input modes: `--spec`, `--docs`, `--plan` (v1 uses `--spec` + `--docs`)
- Transport modes: `standard`, `browser-http`, `browser-chrome`, `browser-chrome-h3` (v1 uses `standard` only)
