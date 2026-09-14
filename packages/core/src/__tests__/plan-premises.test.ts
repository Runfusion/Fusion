import { describe, expect, it } from "vitest";
import { parsePlanPremises } from "../planner/plan-premises.js";

describe("parsePlanPremises", () => {
  it("parses every closed premise kind and preserves unicode literals", () => {
    const result = parsePlanPremises(`# Task\n\n## Plan Premises\n\n- {"kind":"file-exists","path":"src/a.ts"}\n- {"kind":"file-absent","path":"src/old.ts"}\n- {"kind":"text-present","path":"src/a.ts","literal":"réglage réglage"}\n- {"kind":"text-absent","path":"src/a.ts","literal":"removed"}\n\n## Steps\n`);
    expect(result).toEqual({ ok: true, premises: [
      { kind: "file-exists", path: "src/a.ts" },
      { kind: "file-absent", path: "src/old.ts" },
      { kind: "text-present", path: "src/a.ts", literal: "réglage réglage" },
      { kind: "text-absent", path: "src/a.ts", literal: "removed" },
    ] });
  });

  it.each([
    ["missing section", "# Task\n## Steps", "missing-section"],
    ["empty section", "## Plan Premises\n\n## Steps", "empty-section"],
    ["free prose", "## Plan Premises\nRun grep now", "invalid-line"],
    ["command bullet", "## Plan Premises\n- grep -q token src/a.ts", "invalid-line"],
    ["invalid JSON", "## Plan Premises\n- {kind:file-exists}", "invalid-json"],
    ["unknown kind", "## Plan Premises\n- {\"kind\":\"shell\",\"path\":\"src/a.ts\"}", "invalid-premise"],
    ["extra key", "## Plan Premises\n- {\"kind\":\"file-exists\",\"path\":\"src/a.ts\",\"command\":\"rm -rf .\"}", "invalid-premise"],
    ["empty literal", "## Plan Premises\n- {\"kind\":\"text-present\",\"path\":\"src/a.ts\",\"literal\":\"\"}", "invalid-premise"],
    ["absolute path", "## Plan Premises\n- {\"kind\":\"file-exists\",\"path\":\"/etc/passwd\"}", "invalid-premise"],
    ["traversal", "## Plan Premises\n- {\"kind\":\"file-exists\",\"path\":\"src/../secret\"}", "invalid-premise"],
    ["glob", "## Plan Premises\n- {\"kind\":\"file-exists\",\"path\":\"src/*.ts\"}", "invalid-premise"],
  ])("rejects %s", (_name, prompt, reason) => {
    expect(parsePlanPremises(prompt)).toMatchObject({ ok: false, reason });
  });
});
