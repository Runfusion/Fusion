---
category: integration-issues
module: packages/dashboard/src/usage.ts
tags: [grok, usage, billing, redacted-capture, source-provenance]
problem_type: upstream-provenance-mismatch
applies_when: investigating a third-party CLI usage display whose installed release cannot be mapped to inspectable source
---

# Do not derive Grok usage from an unproven CLI source

## Symptom

Fusion's Grok card is authenticated but empty because its existing `GET
https://cli-chat-proxy.grok.com/v1/billing?format=credits` request does not
provide a finite `config.creditUsagePercent`. The installed `grok` command
advertises `/usage` (and alias `/cost`), but that display cannot be used as
evidence until the installed binary is mapped to source.

## Historical FN-8688 evidence

FN-8688 replayed Fusion's existing request through a disposable redacted
in-memory harness. It observed HTTP status `200`; `config.creditUsagePercent`
was absent, and the only numeric `*.val` leaves were unclassified. The harness
did not print a response body, credential, string value, or dynamic key.

VERDICT FN-8688: BLOCKED — Fusion's existing request does not identify the CLI request or a meter formula.

## Source provenance (FN-8689)

### Installed asset identity

- Version: `0.2.118` (`~/.grok/version.json`; local `CHANGELOG.md` dates that
  version 2026-07-31).
- Asset filename: `grok-0.2.118-macos-aarch64`.
- Installed binary path: `~/.grok/downloads/grok-0.2.118-macos-aarch64`.
- Installed SHA-256:
  `2de5b9609a03492dd6b9e4cca9637d651fe998bb8371bf9f852e7b28b38c034e`.

### Retrieval method and attempted provenance chain

1. Local installation metadata (`version.json`, `CHANGELOG.md`, downloads,
   bundled manifest, README, and the shim target) names the version and asset,
   but publishes neither a binary digest nor a source commit.
2. The official installer source at `https://x.ai/cli/install.sh` maps version
   `0.2.118` to asset filename `grok-0.2.118-macos-aarch64` and downloads it
   from `https://x.ai/cli` or
   `https://storage.googleapis.com/grok-build-public-artifacts/cli`. It does
   not provide a checksum, an asset manifest, or a source tag/commit mapping.
   The official stable channel pointer at the latter base returned `0.2.118`,
   which is only a version pointer.
3. Bounded, non-executing binary inspection confirmed the embedded proxy base
   URL and candidate build identifier `0.2.118 (1e1687c1cf6a)`. A build
   identifier without a published asset/digest mapping is candidate-only, not
   source provenance.
4. The public `xai-org-shared/grok-build` repository and release-tag metadata,
   the GCS `.sha256`/`.sha256sum` sidecars, and the x.ai `.sha256` sidecar each
   returned not found. A read-only remote reference query for that repository
   also returned repository-not-found.
5. FN-8688's `@vibe-kit/grok-cli@0.0.34` and
   `superagent-ai/grok-cli` commit `fb97af83f06dca873281d60168430f06c8de6324`
   remain version-skewed candidate material. They are not the installed
   binary's source and were not used to infer a request or formula.

No official `version → asset filename → published digest → source tag/commit`
chain is available. Therefore the installed digest cannot be linked to an
inspectable source archive or commit, and the candidate build identifier is not
sufficient provenance.

## Source-identified handler, request, and arithmetic

Unavailable. Because the provenance chain is unrecoverable, no `/usage` or
`/cost` handler was read as the installed CLI's handler. Consequently this
finding records no source-identified method, URL, query parameters, headers,
response fields, formatter operands, rounding, or clamping. Fusion's existing
billing request is historical context only; it is not asserted to be the CLI's
request.

## Redacted replay

Not performed for FN-8689. A parseable local credential was present, but the
redacted harness contract permits live traffic only for a request proven by
provenance-chained source. Replaying Fusion's legacy request again, guessing an
endpoint, or widening numeric output for unproven fields would not meet that
contract.

## Surface enumeration confirmation

A repository search for `cli-chat-proxy`, `creditUsagePercent`, and
`format=credits` found the executable request only in
`packages/dashboard/src/usage.ts` and its unit tests. Changelog and changeset
hits are historical text. No other provider, shared UI hook, component,
breakpoint, or affordance is changed. Evidence states remain distinct:
credential absence/unparseability, field absence, non-numeric fields, and
unrecoverable provenance never imply a usage value.

VERDICT FN-8689: STATIC-BLOCKED — BLOCKED, source provenance unrecoverable. No provenance chain proven; no source-identified request and no live capture performed.

## Narrow next action

Request from xAI the release checksum or updater manifest for
`grok-0.2.118-macos-aarch64` that maps its SHA-256 to the source commit or
source archive. Once that chain is supplied, read the mapped handler and replay
only its exact request through the redacted in-process harness. Until then,
FN-8668 may implement nothing: there is no confirmed formatter operand or
formula.

## Source provenance (FN-8690)

FN-8690 re-attempted the provenance recovery avenues FN-8689 did not exhaust.
Filtered, non-executing `strings` inspection of the installed Mach-O found
first-party debug/locus strings for
`crates/codegen/xai-grok-shell/src/extensions/usage.rs` and
`crates/codegen/xai-grok-shell/src/extensions/billing.rs`, including billing
handler diagnostic loci at lines 230, 242, 262, 321, and 328. It also found
compiled endpoint and response-identifier fragments. This is evidence that the
installed binary contains those compiled strings, not a readable handler
implementation: no extracted source region establishes the request construction,
formatter operands, arithmetic, rounding, or clamping.

The local bundled manifest was searched for the installed version, candidate
build identifier, asset filename, source/commit mapping, and digest mapping. It
contained bundled-content digests only. Filtered embedded URLs led to the
official installer, which again maps the version to the asset download but does
not map an asset digest to a source tag or commit; the embedded changelog route
returned HTTP 404. No updater/release manifest mapping the installed digest to
source was found.

The source status is therefore `unavailable`: neither a published
`version → asset filename → published digest → source tag/commit` chain nor
readable `embedded-source` exists. The installed SHA-256 remains the FN-8689
recorded value; it is not linked to inspectable source.

## Source-identified handler, request, and arithmetic (FN-8690)

Unavailable. Debug file paths and compiled string fragments are not readable
source under the provenance policy, so FN-8690 did not read a `/usage` or
`/cost` handler as the installed CLI's handler. It asserts no source-identified
method, URL, query, headers, response fields, operand paths, display arithmetic,
rounding, or clamping. Fusion's existing billing request remains historical
context only and is not asserted to be the CLI request.

## Redacted replay (FN-8690)

Not performed. The local credential was present and parseable, but the harness
is permitted to issue live traffic only after provenance-chained or readable
embedded source identifies the exact request. No harness script or output was
created, and no live request was issued.

### Source-named operand classification

| Source-named operand path | Classification |
| --- | --- |
| None — no source handler was readable, so no operand paths could be enumerated. | Not applicable |

No absence claim is made about any response field or numeric leaf. In
particular, this is not a `NO-FIELDS` conclusion.

## FN-8668 hand-off (FN-8690)

**Branch:** `BLOCKED-NO-SOURCE`.

FN-8668 must not derive usage from this evidence. The narrow next action is for
xAI to provide an official release checksum/updater manifest that maps
`grok-0.2.118-macos-aarch64` and the already recorded installed digest to a
source commit/archive, or a readable source bundle embedded in the installed
artifact. A follow-up can then read the pinned handler, enumerate its operands,
and run precisely its request through the redacted harness.

VERDICT FN-8690: BLOCKED-NO-SOURCE — source could not be pinned. Blocker recorded; no source-identified request or formula asserted.
