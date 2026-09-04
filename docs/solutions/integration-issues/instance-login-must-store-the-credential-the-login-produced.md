---
title: "Credential-instance login must store the credential it produced"
date: 2026-09-01
category: integration-issues
module: engine-auth
problem_type: authentication_data_integrity
component: provider-auth
symptoms:
  - "A second OAuth account appears in Authentication but uses the first account's credential"
  - "Changing the default account does not change the account used by runtime lanes"
root_cause: default_slot_readback
resolution_type: code_fix
severity: high
tags: [oauth, credential-instances, anthropic, provider-auth, duplicate-detection]
related_components: [auth-storage, dashboard-auth-routes, model-runtime]
---

# Credential-instance login must store the credential it produced

## Invariant

An instance login writes the credential returned by the login seam directly to its requested instance. It must not read the provider's default credential after login and copy that value into the target.

## Why default readback is unsound

OAuth adapters accept a bare provider id and persist through the provider's current default storage slot. After login, that slot therefore already contains the login product: it is a temporary `default` row on a first named login, or the previous account's row when adding another account. Reading the default after login cannot establish which account the login produced and can silently duplicate an existing credential.

## Duplicate protection

Capture primary credential instances before starting login. Compare the returned login product only with that pre-login snapshot, excluding the target instance for a same-instance refresh. A material match is refused with a named-account message and the prior default row is restored. Never scan post-login storage for this comparison: it necessarily contains the adapter's own write and would reject valid first and second-account logins.

Anthropic's pi OAuth flow exposes opaque tokens and no authoritative account claim. Fusion records a short SHA-256-derived `accountFingerprint` from stored credential material for durable internal identification, but it is not an account id and must never leave auth storage or enter an API response.
