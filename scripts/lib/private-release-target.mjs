import { URL } from "node:url";

const PUBLIC_NPM_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "www.npmjs.com"]);
const SUPPORTED_BINARY_DESTINATIONS = new Set(["workflow-artifact"]);

export const DEFAULT_PRIVATE_PACKAGE_NAME = "@runfusion/fusion";
export const DEFAULT_RELEASE_TOKEN_ENV = "NODE_AUTH_TOKEN";
export const DEFAULT_BINARY_DESTINATION = "workflow-artifact";

export function resolvePrivateReleaseTarget(env = process.env) {
  const packageRegistry = normalizeRegistryUrl(
    env.FUSION_RELEASE_PACKAGE_REGISTRY || env.FUSION_PRIVATE_NPM_REGISTRY,
  );
  if (isPublicNpmRegistry(packageRegistry)) {
    throw new Error(
      "Refusing to release Fusion Pro to the public npm registry. Set FUSION_RELEASE_PACKAGE_REGISTRY to a private npm-compatible registry.",
    );
  }

  const packageName = (env.FUSION_RELEASE_PACKAGE_NAME || DEFAULT_PRIVATE_PACKAGE_NAME).trim();
  if (!packageName.startsWith("@")) {
    throw new Error(`Private package name must be scoped for GitHub Packages compatibility: ${packageName}`);
  }

  const packageTokenEnv = (env.FUSION_RELEASE_PACKAGE_TOKEN_ENV || DEFAULT_RELEASE_TOKEN_ENV).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(packageTokenEnv)) {
    throw new Error(`Invalid token environment variable name: ${packageTokenEnv}`);
  }

  const binaryDestination = (env.FUSION_RELEASE_BINARY_DESTINATION || DEFAULT_BINARY_DESTINATION).trim();
  if (!SUPPORTED_BINARY_DESTINATIONS.has(binaryDestination)) {
    throw new Error(
      `Unsupported binary release destination "${binaryDestination}". Expected one of: ${[
        ...SUPPORTED_BINARY_DESTINATIONS,
      ].join(", ")}`,
    );
  }

  return {
    packageName,
    packageRegistry,
    packageTokenEnv,
    binaryDestination,
    publishCommand: [
      "pnpm",
      "--filter",
      packageName,
      "publish",
      "--registry",
      packageRegistry,
      "--no-git-checks",
    ],
  };
}

export function assertReleaseTokenAvailable(target, env = process.env) {
  if (!env[target.packageTokenEnv]) {
    throw new Error(`Missing required package registry token environment variable: ${target.packageTokenEnv}`);
  }
}

export function formatReleaseTargetSummary(target) {
  return [
    `Package: ${target.packageName}`,
    `Registry: ${target.packageRegistry}`,
    `Token env: ${target.packageTokenEnv}`,
    `Binary destination: ${target.binaryDestination}`,
  ].join("\n");
}

export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@=-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function normalizeRegistryUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("FUSION_RELEASE_PACKAGE_REGISTRY must be set to a private npm-compatible registry.");
  }
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isPublicNpmRegistry(registry) {
  const url = new URL(registry);
  return PUBLIC_NPM_REGISTRY_HOSTS.has(url.hostname);
}
