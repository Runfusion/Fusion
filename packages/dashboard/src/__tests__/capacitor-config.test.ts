import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { CapacitorConfig } from "@capacitor/cli";

const configPath = resolve(__dirname, "../../capacitor.config.ts");

function evaluateConfig(env: NodeJS.ProcessEnv = {}): CapacitorConfig {
  const content = readFileSync(configPath, "utf8");
  const executableSource = content
    .replace('import type { CapacitorConfig } from "@capacitor/cli";\n\n', "")
    .replace("const config: CapacitorConfig = {", "const config = {")
    .replace("export default config;", "return config;");

  const fn = new Function("process", executableSource) as (processLike: { env: NodeJS.ProcessEnv }) => CapacitorConfig;
  return fn({ env });
}

describe("capacitor.config", () => {

  it("exists and exports a TypeScript Capacitor config", () => {
    const content = readFileSync(configPath, "utf8");

    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("import type { CapacitorConfig } from \"@capacitor/cli\"");
    expect(content).toContain("const config: CapacitorConfig = {");
    expect(content).toContain("export default config;");
  });

  it("sets webDir to dist/client", () => {
    const config = evaluateConfig();
    expect(config.webDir).toBe("dist/client");
  });

  it("uses the expected app identity", () => {
    const config = evaluateConfig();
    expect(config.appId).toBe("com.fusion.dashboard");
    expect(config.appName).toBe("Fusion");
  });

  it("enables cleartext server access for local development", () => {
    const config = evaluateConfig();
    expect(config.server?.cleartext).toBe(true);
  });

  it("defaults server.url to undefined when FUSION_BACKEND_URL is unset", () => {
    const config = evaluateConfig({});
    expect(config.server?.url).toBeUndefined();
  });

  it("uses FUSION_BACKEND_URL when provided", () => {
    const config = evaluateConfig({ FUSION_BACKEND_URL: "http://192.168.1.100:4040" });
    expect(config.server?.url).toBe("http://192.168.1.100:4040");
  });

  it("references the FUSION_BACKEND_URL env variable in source", () => {
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("process.env.FUSION_BACKEND_URL || undefined");
  });
});
