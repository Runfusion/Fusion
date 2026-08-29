# sign-windows.ps1 — Authenticode sign a Windows binary.
#
# Usage:
#   $env:WINDOWS_CERTIFICATE_BASE64 = "..."
#   $env:WINDOWS_CERTIFICATE_PASSWORD = "..."
#   pwsh scripts/sign-windows.ps1 path\to\binary.exe
#
# Environment variables (all required):
#   WINDOWS_CERTIFICATE_BASE64     — Base64-encoded .pfx code signing certificate
#   WINDOWS_CERTIFICATE_PASSWORD   — Password for the .pfx certificate

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$BinaryPath
)

$ErrorActionPreference = "Stop"

# ── Validate arguments ────────────────────────────────────────────────
if (-not (Test-Path $BinaryPath)) {
    Write-Error "ERROR: Binary not found: $BinaryPath"
    exit 1
}

# ── Validate environment variables ────────────────────────────────────
$requiredVars = @("WINDOWS_CERTIFICATE_BASE64", "WINDOWS_CERTIFICATE_PASSWORD")
foreach ($var in $requiredVars) {
    if (-not [System.Environment]::GetEnvironmentVariable($var)) {
        Write-Error "ERROR: Required environment variable $var is not set."
        exit 1
    }
}

Write-Host "==> Signing Windows binary: $BinaryPath"

# ── Decode certificate to temporary file ──────────────────────────────
$certFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "signing-cert-$(Get-Random).pfx")

try {
    # Decode base64 certificate
    $certBytes = [System.Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64)
    [System.IO.File]::WriteAllBytes($certFile, $certBytes)
    Write-Host "==> Certificate decoded to temporary file."

    # ── Sign the binary ───────────────────────────────────────────────
    Write-Host "==> Signing with signtool..."
    & signtool sign `
        /f $certFile `
        /p $env:WINDOWS_CERTIFICATE_PASSWORD `
        /tr http://timestamp.digicert.com `
        /td sha256 `
        /fd sha256 `
        $BinaryPath

    if ($LASTEXITCODE -ne 0) {
        Write-Error "ERROR: signtool sign failed with exit code $LASTEXITCODE"
        exit 1
    }

    Write-Host "==> Sign complete. Verifying..."

    # ── Verify the signature ──────────────────────────────────────────
    & signtool verify /pa $BinaryPath

    if ($LASTEXITCODE -ne 0) {
        Write-Error "ERROR: signtool verify failed with exit code $LASTEXITCODE"
        exit 1
    }

    Write-Host "==> ✓ Binary signed and verified: $BinaryPath"
}
finally {
    # ── Clean up temporary certificate file ───────────────────────────
    if (Test-Path $certFile) {
        Remove-Item -Force $certFile
        Write-Host "==> Temporary certificate file removed."
    }
}
