# cli-printing-press research (FN-3761)

## 1) Summary
`cli-printing-press` is a **Go-based generator** (not a Node package) that takes API inputs (`--spec`, `--docs`, or `--plan`) and emits a full Go CLI project plus MCP server scaffolding via embedded templates. It has rich auth modeling (API key, bearer, cookie/composed, session-handshake, OAuth2 incl. `authorization_code` and `client_credentials`) and optional browser-sniff/traffic-analysis guidance. It validates generated output with Go quality gates. The project is opinionated around local filesystem output (`~/printing-press/library/<name>` by default), Go toolchain availability, and optional LLM/agent tooling for higher-level pipeline flows.

## 2) Source examined
- Repo: https://github.com/mvanhorn/cli-printing-press
- Examined commit: `ecb35ab0d585693aa48550f2087191a287b35f61`
- Commit date (UTC): `2026-05-09T00:16:50Z`
- Latest Git tag seen: `v4.0.6` (`c9dd54ae61ce0d8d949dbed0257573194a536953`), with current HEAD ahead by 21 commits.
- npm status: no published `cli-printing-press` package found on npm (`npm view cli-printing-press version` returned 404, 2026-05-08).

## 3) Inputs
**One-line answer:** Generation is primarily driven by an internal `APISpec` model plus `generate` CLI flags and optional research/traffic-analysis artifacts.

- Core generate entrypoint supports:
  - `--spec` (repeatable local/URL API spec),
  - `--docs` (doc-to-spec flow),
  - `--plan` (markdown plan-driven generation),
  - plus shaping flags (`--spec-source`, `--client-pattern`, `--transport`, `--traffic-analysis`, etc.). (`internal/cli/root.go:78-399`)
- Input normalization/validation exists for `spec_source`, `client_pattern`, `http_transport` enums. (`internal/cli/root.go:461-517`)
- Spec schema is a first-class typed model (`APISpec`) with fields for API topology, auth, tier routing, cache/share/mcp settings, etc. (`internal/spec/spec.go:63-164`)
- Auth input surface is broad (`auth.type`, env var specs, cookie/composed auth, session handshake fields, OAuth URLs/scopes/grant). (`internal/spec/spec.go:432-490`)
- Remote specs can be fetched and cached under `~/.cache/printing-press/specs` with 24h cache behavior. (`internal/cli/root.go:789-857`)

## 4) Outputs
**One-line answer:** It emits a standalone Go project tree (CLI + MCP) with generated code/templates, optional archived input spec, and pipeline/provenance artifacts.

- README describes each run producing `<api>-pp-cli` and `<api>-pp-mcp`. (`README.md:95-98`)
- Default output location for generated projects is `~/printing-press/library/<name>` unless overridden. (`internal/cli/root.go:380`, `README.md:102-110`)
- Generation writes many files from embedded templates (`internal/generator/templates/**`) across `cmd/`, `internal/cli`, `internal/client`, `internal/store`, `internal/mcp`, root `go.mod`/`Makefile`/`.goreleaser.yaml`, etc. (`internal/generator/generator.go:1537-1593`, `internal/generator/generator.go:2554-2564`)
- Input spec is archived alongside output as `spec.yaml`/`spec.json` (redacted) for reproducibility. (`internal/cli/root.go:346-357`)

## 5) Generation model / pipeline
**One-line answer:** `generate` parses/enriches inputs, builds a `generator.Generator`, renders templated project files, optionally validates/polishes, and can emit manifest/provenance artifacts.

- `runGenerateProject`: enrich spec, load research + traffic analysis, apply transport defaults, call `Generate()`, optionally `Validate()`, optionally polish. (`internal/cli/root.go:436-459`)
- `Generator.Generate()` orchestrates staged rendering: prepare output -> render core/support files -> resource commands -> auth files -> MCP entrypoint -> root/vision files. (`internal/generator/generator.go:1537-1593`)
- Validation gates include `go mod tidy`, `govulncheck`, `go vet`, `go build`, binary build, and smoke commands (`--help`, `version`, `doctor`). (`internal/generator/validate.go:25-106`)
- Determinism/idempotence notes:
  - Mostly template-driven/deterministic for same inputs.
  - Non-deterministic elements include `currentYear` template helper and environment-derived identity fallbacks (`OwnerName`, `Printer`) if missing. (`internal/generator/generator.go:1549-1561`, `internal/generator/generator.go:2529`)
  - Output claiming behavior (`--force`, auto-claim dirs) affects idempotence on existing dirs. (`internal/cli/root.go:520-537`, `internal/cli/root.go:579-641`)

## 6) Runtime assumptions
**One-line answer:** Generator runtime assumes modern Go toolchain + filesystem write access; generated CLIs assume Go-built binaries and local config/store files.

- Go module declares `go 1.26.3`. (`go.mod:1-4`)
- README install prerequisites: Go 1.26.3+ and Claude Code (for skill-driven flows). (`README.md:23-35`)
- Binary entrypoint is Go (`cmd/printing-press/main.go`). (`cmd/printing-press/main.go:1-23`)
- Validation and many flows assume shelling out to Go tooling is available. (`internal/generator/validate.go:42-96`)
- Filesystem assumptions include user home and cache dirs (`~/.cache/printing-press/...`) plus generated output trees. (`internal/cli/root.go:798-857`, `README.md:102-110`)

## 7) Network and external-service assumptions
**One-line answer:** The generator and generated CLIs both rely on HTTP(S), with optional browser-oriented transport modes and doc/spec fetches.

- Remote spec/doc ingestion uses outbound HTTP (`http.Get`, docs URL processing). (`internal/cli/root.go:789-825`, `internal/cli/root.go:119-161`)
- Spec model includes transport choices: `standard`, `browser-http`, `browser-chrome`, `browser-chrome-h3`. (`internal/spec/spec.go:25-31`, `internal/cli/root.go:391`, `internal/cli/root.go:511-517`)
- Generator may default transport from traffic-analysis/reachability hints. (`internal/cli/root.go:539-549`, `internal/cli/root.go:440-449`)
- README positions browser-sniffed traffic as supported input source (not only canonical OpenAPI). (`README.md:95-97`)
- No evidence of gRPC codegen path in primary generator surfaces; model and templates are HTTP/OpenAPI/GraphQL-centric. (`internal/spec/spec.go:63-164`, `internal/generator/templates/graphql_client.go.tmpl`)

## 8) Auth and credential patterns (OAuth status)
**One-line answer:** Upstream supports multiple auth modes including OAuth2, and OAuth is explicitly implemented (not absent).

- Auth types modeled include `api_key`, `oauth2`, `bearer_token`, `cookie`, `composed`, `session_handshake`, `none`. (`internal/spec/spec.go:432-433`)
- Env var credential modeling includes required/optional/sensitive/kind metadata. (`internal/spec/spec.go:493-531`)
- OAuth2 grant support includes both `authorization_code` and `client_credentials`. (`internal/spec/spec.go:715-750`)
- OAuth auth template (`auth.go.tmpl`) includes browser callback listener + auth code exchange. (`internal/generator/templates/auth.go.tmpl`)
- OAuth client-credentials template (`auth_client_credentials.go.tmpl`) includes token mint and persistence flow. (`internal/generator/templates/auth_client_credentials.go.tmpl`)
- Browser cookie/composed/session-oriented auth paths are implemented in `auth_browser.go.tmpl`. (`internal/generator/templates/auth_browser.go.tmpl`)

**OAuth status for FN-3762 planning:** **Supported upstream** (authorization_code and client_credentials); not a gap in upstream capability.

## 9) Extension points
**One-line answer:** Extension is primarily through spec fields, command flags, templating system, and pipeline commands/artifacts—not via a plugin API in this repo.

- Template-based generation from embedded `internal/generator/templates` files is the core extensibility mechanism. (`internal/generator/generator.go:32-39`, `internal/generator/generator.go:2629-2647`)
- CLI exposes many subcommands beyond `generate` (scorecard, dogfood, patch, vision, browser-sniff, pipeline/print, publish, etc.) that act as workflow extension points. (`internal/cli/root.go:45-73`)
- Spec-level optional features (`Cache`, `Share`, `MCP`, `TierRouting`, etc.) drive generated capability shape. (`internal/spec/spec.go:131-164`)
- No stable external plugin interface akin Fusion’s plugin SDK/types is visible in this project; customization appears source/template/spec driven.

## 10) Known limits and risks
**One-line answer:** Strongly Go/toolchain/filesystem-coupled; mixed deterministic/non-deterministic generation inputs; and broad auth/browser pathways increase operational complexity.

- Hard dependency on Go toolchain and ability to execute external Go commands during validation. (`internal/generator/validate.go:42-96`)
- Browser/web-surface scenarios can be rejected when discovery implies unshippable page-context requirements. (`internal/cli/root.go:444-446`)
- Output regeneration can overwrite unless guarded (`--force` semantics preserve only selected hand-authored files). (`internal/cli/root.go:579-641`)
- Security/secret handling risk surface exists around credential env vars and auth flows; mitigations are present but rely on correct spec/auth configuration. (`internal/spec/spec.go:432-499`, `internal/generator/templates/auth*.go.tmpl`)
- No npm package distribution path for the generator itself; this matters for Node-native embedding expectations. (Observed npm lookup + Go-first install path in `README.md:29-35`)

## 11) Mapping onto Fusion plugin architecture
**One-line answer:** The cleanest Fusion fit is as an orchestrated external-generator workflow (via plugin tools/routes/workflow steps), not as an in-process JS library import.

- **Input ingest fit:** Map Fusion plugin settings/forms to printing-press inputs (`--spec`, `--docs`, `--plan`, transport/auth-related knobs). Fusion plugin schemas/settings are a natural host. (`docs/PLUGIN_AUTHORING.md`, `packages/core/src/plugin-types.ts`)
- **Generation execution fit:** Invoke printing-press as a bounded subprocess from plugin tool/route/workflow-step handlers; avoid event-loop-blocking sync exec in engine paths. (`AGENTS.md` Engine Process Rules; `packages/core/src/plugin-types.ts` workflow/tool surfaces)
- **Output storage fit:** Upstream defaults to `~/printing-press/library/*`; FN-3762 should decide whether Fusion uses worktree-local outputs, plugin-managed storage, or both.
- **Invocation fit:** Generated CLIs/MCP binaries can be exposed through plugin tools or workflow steps, with explicit filesystem boundaries and project scoping.
- **Auth fit:** Upstream OAuth/cookie/session modes exist, but Fusion must decide what subset is supported in v1 UX and where credentials are persisted.
- **Bundling conflict note:** printing-press is Go/binary-driven; Fusion’s `@fusion/*` noExternal bundling concerns are for TS/JS imports, so this integration should stay subprocess-oriented instead of trying to inline upstream code.

## 12) Open questions for FN-3762
1. Where should generated artifacts live in Fusion: project repo, `.fusion/` plugin-private area, or dual-location publish model?
2. Should Fusion require preinstalled `printing-press` binary, or provide setup/install automation via plugin setup hooks?
3. Which upstream input modes are in v1 scope (`--spec` only vs `--docs`/browser-sniff flows too)?
4. How should Fusion surface/limit upstream auth modes (especially cookie/session-handshake) in UX and policy?
5. Should Fusion run upstream validation (`go mod tidy`, `govulncheck`, etc.) always, optionally, or in workflow-step phases only?
6. How should generated MCP binaries be registered/executed inside Fusion runtime boundaries?
7. What is the contract for regenerations (`--force`) when humans have hand-edited generated CLIs?

## 13) References
- Upstream README: `README.md:21-140`
- Upstream CLI entrypoint: `cmd/printing-press/main.go:1-23`
- Root command and subcommands: `internal/cli/root.go:36-76`
- Generate command flags + behavior: `internal/cli/root.go:78-399`
- Generate pipeline glue: `internal/cli/root.go:436-459`
- Input enum validation: `internal/cli/root.go:491-517`
- Output dir/claim semantics: `internal/cli/root.go:520-641`
- Remote spec caching/fetch: `internal/cli/root.go:789-857`
- APISpec model: `internal/spec/spec.go:63-164`
- Auth model: `internal/spec/spec.go:432-531`
- OAuth grant constants/validation: `internal/spec/spec.go:715-750`
- Generator orchestration: `internal/generator/generator.go:1537-1593`
- Auth template selection + MCP emission: `internal/generator/generator.go:1800-1870`
- Template rendering internals: `internal/generator/generator.go:2629-2647`
- Generated-project validation gates: `internal/generator/validate.go:25-106`
- Go runtime/deps baseline: `go.mod:1-59`
- Fusion plugin authoring context: `docs/PLUGIN_AUTHORING.md`
- Fusion plugin type seams: `packages/core/src/plugin-types.ts`
- Fusion SDK surface: `packages/plugin-sdk/src/index.ts`
- Fusion plugin loader context: `packages/core/src/plugin-loader.ts`
- Fusion constraints referenced: `AGENTS.md` (Package Structure, Storage Model, Engine Process Rules)
