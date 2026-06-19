# Real iOS Safari acceptance surface

[← Docs index](./README.md)

<!--
FNXC:iOSAcceptance 2026-06-18-17:18:
Terminal wide-glyph fixes must prove behavior on real iOS Safari because desktop WebKit, Playwright, jsdom, and simulators repeatedly missed the ASCII cell-width defect. This runbook keeps credential provisioning separate from test execution while giving terminal gates a deterministic run-vs-NO-OP probe.
-->

## Purpose

The mobile xterm wide-glyph defect recurred across FN-6390 → FN-6424 → FN-6603 → FN-6638 → FN-6659. Each fix shipped without a real-iOS reproduction because the execution environment had no BrowserStack, Sauce Labs, LambdaTest, or physical-device surface. FN-6641 and FN-6662 therefore had to treat the real-device gate as unavailable instead of verified.

`scripts/ios-acceptance.mjs` is the reachable-surface plumbing for future terminal acceptance gates:

- `--check` reports whether real-iOS cloud credentials are present and exits `0` only when a provider is usable.
- `--dry-run` prints the redacted provider/capability plan without opening a network session.
- Session mode opens a real iOS Safari W3C WebDriver session, navigates to a served Fusion dashboard URL, captures a PNG screenshot, and always deletes the cloud session in `finally`.

The harness is intentionally dependency-light: it uses built-in `fetch` and does **not** install Selenium, WebdriverIO, Appium, or provider CLIs.

## Real-device options

### Option A — physical iPhone or iPad

Use a current iPhone or iPad running Safari with macOS Safari remote Web Inspector:

1. Serve the built dashboard on a reachable free port. Use `--port 0` or another free port; **never use port 4040**, which is reserved for the production dashboard.
2. Open the URL on the physical device.
3. In macOS Safari, enable Develop menu and choose Develop → device → page.
4. Capture screenshots and measure terminal cell widths through Web Inspector.

This path does not use `scripts/ios-acceptance.mjs` session mode, but the `--check` probe should still return non-zero unless cloud credentials are also present. A human verifier records the physical-device evidence in the task document.

### Option B — real-iOS cloud WebDriver

Supply exactly one complete credential pair for a supported provider. If multiple pairs are present, the harness chooses BrowserStack → Sauce Labs → LambdaTest.

| Provider | Credential keys | Default hub URL |
|---|---|---|
| BrowserStack | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` | `https://hub-cloud.browserstack.com/wd/hub` (`upstream-pending-verification`) |
| Sauce Labs | `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY` | `https://ondemand.us-west-1.saucelabs.com/wd/hub` (`upstream-pending-verification`) |
| LambdaTest | `LT_USERNAME`, `LT_ACCESS_KEY` | `https://mobile-hub.lambdatest.com/wd/hub` (`upstream-pending-verification`) |

Hub base URLs are region-configurable:

- `BROWSERSTACK_HUB_URL`
- `SAUCE_HUB_URL`
- `LT_HUB_URL`

Device defaults are intentionally conservative and may be overridden without code changes:

- BrowserStack: `BROWSERSTACK_IOS_DEVICE`, `BROWSERSTACK_IOS_VERSION`
- Sauce Labs: `SAUCE_IOS_DEVICE`, `SAUCE_IOS_VERSION`
- LambdaTest: `LT_IOS_DEVICE`, `LT_IOS_VERSION`

The default capability target is real iOS Safari on `iPhone 15` / iOS `17`; provider-specific options set real-device flags (`realMobile`, `realDevice`, or `isRealMobile`). Do not replace this with Playwright, desktop WebKit, jsdom, or an iOS simulator for terminal acceptance.

## Storing credentials safely

Secret values must never be committed, logged, attached, or written into task documents.

Recommended Fusion setup:

1. Store each provider credential as a project secret with access policy appropriate for the operator (`auto` for unattended gates, `prompt` for manual approval, `deny` when not exportable).
2. Mark gate credentials `env_exportable=true` and set `env_export_key` to the exact env var name, for example `BROWSERSTACK_USERNAME`.
3. Enable project `secretsEnv.enabled=true` so task worktrees receive a gitignored `.env` file with the materialized keys.
4. Keep `secretsEnv.requireGitignored=true` so plaintext is never written to a tracked path.

If environment materialization is unavailable, an operator or agent can fall back to `fn_secret_get` for these exact keys (project scope first, then global) and export them only for the acceptance command. The harness prints key names and missing-key lists, never plaintext values.

## Harness usage

Probe availability for FN-6662-style gates:

```bash
pnpm ios:acceptance -- --check
# or
node scripts/ios-acceptance.mjs --check
```

- Exit `0`: at least one complete cloud credential pair is present; run the real-iOS gate.
- Non-zero: no cloud provider is complete. Record the missing keys and close the observational gate with:

```text
NO-OP: real-iOS surface unavailable — credentials missing, cannot run acceptance gate
```

Inspect a redacted plan without network access:

```bash
BROWSERSTACK_USERNAME=... BROWSERSTACK_ACCESS_KEY=... \
  pnpm ios:acceptance -- --dry-run --provider browserstack
```

Run a real session and capture evidence:

```bash
# Serve the dashboard on a free, reachable, non-4040 port first.
DASHBOARD_URL="https://reachable.example.test" \
  pnpm ios:acceptance -- --url "$DASHBOARD_URL" --out screenshots/ios-acceptance.png
```

The JSON result includes `provider`, `device`, `platformVersion`, `sessionId`, and `screenshotPath`. The screenshot is a PNG decoded from the WebDriver `/screenshot` response. Authenticated hub URLs and `Authorization` headers are never printed.

## Serving the dashboard for cloud access

Build and serve the dashboard from the verification worktree, then make it reachable to the selected real-iOS surface:

```bash
pnpm build
# Use the project serve/dev command appropriate for the gate and choose --port 0 or a known free non-4040 port.
```

For cloud devices, use the provider's documented tunnel, a public preview URL, or another approved remote-access path. The harness does not start tunnels or download provider binaries; it only talks to the hosted WebDriver hub over HTTPS.

## External Integration Evidence

This harness integrates hosted SaaS WebDriver hubs over W3C WebDriver using built-in `fetch`; no provider binary is downloaded or executed locally, so checksums are not applicable.

- **BrowserStack Automate / Live**
  - Canonical upstream repo URL: https://github.com/browserstack/browserstack-local-nodejs
  - Docs / homepage URL: https://www.browserstack.com/docs/automate (Live: https://www.browserstack.com/live)
  - Release / download URL: https://github.com/browserstack/browserstack-local-nodejs/releases/latest — `upstream-pending-verification`
  - WebDriver hub (default, env-overridable via `BROWSERSTACK_HUB_URL`): `https://hub-cloud.browserstack.com/wd/hub` — `upstream-pending-verification`
  - Binary / CLI name: N/A for this harness (`fetch`-based W3C hub over HTTPS); reference client binary `browserstack-local`
  - Credential keys: `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY`
  - Checksum: N/A (hosted service, no downloadable artifact bundled)
- **Sauce Labs Real Device Cloud**
  - Canonical upstream repo URL: https://github.com/saucelabs/saucectl
  - Docs / homepage URL: https://docs.saucelabs.com (Real Device Cloud: https://saucelabs.com/platform/real-device-cloud)
  - Release / download URL: https://github.com/saucelabs/saucectl/releases/latest — `upstream-pending-verification`
  - WebDriver hub (default, env-overridable via `SAUCE_HUB_URL`): `https://ondemand.us-west-1.saucelabs.com/wd/hub` — `upstream-pending-verification`
  - Binary / CLI name: N/A for this harness (`fetch`-based W3C hub over HTTPS); reference CLI `saucectl`
  - Credential keys: `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY`
  - Checksum: N/A (hosted service, no downloadable artifact bundled)
- **LambdaTest Real Time / Real Device**
  - Canonical upstream repo URL: https://github.com/LambdaTest/LT
  - Docs / homepage URL: https://www.lambdatest.com/support/docs/ (Real Time: https://www.lambdatest.com/real-time-browser-testing)
  - Release / download URL: https://github.com/LambdaTest/LT/releases/latest — `upstream-pending-verification`
  - WebDriver hub (default, env-overridable via `LT_HUB_URL`): `https://mobile-hub.lambdatest.com/wd/hub` — `upstream-pending-verification`
  - Binary / CLI name: N/A for this harness (`fetch`-based W3C hub over HTTPS); reference tunnel binary `LT`
  - Credential keys: `LT_USERNAME`, `LT_ACCESS_KEY`
  - Checksum: N/A (hosted service, no downloadable artifact bundled)
