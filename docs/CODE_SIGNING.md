# Code Signing Setup Guide

This document explains how to configure code signing for `kb` release binaries so they don't trigger OS security warnings on macOS (Gatekeeper) or Windows (SmartScreen), and how Linux desktop artifact signatures are published for authenticity verification.

## Overview

The release workflow automatically signs binaries when the appropriate secrets are configured:

- **macOS**: Codesign with hardened runtime + Apple notarization
- **Windows**: Authenticode signing with timestamp
- **Linux**: GPG detached-signature signing of `.AppImage` / `.deb` / `.tar.gz` desktop artifacts

Signing is **optional** — if secrets are not configured, the build succeeds and signing steps are skipped.

## Required GitHub Secrets

### macOS Signing

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE_BASE64` | Base64-encoded `.p12` Developer ID Application certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` certificate |
| `APPLE_IDENTITY` | Signing identity string (e.g., `Developer ID Application: Your Name (TEAMID)`) |
| `APPLE_ID` | Apple ID email address used for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID (10-character alphanumeric) |
| `APPLE_APP_PASSWORD` | App-specific password for notarization |

### Windows Signing

| Secret | Description |
|--------|-------------|
| `WINDOWS_CERTIFICATE_BASE64` | Base64-encoded `.pfx` Authenticode code signing certificate |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the `.pfx` certificate |

### Linux Signing

| Secret | Description |
|--------|-------------|
| `LINUX_GPG_PRIVATE_KEY` | Base64 of an ASCII-armored exported private key (`gpg --armor --export-secret-keys`) |
| `LINUX_GPG_PASSPHRASE` | Passphrase that unlocks the exported private key |
| `LINUX_GPG_KEY_ID` | Long key ID or full fingerprint used with `gpg --local-user` |

## macOS Setup Instructions

### 1. Obtain a Developer ID Application Certificate

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/)
2. In Xcode or the Apple Developer portal, create a **Developer ID Application** certificate
3. Export the certificate from Keychain Access as a `.p12` file with a password

### 2. Encode the Certificate as Base64

```bash
base64 -i certificate.p12 | pbcopy
```

Paste the result as the `APPLE_CERTIFICATE_BASE64` secret.

### 3. Find Your Team ID

Your Team ID is visible at [developer.apple.com/account](https://developer.apple.com/account) under Membership Details. It's a 10-character alphanumeric string (e.g., `ABC1234DEF`).

### 4. Create an App-Specific Password

1. Go to [appleid.apple.com](https://appleid.apple.com/)
2. Sign in and navigate to **Sign-In and Security** → **App-Specific Passwords**
3. Generate a new password and label it (e.g., "kb notarization")
4. Use this as the `APPLE_APP_PASSWORD` secret

### 5. Determine Your Signing Identity

The signing identity looks like:
```
Developer ID Application: Your Name (TEAMID)
```

You can find it by running:
```bash
security find-identity -v -p codesigning
```

## Linux Signing

### 1. Generate a release signing key

```bash
gpg --full-generate-key
```

Recommended: RSA 4096, with either no expiration or a 2-year expiration.

### 2. Export and base64-encode the private key for GitHub Actions secret storage

```bash
gpg --armor --export-secret-keys <key-id> | base64 -w0 | pbcopy
```

Linux clipboard alternative:

```bash
gpg --armor --export-secret-keys <key-id> | base64 -w0 | xclip -selection clipboard
```

Store this output as `LINUX_GPG_PRIVATE_KEY`.

### 3. Set Linux signing secrets

Set repository-level Actions secrets:
- `LINUX_GPG_PRIVATE_KEY`
- `LINUX_GPG_PASSPHRASE`
- `LINUX_GPG_KEY_ID`

### 4. Publish the public key for users

Export and publish the public key in release notes and/or a repository `KEYS` file:

```bash
gpg --armor --export <key-id>
```

### 5. User verification flow

```bash
gpg --import KEYS && gpg --verify Fusion-<version>-linux-x64.AppImage.asc Fusion-<version>-linux-x64.AppImage
```

If `LINUX_GPG_PRIVATE_KEY` is absent (forks/initial setup), CI continues and ships unsigned Linux artifacts without `.asc` sidecars.

## Windows Setup Instructions

### 1. Obtain an Authenticode Code Signing Certificate

Purchase a code signing certificate from a trusted Certificate Authority:
- DigiCert
- Sectigo (Comodo)
- GlobalSign
- SSL.com

### 2. Export as `.pfx`

Export the certificate with its private key as a `.pfx` (PKCS#12) file. Set a strong password.

### 3. Encode the Certificate as Base64

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Set-Clipboard
```

Or on Linux/macOS:
```bash
base64 -i certificate.pfx
```

Paste the result as the `WINDOWS_CERTIFICATE_BASE64` secret.

## How Signing Works in the Release Flow

1. A tag push (`v*`) triggers the release workflow
2. Each platform job builds the standalone binary
3. **macOS CLI jobs**: `scripts/sign-macos.sh` runs codesign + notarization for standalone CLI binaries
4. **macOS desktop jobs**: electron-builder signs `.dmg` / `.zip` outputs using `CSC_LINK` / `CSC_KEY_PASSWORD`, notarizes with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`, and validates signatures/stapling in CI
5. **Windows jobs**: `scripts/sign-windows.ps1` runs Authenticode signing
6. **Linux desktop jobs**: `scripts/sign-linux.sh` runs `gpg --detach-sign --armor` for each `.AppImage` / `.deb` / `.tar.gz` artifact and verifies each signature with `gpg --verify`
7. Checksums are generated **after** signing (so they match the signed binaries)
8. Signed binaries and checksums are uploaded to the GitHub Release

The test-release workflow (`workflow_dispatch`) includes the same signing steps but guards them with secret-availability checks — signing is skipped if secrets are not configured.

Desktop Windows packaging (`.github/workflows/desktop-windows.yml`) now uses the same `WINDOWS_CERTIFICATE_BASE64` / `WINDOWS_CERTIFICATE_PASSWORD` secrets to sign NSIS and portable EXE artifacts via electron-builder (`CSC_LINK` / `CSC_KEY_PASSWORD`) and validates signatures with `Get-AuthenticodeSignature` when signing is enabled.

## Troubleshooting

### macOS: "The signature of the binary is invalid"

- Ensure the certificate is a **Developer ID Application** certificate (not Developer ID Installer or Mac App Distribution)
- Check that the certificate hasn't expired
- Verify the base64 encoding is correct: `echo "$APPLE_CERTIFICATE_BASE64" | base64 --decode | file -`

### macOS: Notarization fails with "Invalid credentials"

- Verify `APPLE_ID` is your Apple ID email
- Verify `APPLE_APP_PASSWORD` is an app-specific password (not your Apple ID password)
- Verify `APPLE_TEAM_ID` matches the team that issued the certificate

### macOS: Notarization fails with "The software is not signed"

- Ensure the `--options runtime` flag is used during codesign (hardened runtime is required for notarization)
- The `sign-macos.sh` script handles this automatically

### Windows: "signtool not found"

- `signtool.exe` is included in the Windows SDK, which is pre-installed on GitHub Actions Windows runners
- For local testing, install the Windows SDK or Visual Studio Build Tools

### Windows: "The specified PFX password is not correct"

- Double-check the `WINDOWS_CERTIFICATE_PASSWORD` secret matches the password used when exporting the `.pfx`

### Linux signing skipped

- Expected when `LINUX_GPG_PRIVATE_KEY` is not set (forks, dry runs, first-time setup)
- In this path, Linux artifacts upload without `.asc` sidecars by design

### Linux signing fails with "No secret key"

- `LINUX_GPG_KEY_ID` does not match the imported private key fingerprint/key ID
- Re-export and re-check key ID via `gpg --list-secret-keys --keyid-format=long`

### Linux verification fails with "BAD signature"

- Artifact changed between sign and verify; investigate runner storage path and artifact staging
- Ensure signatures are generated from the exact file that is later uploaded

### Signing step skipped

- In the test-release workflow, signing is intentionally skipped when secrets are not configured
- Verify the secrets are set at the repository level in **Settings → Secrets and variables → Actions**

### Desktop EXE signing skipped

- The desktop Windows workflow intentionally falls back to unsigned artifacts when `WINDOWS_CERTIFICATE_BASE64` is empty
- In that unsigned path, `Verify signed artifacts` is skipped by design
- Set both `WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD` at the repository level to enable signed desktop EXE output

### Desktop DMG/ZIP signing skipped

- The macOS desktop release jobs intentionally fall back to unsigned artifacts when `APPLE_CERTIFICATE_BASE64` is empty
- In that unsigned path, packaging runs with `-c.mac.notarize=false` so builds do not block on missing Apple notarization credentials
- The `Verify signed and notarized macOS artifacts` step is skipped by design for unsigned runs

### Notarization fails for desktop bundle

- Confirm `APPLE_APP_PASSWORD` is configured in GitHub secrets and mapped to `APPLE_APP_SPECIFIC_PASSWORD` in workflow env
- Confirm `APPLE_TEAM_ID` matches the team that issued the Developer ID certificate
- Confirm the Developer ID certificate in `APPLE_CERTIFICATE_BASE64` is valid and not expired
- Confirm hardened runtime entitlements are present via `packages/desktop/build/entitlements.mac.plist`
