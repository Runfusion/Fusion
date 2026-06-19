/**
 * FNXC:iOSAcceptance 2026-06-18-16:45:
 * Real iOS Safari is the only acceptable terminal wide-glyph gate because Playwright, desktop WebKit, jsdom, and iOS simulators did not reproduce the ASCII cell-width bug that let repeated blind fixes ship. Keep this module pure so availability probes and tests can enumerate credentials and capabilities without network access or secret logging.
 */

import { URL } from "node:url";

export const IOS_PROVIDER_ORDER = ["browserstack", "sauce", "lambdatest"];

export const IOS_PROVIDER_CONFIG = {
  browserstack: {
    label: "BrowserStack",
    usernameKey: "BROWSERSTACK_USERNAME",
    accessKey: "BROWSERSTACK_ACCESS_KEY",
    hubEnvKey: "BROWSERSTACK_HUB_URL",
    defaultHubUrl: "https://hub-cloud.browserstack.com/wd/hub",
    defaultDeviceName: "iPhone 15",
    defaultPlatformVersion: "17",
  },
  sauce: {
    label: "Sauce Labs",
    usernameKey: "SAUCE_USERNAME",
    accessKey: "SAUCE_ACCESS_KEY",
    hubEnvKey: "SAUCE_HUB_URL",
    defaultHubUrl: "https://ondemand.us-west-1.saucelabs.com/wd/hub",
    defaultDeviceName: "iPhone 15",
    defaultPlatformVersion: "17",
  },
  lambdatest: {
    label: "LambdaTest",
    usernameKey: "LT_USERNAME",
    accessKey: "LT_ACCESS_KEY",
    hubEnvKey: "LT_HUB_URL",
    defaultHubUrl: "https://mobile-hub.lambdatest.com/wd/hub",
    defaultDeviceName: "iPhone 15",
    defaultPlatformVersion: "17",
  },
};

export function normalizeProvider(provider) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (normalized === "lt" || normalized === "lambda-test" || normalized === "lambda_test") {
    return "lambdatest";
  }
  if (normalized === "browser-stack" || normalized === "browser_stack") {
    return "browserstack";
  }
  if (IOS_PROVIDER_CONFIG[normalized]) {
    return normalized;
  }
  return null;
}

export function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function checkedCredentialKeys() {
  return IOS_PROVIDER_ORDER.flatMap((provider) => {
    const config = IOS_PROVIDER_CONFIG[provider];
    return [config.usernameKey, config.accessKey];
  });
}

export function credentialsForProvider(provider, env = {}) {
  const normalized = normalizeProvider(provider);
  if (!normalized) {
    return null;
  }
  const config = IOS_PROVIDER_CONFIG[normalized];
  const username = env[config.usernameKey];
  const accessKey = env[config.accessKey];
  if (!nonEmpty(username) || !nonEmpty(accessKey)) {
    return null;
  }
  return {
    username: username.trim(),
    accessKey: accessKey.trim(),
    usernameKey: config.usernameKey,
    accessKeyName: config.accessKey,
  };
}

export function resolveIosProvider(env = {}) {
  for (const provider of IOS_PROVIDER_ORDER) {
    if (credentialsForProvider(provider, env)) {
      return provider;
    }
  }
  return null;
}

export function describeAvailability(env = {}) {
  const checkedKeys = checkedCredentialKeys();
  const provider = resolveIosProvider(env);
  return {
    available: provider !== null,
    provider,
    checkedKeys,
    missing: checkedKeys.filter((key) => !nonEmpty(env[key])),
  };
}

export function iosHubUrl(provider, creds, env = {}) {
  const normalized = normalizeProvider(provider);
  if (!normalized) {
    throw new Error(`Unsupported iOS provider: ${provider}`);
  }
  const config = IOS_PROVIDER_CONFIG[normalized];
  const resolvedCreds = creds ?? credentialsForProvider(normalized, env);
  if (!resolvedCreds || !nonEmpty(resolvedCreds.username) || !nonEmpty(resolvedCreds.accessKey)) {
    throw new Error(`Missing credentials for ${normalized}`);
  }
  const base = nonEmpty(env[config.hubEnvKey]) ? env[config.hubEnvKey].trim() : config.defaultHubUrl;
  const url = new URL(base);
  url.username = resolvedCreds.username.trim();
  url.password = resolvedCreds.accessKey.trim();
  return url.toString();
}

export function redactSecretValue(value) {
  return nonEmpty(value) ? "<redacted>" : value;
}

export function redactUrl(value) {
  if (!nonEmpty(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    if (!url.username && !url.password) {
      return url.toString();
    }
    return `${url.protocol}//<redacted>:<redacted>@${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return String(value).replace(/\/\/([^:@/\s]+):([^@/\s]+)@/g, "//<redacted>:<redacted>@");
  }
}

function resolveCapabilityOption(opts, env, provider, optionName, envSuffix, fallbackName) {
  const config = IOS_PROVIDER_CONFIG[provider];
  const providerPrefix = provider === "browserstack" ? "BROWSERSTACK" : provider === "sauce" ? "SAUCE" : "LT";
  const envKey = `${providerPrefix}_${envSuffix}`;
  return opts[optionName] ?? env?.[envKey] ?? config[fallbackName];
}

export function buildIosCapabilities(provider, opts = {}) {
  const normalized = normalizeProvider(provider);
  if (!normalized) {
    throw new Error(`Unsupported iOS provider: ${provider}`);
  }
  const env = opts.env ?? {};
  const deviceName = String(
    resolveCapabilityOption(opts, env, normalized, "deviceName", "IOS_DEVICE", "defaultDeviceName"),
  ).trim();
  const platformVersion = String(
    resolveCapabilityOption(opts, env, normalized, "platformVersion", "IOS_VERSION", "defaultPlatformVersion"),
  ).trim();
  const sessionName = String(opts.name ?? "Fusion real-iOS Safari acceptance").trim();
  const buildName = String(opts.build ?? "FN-6667 ios-acceptance").trim();

  if (normalized === "browserstack") {
    return {
      browserName: "safari",
      platformName: "iOS",
      "bstack:options": {
        deviceName,
        osVersion: platformVersion,
        realMobile: true,
        projectName: "Fusion",
        buildName,
        sessionName,
      },
    };
  }

  if (normalized === "sauce") {
    return {
      browserName: "safari",
      platformName: "iOS",
      "appium:deviceName": deviceName,
      "appium:platformVersion": platformVersion,
      "appium:automationName": "XCUITest",
      "sauce:options": {
        name: sessionName,
        build: buildName,
        realDevice: true,
      },
    };
  }

  return {
    browserName: "safari",
    platformName: "iOS",
    "LT:Options": {
      deviceName,
      platformVersion,
      platformName: "iOS",
      isRealMobile: true,
      name: sessionName,
      build: buildName,
    },
  };
}

export function publicCapabilityPlan(provider, opts = {}) {
  const normalized = normalizeProvider(provider);
  const capabilities = buildIosCapabilities(normalized, opts);
  return {
    provider: normalized,
    device: capabilityDeviceName(normalized, capabilities),
    platformVersion: capabilityPlatformVersion(normalized, capabilities),
    capabilities,
  };
}

export function capabilityDeviceName(provider, capabilities) {
  const normalized = normalizeProvider(provider);
  if (normalized === "browserstack") {
    return capabilities["bstack:options"]?.deviceName ?? null;
  }
  if (normalized === "sauce") {
    return capabilities["appium:deviceName"] ?? null;
  }
  if (normalized === "lambdatest") {
    return capabilities["LT:Options"]?.deviceName ?? null;
  }
  return null;
}

export function capabilityPlatformVersion(provider, capabilities) {
  const normalized = normalizeProvider(provider);
  if (normalized === "browserstack") {
    return capabilities["bstack:options"]?.osVersion ?? null;
  }
  if (normalized === "sauce") {
    return capabilities["appium:platformVersion"] ?? null;
  }
  if (normalized === "lambdatest") {
    return capabilities["LT:Options"]?.platformVersion ?? null;
  }
  return null;
}
