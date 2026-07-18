import { describe, expect, it } from "vitest";
import plugin from "../index.js";
describe("Claude runtime plugin", () => { it("registers Claude runtime and provider ids", () => { expect(plugin.manifest.id).toBe("fusion-plugin-claude-runtime"); expect(plugin.runtime?.metadata.runtimeId).toBe("claude"); expect(plugin.cliProviders?.[0]?.providerId).toBe("claude-cli"); }); });
