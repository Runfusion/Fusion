#!/usr/bin/env node

/**
 * FNXC:iOSAcceptance 2026-06-18-17:02:
 * Terminal acceptance gates need a cheap run-vs-NO-OP probe and a dependency-light real-device WebDriver path. This CLI emits only structured, redacted metadata so cloud credentials can be supplied through env or Fusion secrets materialization without leaking plaintext into logs.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { URL } from "node:url";
import {
  buildIosCapabilities,
  capabilityDeviceName,
  capabilityPlatformVersion,
  credentialsForProvider,
  describeAvailability,
  iosHubUrl,
  normalizeProvider,
  publicCapabilityPlan,
  redactUrl,
} from "./lib/ios-acceptance.mjs";

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  return `Usage:
  node scripts/ios-acceptance.mjs --check
  node scripts/ios-acceptance.mjs --dry-run [--provider browserstack|sauce|lambdatest]
  node scripts/ios-acceptance.mjs --url <dashboardUrl> --out <screenshotPath> [--provider browserstack|sauce|lambdatest]

Options:
  --check             Probe credential availability only; no WebDriver session.
  --url <url>         Dashboard URL to open on real iOS Safari. Port 4040 is rejected.
  --out <path>        Screenshot PNG path for session mode.
  --provider <name>   Override provider auto-resolution.
  --dry-run           Resolve credentials and print the redacted capability plan; no network.
  --help              Show this help.
`;
}

function parseArgs(argv) {
  const args = { check: false, dryRun: false, provider: null, url: null, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--provider") {
      args.provider = argv[++index];
    } else if (arg === "--url") {
      args.url = argv[++index];
    } else if (arg === "--out") {
      args.out = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function selectProvider(args, env) {
  const availability = describeAvailability(env);
  if (!args.provider) {
    return { provider: availability.provider, availability };
  }
  const provider = normalizeProvider(args.provider);
  if (!provider) {
    throw new Error(`Unsupported provider: ${args.provider}`);
  }
  const creds = credentialsForProvider(provider, env);
  return {
    provider: creds ? provider : null,
    requestedProvider: provider,
    availability: {
      ...availability,
      available: Boolean(creds),
      provider: creds ? provider : null,
    },
  };
}

function printMissingCredentialHint(availability) {
  console.error(`[ios:acceptance] Missing real-iOS credentials: ${availability.missing.join(", ") || "none"}`);
  console.error(
    "[ios:acceptance] If credentials are stored in Fusion, use fn_secret_get or enable env-exportable project secrets so BROWSERSTACK_*, SAUCE_*, or LT_* keys materialize into this worktree.",
  );
  console.error(
    "[ios:acceptance] NO-OP sentinel for verification gates: NO-OP: real-iOS surface unavailable — credentials missing, cannot run acceptance gate",
  );
}

function assertDashboardUrl(value) {
  if (!value) {
    throw new Error("Session mode requires --url <dashboardUrl>.");
  }
  const url = new URL(value);
  if (url.port === "4040") {
    throw new Error("Port 4040 is reserved for the production dashboard; serve acceptance builds on --port 0 or another free non-4040 port.");
  }
  return url.toString();
}

function basicAuthHeader(creds) {
  return `Basic ${Buffer.from(`${creds.username}:${creds.accessKey}`).toString("base64")}`;
}

function webdriverEndpoint(authenticatedHubUrl, path) {
  const url = new URL(authenticatedHubUrl);
  url.username = "";
  url.password = "";
  const basePath = url.pathname.replace(/\/+$/, "");
  const nextPath = path.replace(/^\/+/, "");
  url.pathname = `${basePath}/${nextPath}`;
  return url.toString();
}

async function webdriverFetch(authenticatedHubUrl, path, init = {}) {
  const endpoint = webdriverEndpoint(authenticatedHubUrl, path);
  const response = await fetch(endpoint, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const message = body?.value?.message ?? body?.message ?? response.statusText;
    throw new Error(`WebDriver ${init.method ?? "GET"} ${path} failed (${response.status}): ${message}`);
  }
  return body;
}

function sessionIdFromCreateResponse(body) {
  return body?.value?.sessionId ?? body?.sessionId ?? null;
}

async function runSession({ provider, dashboardUrl, screenshotPath, env }) {
  const creds = credentialsForProvider(provider, env);
  if (!creds) {
    throw new Error(`Missing credentials for ${provider}`);
  }
  const capabilities = buildIosCapabilities(provider, { env });
  const hubUrl = iosHubUrl(provider, creds, env);
  const authHeader = basicAuthHeader(creds);
  let sessionId = null;
  try {
    const createBody = await webdriverFetch(hubUrl, "/session", {
      method: "POST",
      headers: { authorization: authHeader },
      body: JSON.stringify({ capabilities: { alwaysMatch: capabilities } }),
    });
    sessionId = sessionIdFromCreateResponse(createBody);
    if (!sessionId) {
      throw new Error("WebDriver session response did not include a sessionId.");
    }
    await webdriverFetch(hubUrl, `/session/${encodeURIComponent(sessionId)}/url`, {
      method: "POST",
      headers: { authorization: authHeader },
      body: JSON.stringify({ url: dashboardUrl }),
    });
    const screenshotBody = await webdriverFetch(hubUrl, `/session/${encodeURIComponent(sessionId)}/screenshot`, {
      method: "GET",
      headers: { authorization: authHeader },
    });
    const screenshot = screenshotBody?.value;
    if (typeof screenshot !== "string" || screenshot.length === 0) {
      throw new Error("WebDriver screenshot response did not include base64 PNG data.");
    }
    const absoluteScreenshotPath = resolve(screenshotPath);
    await mkdir(dirname(absoluteScreenshotPath), { recursive: true });
    await writeFile(absoluteScreenshotPath, Buffer.from(screenshot, "base64"));
    return {
      provider,
      device: capabilityDeviceName(provider, capabilities),
      platformVersion: capabilityPlatformVersion(provider, capabilities),
      sessionId,
      screenshotPath: absoluteScreenshotPath,
    };
  } finally {
    if (sessionId) {
      try {
        await webdriverFetch(hubUrl, `/session/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          headers: { authorization: authHeader },
        });
      } catch (error) {
        console.error(`[ios:acceptance] Failed to delete WebDriver session ${sessionId}: ${error.message}`);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const { provider, requestedProvider, availability } = selectProvider(args, process.env);

  if (args.check) {
    const result = requestedProvider
      ? { ...availability, requestedProvider }
      : availability;
    printJson(result);
    if (!result.available) {
      printMissingCredentialHint(result);
      return 1;
    }
    return 0;
  }

  if (!provider) {
    printJson(requestedProvider ? { ...availability, requestedProvider } : availability);
    printMissingCredentialHint(availability);
    return 1;
  }

  const creds = credentialsForProvider(provider, process.env);
  const hubUrl = iosHubUrl(provider, creds, process.env);
  const plan = {
    ...publicCapabilityPlan(provider, { env: process.env }),
    hubUrl: redactUrl(hubUrl),
  };

  if (args.dryRun) {
    printJson({ dryRun: true, ...plan });
    return 0;
  }

  const dashboardUrl = assertDashboardUrl(args.url);
  if (!args.out) {
    throw new Error("Session mode requires --out <screenshotPath>.");
  }

  console.error(`[ios:acceptance] Opening real iOS Safari via ${provider} at ${plan.hubUrl}`);
  const result = await runSession({ provider, dashboardUrl, screenshotPath: args.out, env: process.env });
  printJson(result);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[ios:acceptance] ${error.message}`);
    process.exitCode = 1;
  });
