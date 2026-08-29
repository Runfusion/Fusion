#!/usr/bin/env bash
# sign-linux.sh — Create GPG detached ASCII signatures for Linux release artifacts.
#
# Usage:
#   LINUX_GPG_PRIVATE_KEY=... LINUX_GPG_PASSPHRASE=... LINUX_GPG_KEY_ID=... \
#   bash scripts/sign-linux.sh path/to/file [path/to/file...]
#
# Environment variables:
#   LINUX_GPG_PRIVATE_KEY  — Base64-encoded ASCII-armored private key
#   LINUX_GPG_PASSPHRASE   — Passphrase for private key
#   LINUX_GPG_KEY_ID       — Key ID or fingerprint used for --local-user
#
# Exit semantics:
#   0 when signing is skipped (missing LINUX_GPG_PRIVATE_KEY),
#   0 on successful sign + verify for all files,
#   non-zero on signing/verification/import failures.
#
# Do not invoke outside CI unless GNUPGHOME is isolated.

set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "ERROR: No artifact paths provided."
  echo "Usage: $0 <artifact-path> [artifact-path ...]"
  exit 1
fi

if [[ -z "${LINUX_GPG_PRIVATE_KEY:-}" ]]; then
  echo "Linux signing skipped (LINUX_GPG_PRIVATE_KEY not set)"
  exit 0
fi

if [[ -z "${LINUX_GPG_PASSPHRASE:-}" ]]; then
  echo "ERROR: LINUX_GPG_PASSPHRASE is required when signing is enabled."
  exit 1
fi

if [[ -z "${LINUX_GPG_KEY_ID:-}" ]]; then
  echo "ERROR: LINUX_GPG_KEY_ID is required when signing is enabled."
  exit 1
fi

GNUPGHOME="${RUNNER_TEMP:-$(mktemp -d)}/gnupg-fusion"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"
export GNUPGHOME

cleanup() {
  unset LINUX_GPG_PASSPHRASE
  rm -rf "$GNUPGHOME"
}
trap cleanup EXIT

echo "$LINUX_GPG_PRIVATE_KEY" | base64 -d | gpg --batch --import

for file in "$@"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: Artifact not found: $file"
    exit 1
  fi

  gpg --batch --yes \
    --pinentry-mode loopback \
    --passphrase "$LINUX_GPG_PASSPHRASE" \
    --local-user "$LINUX_GPG_KEY_ID" \
    --armor \
    --detach-sign \
    --output "${file}.asc" \
    "$file"

  gpg --verify "${file}.asc" "$file"
done
