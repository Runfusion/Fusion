#!/usr/bin/env bash
# sign-macos.sh — Codesign and notarize a macOS binary for Gatekeeper.
#
# Usage:
#   APPLE_CERTIFICATE_BASE64=... APPLE_CERTIFICATE_PASSWORD=... \
#   APPLE_IDENTITY=... APPLE_ID=... APPLE_TEAM_ID=... APPLE_APP_PASSWORD=... \
#   bash scripts/sign-macos.sh path/to/binary [path/to/runtime/dir]
#
# Environment variables (all required):
#   APPLE_CERTIFICATE_BASE64      — Base64-encoded .p12 Developer ID Application certificate
#   APPLE_CERTIFICATE_PASSWORD    — Password for the .p12 certificate
#   APPLE_IDENTITY                — Signing identity (e.g., "Developer ID Application: Your Name (TEAMID)")
#   APPLE_ID                      — Apple ID email for notarization
#   APPLE_TEAM_ID                 — Apple Developer Team ID
#   APPLE_APP_PASSWORD            — App-specific password for notarization
#
# The script is idempotent — re-running on an already-signed binary will re-sign it.
# If runtime directory is provided, all .node files in it will also be signed.

set -euo pipefail

# ── Validate arguments ────────────────────────────────────────────────
BINARY="${1:-}"
RUNTIME_DIR="${2:-}"  # Optional: path to runtime/ directory with native assets

if [[ -z "$BINARY" ]]; then
  echo "ERROR: No binary path provided."
  echo "Usage: $0 <path-to-binary> [path-to-runtime-dir]"
  exit 1
fi

if [[ ! -f "$BINARY" ]]; then
  echo "ERROR: Binary not found: $BINARY"
  exit 1
fi

# ── Validate environment variables ────────────────────────────────────
REQUIRED_VARS=(
  APPLE_CERTIFICATE_BASE64
  APPLE_CERTIFICATE_PASSWORD
  APPLE_IDENTITY
  APPLE_ID
  APPLE_TEAM_ID
  APPLE_APP_PASSWORD
)

for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: Required environment variable $var is not set."
    exit 1
  fi
done

echo "==> Signing macOS binary: $BINARY"

# ── Set up temporary keychain ─────────────────────────────────────────
KEYCHAIN_NAME="signing-$(date +%s).keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"
CERT_FILE="$(mktemp -t cert.XXXXXX).p12"

cleanup() {
  echo "==> Cleaning up..."
  security delete-keychain "$KEYCHAIN_NAME" 2>/dev/null || true
  rm -f "$CERT_FILE"
}
trap cleanup EXIT

# Decode certificate from base64
echo "$APPLE_CERTIFICATE_BASE64" | base64 --decode > "$CERT_FILE"

# Create temporary keychain
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security set-keychain-settings -lut 900 "$KEYCHAIN_NAME"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# Import certificate into keychain
security import "$CERT_FILE" \
  -k "$KEYCHAIN_NAME" \
  -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security

# Allow codesign to access the keychain without UI prompt
security set-key-partition-list -S "apple-tool:,apple:,codesign:" \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# Add temporary keychain to the search list
security list-keychains -d user -s "$KEYCHAIN_NAME" $(security list-keychains -d user | tr -d '"')

echo "==> Keychain configured."

# ── Sign native runtime assets if provided ──────────────────────────
if [[ -n "$RUNTIME_DIR" && -d "$RUNTIME_DIR" ]]; then
  echo "==> Signing native runtime assets in: $RUNTIME_DIR"
  find "$RUNTIME_DIR" -name "*.node" -type f | while read -r native_file; do
    echo "    Signing: $native_file"
    codesign --force --options runtime --sign "$APPLE_IDENTITY" \
      --keychain "$KEYCHAIN_NAME" \
      "$native_file"
  done
  echo "==> Native runtime assets signed."
fi

# ── Codesign the binary ───────────────────────────────────────────────
echo "==> Codesigning with identity: $APPLE_IDENTITY"
codesign --force --options runtime --sign "$APPLE_IDENTITY" \
  --keychain "$KEYCHAIN_NAME" \
  "$BINARY"

echo "==> Codesign complete. Verifying..."
codesign --verify --verbose "$BINARY"

# ── Notarize the binary ──────────────────────────────────────────────
echo "==> Preparing for notarization..."
ZIP_FILE="$(mktemp -t notarize.XXXXXX).zip"
trap 'rm -f "$ZIP_FILE"; cleanup' EXIT

# Create a ZIP for notarization submission
# Include runtime directory if it exists
if [[ -n "$RUNTIME_DIR" && -d "$RUNTIME_DIR" ]]; then
  BINARY_DIR=$(dirname "$BINARY")
  BINARY_NAME=$(basename "$BINARY")
  # Create temp directory with both binary and runtime
  TEMP_DIR=$(mktemp -d)
  cp "$BINARY" "$TEMP_DIR/"
  cp -r "$RUNTIME_DIR" "$TEMP_DIR/"
  ditto -c -k --keepParent "$TEMP_DIR/$BINARY_NAME" "$ZIP_FILE"
  rm -rf "$TEMP_DIR"
else
  ditto -c -k --keepParent "$BINARY" "$ZIP_FILE"
fi

echo "==> Submitting to Apple notarization service..."
xcrun notarytool submit "$ZIP_FILE" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait

echo "==> Notarization complete."

# Clean up ZIP
rm -f "$ZIP_FILE"

echo "==> ✓ Binary signed and notarized: $BINARY"
