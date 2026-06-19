import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIosCapabilities,
  describeAvailability,
  iosHubUrl,
  redactUrl,
  resolveIosProvider,
} from "../lib/ios-acceptance.mjs";

const allCredentials = {
  BROWSERSTACK_USERNAME: "browserstack-user",
  BROWSERSTACK_ACCESS_KEY: "browserstack-key",
  SAUCE_USERNAME: "sauce-user",
  SAUCE_ACCESS_KEY: "sauce-key",
  LT_USERNAME: "lt-user",
  LT_ACCESS_KEY: "lt-key",
};

test("resolveIosProvider follows BrowserStack, Sauce, LambdaTest precedence", () => {
  assert.equal(resolveIosProvider(allCredentials), "browserstack");
  assert.equal(
    resolveIosProvider({
      SAUCE_USERNAME: "sauce-user",
      SAUCE_ACCESS_KEY: "sauce-key",
    }),
    "sauce",
  );
  assert.equal(
    resolveIosProvider({
      LT_USERNAME: "lt-user",
      LT_ACCESS_KEY: "lt-key",
    }),
    "lambdatest",
  );
  assert.equal(resolveIosProvider({}), null);
});

test("resolveIosProvider treats whitespace-only credential values as absent", () => {
  assert.equal(
    resolveIosProvider({
      BROWSERSTACK_USERNAME: "browserstack-user",
      BROWSERSTACK_ACCESS_KEY: "   ",
      SAUCE_USERNAME: "\t",
      SAUCE_ACCESS_KEY: "sauce-key",
      LT_USERNAME: "lt-user",
      LT_ACCESS_KEY: "\n",
    }),
    null,
  );
});

test("describeAvailability enumerates checked and missing keys without secret values", () => {
  const availability = describeAvailability({});
  assert.equal(availability.available, false);
  assert.equal(availability.provider, null);
  assert.deepEqual(availability.checkedKeys, [
    "BROWSERSTACK_USERNAME",
    "BROWSERSTACK_ACCESS_KEY",
    "SAUCE_USERNAME",
    "SAUCE_ACCESS_KEY",
    "LT_USERNAME",
    "LT_ACCESS_KEY",
  ]);
  assert.deepEqual(availability.missing, availability.checkedKeys);

  const withSecrets = describeAvailability(allCredentials);
  const serialized = JSON.stringify(withSecrets);
  for (const value of Object.values(allCredentials)) {
    assert.equal(serialized.includes(value), false, `availability leaked credential value ${value}`);
  }
});

test("buildIosCapabilities creates real iOS Safari capabilities for each provider", () => {
  const browserstack = buildIosCapabilities("browserstack", {
    deviceName: "iPhone 14",
    platformVersion: "16",
  });
  assert.equal(browserstack.browserName, "safari");
  assert.equal(browserstack.platformName, "iOS");
  assert.equal(browserstack["bstack:options"].deviceName, "iPhone 14");
  assert.equal(browserstack["bstack:options"].osVersion, "16");
  assert.equal(browserstack["bstack:options"].realMobile, true);

  const sauce = buildIosCapabilities("sauce", {
    deviceName: "iPhone 15 Pro",
    platformVersion: "17",
  });
  assert.equal(sauce.browserName, "safari");
  assert.equal(sauce.platformName, "iOS");
  assert.equal(sauce["appium:deviceName"], "iPhone 15 Pro");
  assert.equal(sauce["appium:platformVersion"], "17");
  assert.equal(sauce["sauce:options"].realDevice, true);

  const lambdatest = buildIosCapabilities("lambdatest", {
    deviceName: "iPhone 13",
    platformVersion: "15",
  });
  assert.equal(lambdatest.browserName, "safari");
  assert.equal(lambdatest.platformName, "iOS");
  assert.equal(lambdatest["LT:Options"].deviceName, "iPhone 13");
  assert.equal(lambdatest["LT:Options"].platformVersion, "15");
  assert.equal(lambdatest["LT:Options"].isRealMobile, true);
});

test("iosHubUrl uses provider defaults, env overrides, and redacts embedded credentials", () => {
  const browserstackUrl = iosHubUrl(
    "browserstack",
    { username: "user@example.com", accessKey: "browserstack-secret" },
    {},
  );
  assert.equal(browserstackUrl, "https://user%40example.com:browserstack-secret@hub-cloud.browserstack.com/wd/hub");

  const sauceUrl = iosHubUrl("sauce", { username: "sauce-user", accessKey: "sauce-secret" }, {});
  assert.equal(sauceUrl, "https://sauce-user:sauce-secret@ondemand.us-west-1.saucelabs.com/wd/hub");

  const ltUrl = iosHubUrl("lambdatest", { username: "lt-user", accessKey: "lt-secret" }, {});
  assert.equal(ltUrl, "https://lt-user:lt-secret@mobile-hub.lambdatest.com/wd/hub");

  const overrideUrl = iosHubUrl(
    "browserstack",
    { username: "override-user", accessKey: "override-secret" },
    { BROWSERSTACK_HUB_URL: "https://example.test/custom/wd/hub" },
  );
  assert.equal(overrideUrl, "https://override-user:override-secret@example.test/custom/wd/hub");

  const redacted = redactUrl(overrideUrl);
  assert.equal(redacted, "https://<redacted>:<redacted>@example.test/custom/wd/hub");
  assert.equal(redacted.includes("override-user"), false);
  assert.equal(redacted.includes("override-secret"), false);
});
