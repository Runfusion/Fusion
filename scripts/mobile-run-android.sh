#!/usr/bin/env bash
#
# FNXC:MobileAndroidRun 2026-06-16-17:30:
# Convenience deploy script for the Fusion Capacitor Android app. Codifies the
# environment the native build needs so a contributor can go from "connected
# phone" to "app installed" in one command, without re-discovering toolchain
# requirements each time.
#
# Requirements encoded here (learned during the first manual deploy):
#  - Capacitor 7's :capacitor-android library compiles at source release 21, so
#    Gradle MUST run under a JDK 21 toolchain. JDK 17 fails with
#    "invalid source release: 21". We pin JAVA_HOME to Homebrew openjdk@21.
#  - The Android SDK lives at the Homebrew cmdline-tools root, not the default
#    ~/Library/Android/sdk. We export ANDROID_HOME/ANDROID_SDK_ROOT and write
#    android/local.properties (sdk.dir=...) so Gradle resolves the SDK.
#  - The target device connects over network ADB (Tailscale), which drops
#    between commands. We re-run `adb connect` for FUSION_ANDROID_DEVICE right
#    before deploy so Capacitor can see the device as a valid target.
#  - When FUSION_SERVER_URL is set, the webview loads the live backend
#    (assets + API) from that origin instead of the bundled static client.
#    This is the working path until the mobile shell host-context wiring lands
#    (see shell-host.ts detectShellHostContext: it has no Capacitor branch, so
#    a bundled build self-identifies as a plain browser and calls /api against
#    its own static origin -> "API returned HTML instead of JSON").
#
# Usage:
#   FUSION_ANDROID_DEVICE=100.96.156.40:5555 \
#   FUSION_SERVER_URL=http://100.97.197.105:4040 \
#     pnpm mobile:run:android
#
# Env vars:
#   FUSION_ANDROID_DEVICE  adb target id (host:port for network adb, or serial).
#                          If unset, Capacitor auto-selects the only device.
#   FUSION_SERVER_URL      Optional. If set, the app loads from this backend URL
#                          (remote/live mode). If unset, ships the bundled client.
#   ANDROID_HOME           Optional override for the SDK root.
#   JAVA_HOME              Optional override for the JDK 21 home.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/packages/mobile"

# --- Resolve Android SDK root ------------------------------------------------
if [[ -z "${ANDROID_HOME:-}" ]]; then
  for candidate in \
    "/opt/homebrew/share/android-commandlinetools" \
    "$HOME/Library/Android/sdk" \
    "/usr/local/share/android-commandlinetools"; do
    if [[ -d "$candidate" ]]; then
      ANDROID_HOME="$candidate"
      break
    fi
  done
fi
if [[ -z "${ANDROID_HOME:-}" || ! -d "$ANDROID_HOME" ]]; then
  echo "[mobile:run:android] Could not locate the Android SDK. Set ANDROID_HOME." >&2
  exit 1
fi
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"

# --- Resolve JDK 21 ----------------------------------------------------------
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in \
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
    "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"; do
    if [[ -d "$candidate" ]]; then
      JAVA_HOME="$candidate"
      break
    fi
  done
fi
if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "[mobile:run:android] JDK 21 not found. Install with: brew install openjdk@21" >&2
  echo "[mobile:run:android] Or set JAVA_HOME to a JDK 21 home." >&2
  exit 1
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

echo "[mobile:run:android] ANDROID_HOME=$ANDROID_HOME"
echo "[mobile:run:android] JAVA_HOME=$JAVA_HOME ($("$JAVA_HOME/bin/java" -version 2>&1 | head -1))"

# --- Ensure the Android platform project exists ------------------------------
if [[ ! -d "$MOBILE_DIR/android" ]]; then
  echo "[mobile:run:android] Android project missing; adding it (cap add android)..."
  (cd "$MOBILE_DIR" && npx cap add android)
fi

# Gradle reads the SDK location from local.properties.
printf "sdk.dir=%s\n" "$ANDROID_HOME" > "$MOBILE_DIR/android/local.properties"

# FNXC:MobileShell 2026-06-16-18:40:
# The Android project is generated (gitignored), so re-apply the edge-to-edge
# enablement that @capacitor-community/safe-area needs in MainActivity. Idempotent:
# only rewrites when EdgeToEdge is not already wired. Without this the status bar
# overlaps the app top on Android 15+ (API 35+).
MAIN_ACTIVITY="$MOBILE_DIR/android/app/src/main/java/com/fusion/mobile/MainActivity.java"
if [[ -f "$MAIN_ACTIVITY" ]] && ! grep -q "EdgeToEdge" "$MAIN_ACTIVITY"; then
  echo "[mobile:run:android] Patching MainActivity for edge-to-edge (safe-area insets)..."
  cat > "$MAIN_ACTIVITY" <<'JAVA'
package com.fusion.mobile;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

// FNXC:MobileShell 2026-06-16-18:40:
// Enable Android edge-to-edge so @capacitor-community/safe-area passes status-bar
// insets to the WebView as env(safe-area-inset-*). Re-applied by
// scripts/mobile-run-android.sh because android/ is generated (gitignored).
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    EdgeToEdge.enable(this);
  }
}
JAVA
fi

# --- Build web client --------------------------------------------------------
echo "[mobile:run:android] Building dashboard web client..."
pnpm --filter @fusion/dashboard build

RUN_ENV=()
if [[ -n "${FUSION_SERVER_URL:-}" ]]; then
  echo "[mobile:run:android] Remote mode: app will load from $FUSION_SERVER_URL"
  RUN_ENV+=("FUSION_LIVE_RELOAD=true" "FUSION_SERVER_URL=$FUSION_SERVER_URL")
fi

# --- Reconnect network ADB device right before deploy ------------------------
# FNXC:MobileAndroidRun 2026-06-16-17:55: Network ADB (Tailscale) drops on idle,
# so reconnect AFTER the web build (which takes seconds) and immediately before
# `cap run`, otherwise Capacitor sees no device and rejects the target id.
DEVICE="${FUSION_ANDROID_DEVICE:-}"
if [[ -n "$DEVICE" ]]; then
  echo "[mobile:run:android] Reconnecting adb device $DEVICE..."
  adb connect "$DEVICE" || true
  sleep 1
fi
echo "[mobile:run:android] Attached devices:"
adb devices

cd "$MOBILE_DIR"
if [[ -n "$DEVICE" ]]; then
  env "${RUN_ENV[@]}" npx cap run android --target "$DEVICE"
else
  env "${RUN_ENV[@]}" npx cap run android
fi
